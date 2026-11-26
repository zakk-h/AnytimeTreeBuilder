#define ARBORENUM_LOGISTIC 1
#define ARBORENUM_REGRESSION
#define ARBORENUM_LIVE_NAMESPACE arborenum::logistic_live
#include "../live_session.hpp"

using namespace arborenum::logistic_live;
static void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}
static json root() { return {{"uid", 0}, {"kind", "choice"}}; }
static int depth(const json& tree) {
    return tree.at("kind") == "leaf" ? 0 : 1 + std::max(depth(tree.at("left")), depth(tree.at("right")));
}
static double predict(const json& tree, const json& registry, const std::vector<double>& row) {
    if (tree.at("kind") == "leaf") return tree.at("prediction").get<double>();
    for (const auto& feature : registry) if (feature.at("internalFeature") == tree.at("feature"))
        return predict(tree.at(row.at(feature.at("originalFeature").get<size_t>()) <= feature.at("threshold").get<double>() ? "left" : "right"), registry, row);
    throw std::runtime_error("Unknown split");
}
static json run(json settings, bool abstain = false) {
    Dataset data;
    data.names = {"x", "binary"};
    data.X = {{0,0}, {0,0}, {1,0}, {2,1}, {3,1}, {4,1}};
    data.y = {0,1,0,1,0,1};
    data.classes = {"0", "1"};
    data.base_logits = {-1.2,.7,.2,-.8,1.1,.3};
    const auto original = data;
    Session session("test", std::move(data), Settings::parse(settings));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
    while (!session.done() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    const auto status = session.status();
    require(status.at("phase") == "finished", "Logistic training failed: " + status.dump());
    require(status.at("ready").get<bool>(), "No logistic tree");
    const auto meta = session.metadata();
    require(meta.at("task") == "logistic" && meta.at("classNames").size() == 2, "Incorrect logistic metadata");
    require(std::abs(meta.at("gamma").get<double>() - .06) < 1e-14, "Leaf penalty rounded");
    const auto view = session.query("node", {{"tree", root()}, {"active_uid", 0}});
    require(view.at("options").at("leaves").size() + view.at("options").at("splits").size() > 0, "No live options");
    const auto complete = session.query("complete", {{"tree", root()}, {"active_uid", 0}, {"next_uid", 1}, {"mode", "optimal"}, {"seed", 7}});
    require(depth(complete.at("tree")) <= 2 + settings.value("proxy_delta", 0), "Proxy extension exceeds depth");
    const auto full = session.query("analyze", {{"tree", root()}});
    require(full.at("disagreement").empty(), "Logistic has classification disagreement");
    require(abstain || full.at("log_loss").is_object(), "Missing logistic log loss");
    require(full.at("tree_count").get<std::string>() != "0", "Empty logistic count");
    require(full.at("importance").size() == 2, "Missing logistic importance");
    if (!abstain) {
        const auto fixed = session.query("analyze", {{"tree", complete.at("tree")}});
        require(fixed.at("tree_count") == "1", "Completed tree has multiple completions");
        long double mse = 0;
        for (size_t i = 0; i < original.y.size(); ++i) {
            const double score = (1 - 2 * original.y[i]) * (original.base_logits[i] + predict(complete.at("tree"), meta.at("featureRegistry"), original.X[i]));
            mse += (std::max(0.0, score) + std::log1p(std::exp(-std::abs(score)))) / original.y.size();
        }
        require(std::abs(fixed.at("log_loss").at("min").get<double>() - mse) < 1e-12, "Incorrect log loss");
        for (size_t feature = 0; feature < 2; ++feature) {
            long double changed = 0;
            for (size_t i = 0; i < original.y.size(); ++i) for (size_t j = 0; j < original.y.size(); ++j) {
                auto row = original.X[i]; row[feature] = original.X[j][feature];
                const double score = (1 - 2 * original.y[i]) * (original.base_logits[i] + predict(complete.at("tree"), meta.at("featureRegistry"), row));
                changed += (std::max(0.0, score) + std::log1p(std::exp(-std::abs(score)))) / (original.y.size() * original.y.size());
            }
            const auto expected = changed - mse;
            const auto& bound = fixed.at("importance").at(feature);
            require(std::abs(bound.at("min_ratio").get<double>() - (1 + expected / mse)) < 1e-12, "Incorrect logistic importance ratio");
            require(std::abs(bound.at("min").get<double>() - expected) < 1e-12 && std::abs(bound.at("max").get<double>() - expected) < 1e-12, "Incorrect logistic permutation importance");
        }
    }
    const auto budget = view.at("root_budget").get<double>();
    session.request_budget(budget + .012345);
    require(std::abs(session.status().at("requested_budget").get<double>() - budget - .012345) < 1e-12, "Fractional budget rounded");
    session.query("complete", {{"tree", root()}, {"active_uid", 0}, {"next_uid", 1}, {"mode", "constrained"}, {"constraint", {{"mode", "avoid"}, {"maxLeaves", 8}}}});
    session.shutdown();
    return full;
}
int main() {
    json settings = {{"depth_budget",2}, {"lambda_reg",.01}, {"rashomon_mult",.1}, {"second_rashomon_mult",.2}, {"multiplier_step_size",.1}, {"xgboost_estimators",2}, {"runtime_limit_seconds",10}, {"memory_limit_mb",2048}, {"proxy_mode","continuous"}};
    auto dense = run(settings);
    auto zeros = settings; zeros["sparsification_probability"] = {0.,0.};
    require(run(zeros).at("tree_count") == dense.at("tree_count"), "Zero probabilities changed enumeration");
    auto sparse = settings; sparse["sparsification_probability"] = {1.,1.}; sparse["sparsification_seed"] = 7;
    run(sparse); sparse["sparsification_cache_proxy_splits"] = false; run(sparse);
    auto extended = sparse; extended["proxy_delta"] = 1; run(extended);
    auto greedy = settings; greedy["lookahead_k"] = 0; greedy["proxy_mode"] = "binarized"; run(greedy);
    auto hybrid = settings; hybrid["proxy_mode"] = "hybrid"; run(hybrid);
    std::cout << "Logistic live sessions, sparsification, proxy extension, fractional budgets, log loss and permutation importance passed\n";
}
