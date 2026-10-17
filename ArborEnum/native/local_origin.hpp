#pragma once
#include <algorithm>
#include <charconv>
#include <cctype>
#include <string>
#include <string_view>

namespace arborenum::live {
// Desktop previews can preserve their public loopback Host or rewrite it to the
// backend's loopback port. Trust explicit loopback names rather than one port;
// never trust forwarded host headers or resolve arbitrary names through DNS.
inline bool is_loopback_authority(std::string_view authority) {
    std::string host;
    std::string_view suffix;
    if (authority.starts_with('[')) {
        const auto end = authority.find(']');
        if (end == std::string_view::npos) return false;
        host = authority.substr(0, end + 1);
        suffix = authority.substr(end + 1);
    } else {
        const auto colon = authority.find(':');
        host = authority.substr(0, colon);
        if (colon != std::string_view::npos) suffix = authority.substr(colon);
    }
    std::transform(host.begin(), host.end(), host.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    if (host != "localhost" && host != "127.0.0.1" && host != "[::1]") return false;
    if (suffix.empty()) return true;
    if (!suffix.starts_with(':')) return false;
    suffix.remove_prefix(1);
    if (suffix.empty() || suffix.size() > 5) return false;
    unsigned port = 0;
    const auto parsed = std::from_chars(suffix.data(), suffix.data() + suffix.size(), port);
    return parsed.ec == std::errc{} && parsed.ptr == suffix.data() + suffix.size() && port > 0 && port <= 65535;
}

inline bool is_local_browser_request(std::string_view host, std::string_view origin) {
    if (!is_loopback_authority(host)) return false;
    if (origin.empty()) return true;
    for (const auto scheme : {std::string_view("http://"), std::string_view("https://")}) {
        if (origin.starts_with(scheme)) return is_loopback_authority(origin.substr(scheme.size()));
    }
    return false;
}
}
