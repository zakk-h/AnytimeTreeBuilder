#include "live_session.hpp"
#include "local_origin.hpp"
#include "vendor/httplib.h"
#include "desktop_launch.hpp"
#include "managed_process.hpp"
#ifdef ARBORENUM_EMBEDDED_UI
#include "embedded_ui.hpp"
#endif
#ifdef _WIN32
#include <bcrypt.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <charconv>
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
#elif defined(_WIN32)
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                       BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
        throw std::runtime_error("Cannot obtain secure random bytes");
#elif defined(__APPLE__)
    arc4random_buf(bytes.data(), bytes.size());
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
        bool managed = false;
#ifdef ARBORENUM_DESKTOP
        int port = 0;
        bool open_browser = argc == 1;
#else
        int port = 8765;
        bool open_browser = false;
#endif
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (arg == "--ui" && i + 1 < argc) html_path = argv[++i];
            else if (arg == "--port" && i + 1 < argc) {
                const std::string value = argv[++i];
                const auto parsed = std::from_chars(value.data(), value.data() + value.size(), port);
                if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size())
                    throw std::invalid_argument("Invalid port: " + value);
            }
            else if (arg == "--no-browser") open_browser = false;
            else if (arg == "--managed") { managed = true; open_browser = false; }
            else if (arg == "--open-browser") open_browser = true;
            else if (arg == "--help") {
                std::cout << "AnytimeTreeBuilder [--ui /path/to/index.html] [--port 0..65535] [--no-browser | --open-browser]\n"
                          << "Desktop builds include the UI; port 0 selects a free local port.\n"
                          << "--managed exits cooperatively when its parent closes the stdin pipe.\n";
                return 0;
            } else throw std::invalid_argument("Unknown argument: " + arg);
        }
        if (port < 0 || port > 65535)
            throw std::invalid_argument("Port must be between 0 and 65535");
        if (managed) { require_owner_pipe(); open_browser = false; }

        std::size_t max_sessions = 2;
        if (const char* setting = std::getenv("ARBORENUM_MAX_SESSIONS")) {
            const std::string value(setting);
            std::size_t consumed = 0;
            max_sessions = std::stoul(value, &consumed);
            if (consumed != value.size() || max_sessions < 1 || max_sessions > 16)
                throw std::invalid_argument("ARBORENUM_MAX_SESSIONS must be 1 through 16");
        }

        std::string html;
        if (!html_path.empty()) {
            std::ifstream input(html_path, std::ios::binary);
            if (!input) throw std::runtime_error("Cannot open builder HTML: " + html_path);
            html.assign(std::istreambuf_iterator<char>(input), {});
        } else {
#ifdef ARBORENUM_EMBEDDED_UI
            html.assign(reinterpret_cast<const char*>(arborenum_embedded_ui), sizeof(arborenum_embedded_ui));
#else
            throw std::runtime_error("Pass --ui /path/to/dist/index.html or build the desktop application");
#endif
        }

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
#ifdef ARBORENUM_DESKTOP
        const char* env_host = nullptr; // Portable desktop apps always stay on loopback.
#else
        const char* env_host = std::getenv("RENDER_EXTERNAL_HOSTNAME");
#endif
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
            for (const auto& session : existing) if (session) session->shutdown();
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
        // Normal POST handlers run after httplib consumes the bounded request
        // body. Rejecting media types in pre-routing leaves unread TCP bytes,
        // which can reset the connection and lose the error response on Windows.
        auto post_json = [&](const std::string& path, httplib::Server::Handler handler) {
            server.Post(path, [respond, handler = std::move(handler)](const auto& req, auto& res) {
                if (req.get_header_value("Content-Type").find("application/json") != 0) {
                    respond(res, {{"error", "Expected application/json"}}, 415);
                    return;
                }
                handler(req, res);
            });
        };
        post_json("/api/session", [&](const auto& req, auto& res) {
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
        post_json("/api/node", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res))
                respond(res, current->query("node", json::parse(req.body)));
        });
        post_json("/api/complete", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res))
                respond(res, current->query("complete", json::parse(req.body)));
        });
        post_json("/api/stop", [&](const auto& req, auto& res) {
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
#ifdef _WIN32
        std::signal(SIGBREAK, signal_stop);
#endif
        const std::string bind_host = public_host.empty() ? "127.0.0.1" : "0.0.0.0";
        if (port == 0) {
            port = server.bind_to_any_port(bind_host);
            if (port < 1) throw std::runtime_error("Cannot choose a free local port");
        } else if (!server.bind_to_port(bind_host, port)) {
            throw std::runtime_error("Cannot bind " + bind_host + ":" + std::to_string(port));
        }
        const std::string url = "http://127.0.0.1:" + std::to_string(port);

        std::condition_variable_any janitor_wake;
        std::mutex janitor_mutex;
        std::jthread janitor([&](std::stop_token token) {
            std::unique_lock lock(janitor_mutex);
            while (!token.stop_requested() && !shutting_down.load()) {
                janitor_wake.wait_for(lock, token, std::chrono::seconds(5), [&] { return shutting_down.load(); });
                if (!token.stop_requested() && !shutting_down.load()) reap_idle();
            }
        });
        std::jthread shutdown_watcher([&](std::stop_token token) {
            while (!token.stop_requested() && !shutting_down.load()) {
                if (managed && owner_pipe_closed()) shutting_down.store(true);
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
            if (shutting_down.load()) {
                stop_all();
                server.stop();
            }
        });
        std::cout << "Interactive Tree Builder: " << url << "\n"
                  << "Keep this application running while using the builder. Press Ctrl+C to close.\n" << std::flush;
        if (open_browser && !open_local_browser(url))
            std::cerr << "Could not open the browser automatically. Open " << url << " manually.\n";
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
