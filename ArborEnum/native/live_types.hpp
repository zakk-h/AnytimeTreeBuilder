#pragma once
#include "../src/arborenum/cpp/native_headers.hpp"
#include <list>
#include <optional>
#include <climits>
#ifndef ARBORENUM_LIVE_NAMESPACE
#define ARBORENUM_LIVE_NAMESPACE arborenum::live
#endif
namespace {
#include "../src/arborenum/cpp/arborenum.cpp"
}
#include "vendor/json.hpp"
#include <atomic>
#include <mutex>
#include <thread>
#include <set>
#include <climits>

namespace ARBORENUM_LIVE_NAMESPACE {
using json = nlohmann::json;
inline Prediction wire_prediction(Prediction value) {
    if constexpr (regression_objective) if (value == DEFER_PREDICTION) return -std::numeric_limits<double>::max();
    return value;
}
inline Prediction native_prediction(Prediction value) {
    if constexpr (regression_objective) if (value == -std::numeric_limits<double>::max()) return DEFER_PREDICTION;
    return value;
}
using SumObjective = std::conditional_t<regression_objective, double, int64_t>;

struct Settings {
    double lambda = 0.005, multiplier = 0.01, second_multiplier = 0.01;
    double multiplier_step = 0.0025, runtime = 600, memory = 10000, abstain_cost = 0.1, slack = 0;
    int xgb_depth = 2, xgb_estimators = 125;
    int depth = 5, lookahead = 1, width = 1, proxy_refinement = 2;
    int max_rounds = -1, max_thresholds = -1, proxy_style = 0, greedy_split = 0;
    int continuous_lickety = -1, continuous_exact = -1, continuous_greedy = -1;
    bool abstain = false, multipass = true, rule_list = false, majority_only = false;
    bool trie_cache = true, cache_cheap = false, stronger_rollout = false, evaluated_min = false, additive = false;
    std::string proxy_mode = "binarized", key_mode = "hash", greedy_continuous = "binary";
    std::vector<int> proxy_features, initial_features;
    int proxy_delta = 0, kmeans_min_depth = 2;
    double leaf_logit_clip = 30, newton_tol = 1e-10;
    int newton_max_iter = 50;
    uint64_t sparsification_seed = 0;
    bool sparsification_cache = true, equivalent_points = false, continuous_kmeans = false;
    std::vector<double> sparsification;
    json as_json() const {
        const auto automatic = [](int v) -> json { return v < 0 ? json(nullptr) : json(bool(v)); };
        return {{"leaf_logit_clip", leaf_logit_clip}, {"newton_tol", newton_tol}, {"newton_max_iter", newton_max_iter}, {"proxy_delta", proxy_delta}, {"sparsification_probability", sparsification}, {"sparsification_seed", sparsification_seed},
            {"sparsification_cache_proxy_splits", sparsification_cache}, {"regression_equivalent_points", equivalent_points},
            {"regression_continuous_kmeans", continuous_kmeans}, {"regression_kmeans_min_depth", kmeans_min_depth}, {"lambda_reg", lambda}, {"rashomon_mult", multiplier}, {"second_rashomon_mult", second_multiplier},
            {"multiplier_step_size", multiplier_step}, {"runtime_limit_seconds", runtime}, {"memory_limit_mb", memory},
            {"xgboost_max_depth", xgb_depth}, {"xgboost_estimators", xgb_estimators},
            {"depth_budget", depth}, {"lookahead_k", lookahead}, {"refinement_width", width},
            {"proxy_mode", proxy_mode}, {"key_mode", key_mode}, {"proxy_refinement", proxy_refinement == 0 ? "off" : proxy_refinement == 1 ? "on" : "auto"},
            {"allow_abstain", abstain}, {"abstain_cost", abstain_cost}, {"max_refinement_rounds", max_rounds},
            {"max_number_thresholds_per_feature", max_thresholds}, {"proxy_style", proxy_style}, {"greedy_split_mode", greedy_split},
            {"greedy_continuous_mode", greedy_continuous}, {"use_multipass", multipass}, {"rule_list_mode", rule_list},
            {"majority_leaf_only", majority_only}, {"trie_cache", trie_cache}, {"cache_cheap_subproblems", cache_cheap},
            {"stronger_rollout", stronger_rollout}, {"evaluated_use_min_objectives", evaluated_min}, {"additive", additive},
            {"multiplicative_slack", slack}, {"proxy_threshold_features", proxy_features}, {"initial_active_threshold_features", initial_features},
            {"continuous_proxy_in_lickety", automatic(continuous_lickety)}, {"continuous_proxy_in_depthd_exact", automatic(continuous_exact)},
            {"continuous_proxy_in_greedy", automatic(continuous_greedy)}};
    }
    static Settings parse(const json& j) {
        Settings s;
        if (!j.is_object()) throw std::invalid_argument("settings must be an object");
        const auto defaults = s.as_json();
        for (const auto& [key, value] : j.items()) {
            if (!defaults.contains(key)) throw std::invalid_argument("Unknown setting: " + key);
            const auto& expected = defaults.at(key);
            if (expected.is_boolean() && !value.is_boolean()) throw std::invalid_argument(key + " must be true or false");
            if (expected.is_number_integer() && (!value.is_number_integer() || value.get<double>() < INT_MIN || value.get<double>() > INT_MAX)) throw std::invalid_argument(key + " must be an integer");
            if (expected.is_number_float() && !value.is_number()) throw std::invalid_argument(key + " must be a number");
            if (expected.is_string() && !value.is_string()) throw std::invalid_argument(key + " must be text");
            if (key == "sparsification_probability") {
                if (!value.is_array()) throw std::invalid_argument("Sparsification probabilities must be a list");
                for (const auto& probability : value) if (!probability.is_number() || !std::isfinite(probability.get<double>()) || probability.get<double>() < 0 || probability.get<double>() > 1)
                    throw std::invalid_argument("Sparsification probabilities must be between 0 and 1");
                continue;
            }
            if (expected.is_array()) {
                if (!value.is_array()) throw std::invalid_argument(key + " must be a list of threshold IDs");
                std::set<int> seen;
                for (const auto& id : value) {
                    if (!id.is_number_integer() || id.get<int64_t>() < 0 || id.get<int64_t>() > INT_MAX || !seen.insert(id.get<int>()).second)
                        throw std::invalid_argument(key + " must contain distinct nonnegative integer IDs");
                }
            }
            if (expected.is_null() && !value.is_null() && !value.is_boolean()) throw std::invalid_argument(key + " must be automatic (null), true or false");
        }
        s.leaf_logit_clip = j.value("leaf_logit_clip", 30.0);
        s.newton_tol = j.value("newton_tol", 1e-10);
        s.newton_max_iter = j.value("newton_max_iter", 50);
        if (!std::isfinite(s.leaf_logit_clip) || s.leaf_logit_clip <= 0 || !std::isfinite(s.newton_tol) || s.newton_tol <= 0 || s.newton_max_iter < 1) throw std::invalid_argument("Invalid logistic optimizer settings");
        s.proxy_delta = j.value("proxy_delta", 0);
        s.sparsification = j.value("sparsification_probability", s.sparsification);
        if (j.contains("sparsification_seed") && j.at("sparsification_seed").get<double>() < 0) throw std::invalid_argument("Sparsification seed must be nonnegative");
        s.sparsification_seed = j.value("sparsification_seed", uint64_t(0));
        s.sparsification_cache = j.value("sparsification_cache_proxy_splits", true);
        s.equivalent_points = j.value("regression_equivalent_points", false);
        s.continuous_kmeans = j.value("regression_continuous_kmeans", false);
        s.kmeans_min_depth = j.value("regression_kmeans_min_depth", 2);
        s.xgb_depth = j.value("xgboost_max_depth", s.xgb_depth); s.xgb_estimators = j.value("xgboost_estimators", s.xgb_estimators);
        s.lambda = j.value("lambda_reg", s.lambda);
        s.multiplier = j.value("rashomon_mult", s.multiplier);
        s.second_multiplier = j.value("second_rashomon_mult", s.multiplier);
        s.multiplier_step = j.value("multiplier_step_size", s.multiplier_step);
        s.runtime = j.value("runtime_limit_seconds", s.runtime); s.memory = j.value("memory_limit_mb", s.memory);
        s.depth = j.value("depth_budget", s.depth); s.lookahead = j.value("lookahead_k", std::min(s.lookahead, s.depth));
        s.width = j.value("refinement_width", s.width); s.proxy_mode = j.value("proxy_mode", s.proxy_mode); s.key_mode = j.value("key_mode", s.key_mode);
        const auto refinement = j.value("proxy_refinement", std::string("auto"));
        if (refinement != "off" && refinement != "on" && refinement != "auto") throw std::invalid_argument("Invalid proxy_refinement");
        s.proxy_refinement = refinement == "off" ? 0 : refinement == "on" ? 1 : 2;
        s.abstain = j.value("allow_abstain", s.abstain); s.abstain_cost = j.value("abstain_cost", s.abstain_cost);
        s.max_rounds = j.value("max_refinement_rounds", s.max_rounds); s.max_thresholds = j.value("max_number_thresholds_per_feature", s.max_thresholds);
        s.proxy_style = j.value("proxy_style", s.proxy_style); s.greedy_split = j.value("greedy_split_mode", s.greedy_split);
        s.greedy_continuous = j.value("greedy_continuous_mode", s.greedy_continuous);
        s.multipass = j.value("use_multipass", s.multipass); s.rule_list = j.value("rule_list_mode", s.rule_list);
        s.majority_only = j.value("majority_leaf_only", s.majority_only); s.trie_cache = j.value("trie_cache", s.trie_cache);
        s.cache_cheap = j.value("cache_cheap_subproblems", s.cache_cheap); s.stronger_rollout = j.value("stronger_rollout", s.stronger_rollout);
        s.evaluated_min = j.value("evaluated_use_min_objectives", s.evaluated_min); s.additive = j.value("additive", s.additive);
        s.slack = j.value("multiplicative_slack", s.slack);
        s.proxy_features = j.value("proxy_threshold_features", s.proxy_features); s.initial_features = j.value("initial_active_threshold_features", s.initial_features);
        const auto override_mode = [&](const char* key) { return !j.contains(key) || j.at(key).is_null() ? -1 : int(j.at(key).get<bool>()); };
        s.continuous_lickety = override_mode("continuous_proxy_in_lickety"); s.continuous_exact = override_mode("continuous_proxy_in_depthd_exact"); s.continuous_greedy = override_mode("continuous_proxy_in_greedy");
        for (double x : {s.lambda, s.multiplier, s.second_multiplier, s.multiplier_step, s.runtime, s.memory, s.abstain_cost, s.slack})
            if (!std::isfinite(x)) throw std::invalid_argument("Settings must be finite");
        if (s.xgb_depth < 1 || s.xgb_depth > 32 || s.xgb_estimators < 1 || s.lambda < 0 || s.multiplier < 0 || s.second_multiplier < s.multiplier || s.multiplier_step <= 0 || (s.runtime != -1 && s.runtime <= 0) || (s.memory != -1 && s.memory <= 0) || s.depth < 0 || s.depth > 127 || s.lookahead < 0 || s.lookahead > s.depth || s.width < 1 || s.abstain_cost < 0 || s.slack < 0 || s.max_rounds < -1 || (s.max_thresholds != -1 && s.max_thresholds < 1) || (s.proxy_style != 0 && s.proxy_style != 1 && s.proxy_style != 3) || s.greedy_split < 0 || s.greedy_split > 2)
            throw std::invalid_argument("Invalid enumeration limits or objective settings");
        if (s.proxy_mode != "hybrid" && s.proxy_mode != "continuous" && s.proxy_mode != "binarized") throw std::invalid_argument("Invalid proxy_mode");
        if (s.key_mode != "hash" && s.key_mode != "hash128" && s.key_mode != "exact" && s.key_mode != "lits_exact") throw std::invalid_argument("key_mode must be hash, hash128, exact or lits_exact");
        if (s.greedy_continuous != "binary" && s.greedy_continuous != "numerical") throw std::invalid_argument("Invalid greedy_continuous_mode");
        if (s.proxy_delta < 0 || s.depth + s.proxy_delta > 127 || s.kmeans_min_depth < 0 || s.kmeans_min_depth > 127)
            throw std::invalid_argument("Invalid proxy extension or k-means depth");
        if (!s.sparsification.empty() && s.sparsification.size() != static_cast<size_t>(s.depth))
            throw std::invalid_argument("Sparsification needs one probability per enumeration depth, indexed from remaining depth 1");
        return s;
    }
    static Settings checked(Settings s, size_t rows) {
        if constexpr (logistic_objective) {
            if (s.abstain) throw std::invalid_argument("Logistic deferral is not supported");
            s.greedy_continuous = "numerical";
        }
        if constexpr (regression_objective) {
            if (rows == 0 || rows > static_cast<size_t>(INT_MAX)) throw std::invalid_argument("Invalid dataset size");
            return s;
        }
        const double gamma = std::round(s.lambda * static_cast<double>(rows));
        const double leaf_max = gamma + static_cast<double>(rows) + (s.abstain ? std::round(s.abstain_cost * rows) : 0);
        const double max_budget = leaf_max * (1 + s.second_multiplier) * (1 + s.slack);
        if (rows == 0 || rows > static_cast<size_t>(INT_MAX) || !std::isfinite(max_budget) || max_budget >= INT_MAX)
            throw std::invalid_argument("Dataset and objective settings exceed the engine's integer objective range");
        return s;
    }
};

struct Dataset {
    std::vector<std::string> names, classes;
    std::vector<std::vector<double>> X;
    std::vector<Prediction> y;
    std::vector<double> base_logits;
    static Dataset parse(const json& j) {
        Dataset d;
        d.base_logits = j.value("base_logits", std::vector<double>{});
        d.names = j.at("feature_names").get<std::vector<std::string>>();
        d.classes = j.value("class_names", std::vector<std::string>{});
        d.X = j.at("X").get<std::vector<std::vector<double>>>();
        for (const auto& label : j.at("y"))
            if (regression_objective ? !label.is_number() || !std::isfinite(label.get<double>()) : !label.is_number_integer()) throw std::invalid_argument("Class IDs must be integers");
        d.y = j.at("y").get<std::vector<Prediction>>();
        if (d.names.empty() || d.X.empty() || d.X.size() != d.y.size() || (!regression_objective && (d.classes.empty() || d.classes.size() > 255)))
            throw std::invalid_argument("Dataset needs features, rows, matching labels and 1–255 classes");
        if constexpr (logistic_objective) {
            if (!d.base_logits.empty() && d.base_logits.size() != d.y.size()) throw std::invalid_argument("Base logits must match dataset rows");
            for (double z : d.base_logits) if (!std::isfinite(z)) throw std::invalid_argument("Base logits must be finite");
            for (double y : d.y) if (y != 0 && y != 1) throw std::invalid_argument("Logistic labels must be 0 or 1");
            if (d.classes.empty()) d.classes = {"0", "1"};
            if (d.classes.size() != 2) throw std::invalid_argument("Logistic training requires two classes");
        }
        std::set<std::string> unique(d.names.begin(), d.names.end());
        if (unique.size() != d.names.size() || unique.count("")) throw std::invalid_argument("Feature names must be unique and nonempty");
        for (size_t i = 0; i < d.X.size(); ++i) {
            if (d.X[i].size() != d.names.size()) throw std::invalid_argument("Dataset is not rectangular");
            for (double x : d.X[i]) if (!std::isfinite(x)) throw std::invalid_argument("Features must be finite numbers");
            if (!regression_objective && (d.y[i] < 0 || static_cast<size_t>(d.y[i]) >= d.classes.size())) throw std::invalid_argument("Label is outside class_names");
        }
        return d;
    }
};

}
