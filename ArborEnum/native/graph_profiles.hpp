#pragma once
#include "live_types.hpp"
#include "exact_count.hpp"
#include <bit>
#include <functional>
#include <tuple>
#include <optional>
#include <compare>
#include <unordered_map>

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
    int root_budget_;
    std::set<int> forbidden_;
    std::map<int, bool> truth_;
    struct State {
        int objective = 0, leaves = 0, abstained = 0, mistakes = 0;
        auto operator<=>(const State&) const = default;
    };
    struct StateHash {
        size_t operator()(const State& s) const {
            size_t h = size_t(s.objective);
            for (int v : {s.leaves, s.abstained, s.mistakes}) h = h * 1000003u ^ size_t(v);
            return h;
        }
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
    template<class Value> struct OrderedStates : std::vector<std::pair<State, Value>> {
        using std::vector<std::pair<State, Value>>::vector;
        bool contains(const State& s) const {
            auto it = std::lower_bound(this->begin(), this->end(), s, [](const auto& pair, const State& value) { return pair.first < value; });
            return it != this->end() && it->first == s;
        }
    };
    using Table = OrderedStates<Cell>;
    // Hot joins use direct indexing when ordinary loss allows it. A bounded
    // allocation and a generic spill map keep unusual and abstaining states
    // exact without allocating an unbounded dense tensor.
    template<class Value> class Accumulator {
        int base_;
        size_t width_;
        std::vector<Value> dense_;
        std::vector<int> mistakes_;
        std::unordered_map<State, Value, StateHash> spilled_;
    public:
        Accumulator(int base, size_t width, size_t height, bool enabled) : base_(base), width_(width) {
            if (enabled && height && width <= 262144 && height <= 262144 / width) {
                dense_.resize(width * height); mistakes_.assign(dense_.size(), -1);
            }
        }
        Value& operator[](const State& state) {
            if (!dense_.empty() && state.abstained == 0 && state.objective >= base_ && size_t(state.leaves) < width_) {
                const size_t index = size_t(state.objective - base_) * width_ + state.leaves;
                if (index < dense_.size()) {
                    if (mistakes_[index] < 0) mistakes_[index] = state.mistakes;
                    if (mistakes_[index] == state.mistakes) return dense_[index];
                }
            }
            return spilled_[state];
        }
        OrderedStates<Value> finish() {
            OrderedStates<Value> out;
            for (auto& [state, value] : spilled_) out.emplace_back(state, std::move(value));
            for (size_t i = 0; i < dense_.size(); ++i) if (mistakes_[i] >= 0)
                out.emplace_back(State{base_ + int(i / width_), int(i % width_), 0, mistakes_[i]}, std::move(dense_[i]));
            std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
            return out;
        }
    };
    std::map<Key, int> minima_, budgets_, leaf_limits_;
    bool ordinary_only_ = true;
    std::vector<Key> bound_order_;
    uint32_t work_ticks_ = 0;
    const std::chrono::steady_clock::time_point started_ = std::chrono::steady_clock::now();
    double bounds_seconds_ = 0, counting_seconds_ = 0;
    void check_work() { if ((++work_ticks_ & 1023U) == 0) check_(); }
    static double seconds_since(std::chrono::steady_clock::time_point start) {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    }
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
            if (!TreeTrieNode::split_has_solution(split, k.node->budget) || forbidden_.count(split.feature)) continue;
            if (kind == "split" && split.feature != k.fixed->at("feature").get<int>()) continue;
            bool ls = k.sample, rs = k.sample;
            if (auto found = truth_.find(split.feature); k.sample && found != truth_.end()) { ls = found->second; rs = !found->second; }
            split_fn(split, key(split.left.get(), k.fixed ? &k.fixed->at("left") : nullptr, ls),
                            key(split.right.get(), k.fixed ? &k.fixed->at("right") : nullptr, rs));
        }
    }
    // First compute scalar minima, then propagate the largest objective allowance
    // with which each (borrowed node, fixed partial subtree, constraint) can be
    // reached from the root. Cached native nodes may have much larger budgets
    // than any completion of this partial tree can use. For shared DAG children
    // take the maximum allowance over ALL parents, in topological order.
    int minimum(const Key& k) {
        if (auto found = minima_.find(k); found != minima_.end()) return found->second;
        int best = INT_MAX, leaves = 0;
        alternatives(k, [&](const LeafNode& leaf) {
            best = std::min(best, leaf.loss); leaves = std::max(leaves, 1);
            if (leaf.prediction == -1) ordinary_only_ = false;
        },
            [&](const SplitNode&, const Key& left, const Key& right) {
                const int lo = minimum(left), ro = minimum(right);
                if (int64_t(lo) + ro <= k.node->budget) {
                    best = std::min(best, lo + ro);
                    leaves = std::max(leaves, int(std::min(int64_t(INT_MAX), int64_t(leaf_limits_.at(left)) + leaf_limits_.at(right))));
                }
            });
        leaf_limits_[k] = leaves;
        bound_order_.push_back(k);
        return minima_.emplace(k, best).first->second;
    }
    void bound_from_root() {
        minimum(root_);
        budgets_[root_] = std::min(root_.node->budget, root_budget_);
        for (auto it = bound_order_.rbegin(); it != bound_order_.rend(); ++it) {
            const auto& k = *it;
            auto found = budgets_.find(k); if (found == budgets_.end()) continue;
            const int allowance = found->second;
            alternatives(k, [](const LeafNode&) {}, [&](const SplitNode&, const Key& left, const Key& right) {
                const int lo = minima_.at(left), ro = minima_.at(right);
                if (int64_t(lo) + ro > allowance) return;
                const auto offer = [&](const Key& child, int cap) {
                    cap = std::min(cap, child.node->budget);
                    auto [where, added] = budgets_.emplace(child, cap);
                    if (!added) where->second = std::max(where->second, cap);
                };
                offer(left, allowance - ro); offer(right, allowance - lo);
            });
        }
    }
    template<class Value> Accumulator<Value> accumulator(const Key& k, bool enabled) const {
        const int base = minima_.at(k), budget = budgets_.at(k);
        const size_t width = size_t(std::min(max_leaves_, leaf_limits_.at(k))) + 1;
        const size_t height = base <= budget ? size_t(budget - base) + 1 : 0;
        return Accumulator<Value>(base, width, height, enabled && ordinary_only_ && !k.node->splits.empty());
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
        const auto allowance = budgets_.find(k);
        if (allowance == budgets_.end()) return inside_.emplace(k, Table{}).first->second;
        const int budget = allowance->second;
        auto accumulated = accumulator<Cell>(k, statistics_);
        alternatives(k, [&](const LeafNode& leaf) {
            const auto state = leaf_state(leaf, mask);
            if (allowed(state, budget)) {
                auto& cell = accumulated[state]; if (statistics_) cell.count += ExactCount(1);
                if (!statistics_ && !cell.plan) cell.plan = std::make_shared<Plan>(Plan{&leaf, nullptr, {}, {}});
            }
        }, [&](const SplitNode& split, const Key& left, const Key& right) {
            if (int64_t(minima_.at(left)) + minima_.at(right) > budget) return;
            auto masks = model_.live_child_masks(mask, split.feature);
            const auto& ls = inside(left, masks.first); const auto& rs = inside(right, masks.second);
            for (const auto& [a, ac] : ls) for (const auto& [b, bc] : rs) {
                check_work();
                // Tables are ordered by objective; every later right state
                // also exceeds the allowance once this pair does.
                if (int64_t(a.objective) + b.objective > budget) break;
                if (auto state = sum(a, b, budget)) {
                    auto& cell = accumulated[*state]; if (statistics_) cell.count += ac.count * bc.count;
                    if (!statistics_ && !cell.plan) cell.plan = std::make_shared<Plan>(Plan{nullptr, &split, ac.plan, bc.plan});
                }
            }
        });
        auto out = accumulated.finish();
        check_();
        if (!statistics_) {
            // For optimization, a higher objective with the same resource
            // usage is dominated. Analysis retains all objectives/counts.
            std::set<std::pair<int, int>> resources;
            out.erase(std::remove_if(out.begin(), out.end(), [&](const auto& pair) {
                return !resources.emplace(pair.first.leaves, pair.first.abstained).second;
            }), out.end());
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
    struct Range {
        long double low = std::numeric_limits<long double>::infinity();
        long double high = -std::numeric_limits<long double>::infinity();
    };
    using Ranges = OrderedStates<Range>;
    struct EvalKey {
        Key key;
        std::vector<uint64_t> recipient, donor;
        bool operator<(const EvalKey& b) const {
            if (key < b.key) return true;
            if (b.key < key) return false;
            return std::tie(recipient, donor) < std::tie(b.recipient, b.donor);
        }
    };
    // For one permuted original feature a path's evaluation cases factor into
    // recipient rows x donor rows. This computes the expectation over ALL n!
    // permutations exactly without making n^2 synthetic rows or shuffled data.
    const Ranges& importance(const Key& k, const Packed& recipient, const Packed& donor, int feature,
                             const std::map<int, int>& originals, std::map<EvalKey, Ranges>& memo) {
        EvalKey eval{k, recipient.w, donor.w};
        if (auto found = memo.find(eval); found != memo.end()) return found->second;
        check_();
        Ranges out;
        if (!recipient.any() || !donor.any()) {
            for (const auto& [state, cell] : inside_.at(k)) {
                check_work();
                const long double baseline = state.mistakes + static_cast<long double>(eta_) * state.abstained;
                out.emplace_back(state, Range{-baseline, -baseline});
            }
            return memo.emplace(std::move(eval), std::move(out)).first->second;
        }
        auto accumulated = accumulator<Range>(k, true);
        const auto extend = [&](const State& state, Range range) {
            auto& cell = accumulated[state];
            cell.low = std::min(cell.low, range.low); cell.high = std::max(cell.high, range.high);
        };
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
            extend(state, {delta, delta});
        }, [&](const SplitNode& split, const Key& left, const Key& right) {
            const int budget = budgets_.at(k);
            if (int64_t(minima_.at(left)) + minima_.at(right) > budget) return;
            Packed lr = recipient, rr = recipient, ld = donor, rd = donor;
            if (originals.at(split.feature) == feature) {
                auto parts = model_.live_child_masks(donor, split.feature); ld = std::move(parts.first); rd = std::move(parts.second);
            } else {
                auto parts = model_.live_child_masks(recipient, split.feature); lr = std::move(parts.first); rr = std::move(parts.second);
            }
            const auto& ls = importance(left, lr, ld, feature, originals, memo);
            const auto& rs = importance(right, rr, rd, feature, originals, memo);
            for (const auto& [a, av] : ls) for (const auto& [b, bv] : rs) {
                check_work();
                if (int64_t(a.objective) + b.objective > budget) break;
                // Each child range corresponds to an inside state for this
                // same split. Every budget-feasible sum is already represented
                // at the parent; no per-pair membership lookup is necessary.
                if (auto state = sum(a, b, budget))
                    extend(*state, {av.low + bv.low, av.high + bv.high});
            }
        });
        auto ranges = accumulated.finish(); check_();
        return memo.emplace(std::move(eval), std::move(ranges)).first->second;
    }
    static int cap(const json& options, const char* name, int minimum) {
        if (!options.contains(name) || options.at(name).is_null()) return INT_MAX;
        const auto& v = options.at(name);
        if (!v.is_number_integer() || v.get<double>() < minimum || v.get<double>() > INT_MAX) throw std::invalid_argument(std::string(name) + " must be an integer >= " + std::to_string(minimum));
        return v.get<int>();
    }
public:
    GraphProfiles(ArborEnum& model, const json& meta, const Dataset* data, const json& tree,
                  const json& options, bool statistics, std::function<void()> check, int root_budget = INT_MAX)
        : model_(model), meta_(meta), data_(data), partial_(tree), check_(std::move(check)), statistics_(statistics),
          eta_(meta.value("eta_defer", 0.0)), root_budget_(root_budget), root_{model.result.get(), nullptr, false} {
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
        bound_from_root();
        bounds_seconds_ = seconds_since(started_);
        const auto count_started = std::chrono::steady_clock::now();
        inside(root_, model.live_root_mask());
        counting_seconds_ = seconds_since(count_started);
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
        const auto prediction_started = std::chrono::steady_clock::now();
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
        using Weights = std::unordered_map<State, ExactCount, StateHash>;
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
                const int budget = budgets_.at(k);
                if (int64_t(minima_.at(left)) + minima_.at(right) > budget) return;
                auto& left_weights = outside[left]; auto& right_weights = outside[right];
                for (const auto& [a, ac] : inside_.at(left)) for (const auto& [b, bc] : inside_.at(right)) {
                    check_work();
                    if (int64_t(a.objective) + b.objective > budget) break;
                    if (auto state = sum(a, b, budget)) if (auto w = weights.find(*state); w != weights.end()) {
                        left_weights[a] += w->second * bc.count; right_weights[b] += w->second * ac.count;
                    }
                }
            });
        }
        json disagreement = json::array();
        for (size_t i = 0; i < predictions.size(); ++i) {
            check_(); json counts = json::array(), probabilities = json::array(); double modal_probability = 0;
            for (const auto& count : predictions[i]) { const double p = count.fraction(total); counts.push_back(count.str()); probabilities.push_back(p); modal_probability = std::max(modal_probability, p); }
            disagreement.push_back({{"row", i + 1}, {"counts", counts}, {"probabilities", probabilities}, {"disagreement", std::clamp(1 - modal_probability, 0., 1.)}});
        }
        const double prediction_seconds = seconds_since(prediction_started);
        const auto importance_started = std::chrono::steady_clock::now();
        json importance_ranges = json::array(), feature_times = json::array();
        std::map<int, int> originals;
        for (const auto& f : meta_.at("featureRegistry")) originals.emplace(f.at("internalFeature").get<int>(), f.at("originalFeature").get<int>());
        std::set<int> used_originals;
        for (const auto& k : order_) alternatives(k, [](const LeafNode&) {}, [&](const SplitNode& split, const Key&, const Key&) { used_originals.insert(originals.at(split.feature)); });
        const auto full = model_.live_root_mask();
        for (size_t f = 0; f < data_->names.size(); ++f) {
            check_();
            const auto feature_started = std::chrono::steady_clock::now();
            if (!used_originals.count(int(f))) {
                json by_objective = json::array();
                for (const auto& [objective, count] : objectives) by_objective.push_back({{"objective", objective}, {"min", 0}, {"max", 0}});
                importance_ranges.push_back({{"feature", f}, {"name", data_->names[f]}, {"min", 0}, {"max", 0}, {"by_objective", by_objective}});
                feature_times.push_back({{"feature", f}, {"name", data_->names[f]}, {"seconds", seconds_since(feature_started)}});
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
            feature_times.push_back({{"feature", f}, {"name", data_->names[f]}, {"seconds", seconds_since(feature_started)}});
        }
        auto abstention_distribution = histogram(abstentions);
        for (auto& bin : abstention_distribution) bin["proportion_abstained"] = double(bin.at("value").get<int>()) / data_->y.size();
        return {{"class_count", data_->classes.size()}, {"abstention_enabled", meta_.value("use_deferral", !ordinary_only_)},
            {"disagreement_metric", "variation_ratio"}, {"tree_count", total.str()}, {"sample_count", data_->y.size()}, {"exact", true}, {"permutation", "expectation_over_all_permutations"},
            {"leaf_distribution", histogram(leaves)}, {"abstention_distribution", abstention_distribution}, {"objective_distribution", histogram(objectives)},
            {"accuracy", {{"min", min_accuracy <= max_accuracy ? json(min_accuracy) : json(nullptr)}, {"max", min_accuracy <= max_accuracy ? json(max_accuracy) : json(nullptr)}, {"undefined_count", undefined_accuracy.str()}}},
            {"importance", importance_ranges}, {"prediction_labels", [&] { json labels = data_->classes; labels.push_back("Abstain"); return labels; }()},
            {"disagreement", disagreement}, {"visited_nodes", visited()},
            {"timings", {{"bounds_seconds", bounds_seconds_}, {"counting_seconds", counting_seconds_},
                {"prediction_seconds", prediction_seconds}, {"importance_seconds", seconds_since(importance_started)},
                {"total_seconds", seconds_since(started_)}, {"features", feature_times}}}};
    }
};
}
