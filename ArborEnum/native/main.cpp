#include "live_session.hpp"
#include "local_origin.hpp"
#include "vendor/httplib.h"
#include <csignal>

using namespace arborenum::live;
static std::atomic<bool> shutting_down{false};
static void signal_stop(int) { shutting_down.store(true); }

int main(int argc, char** argv) {
    try {
        std::string html_path;
        int port = 8765;
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (arg == "--ui" && i + 1 < argc) html_path = argv[++i];
            else if (arg == "--port" && i + 1 < argc) port = std::stoi(argv[++i]);
            else if (arg == "--help") { std::cout << "arborenum-builder --ui /path/to/dist/index.html [--port 8765]\n"; return 0; }
            else throw std::invalid_argument("Unknown argument: " + arg);
        }
        if (port < 1 || port > 65535) throw std::invalid_argument("Port must be between 1 and 65535");
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
        std::shared_ptr<Session> session;
        uint64_t next_id = 1;
        auto get_session = [&] { std::lock_guard lock(session_mutex); return session; };
        auto respond = [](httplib::Response& res, const json& body, int status = 200) { res.status = status; res.set_content(body.dump(), "application/json"); };
        // Desktop preview proxies may expose a different loopback authority.
        // Validate explicit loopback Host/Origin names, independent of the port.
        const std::string authority = "127.0.0.1:" + std::to_string(port);
        server.set_pre_routing_handler([&](const httplib::Request& req, httplib::Response& res) {
            res.set_header("Cache-Control", "no-store");
            res.set_header("X-Content-Type-Options", "nosniff");
            res.set_header("Referrer-Policy", "same-origin");
            auto host = req.get_header_value("Host");
            auto origin = req.get_header_value("Origin");
            if (!is_local_browser_request(host, origin)) { respond(res, {{"error", "Loopback requests only"}}, 403); return httplib::Server::HandlerResponse::Handled; }
            if (req.method == "POST" && req.get_header_value("Content-Type").find("application/json") != 0) { respond(res, {{"error", "Expected application/json"}}, 415); return httplib::Server::HandlerResponse::Handled; }
            return httplib::Server::HandlerResponse::Unhandled;
        });
        server.set_exception_handler([&](const httplib::Request&, httplib::Response& res, std::exception_ptr ep) {
            try { if (ep) std::rethrow_exception(ep); }
            catch (const QueryUnavailable& e) { respond(res, {{"error", e.what()}}, 503); }
            catch (const std::exception& e) { respond(res, {{"error", e.what()}}, 400); }
        });
        server.Get("/", [&](const auto&, auto& res) { res.set_content(html, "text/html; charset=utf-8"); });
        server.Get("/api/health", [&](const auto&, auto& res) { respond(res, {{"service", "arborenum-native-builder"}, {"protocol", 2}}); });
        server.Get("/api/session", [&](const auto&, auto& res) {
            auto current = get_session();
            respond(res, current ? current->status() : json(nullptr));
        });
        server.Post("/api/session", [&](const auto& req, auto& res) {
            auto body = json::parse(req.body);
            auto settings = Settings::parse(body.value("settings", json::object()));
            auto data = Dataset::parse(body);
            std::shared_ptr<Session> previous;
            { std::lock_guard lock(session_mutex);
                if (session && !session->done()) { respond(res, {{"error", "Stop the running enumeration before starting another dataset"}}, 409); return; }
                previous = std::move(session);
                session = std::make_shared<Session>(std::to_string(next_id++), std::move(data), settings);
                respond(res, session->status(), 202);
            }
        });
        auto checked_session = [&](const auto& req, auto& res) -> std::shared_ptr<Session> {
            auto current = get_session();
            if (!current) { respond(res, {{"error", "No enumeration session"}}, 404); return {}; }
            const auto id = req.get_param_value("session_id");
            if (id.empty() || current->status().at("session_id") != id) { respond(res, {{"error", "Session changed; reconnect to the current session"}}, 409); return {}; }
            return current;
        };
        server.Get("/api/meta", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res)) respond(res, current->metadata());
        });
        server.Post("/api/node", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res)) respond(res, current->query("node", json::parse(req.body)));
        });
        server.Post("/api/complete", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res)) respond(res, current->query("complete", json::parse(req.body)));
        });
        server.Post("/api/stop", [&](const auto& req, auto& res) {
            if (auto current = checked_session(req, res)) { current->stop(); respond(res, current->status(), 202); }
        });
        server.Get("/api/snapshot", [&](const auto&, auto& res) {
            respond(res, {{"error", "Whole-graph exports have been replaced by native path queries; reload the builder"}}, 410);
        });
        std::signal(SIGINT, signal_stop);
        std::signal(SIGTERM, signal_stop);
        if (!server.bind_to_port("127.0.0.1", port)) throw std::runtime_error("Cannot bind loopback port " + std::to_string(port));
        std::jthread shutdown([&](std::stop_token token) {
            while (!token.stop_requested() && !shutting_down.load()) std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (shutting_down.load()) { if (auto current = get_session()) current->stop(); server.stop(); }
        });
        std::cout << "Interactive Tree Builder: http://" << authority << "\n" << std::flush;
        server.listen_after_bind();
        if (auto current = get_session()) current->stop();
        shutdown.request_stop();
        return 0;
    } catch (const std::exception& e) { std::cerr << "arborenum-builder: " << e.what() << "\n"; return 1; }
}
