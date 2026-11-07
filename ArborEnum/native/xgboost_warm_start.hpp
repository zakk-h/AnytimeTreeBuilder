#pragma once
#include "live_types.hpp"
#include <xgboost/c_api.h>
#include <functional>
#include <limits>

namespace arborenum::live {
struct WarmStart {
    struct Threshold { int feature; double value; };
    std::vector<Threshold> thresholds;
    int rounds = 0;
    size_t trees = 0;
};
inline void xgb_check(int code) {
    if (code != 0) throw std::runtime_error(std::string("XGBoost warm start: ") + XGBGetLastError());
}

// Only the public native API crosses the library boundary. No interpreter,
// subprocess, model file, or graph export is involved.
inline WarmStart train_warm_start(const Dataset& data, const Settings& settings, const std::function<void()>& check) {
    WarmStart result;
    if (std::set<int>(data.y.begin(), data.y.end()).size() < 2) return result;
    const size_t n = data.X.size(), p = data.names.size();
    std::vector<std::vector<double>> values(p);
    bool has_continuous = false;
    for (size_t f = 0; f < p; ++f) {
        check();
        auto& v = values[f]; v.reserve(n);
        for (const auto& row : data.X) v.push_back(row[f]);
        std::sort(v.begin(), v.end()); v.erase(std::unique(v.begin(), v.end()), v.end());
        has_continuous |= v.size() > 2;
    }
    // Binary features are already all active; fitting cannot add thresholds.
    if (!has_continuous) return result;
    std::vector<float> matrix(n * p), labels(data.y.begin(), data.y.end());
    for (size_t f = 0; f < p; ++f) {
        check();
        const auto& v = values[f];
        if (v.size() > (1u << 24)) throw std::invalid_argument("Too many distinct values for the XGBoost warm start");
        for (size_t i = 0; i < n; ++i)
            matrix[i * p + f] = float(std::lower_bound(v.begin(), v.end(), data.X[i][f]) - v.begin());
    }
    // XGBoost consumes float32. Ordered ranks preserve every original split,
    // even for doubles which overflow float32 or collapse to the same float.
    struct Matrix {
        DMatrixHandle value = nullptr;
        ~Matrix() { if (value) XGDMatrixFree(value); }
    } dtrain;
    xgb_check(XGDMatrixCreateFromMat(matrix.data(), n, p, std::numeric_limits<float>::quiet_NaN(), &dtrain.value));
    xgb_check(XGDMatrixSetFloatInfo(dtrain.value, "label", labels.data(), n));
    struct Booster {
        BoosterHandle value = nullptr;
        ~Booster() { if (value) XGBoosterFree(value); }
    } booster;
    xgb_check(XGBoosterCreate(&dtrain.value, 1, &booster.value));
    const auto param = [&](const char* name, const std::string& value) { xgb_check(XGBoosterSetParam(booster.value, name, value.c_str())); };
    param("booster", "gbtree"); param("tree_method", "hist"); param("device", "cpu");
    param("nthread", "1"); param("seed", "0"); param("verbosity", "0");
    param("max_depth", std::to_string(settings.xgb_depth));
    param("objective", data.classes.size() == 2 ? "binary:logistic" : "multi:softprob");
    if (data.classes.size() > 2) param("num_class", std::to_string(data.classes.size()));
    for (int round = 0; round < settings.xgb_estimators; ++round) {
        check(); xgb_check(XGBoosterUpdateOneIter(booster.value, round, dtrain.value)); ++result.rounds;
    }
    bst_ulong count = 0; const char** dumps = nullptr;
    xgb_check(XGBoosterDumpModelEx(booster.value, "", 0, "json", &count, &dumps));
    result.trees = count;
    std::set<std::pair<int, double>> cuts;
    const auto visit = [&](const auto& self, const json& node) -> void {
        check();
        if (!node.contains("split")) return;
        const std::string name = node.at("split");
        if (name.size() < 2 || name.front() != 'f') throw std::runtime_error("Unexpected XGBoost split feature");
        const int feature = std::stoi(name.substr(1));
        const auto& v = values.at(feature);
        // XGBoost's left branch is rank < split_condition; ArborEnum uses
        // original value <= cut. Pick the last observed value on that branch.
        const double rank_cut = node.at("split_condition");
        const auto left_size = static_cast<int64_t>(std::ceil(rank_cut));
        if (v.size() > 2 && left_size > 0 && left_size < static_cast<int64_t>(v.size()))
            cuts.emplace(feature, v.at(static_cast<size_t>(left_size - 1)));
        for (const auto& child : node.at("children")) self(self, child);
    };
    for (bst_ulong i = 0; i < count; ++i) { check(); visit(visit, json::parse(dumps[i])); }
    for (const auto& [feature, value] : cuts) result.thresholds.push_back({feature, value});
    return result;
}
// Keep the original feature identity even when two columns induce identical
// partitions. With a user threshold cap, choose the closest available partition
// on that same feature, using sample counts rather than numeric distance.
inline std::vector<int> map_warm_thresholds(const WarmStart& warm, const Dataset& data, const json& registry) {
    std::map<int, std::vector<double>> columns;
    for (const auto& cut : warm.thresholds) if (!columns.contains(cut.feature)) {
        auto& column = columns[cut.feature];
        for (const auto& row : data.X) column.push_back(row[cut.feature]);
        std::sort(column.begin(), column.end());
    }
    std::set<int> ids;
    for (const auto& cut : warm.thresholds) {
        const auto& column = columns.at(cut.feature);
        const auto target = std::upper_bound(column.begin(), column.end(), cut.value) - column.begin();
        int best = -1; size_t difference = std::numeric_limits<size_t>::max();
        for (const auto& feature : registry) if (feature.at("originalFeature") == cut.feature) {
            const double value = feature.at("threshold");
            const auto left = std::upper_bound(column.begin(), column.end(), value) - column.begin();
            const size_t delta = static_cast<size_t>(std::abs(left - target));
            if (delta < difference) { difference = delta; best = feature.at("internalFeature"); }
        }
        if (best < 0) throw std::runtime_error("XGBoost feature has no prepared threshold");
        ids.insert(best);
    }
    return {ids.begin(), ids.end()};
}

}
