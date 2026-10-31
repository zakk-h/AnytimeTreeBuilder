#pragma once
#include "graph_queries.hpp"
#include <condition_variable>
#include <future>
#include <queue>

namespace arborenum::live {
class QueryUnavailable : public std::runtime_error { public: using std::runtime_error::runtime_error; };
class Session {
    struct Request {
        std::string operation;
        json body;
        std::promise<json> promise;
        std::atomic<bool> cancelled{false};
        std::chrono::steady_clock::time_point deadline;
    };
    const std::string id_;
    const Settings settings_;
    const std::chrono::steady_clock::time_point started_ = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point ended_{};
    mutable std::mutex mutex_;
    std::condition_variable wake_;
    std::string phase_ = "preparing", error_;
    bool ready_ = false;
    uint64_t checkpoint_ = 0, query_count_ = 0, node_queries_ = 0, completion_queries_ = 0;
    size_t last_visited_ = 0;
    json meta_;
    std::queue<std::shared_ptr<Request>> requests_;
    std::atomic<bool> pending_{false}, cancel_search_{false};
    // The actor keeps its actual model alive after enumeration stops. Querying
    // a finished/cancelled run never requires an export or reconstruction.
    std::jthread worker_;

    void pump(ArborEnum& model, const json& meta, std::stop_token lifetime) {
        for (int batch = 0; batch < 8; ++batch) {
            std::shared_ptr<Request> request;
            {
                std::lock_guard lock(mutex_);
                if (requests_.empty()) { pending_.store(false, std::memory_order_relaxed); return; }
                request = std::move(requests_.front()); requests_.pop();
                pending_.store(!requests_.empty(), std::memory_order_relaxed);
            }
            try {
                GraphQueries graph(model, meta, [&] { return lifetime.stop_requested() || request->cancelled.load() || std::chrono::steady_clock::now() >= request->deadline; });
                json reply;
                const auto& body = request->body;
                if (request->operation == "node") reply = graph.view(body.at("tree"), body.at("active_uid"));
                else reply = graph.complete(body.at("tree"), body.at("active_uid"), body.at("next_uid"), body.at("mode"), body.value("constraint", json::object()), body.value("seed", std::random_device{}()));
                const size_t visited = graph.visited();
                if (request->operation != "node") reply["view"] = graph.view(reply.at("tree"), reply.at("active_uid"));
                {
                    std::lock_guard lock(mutex_);
                    ++query_count_;
                    if (request->operation == "node") ++node_queries_; else ++completion_queries_;
                    last_visited_ = visited;
                    reply["checkpoint"] = checkpoint_; reply["query_id"] = query_count_;
                }
                reply["session_id"] = id_;
                if (reply.contains("view")) {
                    reply["view"]["session_id"] = id_;
                    reply["view"]["query_id"] = reply["query_id"];
                    reply["view"]["checkpoint"] = reply["checkpoint"];
                }
                request->promise.set_value(std::move(reply));
            } catch (...) { request->promise.set_exception(std::current_exception()); }
        }
    }
    void run(Dataset data, std::stop_token lifetime) noexcept {
        ArborEnum model;
        model.live_forbid_graph_export = true;
        json meta;
        bool root_announced = false; // Owner-thread state for the model's lifetime.
        try {
            const size_t n = data.X.size();
            std::vector<int> binary, continuous;
            std::vector<double> binary_cuts;
            for (size_t f = 0; f < data.names.size(); ++f) {
                std::set<double> values;
                for (const auto& row : data.X) values.insert(row[f]);
                if (values.size() <= 2) { binary.push_back(f); binary_cuts.push_back(*values.begin()); }
                else continuous.push_back(f);
            }
            std::vector<std::vector<double>> numeric(n);
            std::vector<std::vector<uint8_t>> bin(n), seed(n), proxy(n);
            for (size_t i = 0; i < n; ++i) {
                for (size_t f = 0; f < binary.size(); ++f) bin[i].push_back(data.X[i][binary[f]] <= binary_cuts[f]);
                for (int f : continuous) numeric[i].push_back(data.X[i][f]);
                if (!continuous.empty()) seed[i].push_back(data.y[i] == 0);
            }
            // Deterministic median seeds; continuous Lickety uses every threshold.
            for (int f : continuous) {
                std::vector<double> col;
                for (const auto& row : data.X) col.push_back(row[f]);
                std::sort(col.begin(), col.end());
                double cut = col[(n - 1) / 2];
                for (size_t i = 0; i < n; ++i) proxy[i].push_back(data.X[i][f] <= cut);
            }
            model.prepare_continuous_data(numeric, bin, data.y, seed, proxy, settings_.max_thresholds, settings_.abstain ? data.y : std::vector<int>{});
            json registry = json::array();
            for (size_t f = 0; f < binary.size(); ++f) registry.push_back({{"internalFeature", f}, {"originalFeature", binary[f]}, {"originalName", data.names[binary[f]]}, {"threshold", binary_cuts[f]}, {"kind", "binary_threshold"}, {"continuousGroup", nullptr}});
            auto starts = model.get_continuous_starts();
            for (size_t group = 0; group < continuous.size(); ++group) {
                auto cuts = model.get_continuous_cutpoints(group);
                for (size_t k = 0; k < cuts.size(); ++k) registry.push_back({{"internalFeature", starts.at(group) + k}, {"originalFeature", continuous[group]}, {"originalName", data.names[continuous[group]]}, {"threshold", cuts[k]}, {"kind", "continuous_threshold"}, {"continuousGroup", group}});
            }
            for (const auto* ids : {&settings_.proxy_features, &settings_.initial_features})
                for (int id : *ids) if (static_cast<size_t>(id) >= registry.size()) throw std::invalid_argument("Threshold feature ID is outside the prepared feature registry");
            meta = {{"featureRegistry", registry}, {"classNames", data.classes}, {"lambda_reg", settings_.lambda}, {"gamma", static_cast<int>(std::llround(settings_.lambda * n))}, {"root_n", n}, {"depth_budget", settings_.depth}, {"rashomon_mult", settings_.multiplier}, {"use_deferral", settings_.abstain}, {"eta_defer", settings_.abstain_cost}, {"abstain_uses_labels", settings_.abstain}, {"training_settings", settings_.as_json()}};
            { std::lock_guard lock(mutex_); meta_ = meta; phase_ = "running"; }
            model.live_poll = [&] {
                if (!root_announced) {
                    model.live_refresh_in_progress();
                    if (model.live_root_has_solution()) {
                        std::lock_guard lock(mutex_);
                        ready_ = true;
                        root_announced = true;
                    }
                }
                if (pending_.load(std::memory_order_relaxed)) pump(model, meta, lifetime);
            };
            model.live_checkpoint = [&] {
                { std::lock_guard lock(mutex_); ++checkpoint_; ready_ = model.live_root_has_solution(); }
                model.live_poll();
            };
            model.live_stop_requested = [&] { return cancel_search_.load() || lifetime.stop_requested(); };
            model.set_key_mode(settings_.key_mode == "exact" ? ArborEnum::KeyMode::EXACT : settings_.key_mode == "lits_exact" ? ArborEnum::KeyMode::LITS_EXACT : settings_.key_mode == "hash128" ? ArborEnum::KeyMode::HASH128 : ArborEnum::KeyMode::HASH64);
            model.set_trie_cache_enabled(settings_.trie_cache);
            model.set_greedy_split_mode(settings_.greedy_split);
            model.set_greedy_continuous_mode(settings_.greedy_continuous == "numerical" ? 1 : 0);
            model.set_stronger_rollout(settings_.stronger_rollout);
            model.set_evaluated_use_min_objectives(settings_.evaluated_min);
            model.set_additive(settings_.additive);
            model.set_multiplicative_slack(settings_.slack);
            if (!model.live_stop_requested()) {
                model.fit_prepared_anytime(settings_.lambda, settings_.depth, settings_.multiplier, settings_.second_multiplier, settings_.multiplier_step, settings_.lookahead,
                    settings_.multipass, settings_.rule_list, settings_.proxy_style, settings_.majority_only, settings_.cache_cheap, true,
                    settings_.proxy_features, settings_.initial_features, settings_.width, settings_.max_rounds, settings_.proxy_refinement,
                    settings_.continuous_lickety < 0 ? settings_.proxy_mode != "binarized" : bool(settings_.continuous_lickety),
                    settings_.continuous_exact < 0 ? settings_.proxy_mode != "binarized" : bool(settings_.continuous_exact),
                    settings_.continuous_greedy < 0 ? settings_.proxy_mode == "continuous" : bool(settings_.continuous_greedy),
                    settings_.runtime, settings_.memory, settings_.abstain, settings_.abstain_cost);
            }
            { std::lock_guard lock(mutex_); ready_ = model.live_root_has_solution(); phase_ = cancel_search_.load() ? "stopped" : "finished"; ended_ = std::chrono::steady_clock::now(); }
        } catch (const LiveEnumerationCancelled&) {
            std::lock_guard lock(mutex_); ready_ = model.live_root_has_solution(); phase_ = "stopped"; ended_ = std::chrono::steady_clock::now();
        } catch (const std::exception& e) {
            std::lock_guard lock(mutex_); ready_ = model.live_root_has_solution(); error_ = e.what(); phase_ = "failed"; ended_ = std::chrono::steady_clock::now();
        } catch (...) {
            std::lock_guard lock(mutex_); ready_ = model.live_root_has_solution(); error_ = "Unknown native enumeration error"; phase_ = "failed"; ended_ = std::chrono::steady_clock::now();
        }
        // No model access occurs on HTTP threads, including after fit completes.
        while (!lifetime.stop_requested()) {
            std::unique_lock lock(mutex_);
            wake_.wait(lock, [&] { return lifetime.stop_requested() || !requests_.empty(); });
            lock.unlock();
            if (!lifetime.stop_requested()) pump(model, meta, lifetime);
        }
        std::lock_guard lock(mutex_);
        while (!requests_.empty()) {
            requests_.front()->promise.set_exception(std::make_exception_ptr(QueryUnavailable("Native session closed")));
            requests_.pop();
        }
    }
public:
    Session(std::string id, Dataset data, Settings settings) : id_(std::move(id)), settings_(Settings::checked(settings, data.X.size())), worker_([this, data = std::move(data)](std::stop_token stop) mutable { run(std::move(data), stop); }) {}
    ~Session() { shutdown(); }
    // Closing the application also cancels pending/in-progress graph queries.
    // The UI's Stop operation intentionally retains queries on the live model.
    void shutdown() { worker_.request_stop(); wake_.notify_all(); }
    void stop() { cancel_search_.store(true); wake_.notify_all(); }
    bool done() const { std::lock_guard lock(mutex_); return phase_ == "finished" || phase_ == "stopped" || phase_ == "failed"; }
    json metadata() const { std::lock_guard lock(mutex_); return meta_; }
    json query(std::string operation, json body) {
        auto request = std::make_shared<Request>();
        request->operation = std::move(operation); request->body = std::move(body);
        const auto timeout = std::chrono::seconds(request->operation == "node" ? 10 : 60);
        request->deadline = std::chrono::steady_clock::now() + timeout;
        auto future = request->promise.get_future();
        {
            std::lock_guard lock(mutex_);
            if (worker_.get_stop_token().stop_requested()) throw QueryUnavailable("Native session closed");
            if (!ready_) throw QueryUnavailable("Waiting for the first feasible native tree");
            if (requests_.size() >= 32) throw QueryUnavailable("Native query queue is full; retry the latest selection");
            requests_.push(request); pending_.store(true, std::memory_order_relaxed);
        }
        wake_.notify_one();
        if (future.wait_for(timeout) != std::future_status::ready) {
            request->cancelled.store(true);
            throw QueryUnavailable("Native query timed out; retry the latest selection");
        }
        return future.get();
    }
    json status() const {
        std::lock_guard lock(mutex_);
        return {{"session_id", id_}, {"phase", phase_}, {"error", error_}, {"ready", ready_}, {"stop_requested", cancel_search_.load()}, {"checkpoint", checkpoint_}, {"query_count", query_count_}, {"node_queries", node_queries_}, {"completion_queries", completion_queries_}, {"last_visited_nodes", last_visited_}, {"full_graph_exports", 0}, {"elapsed_seconds", std::chrono::duration<double>((ended_ == std::chrono::steady_clock::time_point{} ? std::chrono::steady_clock::now() : ended_) - started_).count()}};
    }
};
}
