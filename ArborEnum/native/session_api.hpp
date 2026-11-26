#pragma once
#include "vendor/json.hpp"
#include <memory>
#include <stdexcept>
#include <string>

namespace arborenum::service {
using json = nlohmann::json;
class QueryUnavailable : public std::runtime_error { public: using std::runtime_error::runtime_error; };
class SessionApi {
public:
    virtual ~SessionApi() = default;
    virtual void shutdown() = 0;
    virtual void stop() = 0;
    virtual void cancel_analysis(const std::string&) = 0;
    virtual bool done() const = 0;
    virtual json metadata() const = 0;
    virtual json query(std::string, json) = 0;
    virtual json start_analysis(json) = 0;
    virtual json analysis_result(const std::string&) const = 0;
    virtual void request_budget(double) = 0;
    virtual json analysis_progress(const std::string&) const = 0;
    virtual json status() const = 0;
};
std::shared_ptr<SessionApi> make_regression_session(std::string id, const json& body);
}
