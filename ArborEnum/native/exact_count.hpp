#pragma once
#include <cmath>
#include <algorithm>
#include <limits>
#include <string>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <vector>

namespace arborenum::live {
// Only the nonnegative arithmetic required by inside/outside tree counting.
// Counts never saturate at the engine's legacy uint64_t histogram limit.
class ExactCount {
    static constexpr uint64_t base = 1000000000;
    std::vector<uint32_t> digits_;
public:
    ExactCount(uint64_t n = 0) { while (n) { digits_.push_back(uint32_t(n % base)); n /= base; } }
    bool zero() const { return digits_.empty(); }
    ExactCount& operator+=(const ExactCount& b) {
        digits_.resize(std::max(digits_.size(), b.digits_.size()), 0);
        uint64_t carry = 0;
        for (size_t i = 0; i < digits_.size(); ++i) {
            const uint64_t sum = uint64_t(digits_[i]) + (i < b.digits_.size() ? b.digits_[i] : 0) + carry;
            digits_[i] = uint32_t(sum % base); carry = sum / base;
        }
        if (carry) digits_.push_back(uint32_t(carry));
        return *this;
    }
    friend ExactCount operator*(const ExactCount& a, const ExactCount& b) {
        ExactCount out;
        if (a.zero() || b.zero()) return out;
        out.digits_.assign(a.digits_.size() + b.digits_.size(), 0);
        for (size_t i = 0; i < a.digits_.size(); ++i) {
            uint64_t carry = 0;
            for (size_t j = 0; j < b.digits_.size() || carry; ++j) {
                const uint64_t value = out.digits_[i + j] + carry + (j < b.digits_.size() ? uint64_t(a.digits_[i]) * b.digits_[j] : 0);
                out.digits_[i + j] = uint32_t(value % base); carry = value / base;
            }
        }
        while (!out.digits_.empty() && out.digits_.back() == 0) out.digits_.pop_back();
        return out;
    }
    std::string str() const {
        if (zero()) return "0";
        std::ostringstream out; out << digits_.back();
        for (size_t i = digits_.size() - 1; i > 0; --i) out << std::setw(9) << std::setfill('0') << digits_[i - 1];
        return out.str();
    }
    long double log_value() const {
        if (zero()) return -std::numeric_limits<long double>::infinity();
        long double leading = digits_.back();
        if (digits_.size() > 1) leading += static_cast<long double>(digits_[digits_.size() - 2]) / base;
        return std::log(leading) + (digits_.size() - 1) * std::log(static_cast<long double>(base));
    }
    double fraction(const ExactCount& denominator) const {
        if (zero() || denominator.zero()) return 0;
        return double(std::exp(log_value() - denominator.log_value()));
    }
};
}
