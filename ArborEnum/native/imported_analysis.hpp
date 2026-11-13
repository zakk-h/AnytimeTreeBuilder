#pragma once
#include "live_types.hpp"
#include "exact_count.hpp"
#include "graph_profiles.hpp"
#include <tuple>

namespace arborenum::live {
// Read-only indexes into an uploaded AND/OR DAG. Convolution counts models,
// never materializes completed trees, and retains every local objective bound.
class ImportedAnalysis {
    using State = std::tuple<int64_t, int64_t, int64_t, int64_t>; // objective, leaves, abstained, mistakes
    using Table = std::map<State, ExactCount>;
    const json& graph_;
    const json& meta_;
    std::map<int, const json*> tries_, splits_, leaves_;
    std::map<std::pair<int, const json*>, Table> memo_;
    std::set<int> visiting_;
    bool accuracy_ = true, abstentions_ = true, abstain_enabled_ = false;
    int64_t gamma_ = -1, samples_ = 0;
    size_t ticks_ = 0;
    std::function<void()> cancelled_;
    const std::chrono::steady_clock::time_point deadline_ = std::chrono::steady_clock::now() + std::chrono::seconds(300);
    void check() {
        if (cancelled_) cancelled_();
        if ((++ticks_ & 1023) == 0 && std::chrono::steady_clock::now() > deadline_)
            throw std::runtime_error("Uploaded graph analysis exceeded five minutes");
    }
    static int64_t nonnegative(const json& j, const char* key, int64_t fallback) {
        if (!j.contains(key)) return fallback;
        const auto& v = j.at(key);
        if (!v.is_number_integer() || v.get<double>() < 0 || v.get<double>() > INT_MAX)
            throw std::invalid_argument(std::string("Invalid graph ") + key);
        return v.get<int64_t>();
    }
    static void index(const json& list, std::map<int, const json*>& out) {
        for (const auto& item : list) {
            const int id = int(nonnegative(item, "id", -1));
            if (id < 0 || !out.emplace(id, &item).second) throw std::invalid_argument("Invalid or duplicate graph node ID");
        }
    }
    const Table& visit(int id, const json* fixed, size_t depth = 0) {
        check();
        if (fixed && fixed->value("kind", "") == "choice") fixed = nullptr;
        const auto key = std::make_pair(id, fixed);
        if (auto found = memo_.find(key); found != memo_.end()) return found->second;
        if (depth > 512 || !visiting_.insert(id).second) throw std::invalid_argument("Uploaded graph contains a cycle or excessive depth");
        const auto& node = *tries_.at(id);
        if (fixed && fixed->at("graphTrieId").get<int>() != id) throw std::invalid_argument("Partial tree does not match uploaded graph");
        const int64_t budget = nonnegative(node, "budget", INT_MAX);
        const std::string kind = fixed ? fixed->at("kind").get<std::string>() : "choice";
        if (kind != "choice" && kind != "leaf" && kind != "split") throw std::invalid_argument("Invalid partial tree node kind");
        Table table;
        for (const auto& leaf_id : node.at("leaf_ids")) {
            const auto& leaf = *leaves_.at(leaf_id.get<int>());
            if (leaf.at("parent_trie_id").get<int>() != id) throw std::invalid_argument("Invalid leaf parent");
            if (kind == "split" || (kind == "leaf" && (fixed->at("leafId") != leaf_id || fixed->at("prediction") != leaf.at("prediction")))) continue;
            const auto loss = nonnegative(leaf, "loss", nonnegative(leaf, "objective", -1));
            if (loss < 0) throw std::invalid_argument("Uploaded graph leaves need loss or objective values");
            if (loss > budget) continue;
            const auto size = nonnegative(leaf, "subproblem_size", nonnegative(node, "subproblem_size", -1));
            const bool abstain = leaf.at("prediction").get<int>() == -1;
            abstain_enabled_ |= abstain;
            if (abstain && size < 0) abstentions_ = false;
            const int64_t mistakes = abstain ? 0 : gamma_ < 0 ? -1 : loss - gamma_;
            if (mistakes < 0 || (size >= 0 && mistakes > size)) accuracy_ = false;
            table[{loss, 1, abstain ? std::max<int64_t>(0, size) : 0, std::max<int64_t>(0, mistakes)}] += ExactCount(1);
        }
        for (const auto& split_id : node.at("split_ids")) {
            const auto& split = *splits_.at(split_id.get<int>());
            if (split.at("parent_trie_id").get<int>() != id) throw std::invalid_argument("Invalid split parent");
            if (kind == "leaf" || (kind == "split" && (fixed->at("splitId") != split_id || fixed->at("feature") != split.at("feature")))) continue;
            const auto& left = visit(split.at("left_trie_id"), fixed ? &fixed->at("left") : nullptr, depth + 1);
            const auto& right = visit(split.at("right_trie_id"), fixed ? &fixed->at("right") : nullptr, depth + 1);
            for (const auto& [a, ac] : left) for (const auto& [b, bc] : right) {
                check();
                if (std::get<0>(a) + std::get<0>(b) > budget) break;
                table[{std::get<0>(a)+std::get<0>(b), std::get<1>(a)+std::get<1>(b), std::get<2>(a)+std::get<2>(b), std::get<3>(a)+std::get<3>(b)}] += ac * bc;
            }
        }
        visiting_.erase(id);
        return memo_.emplace(key, std::move(table)).first->second;
    }
public:
    ImportedAnalysis(const json& payload) : graph_(payload.at("graph")), meta_(payload.at("meta")) {
        index(graph_.at("trie_nodes"), tries_); index(graph_.at("split_nodes"), splits_); index(graph_.at("leaf_nodes"), leaves_);
        const auto& root = *tries_.at(graph_.at("root_trie_id").get<int>());
        samples_ = nonnegative(meta_, "root_n", nonnegative(root, "subproblem_size", 0));
        gamma_ = nonnegative(meta_, "gamma", -1);
        if (gamma_ < 0 && samples_ && meta_.contains("lambda_reg")) {
            const double gamma = std::round(meta_.at("lambda_reg").get<double>() * samples_);
            if (!std::isfinite(gamma) || gamma < 0 || gamma > INT_MAX) throw std::invalid_argument("Invalid graph leaf penalty");
            gamma_ = int64_t(gamma);
        }
        accuracy_ = samples_ > 0 && gamma_ >= 0;
        abstain_enabled_ = meta_.value("use_deferral", false);
    }
    json analyze_dataset(const json& tree, const json& dataset, std::function<void()> cancelled = {},
                         std::function<void(int, size_t, size_t, const std::string&)> progress = {}) {
        Dataset data = Dataset::parse(dataset);
        if (samples_ && samples_ != int64_t(data.y.size())) throw std::invalid_argument("Dataset row count does not match the graph");
        if (gamma_ < 0) throw std::invalid_argument("Graph metadata needs gamma or lambda_reg to verify the dataset");
        json meta = meta_; meta["root_n"] = data.y.size();
        std::map<int, Packed> bits;
        Packed full((data.y.size()+63)/64);
        for (size_t i=0; i<data.y.size(); ++i) full.w[i/64] |= uint64_t(1) << (i%64);
        for (const auto& feature : meta.at("featureRegistry")) {
            const int id = feature.at("internalFeature"), original = feature.at("originalFeature");
            if (original < 0 || size_t(original) >= data.names.size() || data.names[original] != feature.at("originalName").get<std::string>())
                throw std::invalid_argument("Dataset feature names/order do not match graph featureRegistry");
            const double threshold = feature.at("threshold");
            if (!std::isfinite(threshold) || bits.contains(id)) throw std::invalid_argument("Invalid graph feature registry");
            Packed mask(full.w.size());
            for (size_t i=0; i<data.y.size(); ++i) if (data.X[i][original] <= threshold) mask.w[i/64] |= uint64_t(1) << (i%64);
            bits.emplace(id, std::move(mask));
        }
        const auto children = [&](const Packed& mask, int feature) {
            const auto& bit = bits.at(feature); Packed left(mask.w.size()), right(mask.w.size());
            for (size_t i=0; i<mask.w.size(); ++i) { left.w[i] = mask.w[i] & bit.w[i]; right.w[i] = mask.w[i] & ~bit.w[i]; }
            return std::make_pair(std::move(left), std::move(right));
        };
        std::map<int, std::shared_ptr<TreeTrieNode>> nodes;
        std::map<int, Packed> masks;
        std::set<int> active;
        const auto check_query = [&] { check(); if (cancelled) cancelled(); };
        std::function<std::shared_ptr<TreeTrieNode>(int,const Packed&,size_t)> build = [&](int id, const Packed& mask, size_t depth) {
            check_query();
            if (active.count(id) || depth > 512) throw std::invalid_argument("Uploaded graph contains a cycle or excessive depth");
            if (nodes.contains(id)) {
                if (masks.at(id).w != mask.w) throw std::invalid_argument("Shared graph node has inconsistent sample regions");
                return nodes.at(id);
            }
            active.insert(id); masks.emplace(id, mask);
            const auto& source = *tries_.at(id);
            if (nonnegative(source,"subproblem_size",mask.count()) != mask.count()) throw std::invalid_argument("Dataset sample regions do not match graph");
            auto node = std::make_shared<TreeTrieNode>(); node->budget = int(nonnegative(source,"budget",INT_MAX));
            for (const auto& leaf_id : source.at("leaf_ids")) {
                const auto& leaf = *leaves_.at(leaf_id.get<int>());
                if (leaf.at("parent_trie_id").get<int>() != id) throw std::invalid_argument("Invalid leaf parent");
                const int prediction = leaf.at("prediction");
                if (prediction < -1 || prediction >= int(data.classes.size())) throw std::invalid_argument("Dataset classes do not match graph predictions");
                int mistakes = 0;
                for (size_t row=0; row<data.y.size(); ++row) if ((mask.w[row/64] >> (row%64)) & 1) mistakes += data.y[row] != prediction;
                const int64_t expected = gamma_ + (prediction == -1 ? int64_t(std::llround(meta.value("eta_defer",0.0)*mask.count())) : mistakes);
                const int64_t loss = nonnegative(leaf,"loss",nonnegative(leaf,"objective",-1));
                if (loss != expected) throw std::invalid_argument("Dataset labels or abstention cost do not match graph leaf losses");
                node->leaves.push_back({prediction,int(loss)}); node->min_objective = std::min(node->min_objective,int(loss));
            }
            for (const auto& split_id : source.at("split_ids")) {
                const auto& split = *splits_.at(split_id.get<int>());
                if (split.at("parent_trie_id").get<int>() != id) throw std::invalid_argument("Invalid split parent");
                const int feature = split.at("feature"); auto parts = children(mask,feature);
                auto left = build(split.at("left_trie_id"),parts.first,depth+1), right = build(split.at("right_trie_id"),parts.second,depth+1);
                if (int64_t(left->min_objective)+right->min_objective <= node->budget)
                    node->min_objective = std::min(node->min_objective,left->min_objective+right->min_objective);
                node->splits.push_back({feature,left,right,0});
            }
            active.erase(id); nodes.emplace(id,node); return node;
        };
        auto root = build(graph_.at("root_trie_id"),full,0);
        // Verify fixed IDs against the original export before GraphProfiles uses
        // feature/prediction constraints on the reconstructed native nodes.
        std::function<void(const json&,int)> verify = [&](const json& fixed,int id) {
            if (fixed.at("graphTrieId").get<int>() != id) throw std::invalid_argument("Partial tree does not match graph");
            const std::string kind = fixed.at("kind");
            if (kind == "choice") return;
            if (kind == "leaf") { const auto& leaf = *leaves_.at(fixed.at("leafId").get<int>()); if (leaf.at("parent_trie_id") != id || leaf.at("prediction") != fixed.at("prediction")) throw std::invalid_argument("Invalid fixed leaf"); return; }
            if (kind != "split") throw std::invalid_argument("Invalid partial tree kind");
            const auto& split = *splits_.at(fixed.at("splitId").get<int>());
            if (split.at("parent_trie_id") != id || split.at("feature") != fixed.at("feature")) throw std::invalid_argument("Invalid fixed split");
            verify(fixed.at("left"),split.at("left_trie_id")); verify(fixed.at("right"),split.at("right_trie_id"));
        };
        verify(tree,graph_.at("root_trie_id"));
        GraphProfiles profiles(root.get(),full,children,meta,&data,tree,json::object(),true,check_query,root->budget,std::move(progress));
        auto result = profiles.analyze(); result["source"] = "uploaded_graph"; return result;
    }
    json analyze(const json& tree, std::function<void()> cancelled = {}) {
        cancelled_ = std::move(cancelled);
        const auto& table = visit(graph_.at("root_trie_id"), &tree);
        ExactCount total, undefined;
        std::map<int64_t, ExactCount> leaves, abstentions, objectives;
        double low = 1, high = 0;
        for (const auto& [s, count] : table) {
            const auto [objective, leaf_count, abstained, mistakes] = s;
            total += count; leaves[leaf_count] += count; abstentions[abstained] += count; objectives[objective] += count;
            if (abstained > samples_ || mistakes > samples_ - abstained) accuracy_ = false;
            const auto predicted = samples_ - abstained;
            if (!predicted) undefined += count;
            else if (predicted > 0) { const double a = 1.0 - double(mistakes)/predicted; low = std::min(low,a); high = std::max(high,a); }
        }
        if (total.zero()) throw std::invalid_argument("No completion satisfies this partial tree and the uploaded graph budgets");
        const auto histogram = [&](const auto& bins) { json out = json::array(); for (const auto& [value, count] : bins) out.push_back({{"value",value},{"count",count.str()},{"probability",count.fraction(total)}}); return out; };
        return {{"source","uploaded_graph"},{"exact",true},{"tree_count",total.str()},{"sample_count",samples_},
            {"leaf_distribution",histogram(leaves)},{"objective_distribution",histogram(objectives)},
            {"abstention_enabled",abstain_enabled_},{"abstention_distribution",abstentions_ && samples_ > 0 ? histogram(abstentions) : json::array()},
            {"accuracy",{{"min",accuracy_ && abstentions_ && low <= high ? json(low) : json(nullptr)},{"max",accuracy_ && abstentions_ && low <= high ? json(high) : json(nullptr)},{"undefined_count",accuracy_ && abstentions_ ? undefined.str() : "0"}}},
            {"importance",json::array()},{"disagreement",json::array()},{"class_count",0},{"prediction_labels",json::array()},
            {"unavailable_reason","Permutation importance and sample disagreement require the original training dataset, which is not included in this graph."},
            {"accuracy_available",accuracy_ && abstentions_},{"abstention_available",abstentions_ && samples_ > 0}};
    }
};
}
