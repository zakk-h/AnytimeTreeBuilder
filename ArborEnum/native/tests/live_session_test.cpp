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
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    const auto retained = session.status();
    require(retained["elapsed_seconds"] == status["elapsed_seconds"], "Stopped enumeration timer continued advancing");
    require(retained["checkpoint"] == status["checkpoint"] && retained["phase"] == "stopped", "Stopped enumeration continued building");
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
    const auto terminal = session.status();
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    require(session.status()["elapsed_seconds"] == terminal["elapsed_seconds"], "Completed enumeration timer continued advancing");
    session.shutdown();
    const auto closed_at = std::chrono::steady_clock::now();
    bool rejected = false;
    try { session.query("node", {{"tree", root()}, {"active_uid", 0}}); }
    catch (const QueryUnavailable&) { rejected = true; }
    require(rejected && std::chrono::steady_clock::now() - closed_at < std::chrono::seconds(1), "Closed session queued a query with no owner to answer it");
}
static int abstained(ArborEnum& model, const json& tree, const Packed& mask) {
    if (tree.at("kind") == "leaf") return tree.at("prediction") == -1 ? int(mask.count()) : 0;
    auto children = model.live_child_masks(mask, tree.at("feature"));
    return abstained(model, tree.at("left"), children.first) + abstained(model, tree.at("right"), children.second);
}
static void minimum_abstention() {
    ArborEnum model;
    std::vector<std::vector<uint8_t>> X;
    for (int i = 0; i < 8; ++i) X.push_back({uint8_t(i < 6)});
    model.prepare_continuous_data(std::vector<std::vector<double>>(8), X, std::vector<int>(8, 0),
        std::vector<std::vector<uint8_t>>(8), std::vector<std::vector<uint8_t>>(8), -1);
    model.fit_prepared_anytime(.125, 1, 0., 0., .1, 1, true, false, 0, false, false, true, {}, {}, 1);
    auto left = std::make_shared<TreeTrieNode>(), right = std::make_shared<TreeTrieNode>();
    left->budget = 8; right->budget = 8;
    left->add_leaf(-1, 1); left->add_leaf(0, 6);
    right->add_leaf(-1, 1); right->add_leaf(0, 8);
    model.result = std::make_shared<TreeTrieNode>();
    model.result->min_objective = 2;
    model.result->splits.push_back(SplitNode{0, left, right});
    const json meta = {{"root_n", 8}};
    const json constraint = {{"mode", "avoid"}, {"minimizeAbstention", true}};
    auto complete = [&](json tree, int active, const json& c) {
        GraphQueries query(model, meta);
        return query.complete(std::move(tree), active, 3, "constrained", c, 0);
    };
    // Independent exhaustive comparison across budgets, including the case in
    // which each sibling can avoid abstention but both cannot afford to do so.
    for (int budget = 2; budget <= 16; ++budget) {
        model.result->budget = budget;
        std::pair<int, int> expected{INT_MAX, INT_MAX};
        for (const auto& [tree, objective] : enumerate(model.result.get(), {}, json::object(), -1))
            expected = std::min(expected, std::pair{abstained(model, tree, model.live_root_mask()), objective});
        const auto result = complete(root(), 0, constraint);
        const auto& tree = result.at("tree");
        require(std::pair{abstained(model, tree, model.live_root_mask()), cost(model.result.get(), tree)} == expected,
            "Minimum abstention disagreed with exhaustive trees or objective tie-break");
        require(result["abstained_samples"] == expected.first && result["objective"] == expected.second, "Minimum-abstention result metrics were wrong");
    }
    model.result->budget = 12;
    auto result = complete(root(), 0, constraint);
    require(result["abstained_samples"] == 2 && result["objective"] == 7, "Planner minimized leaves instead of samples or lost sibling budget tradeoffs");
    const json partial = {{"uid", 0}, {"kind", "split"}, {"feature", 0},
        {"left", {{"uid", 1}, {"kind", "leaf"}, {"prediction", -1}}}, {"right", {{"uid", 2}, {"kind", "choice"}}}};
    result = complete(partial, 0, constraint);
    require(result["tree"]["left"] == partial["left"] && result["tree"]["right"]["prediction"] == 0 && result["abstained_samples"] == 6,
        "Minimum abstention changed an existing leaf or missed the best remaining completion");
    auto scoped = partial; scoped["left"] = {{"uid", 1}, {"kind", "choice"}};
    result = complete(scoped, 1, constraint);
    require(result["tree"]["left"]["prediction"] == 0 && result["tree"]["right"] == scoped["right"], "Minimum abstention changed choices outside the selected subtree");
    auto sample = constraint; sample["mode"] = "sample"; sample["targetPrediction"] = -1; sample["featureTruth"] = {{"0", true}};
    result = complete(root(), 0, sample);
    require(result["tree"]["left"]["prediction"] == -1 && result["tree"]["right"]["prediction"] == 0, "Minimum abstention violated a required prediction");
    bool rejected = false;
    auto forbidden = constraint; forbidden["forbiddenInternalFeatures"] = {0};
    try { complete(root(), 0, forbidden); } catch (const std::invalid_argument&) { rejected = true; }
    require(rejected, "Minimum abstention ignored a forbidden feature");
    left->budget = 5;
    result = complete(scoped, 0, constraint);
    require(result["abstained_samples"] == 6, "Minimum abstention exceeded an internal node budget");
    bool cancelled = false;
    try { GraphQueries q(model, meta, [] { return true; }); q.complete(root(), 0, 3, "constrained", constraint, 0); }
    catch (const std::runtime_error&) { cancelled = true; }
    require(cancelled, "Minimum abstention ignored query cancellation");
}

static void training_options() {
    for (const auto& bad : std::vector<json>{
        {{"allow_abstain", 1}}, {{"abstain_cost", -1}}, {{"proxy_style", 2}}, {{"max_number_thresholds_per_feature", 0}},
        {{"lookahead_k", 2.5}}, {{"depth_budget", 128}}, {{"refinement_width", 4294967297LL}}, {{"trie_cache", "false"}},
        {{"proxy_threshold_features", {0, 0}}}, {{"continuous_proxy_in_greedy", 1}}}) {
        bool rejected = false;
        try { Settings::parse(bad); } catch (const std::exception&) { rejected = true; }
        require(rejected, "Invalid training settings were accepted: " + bad.dump());
    }
    require(Settings::parse({{"depth_budget", 0}}).lookahead == 0, "Depth-zero default lookahead was invalid");
    bool overflow = false;
    try { Settings::checked(Settings::parse({{"allow_abstain", true}, {"abstain_cost", 1e20}}), 20); }
    catch (const std::exception&) { overflow = true; }
    require(overflow, "Abstention loss overflow was accepted");
    for (double eta : {0., .25, 1.}) {
        Dataset data; data.names = {"constant"}; data.classes = {"no", "yes"};
        for (int i = 0; i < 20; ++i) { data.X.push_back({0}); data.y.push_back(i % 2); }
        auto settings = Settings::parse({{"allow_abstain", true}, {"abstain_cost", eta}, {"lambda_reg", .05},
            {"depth_budget", 0}, {"key_mode", "hash128"}, {"trie_cache", false}, {"runtime_limit_seconds", -1}, {"memory_limit_mb", -1}});
        require(Settings::parse(settings.as_json()).as_json() == settings.as_json(), "Training settings did not round-trip");
        Session session("abstain", std::move(data), settings);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!session.done()) { require(std::chrono::steady_clock::now() < deadline, "Abstention fit timed out"); std::this_thread::sleep_for(std::chrono::milliseconds(1)); }
        require(session.status()["phase"] == "finished", session.status().dump());
        require(session.metadata()["abstain_uses_labels"] == true && session.metadata()["eta_defer"] == eta, "Abstention metadata missing");
        auto view = session.query("node", {{"tree", root()}, {"active_uid", 0}});
        bool found = false;
        for (const auto& leaf : view["options"]["leaves"]) if (leaf["prediction"] == -1) {
            found = true; require(leaf["loss"] == 1 + int(std::llround(eta * 20)), "Abstention loss included classification mistakes or omitted its penalty");
        }
        require(found == (eta < .5), "Abstention feasibility ignored its cost");
        auto best = session.query("complete", {{"tree", root()}, {"active_uid", 0}, {"next_uid", 1}, {"mode", "optimal"}});
        require((best["tree"]["prediction"] == -1) == (eta < .5), "Optimal completion did not respect abstention cost");
        if (found) {
            auto constrained = session.query("complete", {{"tree", root()}, {"active_uid", 0}, {"next_uid", 1}, {"mode", "constrained"}, {"constraint", {{"mode", "sample"}, {"targetPrediction", -1}}}});
            require(constrained["tree"]["prediction"] == -1, "Constrained completion could not select Abstain");
        }
        require(session.status()["full_graph_exports"] == 0, "Abstention exported the graph");
    }
    // Exercise alternative search/cache modes on a real nontrivial native fit.
    auto advanced = Settings::parse({{"depth_budget", 3}, {"lookahead_k", 2}, {"proxy_mode", "continuous"},
        {"proxy_refinement", "off"}, {"proxy_style", 3}, {"key_mode", "lits_exact"}, {"max_refinement_rounds", 0},
        {"max_number_thresholds_per_feature", 2}, {"rule_list_mode", true}, {"use_multipass", false},
        {"majority_leaf_only", true}, {"cache_cheap_subproblems", true}, {"stronger_rollout", true},
        {"greedy_split_mode", 2}, {"greedy_continuous_mode", "numerical"}, {"evaluated_use_min_objectives", true},
        {"additive", true}, {"multiplicative_slack", .1}, {"proxy_threshold_features", {0}}, {"initial_active_threshold_features", {0}},
        {"continuous_proxy_in_greedy", false}, {"continuous_proxy_in_lickety", false}, {"continuous_proxy_in_depthd_exact", true}});
    Session session("advanced", dataset(), advanced);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!session.done()) { require(std::chrono::steady_clock::now() < deadline, "Advanced fit timed out"); std::this_thread::sleep_for(std::chrono::milliseconds(1)); }
    require(session.status()["phase"] == "finished" && session.status()["ready"] == true, session.status().dump());
    require(session.metadata()["training_settings"] == advanced.as_json(), "Native training configuration was not retained");
}
int main() {
    try {
        initial_root(false); initial_root(true);
        initial_root(true, 1); initial_root(false, 2); initial_root(true, 2);
        initial_actor_queries();
        incremental_attachment(false); incremental_attachment(true);
        incremental_attachment(true, 1); incremental_attachment(true, 2);
        native_queries(); actor_queries(); training_options(); minimum_abstention();
        std::cout << "Incremental attachment, mid-solve queries/completions, cancellation, offline graph equivalence, native paths, exhaustive optima, concurrent actor requests, stop retention and zero exports passed\n";
        return 0;
    }
    catch (const std::exception& e) { std::cerr << e.what() << "\n"; return 1; }
}
