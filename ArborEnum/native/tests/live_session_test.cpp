#include "../live_session.hpp"
#include <bit>
#include <future>

using namespace arborenum::live;
static void require(bool ok, const std::string& message) { if (!ok) throw std::runtime_error(message); }
static json root() { return {{"uid", 0}, {"kind", "choice"}}; }
static int cost(TreeTrieNode* node, const json& tree, const std::set<int>& forbidden = {}, const json& truth = json::object(), int target = -1) {
    if (tree.at("kind") == "leaf") {
        const int prediction = tree.at("prediction");
        if (target >= 0 && prediction != target) throw std::runtime_error("Sample prediction violated");
        for (const auto& l : node->leaves) if (l.prediction == prediction) return l.loss;
        throw std::runtime_error("Completion leaf not in native node");
    }
    const int feature = tree.at("feature");
    require(!forbidden.count(feature), "Forbidden feature used");
    for (const auto& s : node->splits) if (s.feature == feature) {
        int lt = target, rt = target;
        if (target >= 0 && truth.contains(std::to_string(feature))) {
            if (truth.at(std::to_string(feature)).get<bool>()) rt = -1; else lt = -1;
        }
        int value = cost(s.left.get(), tree.at("left"), forbidden, truth, lt) + cost(s.right.get(), tree.at("right"), forbidden, truth, rt);
        require(value <= node->budget, "Completion exceeded native node budget");
        return value;
    }
    throw std::runtime_error("Completion split not in native node");
}
// Independent exhaustive fixture oracle: materialization is confined to tests.
static std::vector<std::pair<json,int>> enumerate(TreeTrieNode* node, const std::set<int>& forbidden, const json& truth, int target) {
    std::vector<std::pair<json,int>> out;
    for (const auto& l : node->leaves) if (target < 0 || target == l.prediction) out.push_back({json{{"kind", "leaf"}, {"prediction", l.prediction}}, l.loss});
    for (const auto& s : node->splits) if (!forbidden.count(s.feature) && s.left && s.right) {
        int lt = target, rt = target;
        if (target >= 0 && truth.contains(std::to_string(s.feature))) { if (truth.at(std::to_string(s.feature)).get<bool>()) rt = -1; else lt = -1; }
        for (const auto& [l, lc] : enumerate(s.left.get(), forbidden, truth, lt))
            for (const auto& [r, rc] : enumerate(s.right.get(), forbidden, truth, rt))
                if (lc + rc <= node->budget) out.push_back({json{{"kind", "split"}, {"feature", s.feature}, {"left", l}, {"right", r}}, lc + rc});
    }
    return out;
}

// Test-only graph inspection: production node requests never walk the DAG.
static bool has_placeholder(TreeTrieNode* node, std::set<TreeTrieNode*>& seen) {
    if (!node || !seen.insert(node).second) return false;
    for (const auto& s : node->splits)
        if (!TreeTrieNode::split_has_solution(s, node->budget) ||
            has_placeholder(s.left.get(), seen) || has_placeholder(s.right.get(), seen)) return true;
    return false;
}
static json graph_signature(TreeTrieNode* node, std::map<TreeTrieNode*, int>& seen, json& records) {
    if (auto found = seen.find(node); found != seen.end()) return found->second;
    const int id = static_cast<int>(seen.size()); seen.emplace(node, id);
    json record = {{"id", id}, {"budget", node->budget}, {"minimum", node->min_objective}, {"leaves", json::array()}, {"splits", json::array()}};
    std::set<int> features;
    for (const auto& l : node->leaves) record["leaves"].push_back({l.prediction, l.loss});
    for (const auto& s : node->splits) {
        require(TreeTrieNode::split_has_solution(s, node->budget), "Unusable placeholder survived unwinding");
        require(features.insert(s.feature).second, "Incremental attachment duplicated a split");
        auto left = graph_signature(s.left.get(), seen, records);
        auto right = graph_signature(s.right.get(), seen, records);
        record["splits"].push_back({s.feature, left, right});
    }
    records.push_back(std::move(record));
    return id;
}
static json graph_signature(TreeTrieNode* node) {
    std::map<TreeTrieNode*, int> seen; json records = json::array();
    graph_signature(node, seen, records); return records;
}
static void incremental_attachment(bool cache, int cancel_stage = 0) {
    ArborEnum model, baseline;
    std::vector<std::vector<double>> X;
    std::vector<std::vector<uint8_t>> binary;
    std::vector<int> y;
    for (int i = 0; i < 30; ++i) {
        X.push_back({double(i), double((i * 7) % 30)});
        binary.push_back({uint8_t(i % 2), uint8_t((i / 3) % 2)});
        y.push_back((i / 4 + i % 3) % 2);
    }
    for (auto* m : {&model, &baseline}) {
        m->prepare_continuous_data(X, binary, y, {}, {});
        m->set_trie_cache_enabled(cache);
    }
    auto fit = [](ArborEnum& m) {
        m.fit_prepared_anytime(.04, 3, .6, 1., .2, 1, true, false, 0, false, false, true, {}, {}, 1, -1, 1, true, true, false);
    };
    const json meta = {{"root_n", y.size()}};
    std::set<int> started, exposed;
    bool saw_null = false, saw_growing = false, cancel = false;
    size_t polls = 0;
    std::vector<json> selected_trees;
    model.live_stop_requested = [&] { return cancel; };
    model.live_poll = [&] {
        if (!model.result) return;
        model.live_refresh_in_progress();
        if (!model.live_root_has_solution()) return;
        // Observe every yield until the key mid-construction case is proven,
        // then sample monotonicity without flooding the solver with queries.
        if (saw_growing && !cancel && (++polls % 256) != 0) return;
        GraphQueries query(model, meta);
        const auto view = query.view(root(), 0);
        std::set<int> offered;
        for (const auto& s : view["options"]["splits"]) offered.insert(s["feature"].get<int>());
        for (int feature : exposed) require(offered.count(feature), "Previously exposed split disappeared");
        for (const auto& s : model.result->splits) {
            if (!s.left || !s.right) {
                saw_null = true; started.insert(s.feature);
                require(!offered.count(s.feature), "Null placeholder offered to the GUI");
                if (cancel_stage == 1) cancel = true;
            }
            if (saw_growing || !started.count(s.feature) || !TreeTrieNode::split_has_solution(s, model.result->budget)) continue;
            std::set<TreeTrieNode*> visited;
            if (!has_placeholder(s.left.get(), visited) && !has_placeholder(s.right.get(), visited)) continue;
            require(offered.count(s.feature), "Usable split hidden until its child solves finished");
            if (!saw_growing) {
                saw_growing = true;
                json partial = {{"uid", 0}, {"kind", "split"}, {"feature", s.feature}, {"left", {{"uid", 1}, {"kind", "choice"}}}, {"right", {{"uid", 2}, {"kind", "choice"}}}};
                require(query.view(partial, 2)["visited_nodes"] == 3, "Growing child could not be explored");
                for (const std::string mode : {"optimal", "random", "constrained"}) {
                    const json constraint = mode == "constrained" ? json{{"mode", "avoid"}, {"forbiddenInternalFeatures", json::array()}} : json::object();
                    auto result = query.complete(partial, 0, 3, mode, constraint, 4);
                    require(cost(model.result.get(), result["tree"]) <= model.result->budget, "Completion used unfinished children");
                    selected_trees.push_back(result["tree"]);
                }
                if (cancel_stage == 2) cancel = true;
            }
        }
        exposed.insert(offered.begin(), offered.end());
    };
    bool cancelled = false;
    try { fit(model); } catch (const LiveEnumerationCancelled&) { cancelled = true; }
    require(saw_null, "No split was attached before child construction");
    require(cancelled == (cancel_stage != 0), "Cancellation was not delivered during attachment");
    if (cancel_stage != 1) require(saw_growing, "No split became visible while descendants were still growing");
    // Includes null-free structure, unique features, and finite feasible minima.
    const auto signature = graph_signature(model.result.get());
    GraphQueries query(model, meta);
    const auto final_view = query.view(root(), 0);
    for (int feature : exposed) {
        bool found = false;
        for (const auto& s : final_view["options"]["splits"]) found |= s["feature"] == feature;
        require(found, "Cancellation discarded an exposed split");
    }
    for (const auto& tree : selected_trees) cost(model.result.get(), tree);
    if (!cancel_stage) {
        fit(baseline);
        require(signature == graph_signature(baseline.result.get()), "Live attachment changed the finished graph");
        require(model.result->count_trees() == baseline.result->count_trees(), "Live attachment changed tree counts");
    }
}
static void native_queries() {
    ArborEnum model; model.live_forbid_graph_export = true;
    std::vector<std::vector<double>> X;
    std::vector<int> y;
    for (int i = 0; i < 18; ++i) { X.push_back({double(i), double((i * 7) % 18)}); y.push_back((i / 3) % 2); }
    model.prepare_continuous_data(X, {}, y, {}, {});
    json meta = {{"root_n", 18}};
    int checked = 0;
    model.live_checkpoint = [&] {
        GraphQueries query(model, meta);
        auto result = query.view(root(), 0);
        require(result["visited_nodes"] == 1, "Node query traversed beyond displayed root");
        require(result["options"]["splits"].size() == model.result->splits.size(), "Missing native options");
        ++checked;
    };
    model.fit_prepared_anytime(.05, 2, .4, .5, .05, 1, true, false, 0, false, false, true, {}, {}, 1, -1, 1, true, true, false, 30, 10000);
    require(checked > 1, "No anytime refinement observed");
    bool blocked = false; try { model.export_andor_graph(); } catch (const std::logic_error&) { blocked = true; }
    require(blocked, "Live full graph export was not disabled");
    GraphQueries query(model, meta);
    for (const auto& forbidden : {std::set<int>{}, std::set<int>{0}}) for (int target : {-1, 0, 1}) {
        json truth = {{"0", true}, {"1", false}};
        auto candidates = enumerate(model.result.get(), forbidden, truth, target);
        json constraint = {{"mode", target < 0 ? "avoid" : "sample"}, {"forbiddenInternalFeatures", forbidden}, {"featureTruth", truth}, {"targetPrediction", target}};
        if (candidates.empty()) {
            bool rejected = false; try { query.complete(root(), 0, 1, "constrained", constraint, 0); } catch (const std::invalid_argument&) { rejected = true; }
            require(rejected, "Impossible constraint was accepted");
        } else {
            auto result = query.complete(root(), 0, 1, "constrained", constraint, 0);
            int best = std::numeric_limits<int>::max(); for (const auto& candidate : candidates) best = std::min(best, candidate.second);
            require(cost(model.result.get(), result.at("tree"), forbidden, truth, target) == best, "Native constrained optimum differs from exhaustive oracle");
        }
    }
    for (int seed = 0; seed < 15; ++seed) {
        auto result = query.complete(root(), 0, 1, "random", json::object(), seed);
        require(cost(model.result.get(), result.at("tree")) <= model.result->budget, "Invalid random completion");
    }
    const auto& split = model.result->splits.front();
    json partial = {{"uid", 0}, {"kind", "split"}, {"feature", split.feature}, {"left", {{"uid", 1}, {"kind", "choice"}}}, {"right", {{"uid", 2}, {"kind", "choice"}}}};
    auto view = query.view(partial, 1);
    require(view["visited_nodes"] == 3, "Path query walked undisplayed subgraphs");
    require(view["options"]["splits"].size() == split.left->splits.size(), "Path did not resolve native left node");
    auto scoped = query.complete(partial, 1, 3, "optimal", json::object(), 0);
    require(scoped["tree"]["right"] == partial["right"], "Completion changed the other subtree");
    require(scoped["tree"]["feature"] == split.feature, "Completion changed a selected split");
}
static Dataset dataset() {
    Dataset d; d.names = {"x", "z"}; d.classes = {"no", "yes"};
    for (int i = 0; i < 180; ++i) { d.X.push_back({double(i), double((i * 23) % 180)}); d.y.push_back((i / 17) % 2); }
    return d;
}
static void initial_root(bool split_only, int cancel_stage = 0) {
    ArborEnum model, baseline;
    std::vector<std::vector<uint8_t>> binary;
    std::vector<int> y;
    for (int i = 0; i < 16; ++i) {
        binary.push_back({uint8_t(i & 1), uint8_t((i >> 1) & 1), uint8_t((i >> 2) & 1), uint8_t((i >> 3) & 1)});
        y.push_back(split_only ? ((i & 1) ^ ((i >> 1) & 1)) : (i & 1));
    }
    for (auto* m : {&model, &baseline}) {
        m->prepare_continuous_data({}, binary, y, {}, {});
        m->set_trie_cache_enabled(true);
    }
    auto fit = [&](ArborEnum& m) {
        m.fit_prepared_anytime(.0625, 3, split_only ? 0. : 5., split_only ? 0. : 5., .1, 1,
            true, false, 0, false, false, true, {}, {}, 1);
    };
    const json meta = {{"root_n", y.size()}};
    bool checkpoint = false, saw_empty = false, saw_ready = false, cancel = false;
    std::vector<json> completions;
    model.live_checkpoint = [&] { checkpoint = true; };
    model.live_stop_requested = [&] { return cancel; };
    model.live_poll = [&] {
        if (!model.result || checkpoint) return;
        model.live_refresh_in_progress();
        GraphQueries query(model, meta);
        if (!model.live_root_has_solution()) {
            saw_empty = true;
            bool rejected = false;
            try { query.view(root(), 0); } catch (const std::runtime_error&) { rejected = true; }
            require(rejected, "An empty initial root was exposed");
            if (cancel_stage == 1) cancel = true;
            return;
        }
        if (saw_ready) return;
        saw_ready = true;
        require(model.result->leaves.empty() == split_only, "Initial readiness fixture has the wrong first completion");
        auto view = query.view(root(), 0);
        require(view["visited_nodes"] == 1 && view["root_minimum"].get<int>() <= view["root_budget"].get<int>(), "Initial root query was invalid");
        for (const std::string mode : {"optimal", "random", "constrained"}) {
            const json constraint = mode == "constrained" ? json{{"mode", "avoid"}, {"forbiddenInternalFeatures", json::array()}} : json::object();
            auto result = query.complete(root(), 0, 1, mode, constraint, 7);
            require(cost(model.result.get(), result["tree"]) <= model.result->budget, "Invalid completion during the initial solve");
            completions.push_back(result["tree"]);
        }
        if (cancel_stage == 2) cancel = true;
    };
    bool cancelled = false;
    try { fit(model); } catch (const LiveEnumerationCancelled&) { cancelled = true; }
    require(saw_empty, "Initial root was not bound before construction");
    require(cancelled == (cancel_stage != 0), "Initial-solve cancellation was not delivered");
    if (cancel_stage == 1) {
        require(!checkpoint && !model.live_root_has_solution(), "Cancellation before feasibility exposed an empty root");
        return;
    }
    require(saw_ready, "The first feasible root was hidden until the initial solve finished");
    require(model.live_root_has_solution(), "Initial-solve cancellation lost a feasible root");
    for (const auto& tree : completions) cost(model.result.get(), tree);
    if (cancel_stage == 2) require(!checkpoint, "Cancellation occurred after the initial solve");
    else {
        fit(baseline);
        require(graph_signature(model.result.get()) == graph_signature(baseline.result.get()), "Early root availability changed the completed graph");
    }
}
static void initial_actor_queries() {
    Dataset data; data.classes = {"no", "yes"};
    // A full 9-bit cube collapses into a tiny cached DAG and can finish before
    // a fast machine's 1ms observer wakes. Random masks avoid that symmetry.
    std::mt19937 rng(812);
    for (int f = 0; f < 20; ++f) data.names.push_back("bit" + std::to_string(f));
    for (int i = 0; i < 1024; ++i) {
        const auto mask = static_cast<unsigned>(rng()) & ((1u << 20) - 1);
        std::vector<double> row;
        for (int f = 0; f < 20; ++f) row.push_back((mask >> f) & 1);
        data.X.push_back(std::move(row)); data.y.push_back(std::popcount(mask) % 2);
    }
    Settings settings; settings.depth = 8; settings.lambda = .002; settings.multiplier = 2.; settings.second_multiplier = 2.; settings.runtime = 1;
    Session session("initial", std::move(data), settings);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    json status;
    do {
        status = session.status();
        require(std::chrono::steady_clock::now() < deadline && status["phase"] != "failed", status.dump());
        if (!status["ready"].get<bool>()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    } while (!status["ready"].get<bool>());
    require(status["checkpoint"] == 0 && status["phase"] == "running", "Actor readiness waited for the initial solve");
    auto view = session.query("node", {{"tree", root()}, {"active_uid", 0}});
    require(view["checkpoint"] == 0 && view["visited_nodes"] == 1, "Actor could not query the initial solve");
    session.stop();
    while (!session.done()) {
        require(std::chrono::steady_clock::now() < deadline, "Initial actor did not stop");
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    status = session.status();
    require(status["checkpoint"] == 0 && status["ready"] == true && status["phase"] == "stopped", "Stopping the initial solve lost its usable root");
    auto result = session.query("complete", {{"tree", root()}, {"active_uid", 0}, {"next_uid", 1}, {"mode", "optimal"}});
    require(result.contains("tree") && status["full_graph_exports"] == 0, "Initial cancellation lost native completion");
}
static void actor_queries() {
    Settings settings; settings.depth = 4; settings.lambda = .01; settings.multiplier = .2; settings.runtime = 5;
    Session session("actor", dataset(), settings);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (!session.status()["ready"].get<bool>()) {
        require(std::chrono::steady_clock::now() < deadline && session.status()["phase"] != "failed", session.status().dump());
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    std::vector<std::future<void>> readers;
    for (int t = 0; t < 4; ++t) readers.push_back(std::async(std::launch::async, [&] {
        for (int i = 0; i < 12; ++i) {
            auto reply = session.query("node", {{"tree", root()}, {"active_uid", 0}});
            require(reply["visited_nodes"] == 1 && reply["session_id"] == "actor", "Actor returned an invalid local view");
            require(!reply.contains("graph"), "Actor materialized a graph");
        }
    }));
    for (auto& reader : readers) reader.get();
    session.stop();
    while (!session.done()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    auto result = session.query("complete", {{"tree", root()}, {"active_uid", 0}, {"next_uid", 1}, {"mode", "optimal"}});
    require(result.contains("tree") && !result.contains("graph"), "Stopped session lost its native model");
    require(session.status()["full_graph_exports"] == 0 && session.status()["node_queries"] == 48, "Unexpected graph export or lost requests");
    session.shutdown();
    const auto closed_at = std::chrono::steady_clock::now();
    bool rejected = false;
    try { session.query("node", {{"tree", root()}, {"active_uid", 0}}); }
    catch (const QueryUnavailable&) { rejected = true; }
    require(rejected && std::chrono::steady_clock::now() - closed_at < std::chrono::seconds(1), "Closed session queued a query with no owner to answer it");
}
int main() {
    try {
        initial_root(false); initial_root(true);
        initial_root(true, 1); initial_root(false, 2); initial_root(true, 2);
        initial_actor_queries();
        incremental_attachment(false); incremental_attachment(true);
        incremental_attachment(true, 1); incremental_attachment(true, 2);
        native_queries(); actor_queries();
        std::cout << "Incremental attachment, mid-solve queries/completions, cancellation, offline graph equivalence, native paths, exhaustive optima, concurrent actor requests, stop retention and zero exports passed\n";
        return 0;
    }
    catch (const std::exception& e) { std::cerr << e.what() << "\n"; return 1; }
}
