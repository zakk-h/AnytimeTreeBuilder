#pragma once
#include "live_types.hpp"
#include <functional>

namespace arborenum::live {
// This object borrows the actual model on its owner thread. It does not own,
// export, clone, or accumulate a second Rashomon graph.
class GraphQueries {
    ArborEnum& model_;
    const json& meta_;
    std::function<bool()> cancelled_;
    size_t visited_ = 0;
    static constexpr int INF = std::numeric_limits<int>::max();
    struct Located {
        TreeTrieNode* node;
        Packed mask;
        json* build;
        bool scope = false, sample = false;
    };
    std::vector<Located> located_;
    std::set<int> uids_;
    int active_ = 0;
    const SplitNode& split(TreeTrieNode* node, int feature) {
        auto found = std::find_if(node->splits.begin(), node->splits.end(), [&](const auto& s) { return s.feature == feature && TreeTrieNode::split_has_solution(s, node->budget); });
        if (found == node->splits.end()) throw std::invalid_argument("Selected split is not present at this path");
        return *found;
    }
    const LeafNode& leaf(TreeTrieNode* node, int prediction) {
        auto found = std::find_if(node->leaves.begin(), node->leaves.end(), [&](const auto& l) { return l.prediction == prediction; });
        if (found == node->leaves.end()) throw std::invalid_argument("Selected leaf is not present at this path");
        return *found;
    }
    void check() {
        if (cancelled_ && cancelled_()) throw std::runtime_error("Native query cancelled or timed out");
    }
    void locate(TreeTrieNode* node, Packed mask, json& build, int depth, bool in_scope,
                bool sample, const json& constraint) {
        check(); ++visited_;
        if (!node || depth > meta_.value("depth_budget", 127) || located_.size() >= 100000) throw std::invalid_argument("Invalid displayed tree");
        int uid = build.at("uid").get<int>();
        if (uid < 0 || !uids_.insert(uid).second) throw std::invalid_argument("Duplicate or invalid displayed node UID");
        if (uid == active_) { in_scope = true; sample = constraint.value("mode", "") == "sample"; }
        located_.push_back({node, mask, &build, in_scope, sample});
        const std::string kind = build.at("kind");
        if (kind == "leaf") { leaf(node, build.at("prediction")); return; }
        if (kind == "choice") return;
        if (kind != "split") throw std::invalid_argument("Invalid displayed node kind");
        const int feature = build.at("feature");
        const auto& s = split(node, feature);
        auto masks = model_.live_child_masks(mask, feature);
        bool left_sample = sample, right_sample = sample;
        const auto truth = constraint.value("featureTruth", json::object());
        if (sample && truth.contains(std::to_string(feature))) {
            const bool branch = truth.at(std::to_string(feature)).get<bool>();
            left_sample = branch; right_sample = !branch;
        }
        locate(s.left.get(), std::move(masks.first), build.at("left"), depth + 1, in_scope, left_sample, constraint);
        locate(s.right.get(), std::move(masks.second), build.at("right"), depth + 1, in_scope, right_sample, constraint);
    }
    void prepare(json& tree, int active, const json& constraint = json::object()) {
        model_.live_refresh_in_progress();
        if (!model_.live_root_has_solution()) throw std::runtime_error("The native root does not have a feasible completion yet");
        visited_ = 0; located_.clear(); uids_.clear(); active_ = active;
        locate(model_.result.get(), model_.live_root_mask(), tree, 0, false, false, constraint);
        if (!uids_.count(active)) throw std::invalid_argument("Active displayed node is missing");
    }
    struct Best {
        int objective = INF;
        const LeafNode* leaf = nullptr;
        const SplitNode* split = nullptr;
        bool left_sample = false, right_sample = false;
    };
    struct Planner {
        GraphQueries& owner;
        std::set<int> forbidden;
        std::unordered_map<int, bool> truth;
        std::array<std::unordered_map<TreeTrieNode*, Best>, 2> memo;
        int target = -1;
        explicit Planner(GraphQueries& o, const json& c) : owner(o) {
            if (c.contains("featureTruth")) for (const auto& [key, value] : c.at("featureTruth").items()) {
                size_t consumed = 0;
                const int feature = std::stoi(key, &consumed);
                if (feature < 0 || consumed != key.size() || std::to_string(feature) != key) throw std::invalid_argument("Invalid featureTruth key");
                truth.emplace(feature, value.get<bool>());
            }
            if (c.contains("forbiddenInternalFeatures")) for (const auto& f : c.at("forbiddenInternalFeatures")) forbidden.insert(f.get<int>());
            if (c.value("mode", "") == "sample") target = c.at("targetPrediction").get<int>();
        }
        const Best& best(TreeTrieNode* node, bool sample) {
            auto& cache = memo[sample ? 1 : 0];
            if (auto found = cache.find(node); found != cache.end()) return found->second;
            owner.check(); ++owner.visited_;
            Best result;
            for (const auto& l : node->leaves) if ((!sample || l.prediction == target) && l.loss < result.objective && l.loss <= node->budget) result = {l.loss, &l};
            for (const auto& s : node->splits) {
                if (!s.left || !s.right || forbidden.count(s.feature)) continue;
                bool left = sample, right = sample;
                if (auto branch = truth.find(s.feature); sample && branch != truth.end()) {
                    left = branch->second; right = !branch->second;
                }
                const int lo = best(s.left.get(), left).objective, ro = best(s.right.get(), right).objective;
                if (lo < INF && ro < INF && static_cast<int64_t>(lo) + ro < result.objective && static_cast<int64_t>(lo) + ro <= node->budget)
                    result = {lo + ro, nullptr, &s, left, right};
            }
            return cache.emplace(node, result).first->second;
        }
        json optimal(TreeTrieNode* node, bool sample, int& uid) {
            const auto& b = best(node, sample);
            if (b.objective == INF) throw std::invalid_argument("No native completion satisfies these constraints");
            const int current = uid++;
            if (b.leaf) return {{"uid", current}, {"kind", "leaf"}, {"prediction", b.leaf->prediction}};
            auto left = optimal(b.split->left.get(), b.left_sample, uid);
            auto right = optimal(b.split->right.get(), b.right_sample, uid);
            return {{"uid", current}, {"kind", "split"}, {"feature", b.split->feature}, {"left", std::move(left)}, {"right", std::move(right)}};
        }
        std::pair<json, int> random(TreeTrieNode* node, int budget, int& uid, std::mt19937_64& rng) {
            owner.check();
            budget = std::min(budget, node->budget);
            std::vector<Best> choices;
            for (const auto& l : node->leaves) if (l.loss <= budget) choices.push_back({l.loss, &l});
            for (const auto& s : node->splits) if (s.left && s.right) {
                const int lo = best(s.left.get(), false).objective, ro = best(s.right.get(), false).objective;
                if (lo < INF && ro < INF && static_cast<int64_t>(lo) + ro <= budget) choices.push_back({lo + ro, nullptr, &s});
            }
            if (choices.empty()) throw std::invalid_argument("No native completion fits the remaining objective budget");
            const auto chosen = choices[std::uniform_int_distribution<size_t>(0, choices.size() - 1)(rng)];
            const int current = uid++;
            if (chosen.leaf) return {json{{"uid", current}, {"kind", "leaf"}, {"prediction", chosen.leaf->prediction}}, chosen.objective};
            auto left = random(chosen.split->left.get(), budget - best(chosen.split->right.get(), false).objective, uid, rng);
            auto right = random(chosen.split->right.get(), budget - left.second, uid, rng);
            return {json{{"uid", current}, {"kind", "split"}, {"feature", chosen.split->feature}, {"left", std::move(left.first)}, {"right", std::move(right.first)}}, left.second + right.second};
        }
    };
    // Pareto states retain only nondominated (objective, abstained samples)
    // pairs. A single lexicographic best per node is insufficient: siblings
    // must share a finite objective budget.
    struct AbstentionPlanner : Planner {
        struct Plan {
            int objective, abstained;
            const LeafNode* leaf = nullptr;
            const SplitNode* split = nullptr;
            std::shared_ptr<const Plan> left, right;
        };
        using Ptr = std::shared_ptr<const Plan>;
        using Frontier = std::vector<Ptr>;
        std::array<std::unordered_map<TreeTrieNode*, Frontier>, 2> pareto;
        using Planner::Planner;
        Frontier prune(Frontier points) {
            std::sort(points.begin(), points.end(), [](const Ptr& a, const Ptr& b) {
                return a->objective != b->objective ? a->objective < b->objective : a->abstained < b->abstained;
            });
            Frontier out;
            int least = INF;
            for (const auto& p : points) {
                owner.check();
                if (p->abstained < least) { out.push_back(p); least = p->abstained; }
            }
            return out;
        }
        Frontier combine(const Frontier& left, const Frontier& right, const SplitNode* split, int budget) {
            std::map<int, Ptr> points;
            for (const auto& l : left) for (const auto& r : right) {
                owner.check();
                const int64_t objective = int64_t(l->objective) + r->objective;
                if (objective > budget) break; // Frontiers are sorted by objective.
                const int abstained = l->abstained + r->abstained;
                auto next = points.lower_bound(int(objective));
                if (next != points.end() && next->first == objective && next->second->abstained <= abstained) continue;
                if (next != points.begin() && std::prev(next)->second->abstained <= abstained) continue;
                while (next != points.end() && next->second->abstained >= abstained) next = points.erase(next);
                points.emplace_hint(next, int(objective), std::make_shared<Plan>(Plan{int(objective), abstained, nullptr, split, l, r}));
            }
            Frontier out;
            for (auto& [objective, plan] : points) out.push_back(std::move(plan));
            return out;
        }
        const Frontier& alternatives(TreeTrieNode* node, const Packed& mask, bool sample) {
            auto& cache = pareto[sample ? 1 : 0];
            if (auto found = cache.find(node); found != cache.end()) return found->second;
            owner.check(); ++owner.visited_;
            Frontier out;
            for (const auto& l : node->leaves)
                if ((!sample || l.prediction == target) && l.loss <= node->budget)
                    out.push_back(std::make_shared<Plan>(Plan{l.loss, l.prediction == -1 ? int(mask.count()) : 0, &l, nullptr, {}, {}}));
            out = prune(std::move(out));
            for (const auto& s : node->splits) {
                owner.check();
                if (!s.left || !s.right || forbidden.count(s.feature)) continue;
                bool left = sample, right = sample;
                if (auto branch = truth.find(s.feature); sample && branch != truth.end()) {
                    left = branch->second; right = !branch->second;
                }
                auto masks = owner.model_.live_child_masks(mask, s.feature);
                const auto& ls = alternatives(s.left.get(), masks.first, left);
                const auto& rs = alternatives(s.right.get(), masks.second, right);
                auto joined = combine(ls, rs, &s, node->budget);
                out.insert(out.end(), joined.begin(), joined.end());
                out = prune(std::move(out));
            }
            return cache.emplace(node, std::move(out)).first->second;
        }
        Frontier partial(const Located& item, const std::unordered_map<int, const Located*>& by_uid, size_t& choices) {
            owner.check();
            const auto& build = *item.build;
            const std::string kind = build.at("kind");
            if (kind == "choice") {
                if (item.scope) { ++choices; return alternatives(item.node, item.mask, item.sample); }
                return {std::make_shared<Plan>(Plan{item.node->min_objective, 0, nullptr, nullptr, {}, {}})};
            }
            if (kind == "leaf") {
                const auto& l = owner.leaf(item.node, build.at("prediction"));
                if (item.scope && item.sample && l.prediction != target) throw std::invalid_argument("An existing leaf conflicts with the required prediction");
                return {std::make_shared<Plan>(Plan{l.loss, l.prediction == -1 ? int(item.mask.count()) : 0, &l, nullptr, {}, {}})};
            }
            const int feature = build.at("feature");
            if (item.scope && forbidden.count(feature)) throw std::invalid_argument("A forbidden feature is already selected in this subtree");
            const auto left = partial(*by_uid.at(build.at("left").at("uid").get<int>()), by_uid, choices);
            const auto right = partial(*by_uid.at(build.at("right").at("uid").get<int>()), by_uid, choices);
            return combine(left, right, &owner.split(item.node, feature), item.node->budget);
        }
        json materialize(const Ptr& plan, int& uid) {
            owner.check();
            const int current = uid++;
            if (plan->leaf) return {{"uid", current}, {"kind", "leaf"}, {"prediction", plan->leaf->prediction}};
            auto left = materialize(plan->left, uid);
            auto right = materialize(plan->right, uid);
            return {{"uid", current}, {"kind", "split"}, {"feature", plan->split->feature}, {"left", std::move(left)}, {"right", std::move(right)}};
        }
        void fill(json& build, const Ptr& plan, const std::unordered_map<int, const Located*>& by_uid, int& uid) {
            owner.check();
            const int old_uid = build.at("uid");
            if (build.at("kind") == "choice") {
                if (by_uid.at(old_uid)->scope) { build = materialize(plan, uid); build["uid"] = old_uid; }
            } else if (build.at("kind") == "split") {
                fill(build.at("left"), plan->left, by_uid, uid);
                fill(build.at("right"), plan->right, by_uid, uid);
            }
        }
    };
public:
    GraphQueries(ArborEnum& model, const json& meta, std::function<bool()> cancelled = {}) : model_(model), meta_(meta), cancelled_(std::move(cancelled)) {}
    size_t visited() const { return visited_; }
    json view(json tree, int active) {
        prepare(tree, active);
        json summaries = json::array(), leaves = json::array(), splits = json::array();
        Located* selected = nullptr;
        for (auto& item : located_) {
            json summary = {{"uid", item.build->at("uid")}, {"minimum", item.node->min_objective}, {"sample_size", item.mask.count()}};
            if (item.build->at("kind") == "leaf") summary["loss"] = leaf(item.node, item.build->at("prediction")).loss;
            summaries.push_back(std::move(summary));
            if (item.build->at("uid") == active) selected = &item;
        }
        if (selected && selected->build->at("kind") == "choice") {
            for (const auto& l : selected->node->leaves) leaves.push_back({{"prediction", l.prediction}, {"loss", l.loss}});
            for (const auto& s : selected->node->splits) if (TreeTrieNode::split_has_solution(s, selected->node->budget)) {
                const auto masks = model_.live_child_masks(selected->mask, s.feature);
                splits.push_back({{"feature", s.feature}, {"minimum", static_cast<int64_t>(s.left->min_objective) + s.right->min_objective}, {"left_minimum", s.left->min_objective}, {"right_minimum", s.right->min_objective}, {"left_size", masks.first.count()}, {"right_size", masks.second.count()}});
            }
        }
        return {{"root_budget", model_.result->budget}, {"root_minimum", model_.result->min_objective}, {"root_size", meta_.at("root_n")}, {"summaries", std::move(summaries)}, {"options", {{"uid", active}, {"leaves", std::move(leaves)}, {"splits", std::move(splits)}}}, {"visited_nodes", visited_}};
    }
    json complete(json tree, int active, int next_uid, const std::string& mode, const json& constraint, uint64_t seed) {
        if (mode != "optimal" && mode != "random" && mode != "constrained") throw std::invalid_argument("Invalid completion mode");
        if (mode != "constrained" && !constraint.empty()) throw std::invalid_argument("Constraints require constrained completion mode");
        if (mode == "constrained" && constraint.value("mode", "") != "avoid" && constraint.value("mode", "") != "sample") throw std::invalid_argument("Invalid native completion constraint");
        prepare(tree, active, constraint);
        if (next_uid <= *uids_.rbegin()) throw std::invalid_argument("next_uid overlaps existing displayed UIDs");
        if (constraint.value("minimizeAbstention", false)) {
            AbstentionPlanner planner(*this, constraint);
            std::unordered_map<int, const Located*> by_uid;
            for (const auto& item : located_) by_uid.emplace(item.build->at("uid").get<int>(), &item);
            size_t choices = 0;
            const auto candidates = planner.partial(located_.front(), by_uid, choices);
            if (!choices) throw std::invalid_argument("The selected subtree has no unfinished choices");
            if (candidates.empty()) throw std::invalid_argument("No completion satisfies these constraints and the Rashomon budget");
            // Pruned frontiers have ascending cost and strictly decreasing
            // abstention, so the final point minimizes abstention, then cost.
            const auto& best = candidates.back();
            planner.fill(tree, best, by_uid, next_uid);
            return {{"tree", std::move(tree)}, {"active_uid", active}, {"next_uid", next_uid}, {"visited_nodes", visited_},
                {"abstained_samples", best->abstained}, {"objective", best->objective}};
        }
        Planner planner(*this, constraint);
        int64_t total = 0;
        std::vector<Located*> frontier;
        for (auto& item : located_) {
            const std::string kind = item.build->at("kind");
            if (item.scope && kind == "split" && planner.forbidden.count(item.build->at("feature").get<int>())) throw std::invalid_argument("A forbidden feature is already selected in this subtree");
            if (kind == "leaf") {
                const auto& l = leaf(item.node, item.build->at("prediction"));
                if (item.scope && item.sample && l.prediction != planner.target) throw std::invalid_argument("An existing leaf conflicts with the required prediction");
                total += l.loss;
            } else if (kind == "choice") {
                if (item.scope) { total += planner.best(item.node, item.sample).objective; frontier.push_back(&item); }
                else total += item.node->min_objective;
            }
        }
        if (frontier.empty()) throw std::invalid_argument("The selected subtree has no unfinished choices");
        if (total > model_.result->budget) throw std::invalid_argument("No completion satisfies the Rashomon budget");
        std::mt19937_64 rng(seed);
        for (auto* item : frontier) {
            const int best = planner.best(item->node, item->sample).objective;
            const int old_uid = item->build->at("uid");
            json filled;
            if (mode == "random") {
                auto result = planner.random(item->node, model_.result->budget - static_cast<int>(total - best), next_uid, rng);
                total += result.second - best;
                filled = std::move(result.first);
            } else filled = planner.optimal(item->node, item->sample, next_uid);
            filled["uid"] = old_uid;
            *item->build = std::move(filled);
        }
        return {{"tree", std::move(tree)}, {"active_uid", active}, {"next_uid", next_uid}, {"visited_nodes", visited_}};
    }
};
}
