#pragma once
#include "live_types.hpp"
#include "exact_count.hpp"
#include <bit>
#include <functional>
#include <tuple>
#include <optional>
#include <compare>

namespace arborenum::live {
// Query-local sufficient-statistic tables over borrowed native nodes. These
// contain no copied trie nodes, split lists, or materialized completed trees.
class GraphProfiles {
    ArborEnum& model_;
    const json& meta_;
    const Dataset* data_;
    const json& partial_;
    std::function<void()> check_;
    bool statistics_;
    int max_leaves_ = INT_MAX, max_abstained_ = INT_MAX, target_ = -1;
    double eta_;
    std::set<int> forbidden_;
    std::map<int, bool> truth_;
    struct State {
        int objective = 0, leaves = 0, abstained = 0, mistakes = 0;
        auto operator<=>(const State&) const = default;
    };
    struct Key {
        TreeTrieNode* node;
        const json* fixed;
        bool sample;
        bool operator<(const Key& b) const {
            return std::tuple{reinterpret_cast<uintptr_t>(node), reinterpret_cast<uintptr_t>(fixed), sample} <
                   std::tuple{reinterpret_cast<uintptr_t>(b.node), reinterpret_cast<uintptr_t>(b.fixed), b.sample};
        }
    };
    struct Plan {
        const LeafNode* leaf = nullptr;
        const SplitNode* split = nullptr;
        std::shared_ptr<const Plan> left, right;
    };
    struct Cell { ExactCount count; std::shared_ptr<const Plan> plan; };
    using Table = std::map<State, Cell>;
    std::map<Key, Table> inside_;
    std::map<Key, Packed> masks_;
    std::vector<Key> order_;
    Key root_;
    mutable std::map<std::vector<uint64_t>, std::vector<size_t>> label_histograms_;
    static bool member(const Packed& mask, size_t i) { return (mask.w[i >> 6] >> (i & 63)) & 1; }
    template<class Fn> void rows(const Packed& mask, Fn fn) const {
        for (size_t w = 0; w < mask.w.size(); ++w) {
            check_();
            auto word = mask.w[w];
            while (word) { const auto bit = std::countr_zero(word); fn(w * 64 + bit); word &= word - 1; }
        }
    }
    Key key(TreeTrieNode* node, const json* fixed, bool sample) const {
        if (fixed && fixed->at("kind") == "choice") fixed = nullptr;
        return {node, fixed, sample};
    }
    bool allowed(const State& s, int budget) const {
        return s.objective <= budget && s.leaves <= max_leaves_ && s.abstained <= max_abstained_;
    }
    std::optional<State> sum(const State& a, const State& b, int budget) const {
        if (int64_t(a.objective) + b.objective > budget || int64_t(a.leaves) + b.leaves > max_leaves_ || int64_t(a.abstained) + b.abstained > max_abstained_) return {};
        return State{a.objective + b.objective, a.leaves + b.leaves, a.abstained + b.abstained, a.mistakes + b.mistakes};
    }
    template<class LeafFn, class SplitFn> void alternatives(const Key& k, LeafFn leaf_fn, SplitFn split_fn) const {
        check_();
        const std::string kind = k.fixed ? k.fixed->at("kind").get<std::string>() : "choice";
        if (kind != "split") for (const auto& leaf : k.node->leaves) {
            if (kind == "leaf" && leaf.prediction != k.fixed->at("prediction").get<int>()) continue;
            if (k.sample && leaf.prediction != target_) continue;
            if (leaf.loss <= k.node->budget) leaf_fn(leaf);
        }
        if (kind == "leaf") return;
        for (const auto& split : k.node->splits) {
            check_();
            if (!split.left || !split.right || forbidden_.count(split.feature)) continue;
            if (kind == "split" && split.feature != k.fixed->at("feature").get<int>()) continue;
            bool ls = k.sample, rs = k.sample;
            if (auto found = truth_.find(split.feature); k.sample && found != truth_.end()) { ls = found->second; rs = !found->second; }
            split_fn(split, key(split.left.get(), k.fixed ? &k.fixed->at("left") : nullptr, ls),
                            key(split.right.get(), k.fixed ? &k.fixed->at("right") : nullptr, rs));
        }
    }
    const std::vector<size_t>& label_histogram(const Packed& mask) const {
        if (auto found = label_histograms_.find(mask.w); found != label_histograms_.end()) return found->second;
        std::vector<size_t> counts(data_->classes.size(), 0);
        rows(mask, [&](size_t i) { ++counts.at(data_->y.at(i)); });
        return label_histograms_.emplace(mask.w, std::move(counts)).first->second;
    }
    State leaf_state(const LeafNode& leaf, const Packed& mask) const {
        State s{leaf.loss, 1, leaf.prediction == -1 ? int(mask.count()) : 0, 0};
        if (statistics_ && leaf.prediction != -1) s.mistakes = int(mask.count() - label_histogram(mask).at(leaf.prediction));
        return s;
    }
    const Table& inside(const Key& k, const Packed& mask) {
        if (auto found = inside_.find(k); found != inside_.end()) return found->second;
        check_();
        masks_.emplace(k, mask);
        Table out;
        alternatives(k, [&](const LeafNode& leaf) {
            const auto state = leaf_state(leaf, mask);
            if (allowed(state, k.node->budget)) {
                auto& cell = out[state]; if (statistics_) cell.count += ExactCount(1);
                if (!statistics_ && !cell.plan) cell.plan = std::make_shared<Plan>(Plan{&leaf, nullptr, {}, {}});
            }
        }, [&](const SplitNode& split, const Key& left, const Key& right) {
            auto masks = model_.live_child_masks(mask, split.feature);
            const auto& ls = inside(left, masks.first); const auto& rs = inside(right, masks.second);
            for (const auto& [a, ac] : ls) for (const auto& [b, bc] : rs) {
                check_();
                if (auto state = sum(a, b, k.node->budget)) {
                    auto& cell = out[*state]; if (statistics_) cell.count += ac.count * bc.count;
                    if (!statistics_ && !cell.plan) cell.plan = std::make_shared<Plan>(Plan{nullptr, &split, ac.plan, bc.plan});
                }
            }
        });
        if (!statistics_) {
            // For optimization, a higher objective with the same resource
            // usage is dominated. Analysis retains all objectives/counts.
            std::set<std::pair<int, int>> resources;
            for (auto it = out.begin(); it != out.end();) {
                if (!resources.emplace(it->first.leaves, it->first.abstained).second) it = out.erase(it);
                else ++it;
            }
        }
        order_.push_back(k);
        return inside_.emplace(k, std::move(out)).first->second;
    }
    json emit(const std::shared_ptr<const Plan>& plan, int& uid, const json* fixed) const {
        check_();
        const int current = fixed ? fixed->at("uid").get<int>() : uid++;
        if (plan->leaf) return {{"uid", current}, {"kind", "leaf"}, {"prediction", plan->leaf->prediction}};
        const bool fixed_split = fixed && fixed->at("kind") == "split";
        auto left = emit(plan->left, uid, fixed_split ? &fixed->at("left") : nullptr);
        auto right = emit(plan->right, uid, fixed_split ? &fixed->at("right") : nullptr);
        return {{"uid", current}, {"kind", "split"}, {"feature", plan->split->feature}, {"left", std::move(left)}, {"right", std::move(right)}};
    }
    struct Range { long double low, high; };
    using Ranges = std::map<State, Range>;
    struct EvalKey {
        Key key;
        std::vector<uint64_t> recipient, donor;
        bool operator<(const EvalKey& b) const {
            if (key < b.key) return true;
            if (b.key < key) return false;
            return std::tie(recipient, donor) < std::tie(b.recipient, b.donor);
        }
    };
    static void extend(Ranges& out, const State& s, Range r) {
        auto [it, added] = out.emplace(s, r);
        if (!added) { it->second.low = std::min(it->second.low, r.low); it->second.high = std::max(it->second.high, r.high); }
    }
    // For one permuted original feature a path's evaluation cases factor into
    // recipient rows x donor rows. This computes the expectation over ALL n!
    // permutations exactly without making n^2 synthetic rows or shuffled data.
    const Ranges& importance(const Key& k, const Packed& recipient, const Packed& donor, int feature,
                             const std::map<int, int>& originals, std::map<EvalKey, Ranges>& memo) {
        EvalKey eval{k, recipient.w, donor.w};
        if (auto found = memo.find(eval); found != memo.end()) return found->second;
        check_();
        Ranges out;
        const auto& native_mask = masks_.at(k);
        alternatives(k, [&](const LeafNode& leaf) {
            const auto state = leaf_state(leaf, native_mask);
            if (!inside_.at(k).contains(state)) return;
            const auto donor_n = donor.count(), recipient_n = recipient.count();
            const long double changed = leaf.prediction == -1
                ? static_cast<long double>(eta_) * recipient_n * donor_n
                : static_cast<long double>(recipient_n - label_histogram(recipient).at(leaf.prediction)) * donor_n;
            const long double baseline = leaf.prediction == -1 ? static_cast<long double>(eta_) * state.abstained : state.mistakes;
            const long double delta = changed / data_->y.size() - baseline;
            extend(out, state, {delta, delta});
        }, [&](const SplitNode& split, const Key& left, const Key& right) {
            Packed lr = recipient, rr = recipient, ld = donor, rd = donor;
            if (originals.at(split.feature) == feature) {
                auto parts = model_.live_child_masks(donor, split.feature); ld = std::move(parts.first); rd = std::move(parts.second);
            } else {
                auto parts = model_.live_child_masks(recipient, split.feature); lr = std::move(parts.first); rr = std::move(parts.second);
            }
            const auto& ls = importance(left, lr, ld, feature, originals, memo);
            const auto& rs = importance(right, rr, rd, feature, originals, memo);
            for (const auto& [a, av] : ls) for (const auto& [b, bv] : rs) {
                check_();
                if (auto state = sum(a, b, k.node->budget); state && inside_.at(k).contains(*state))
                    extend(out, *state, {av.low + bv.low, av.high + bv.high});
            }
        });
        return memo.emplace(std::move(eval), std::move(out)).first->second;
    }
    static int cap(const json& options, const char* name, int minimum) {
        if (!options.contains(name) || options.at(name).is_null()) return INT_MAX;
        const auto& v = options.at(name);
        if (!v.is_number_integer() || v.get<double>() < minimum || v.get<double>() > INT_MAX) throw std::invalid_argument(std::string(name) + " must be an integer >= " + std::to_string(minimum));
        return v.get<int>();
    }
public:
    GraphProfiles(ArborEnum& model, const json& meta, const Dataset* data, const json& tree,
                  const json& options, bool statistics, std::function<void()> check)
        : model_(model), meta_(meta), data_(data), partial_(tree), check_(std::move(check)), statistics_(statistics),
          eta_(meta.value("eta_defer", 0.0)), root_{model.result.get(), nullptr, false} {
        max_leaves_ = cap(options, "maxLeaves", 1); max_abstained_ = cap(options, "maxAbstainedSamples", 0);
        if (statistics && (!data || data->y.empty())) throw std::invalid_argument("Analysis requires the training dataset from a native session");
        if (options.contains("forbiddenInternalFeatures")) for (const auto& f : options.at("forbiddenInternalFeatures")) forbidden_.insert(f.get<int>());
        if (options.contains("featureTruth")) for (const auto& [f, value] : options.at("featureTruth").items()) {
            size_t consumed = 0; const int feature = std::stoi(f, &consumed);
            if (feature < 0 || consumed != f.size() || std::to_string(feature) != f) throw std::invalid_argument("Invalid featureTruth key");
            truth_.emplace(feature, value.get<bool>());
        }
        if (options.value("mode", "") == "sample") target_ = options.at("targetPrediction").get<int>();
        root_ = key(model.result.get(), &tree, options.value("mode", "") == "sample");
        inside(root_, model.live_root_mask());
        if (inside_.at(root_).empty()) throw std::invalid_argument("No completion satisfies the partial tree, caps and objective budget");
    }
    size_t visited() const { return inside_.size(); }
    json complete(int& uid, bool minimize) const {
        const State* chosen = nullptr; const Cell* cell = nullptr;
        for (const auto& [s, c] : inside_.at(root_)) {
            check_();
            if (!chosen || (minimize ? std::tie(s.abstained, s.objective, s.leaves) < std::tie(chosen->abstained, chosen->objective, chosen->leaves)
                                    : std::tie(s.objective, s.abstained, s.leaves) < std::tie(chosen->objective, chosen->abstained, chosen->leaves))) { chosen = &s; cell = &c; }
        }
        return {{"tree", emit(cell->plan, uid, &partial_)}, {"objective", chosen->objective}, {"leaves", chosen->leaves}, {"abstained_samples", chosen->abstained}};
    }
    json analyze() {
        const auto& root_table = inside_.at(root_);
        ExactCount total, undefined_accuracy;
        std::map<int, ExactCount> leaves, abstentions, objectives;
        double min_accuracy = 1, max_accuracy = 0;
        for (const auto& [s, c] : root_table) {
            check_(); total += c.count; leaves[s.leaves] += c.count; abstentions[s.abstained] += c.count; objectives[s.objective] += c.count;
            const auto predicted = data_->y.size() - s.abstained;
            if (!predicted) undefined_accuracy += c.count;
            else { const double accuracy = 1.0 - double(s.mistakes) / predicted; min_accuracy = std::min(min_accuracy, accuracy); max_accuracy = std::max(max_accuracy, accuracy); }
        }
        const auto histogram = [&](const std::map<int, ExactCount>& values) {
            json out = json::array();
            for (const auto& [value, count] : values) out.push_back({{"value", value}, {"count", count.str()}, {"probability", count.fraction(total)}});
            return out;
        };
        // Outside messages count compatible sibling/ancestor completions. All
        // rows' class marginals are accumulated together on the leaf masks.
        using Weights = std::map<State, ExactCount>;
        std::map<Key, Weights> outside;
        for (const auto& [s, c] : root_table) outside[root_][s] = ExactCount(1);
        const size_t classes = data_->classes.size();
        std::vector<std::vector<ExactCount>> predictions(data_->y.size(), std::vector<ExactCount>(classes + 1));
        for (auto it = order_.rbegin(); it != order_.rend(); ++it) {
            const auto& k = *it;
            const auto found = outside.find(k); if (found == outside.end()) continue;
            const auto& weights = found->second;
            alternatives(k, [&](const LeafNode& leaf) {
                const auto state = leaf_state(leaf, masks_.at(k));
                if (auto w = weights.find(state); w != weights.end()) rows(masks_.at(k), [&](size_t i) {
                    predictions.at(i).at(leaf.prediction == -1 ? classes : size_t(leaf.prediction)) += w->second;
                });
            }, [&](const SplitNode& split, const Key& left, const Key& right) {
                for (const auto& [a, ac] : inside_.at(left)) for (const auto& [b, bc] : inside_.at(right)) {
                    check_();
                    if (auto state = sum(a, b, k.node->budget)) if (auto w = weights.find(*state); w != weights.end()) {
                        outside[left][a] += w->second * bc.count; outside[right][b] += w->second * ac.count;
                    }
                }
            });
        }
        json disagreement = json::array();
        for (size_t i = 0; i < predictions.size(); ++i) {
            check_(); json counts = json::array(), probabilities = json::array(); double same = 0;
            for (const auto& count : predictions[i]) { const double p = count.fraction(total); counts.push_back(count.str()); probabilities.push_back(p); same += p * p; }
            disagreement.push_back({{"row", i + 1}, {"counts", counts}, {"probabilities", probabilities}, {"disagreement", std::clamp(1 - same, 0., 1.)}});
        }
        json importance_ranges = json::array();
        std::map<int, int> originals;
        for (const auto& f : meta_.at("featureRegistry")) originals.emplace(f.at("internalFeature").get<int>(), f.at("originalFeature").get<int>());
        std::set<int> used_originals;
        for (const auto& k : order_) alternatives(k, [](const LeafNode&) {}, [&](const SplitNode& split, const Key&, const Key&) { used_originals.insert(originals.at(split.feature)); });
        const auto full = model_.live_root_mask();
        for (size_t f = 0; f < data_->names.size(); ++f) {
            check_();
            if (!used_originals.count(int(f))) {
                json by_objective = json::array();
                for (const auto& [objective, count] : objectives) by_objective.push_back({{"objective", objective}, {"min", 0}, {"max", 0}});
                importance_ranges.push_back({{"feature", f}, {"name", data_->names[f]}, {"min", 0}, {"max", 0}, {"by_objective", by_objective}});
                continue;
            }
            std::map<EvalKey, Ranges> memo;
            const auto& ranges = importance(root_, full, full, int(f), originals, memo);
            long double low = std::numeric_limits<long double>::infinity(), high = -low;
            json by_objective = json::array(); std::map<int, Range> grouped;
            for (const auto& [s, range] : ranges) if (root_table.contains(s)) {
                low = std::min(low, range.low); high = std::max(high, range.high);
                auto [g, added] = grouped.emplace(s.objective, range);
                if (!added) { g->second.low = std::min(g->second.low, range.low); g->second.high = std::max(g->second.high, range.high); }
            }
            for (const auto& [objective, range] : grouped) by_objective.push_back({{"objective", objective}, {"min", double(range.low / data_->y.size())}, {"max", double(range.high / data_->y.size())}});
            importance_ranges.push_back({{"feature", f}, {"name", data_->names[f]}, {"min", double(low / data_->y.size())}, {"max", double(high / data_->y.size())}, {"by_objective", by_objective}});
        }
        return {{"tree_count", total.str()}, {"sample_count", data_->y.size()}, {"exact", true}, {"permutation", "expectation_over_all_permutations"},
            {"leaf_distribution", histogram(leaves)}, {"abstention_distribution", histogram(abstentions)}, {"objective_distribution", histogram(objectives)},
            {"accuracy", {{"min", min_accuracy <= max_accuracy ? json(min_accuracy) : json(nullptr)}, {"max", min_accuracy <= max_accuracy ? json(max_accuracy) : json(nullptr)}, {"undefined_count", undefined_accuracy.str()}}},
            {"importance", importance_ranges}, {"prediction_labels", [&] { json labels = data_->classes; labels.push_back("Abstain"); return labels; }()},
            {"disagreement", disagreement}, {"visited_nodes", visited()}};
    }
};
}
