#pragma once
#include "../src/arborenum/cpp/arborenum.cpp"
#include "vendor/json.hpp"
#include <atomic>
#include <mutex>
#include <thread>
#include <set>

namespace arborenum::live {
using json = nlohmann::json;

struct Settings {
    double lambda = 0.005, multiplier = 0.01, second_multiplier = 0.01;
    double multiplier_step = 0.0025, runtime = 600, memory = 10000;
    int depth = 5, lookahead = 1, width = 1, proxy_refinement = 2;
    std::string proxy_mode = "binarized", key_mode = "hash";
    static Settings parse(const json& j) {
        Settings s;
        const std::set<std::string> allowed = {"lambda_reg", "rashomon_mult", "second_rashomon_mult", "multiplier_step_size", "runtime_limit_seconds", "memory_limit_mb", "depth_budget", "lookahead_k", "refinement_width", "proxy_refinement", "proxy_mode", "key_mode"};
        if (!j.is_object()) throw std::invalid_argument("settings must be an object");
        for (const auto& [key, value] : j.items())
            if (!allowed.count(key)) throw std::invalid_argument("Unknown setting: " + key);
        for (const auto* key : {"depth_budget", "lookahead_k", "refinement_width"})
            if (j.contains(key) && !j.at(key).is_number_integer()) throw std::invalid_argument(std::string(key) + " must be an integer");
        s.lambda = j.value("lambda_reg", s.lambda);
        s.multiplier = j.value("rashomon_mult", s.multiplier);
        s.second_multiplier = j.value("second_rashomon_mult", s.multiplier);
        s.multiplier_step = j.value("multiplier_step_size", s.multiplier_step);
        s.runtime = j.value("runtime_limit_seconds", s.runtime);
        s.memory = j.value("memory_limit_mb", s.memory);
        s.depth = j.value("depth_budget", s.depth);
        s.lookahead = j.value("lookahead_k", s.lookahead);
        s.width = j.value("refinement_width", s.width);
        s.proxy_mode = j.value("proxy_mode", s.proxy_mode);
        s.key_mode = j.value("key_mode", s.key_mode);
        std::string refinement = j.value("proxy_refinement", std::string("auto"));
        if (refinement != "off" && refinement != "on" && refinement != "auto") throw std::invalid_argument("Invalid proxy_refinement");
        s.proxy_refinement = refinement == "off" ? 0 : refinement == "on" ? 1 : 2;
        for (double x : {s.lambda, s.multiplier, s.second_multiplier, s.multiplier_step, s.runtime, s.memory})
            if (!std::isfinite(x)) throw std::invalid_argument("Settings must be finite");
        if (s.lambda < 0 || s.multiplier < 0 || s.second_multiplier < s.multiplier || s.multiplier_step <= 0 || s.runtime <= 0 || s.memory <= 0 || s.depth < 0 || s.depth > 20 || s.lookahead < 0 || s.lookahead > s.depth || s.width < 1)
            throw std::invalid_argument("Invalid enumeration limits or objective settings");
        if (s.proxy_mode != "hybrid" && s.proxy_mode != "continuous" && s.proxy_mode != "binarized") throw std::invalid_argument("Invalid proxy_mode");
        if (s.key_mode != "hash" && s.key_mode != "exact") throw std::invalid_argument("key_mode must be hash or exact");
        return s;
    }
    static Settings checked(Settings s, size_t rows) {
        const double gamma = std::round(s.lambda * static_cast<double>(rows));
        const double max_budget = (gamma + static_cast<double>(rows)) * (1 + s.second_multiplier);
        if (rows == 0 || rows > static_cast<size_t>(std::numeric_limits<int>::max()) || !std::isfinite(max_budget) || max_budget >= std::numeric_limits<int>::max())
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
