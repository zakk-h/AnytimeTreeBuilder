#define ARBORENUM_LOGISTIC 1
#define ARBORENUM_REGRESSION 1
#define ARBORENUM_LIVE_NAMESPACE arborenum::logistic_live
#include "live_session.hpp"

std::shared_ptr<arborenum::service::SessionApi> arborenum::service::make_logistic_session(std::string id, const json& body) {
    return std::make_shared<arborenum::logistic_live::Session>(std::move(id), arborenum::logistic_live::Dataset::parse(body), arborenum::logistic_live::Settings::parse(body.value("settings", json::object())));
}
