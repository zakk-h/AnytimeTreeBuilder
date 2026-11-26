#define ARBORENUM_REGRESSION
#define ARBORENUM_LIVE_NAMESPACE arborenum::regression_live
#include "live_session.hpp"

std::shared_ptr<arborenum::service::SessionApi> arborenum::service::make_regression_session(std::string id, const json& body) {
    return std::make_shared<arborenum::regression_live::Session>(std::move(id), arborenum::regression_live::Dataset::parse(body), arborenum::regression_live::Settings::parse(body.value("settings", json::object())));
}
