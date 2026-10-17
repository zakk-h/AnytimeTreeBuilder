#include "live_session.hpp"
#include "local_origin.hpp"
#include "vendor/httplib.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <random>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef __linux__
#include <cerrno>
#include <sys/random.h>
#endif

using namespace arborenum::live;

static std::atomic<bool> shutting_down{false};
static void signal_stop(int) { shutting_down.store(true); }

// A 256-bit, unpredictable browser identity. Never use numeric session IDs as
// authentication: the frontend exposes those IDs in API responses.
static std::string new_secret() {
    std::array<unsigned char, 32> bytes{};
#ifdef __linux__
    std::size_t filled = 0;
    while (filled < bytes.size()) {
        const auto n = ::getrandom(bytes.data() + filled, bytes.size() - filled, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) throw std::runtime_error("Cannot obtain secure random bytes");
        filled += static_cast<std::size_t>(n);
    }
#else
    std::random_device rd;
    for (auto& byte : bytes) byte = static_cast<unsigned char>(rd());
#endif
    constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(bytes.size() * 2);
    for (const auto byte : bytes) {
        result.push_back(hex[byte >> 4]);
        result.push_back(hex[byte & 15]);
    }
    return result;
}

static std::string browser_cookie(const httplib::Request& req) {
    constexpr std::string_view name = "arborenum_browser";
    const std::string header = req.get_header_value("Cookie");
    std::string_view cookies(header);
    while (!cookies.empty()) {
        const auto semicolon = cookies.find(';');
        auto item = cookies.substr(0, semicolon);
        while (!item.empty() && item.front() == ' ') item.remove_prefix(1);
        const auto equals = item.find('=');
        if (equals != std::string_view::npos && item.substr(0, equals) == name) {
            const auto value = item.substr(equals + 1);
            if (value.size() != 64 || !std::all_of(value.begin(), value.end(), [](char c) {
                    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                })) return {};
            return std::string(value);
        }
        if (semicolon == std::string_view::npos) break;
        cookies.remove_prefix(semicolon + 1);
    }
    return {};
}

struct BrowserSession {
    std::shared_ptr<Session> session;
    std::chrono::steady_clock::time_point last_access;
};

int main(int argc, char** argv) {
    try {
        std::string html_path;
        int port = 8765;
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (arg == "--ui" && i + 1 < argc) html_path = argv[++i];
            else if (arg == "--port" && i + 1 < argc) port = std::stoi(argv[++i]);
            else if (arg == "--help") {
                std::cout << "arborenum-builder --ui /path/to/dist/index.html [--port 8765]\n";
                return 0;
            } else throw std::invalid_argument("Unknown argument: " + arg);
        }
        if (port < 1 || port > 65535)
            throw std::invalid_argument("Port must be between 1 and 65535");

        std::size_t max_sessions = 2;
        if (const char* setting = std::getenv("ARBORENUM_MAX_SESSIONS")) {
            const std::string value(setting);
            std::size_t consumed = 0;
            max_sessions = std::stoul(value, &consumed);
            if (consumed != value.size() || max_sessions < 1 || max_sessions > 16)
                throw std::invalid_argument("ARBORENUM_MAX_SESSIONS must be 1 through 16");
        }

        std::ifstream input(html_path, std::ios::binary);
        if (!input) throw std::runtime_error("Cannot open builder HTML; pass --ui /path/to/dist/index.html");
        const std::string html((std::istreambuf_iterator<char>(input)), {});
        input.close();

        httplib::Server server;
        server.new_task_queue = [] { return new httplib::ThreadPool(4); };
        server.set_payload_max_length(128 * 1024 * 1024);
        server.set_read_timeout(30, 0);
        server.set_write_timeout(30, 0);

        std::mutex session_mutex;
        std::unordered_map<std::string, BrowserSession> sessions;
        uint64_t next_id = 1;
        const auto max_idle = std::chrono::minutes(30);

        auto respond = [](httplib::Response& res, const json& body, int status = 200) {
            res.status = status;
            res.set_content(body.dump(), "application/json");
        };
        const std::string authority = "127.0.0.1:" + std::to_string(port);
        const char* env_host = std::getenv("RENDER_EXTERNAL_HOSTNAME");
        const std::string public_host = env_host ? env_host : "";

        auto ensure_browser = [&](const httplib::Request& req, httplib::Response& res) {
            std::string key = browser_cookie(req);
            if (!key.empty()) return key;
            key = new_secret();
            std::string cookie = "arborenum_browser=" + key +
                                 "; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400";
            if (!public_host.empty()) cookie += "; Secure";
            res.set_header("Set-Cookie", cookie);
            return key;
        };

        auto get_session = [&](const std::string& key) -> std::shared_ptr<Session> {
            if (key.empty()) return {};
            std::lock_guard lock(session_mutex);
            const auto it = sessions.find(key);
            if (it == sessions.end()) return {};
            it->second.last_access = std::chrono::steady_clock::now();
            return it->second.session;
        };

        // Reap abandoned sessions outside the global mutex, because destroying
        // Session can join its native worker thread.
        auto reap_idle = [&] {
            std::vector<std::shared_ptr<Session>> expired;
            const auto now = std::chrono::steady_clock::now();
            {
                std::lock_guard lock(session_mutex);
                for (auto it = sessions.begin(); it != sessions.end();) {
                    if (now - it->second.last_access > max_idle) {
                        expired.push_back(std::move(it->second.session));
                        it = sessions.erase(it);
                    } else ++it;
                }
            }
            for (auto& session : expired) if (session) session->stop();
        };

        auto stop_all = [&] {
            std::vector<std::shared_ptr<Session>> existing;
            {
                std::lock_guard lock(session_mutex);
                for (const auto& [key, slot] : sessions) existing.push_back(slot.session);
            }
            for (const auto& session : existing) if (session) session->stop();
        };

        server.set_pre_routing_handler([&](const httplib::Request& req, httplib::Response& res) {
            res.set_header("Cache-Control", "no-store");
            res.set_header("X-Content-Type-Options", "nosniff");
            res.set_header("Referrer-Policy", "same-origin");
            const auto host = req.get_header_value("Host");
            const auto origin = req.get_header_value("Origin");
            const bool allowed_public = !public_host.empty() && host == public_host &&
                (origin.empty() || origin == "https://" + public_host);
            if (!is_local_browser_request(host, origin) && !allowed_public) {
                respond(res, {{"error", "Host/Origin not allowed"}}, 403);
                return httplib::Server::HandlerResponse::Handled;
            }
            if (req.method == "POST" &&
                req.get_header_value("Content-Type").find("application/json") != 0) {
                respond(res, {{"error", "Expected application/json"}}, 415);
                return httplib::Server::HandlerResponse::Handled;
            }
            return httplib::Server::HandlerResponse::Unhandled;
        });

        server.set_exception_handler([&](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
            try { if (ep) std::rethrow_exception(ep); }
            catch (const QueryUnavailable& e) { respond(res, {{"error", e.what()}}, 503); }
            catch (const std::exception& e) { respond(res, {{"error", e.what()}}, 400); }
        });

        server.Get("/", [&](const auto&, auto& res) {
            res.set_content(html, "text/html; charset=utf-8");
        });
        server.Get("/api/health", [&](const auto&, auto& res) {
            respond(res, {{"service", "arborenum-native-builder"}, {"protocol", 2}});
        });
        server.Get("/api/session", [&](const auto& req, auto& res) {
            const auto key = ensure_browser(req, res);
            const auto current = get_session(key);
            respond(res, current ? current->status() : json(nullptr));
        });
        server.Post("/api/session", [&](const auto& req, auto& res) {
            const auto key = ensure_browser(req, res);
            auto body = json::parse(req.body);
            auto settings = Settings::parse(body.value("settings", json::object()));
            auto data = Dataset::parse(body);
            std::shared_ptr<Session> current;
            std::shared_ptr<Session> previous;
            {
                std::lock_guard lock(session_mutex);
                auto it = sessions.find(key);
                if (it != sessions.end() && it->second.session && !it->second.session->done()) {
                    respond(res, {{"error", "Stop your running enumeration before starting another dataset"}}, 409);
                    return;
                }
                if (it == sessions.end() && sessions.size() >= max_sessions) {
                    respond(res, {{"error", "Server is at its session limit. Try again after an idle session expires."}}, 503);
                    return;
                }
                current = std::make_shared<Session>(std::to_string(next_id++), std::move(data), settings);
                if (it == sessions.end()) {
                    sessions.emplace(key, BrowserSession{current, std::chrono::steady_clock::now()});
                } else {
                    previous = std::move(it->second.session);
                    it->second.session = current;
                    it->second.last_access = std::chrono::steady_clock::now();
                }
            }
            // The old worker (if any) is destructed without holding session_mutex.
            respond(res, current->status(), 202);
        });

        auto checked_session = [&](const httplib::Request& req, httplib::Response& res) -> std::shared_ptr<Session> {
            const auto key = browser_cookie(req);
            if (key.empty()) {
                respond(res, {{"error", "No browser session cookie; reload the page"}}, 401);
                return {};
            }
            const auto current = get_session(key);
            if (!current) {
                respond(res, {{"error", "No enumeration for this browser"}}, 404);
                return {};
            }
            const auto id = req.get_param_value("session_id");
            if (id.empty() || current->status().at("session_id") != id) {
                respond(res, {{"error", "Session changed; reconnect to your current session"}}, 409);
                return {};
            }
            return current;
        };

        server.Get("/api/meta", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res)) respond(res, current->metadata());
        });
        server.Post("/api/node", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res))
                respond(res, current->query("node", json::parse(req.body)));
        });
        server.Post("/api/complete", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res))
                respond(res, current->query("complete", json::parse(req.body)));
        });
        server.Post("/api/stop", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res)) {
                current->stop();
                respond(res, current->status(), 202);
            }
        });
        server.Get("/api/snapshot", [&](const auto&, auto& res) {
            respond(res, {{"error", "Whole-graph exports have been replaced by native path queries; reload the builder"}}, 410);
        });

        std::signal(SIGINT, signal_stop);
        std::signal(SIGTERM, signal_stop);
        const std::string bind_host = public_host.empty() ? "127.0.0.1" : "0.0.0.0";
        if (!server.bind_to_port(bind_host, port))
            throw std::runtime_error("Cannot bind " + bind_host + ":" + std::to_string(port));

        std::jthread janitor([&](std::stop_token token) {
            while (!token.stop_requested() && !shutting_down.load()) {
                std::this_thread::sleep_for(std::chrono::seconds(5));
                if (!token.stop_requested() && !shutting_down.load()) reap_idle();
            }
        });
        std::jthread shutdown_watcher([&](std::stop_token token) {
            while (!token.stop_requested() && !shutting_down.load())
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (shutting_down.load()) {
                stop_all();
                server.stop();
            }
        });
        std::cout << "Interactive Tree Builder: http://" << authority << "\n" << std::flush;
        server.listen_after_bind();
        janitor.request_stop();
        shutdown_watcher.request_stop();
        stop_all();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "arborenum-builder: " << e.what() << "\n";
        return 1;
    }
}
