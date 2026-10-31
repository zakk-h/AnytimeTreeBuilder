#pragma once
#include "../src/arborenum/cpp/arborenum.cpp"
#include "vendor/json.hpp"
#include <atomic>
#include <mutex>
#include <thread>
#include <set>
#include <climits>

namespace arborenum::live {
using json = nlohmann::json;

struct Settings {
    double lambda = 0.005, multiplier = 0.01, second_multiplier = 0.01;
    double multiplier_step = 0.0025, runtime = 600, memory = 10000, abstain_cost = 0.1, slack = 0;
    int depth = 5, lookahead = 1, width = 1, proxy_refinement = 2;
    int max_rounds = -1, max_thresholds = -1, proxy_style = 0, greedy_split = 0;
    int continuous_lickety = -1, continuous_exact = -1, continuous_greedy = -1;
    bool abstain = false, multipass = true, rule_list = false, majority_only = false;
    bool trie_cache = true, cache_cheap = false, stronger_rollout = false, evaluated_min = false, additive = false;
    std::string proxy_mode = "binarized", key_mode = "hash", greedy_continuous = "binary";
    std::vector<int> proxy_features, initial_features;
    json as_json() const {
        const auto automatic = [](int v) -> json { return v < 0 ? json(nullptr) : json(bool(v)); };
        return {{"lambda_reg", lambda}, {"rashomon_mult", multiplier}, {"second_rashomon_mult", second_multiplier},
            {"multiplier_step_size", multiplier_step}, {"runtime_limit_seconds", runtime}, {"memory_limit_mb", memory},
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
        if (s.lambda < 0 || s.multiplier < 0 || s.second_multiplier < s.multiplier || s.multiplier_step <= 0 || (s.runtime != -1 && s.runtime <= 0) || (s.memory != -1 && s.memory <= 0) || s.depth < 0 || s.depth > 127 || s.lookahead < 0 || s.lookahead > s.depth || s.width < 1 || s.abstain_cost < 0 || s.slack < 0 || s.max_rounds < -1 || (s.max_thresholds != -1 && s.max_thresholds < 1) || (s.proxy_style != 0 && s.proxy_style != 1 && s.proxy_style != 3) || s.greedy_split < 0 || s.greedy_split > 2)
            throw std::invalid_argument("Invalid enumeration limits or objective settings");
        if (s.proxy_mode != "hybrid" && s.proxy_mode != "continuous" && s.proxy_mode != "binarized") throw std::invalid_argument("Invalid proxy_mode");
        if (s.key_mode != "hash" && s.key_mode != "hash128" && s.key_mode != "exact" && s.key_mode != "lits_exact") throw std::invalid_argument("key_mode must be hash, hash128, exact or lits_exact");
        if (s.greedy_continuous != "binary" && s.greedy_continuous != "numerical") throw std::invalid_argument("Invalid greedy_continuous_mode");
        return s;
    }
    static Settings checked(Settings s, size_t rows) {
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
    std::vector<int> y;
    static Dataset parse(const json& j) {
        Dataset d;
        d.names = j.at("feature_names").get<std::vector<std::string>>();
        d.classes = j.at("class_names").get<std::vector<std::string>>();
        d.X = j.at("X").get<std::vector<std::vector<double>>>();
        for (const auto& label : j.at("y"))
            if (!label.is_number_integer()) throw std::invalid_argument("Class IDs must be integers");
        d.y = j.at("y").get<std::vector<int>>();
        if (d.names.empty() || d.X.empty() || d.X.size() != d.y.size() || d.classes.empty() || d.classes.size() > 255)
            throw std::invalid_argument("Dataset needs features, rows, matching labels and 1–255 classes");
        std::set<std::string> unique(d.names.begin(), d.names.end());
        if (unique.size() != d.names.size() || unique.count("")) throw std::invalid_argument("Feature names must be unique and nonempty");
        for (size_t i = 0; i < d.X.size(); ++i) {
            if (d.X[i].size() != d.names.size()) throw std::invalid_argument("Dataset is not rectangular");
            for (double x : d.X[i]) if (!std::isfinite(x)) throw std::invalid_argument("Features must be finite numbers");
            if (d.y[i] < 0 || static_cast<size_t>(d.y[i]) >= d.classes.size()) throw std::invalid_argument("Label is outside class_names");
        }
        return d;
    }
};

}
