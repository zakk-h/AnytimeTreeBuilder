#pragma once
#include <cmath>
#include <algorithm>
#include <limits>
#include <string>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <vector>
#include <array>

namespace arborenum::live {
// Only the nonnegative arithmetic required by inside/outside tree counting.
// Counts never saturate at the engine's legacy uint64_t histogram limit.
class ExactCount {
    static constexpr uint64_t base = 1000000000;
    // Most subtree counts fit in a machine word. Promote only on overflow,
    // avoiding heap allocation for every product in the convolution loops.
    uint64_t small_ = 0;
    std::vector<uint32_t> digits_;
    void promote() {
        for (auto n = small_; n; n /= base) digits_.push_back(uint32_t(n % base));
        small_ = 0;
    }
    static std::pair<const uint32_t*, size_t> digit_view(const ExactCount& n, std::array<uint32_t, 3>& scratch) {
        if (!n.digits_.empty()) return {n.digits_.data(), n.digits_.size()};
        size_t size = 0;
        for (auto value = n.small_; value; value /= base) scratch[size++] = uint32_t(value % base);
        return {scratch.data(), size};
    }
public:
    ExactCount(uint64_t n = 0) : small_(n) {}
    bool zero() const { return digits_.empty() && small_ == 0; }
    ExactCount& operator+=(const ExactCount& b) {
        if (digits_.empty() && b.digits_.empty() && small_ <= UINT64_MAX - b.small_) {
            small_ += b.small_; return *this;
        }
        if (digits_.empty()) promote();
        std::array<uint32_t, 3> small_digits{}; size_t size = 0;
        if (b.digits_.empty()) for (auto n = b.small_; n; n /= base) small_digits[size++] = uint32_t(n % base);
        else size = b.digits_.size();
        digits_.resize(std::max(digits_.size(), size), 0);
        uint64_t carry = 0;
        for (size_t i = 0; i < digits_.size(); ++i) {
            const uint64_t digit = i < size ? (b.digits_.empty() ? small_digits[i] : b.digits_[i]) : 0;
            const uint64_t sum = uint64_t(digits_[i]) + digit + carry;
            digits_[i] = uint32_t(sum % base); carry = sum / base;
        }
        if (carry) digits_.push_back(uint32_t(carry));
        return *this;
    }
    friend ExactCount operator*(const ExactCount& a, const ExactCount& b) {
        if (a.zero() || b.zero()) return ExactCount();
        if (a.digits_.empty() && b.digits_.empty() && a.small_ <= UINT64_MAX / b.small_)
            return ExactCount(a.small_ * b.small_);
        std::array<uint32_t, 3> ad{}, bd{};
        const auto [ap, an] = digit_view(a, ad); const auto [bp, bn] = digit_view(b, bd);
        ExactCount out; out.digits_.assign(an + bn, 0);
        for (size_t i = 0; i < an; ++i) {
            uint64_t carry = 0;
            for (size_t j = 0; j < bn || carry; ++j) {
                const uint64_t value = out.digits_[i + j] + carry + (j < bn ? uint64_t(ap[i]) * bp[j] : 0);
                out.digits_[i + j] = uint32_t(value % base); carry = value / base;
            }
        }
        while (!out.digits_.empty() && out.digits_.back() == 0) out.digits_.pop_back();
        return out;
    }
    std::string str() const {
        if (digits_.empty()) return std::to_string(small_);
        std::ostringstream out; out << digits_.back();
        for (size_t i = digits_.size() - 1; i > 0; --i) out << std::setw(9) << std::setfill('0') << digits_[i - 1];
        return out.str();
    }
    long double log_value() const {
        if (zero()) return -std::numeric_limits<long double>::infinity();
        if (digits_.empty()) return std::log(static_cast<long double>(small_));
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
