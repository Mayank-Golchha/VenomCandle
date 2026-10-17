// ============================================================
// VOLUME_PROFILE.CPP — Ultra-high-performance Volume Profile Engine
// ============================================================
//
// PERFORMANCE CHARACTERISTICS:
//   - addTick():           O(1) amortized (direct index into flat vector)
//   - recomputeIfDirty():  O(N) over levels, but only when dirty
//   - buildDirtyMessage(): O(D) where D = number of dirty levels
//   - Memory:              ~40 bytes per price level, contiguous
//   - No allocations after warm-up (vector pre-reserved)
//   - No floating-point in the hot path (fixed-point integer prices)
//

#include "volume_profile.h"
#include "config.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <numeric>
#include <iomanip>
#include <sstream>

static std::string volumeNumber(double value)
{
    std::ostringstream out;
    out << std::setprecision(12) << value;
    return out.str();
}

// ============================================================
// GLOBAL INSTANCE
// ============================================================

std::mutex g_volumeProfileMutex;
std::unordered_map<std::string, VolumeProfileEngine> g_volumeProfilesBySymbol;
static std::unordered_map<std::string, int> g_sessionProfileDayBySymbol;

VolumeProfileEngine& volumeProfileForSymbol(const std::string& symbol) {
    SYSTEMTIME now{};
    GetLocalTime(&now);
    const int day = now.wYear * 10000 + now.wMonth * 100 + now.wDay;
    auto& profile = g_volumeProfilesBySymbol.try_emplace(symbol).first->second;
    auto& storedDay = g_sessionProfileDayBySymbol[symbol];
    if (storedDay != day) {
        profile.reset();
        storedDay = day;
    }
    return profile;
}

// ============================================================
// CONSTRUCTOR
// ============================================================

VolumeProfileEngine::VolumeProfileEngine()
{
    // Pre-reserve for typical instrument price ranges.
    // For GoldPetal at ~6000-7000: (7000-6000)*100 = 100,000 levels
    // at 0.01 granularity. Most instruments need far fewer.
    levels_.reserve(4096);
    dirty_.reserve(4096);
}

// ============================================================
// FIXED-POINT CONVERSIONS
// ============================================================

int64_t VolumeProfileEngine::toFixedPrice(double price)
{
    // Round to nearest tick to avoid floating-point drift.
    // For PRICE_SCALE=100: 6543.21 -> 654321
    return (int64_t)std::llround(price * PRICE_SCALE);
}

double VolumeProfileEngine::fromFixedPrice(int64_t fp)
{
    return (double)fp / (double)PRICE_SCALE;
}

// ============================================================
// ENSURE LEVEL — grow the vector to cover a new price
// ============================================================

size_t VolumeProfileEngine::ensureLevel(int64_t fixedPrice)
{
    if (!initialized_) {
        // First tick ever: initialize base price.
        basePrice_ = fixedPrice;
        initialized_ = true;

        levels_.resize(1);
        levels_[0].price = fixedPrice;
        dirty_.resize(1, false);
        return 0;
    }

    // Calculate the index relative to basePrice_.
    const int64_t offset = fixedPrice - basePrice_;
    const int64_t idx = offset / tickSize_;

    if (idx >= 0 && (size_t)idx < levels_.size()) {
        // Already covered — O(1) fast path.
        return (size_t)idx;
    }

    if (idx >= 0) {
        // Price is above our current range. Append levels.
        const size_t newSize = (size_t)idx + 1;
        const size_t oldSize = levels_.size();

        levels_.resize(newSize);
        dirty_.resize(newSize, false);

        for (size_t i = oldSize; i < newSize; ++i) {
            levels_[i] = PriceLevel{};
            levels_[i].price = basePrice_ + (int64_t)i * tickSize_;
        }

        return (size_t)idx;
    }

    // idx < 0: Price is below our current base. Prepend levels.
    const size_t count = (size_t)(-idx);
    const size_t oldSize = levels_.size();
    const size_t newSize = oldSize + count;

    // Save old dirty bits before resize
    std::vector<bool> oldDirty = dirty_;

    levels_.resize(newSize);
    dirty_.assign(newSize, false);

    // Shift existing data up by `count` positions (back-to-front to avoid overlap).
    for (size_t i = oldSize; i > 0; --i) {
        levels_[i - 1 + count] = levels_[i - 1];
        dirty_[i - 1 + count] = oldDirty[i - 1];
    }

    // Initialize the new prefix levels.
    const int64_t newBase = basePrice_ - (int64_t)count * tickSize_;
    for (size_t i = 0; i < count; ++i) {
        levels_[i] = PriceLevel{};
        levels_[i].price = newBase + (int64_t)i * tickSize_;
        dirty_[i] = false;
    }

    basePrice_ = newBase;

    // The requested price is at index 0 (since offset == -count * tickSize_).
    return 0;
}

// ============================================================
// ADD TICK — O(1) hot path
// ============================================================

void VolumeProfileEngine::addTick(double rawPrice, Side side, double qty)
{
    if (qty == 0) return;

    const int64_t fp = toFixedPrice(rawPrice);
    const size_t idx = ensureLevel(fp);

    PriceLevel& level = levels_[idx];

    // Preserve fractional trade sizes for markets such as crypto.
    level.totalVolume += qty;

    if (side == Side::Buy) {
        level.buyVolume += qty;
        level.delta += qty;
    } else if (side == Side::Sell) {
        level.sellVolume += qty;
        level.delta -= qty;
    }
    // Side::Other contributes to totalVolume only.

    // Mark dirty.
    if (idx < dirty_.size()) {
        dirty_[idx] = true;
        anyDirty_ = true;
    }
}

// ============================================================
// RECOMPUTE POC / VAH / VAL — only when dirty
// ============================================================

void VolumeProfileEngine::recomputeIfDirty()
{
    if (!anyDirty_ || levels_.empty()) return;

    // Find POC (price level with highest total volume).
    double maxVol = 0;
    size_t pocIdx = 0;
    double totalSessionVolume = 0;

    for (size_t i = 0; i < levels_.size(); ++i) {
        totalSessionVolume += levels_[i].totalVolume;
        if (levels_[i].totalVolume > maxVol) {
            maxVol = levels_[i].totalVolume;
            pocIdx = i;
        }
    }

    poc_ = levels_[pocIdx].price;

    // Compute Value Area: expand outward from POC until VALUE_AREA_PCT
    // of total volume is captured.
    if (totalSessionVolume == 0) {
        vah_ = poc_;
        val_ = poc_;
        return;
    }

    const double targetVolume = totalSessionVolume * VALUE_AREA_PCT;
    double areaVolume = levels_[pocIdx].totalVolume;

    size_t lo = pocIdx;
    size_t hi = pocIdx;

    while (areaVolume < targetVolume) {
        // Look one level up and one level down, pick whichever has more volume.
        const double upVol   = (hi + 1 < levels_.size()) ? levels_[hi + 1].totalVolume : 0;
        const double downVol = (lo > 0)                  ? levels_[lo - 1].totalVolume : 0;

        if (upVol == 0 && downVol == 0) break;

        if (upVol >= downVol) {
            ++hi;
            areaVolume += upVol;
        } else {
            --lo;
            areaVolume += downVol;
        }
    }

    val_ = levels_[lo].price;
    vah_ = levels_[hi].price;
}

// ============================================================
// BUILD DIRTY MESSAGE — only changed levels
// ============================================================

std::string VolumeProfileEngine::buildDirtyMessage()
{
    if (!anyDirty_ || levels_.empty()) return "";

    std::string json;
    json.reserve(4096);

    json += "{\"type\":\"vp\",\"poc\":";
    json += std::to_string(fromFixedPrice(poc_));
    json += ",\"vah\":";
    json += std::to_string(fromFixedPrice(vah_));
    json += ",\"val\":";
    json += std::to_string(fromFixedPrice(val_));
    json += ",\"step\":";
    json += std::to_string(displayStep_ > 0.0 ? displayStep_ : 1.0 / (double)PRICE_SCALE);
    json += ",\"levels\":[";

    bool first = true;
    int count = 0;

    for (size_t i = 0; i < levels_.size(); ++i) {
        if (!dirty_[i]) continue;
        if (levels_[i].totalVolume == 0) continue;  // skip empty levels

        if (VP_BATCH_LIMIT > 0 && count >= VP_BATCH_LIMIT) break;

        if (!first) json += ',';
        first = false;

        json += "{\"p\":";
        json += std::to_string(fromFixedPrice(levels_[i].price));
        json += ",\"b\":";
        json += volumeNumber(levels_[i].buyVolume);
        json += ",\"s\":";
        json += volumeNumber(levels_[i].sellVolume);
        json += ",\"t\":";
        json += volumeNumber(levels_[i].totalVolume);
        json += ",\"d\":";
        json += volumeNumber(levels_[i].delta);
        json += '}';

        dirty_[i] = false;
        ++count;
    }

    json += "]}";

    anyDirty_ = false;

    // If no levels were actually dirty (all had zero volume), return empty.
    if (first) return "";

    return json;
}

// ============================================================
// BUILD FULL SNAPSHOT — for new client connections
// ============================================================

std::string VolumeProfileEngine::buildFullSnapshot() const
{
    std::string json;
    json.reserve(8192);

    json += "{\"type\":\"vp_snapshot\",\"poc\":";
    json += std::to_string(fromFixedPrice(poc_));
    json += ",\"vah\":";
    json += std::to_string(fromFixedPrice(vah_));
    json += ",\"val\":";
    json += std::to_string(fromFixedPrice(val_));
    json += ",\"step\":";
    json += std::to_string(displayStep_ > 0.0 ? displayStep_ : 1.0 / (double)PRICE_SCALE);
    json += ",\"levels\":[";

    bool first = true;
    for (size_t i = 0; i < levels_.size(); ++i) {
        if (levels_[i].totalVolume == 0) continue;

        if (!first) json += ',';
        first = false;

        json += "{\"p\":";
        json += std::to_string(fromFixedPrice(levels_[i].price));
        json += ",\"b\":";
        json += volumeNumber(levels_[i].buyVolume);
        json += ",\"s\":";
        json += volumeNumber(levels_[i].sellVolume);
        json += ",\"t\":";
        json += volumeNumber(levels_[i].totalVolume);
        json += ",\"d\":";
        json += volumeNumber(levels_[i].delta);
        json += '}';
    }

    json += "]}";
    return json;
}

// ============================================================
// RESET
// ============================================================

void VolumeProfileEngine::reset()
{
    levels_.clear();
    dirty_.clear();
    basePrice_ = 0;
    initialized_ = false;
    anyDirty_ = false;
    poc_ = 0;
    vah_ = 0;
    val_ = 0;
}

// ============================================================
// FIXED RANGE VOLUME PROFILE — compute from candle data
// ============================================================

std::string VolumeProfileEngine::computeFixedRange(int startIdx, int endIdx)
{
    std::vector<Candle> candles;

    {
        std::lock_guard<std::mutex> lock(g_state.candleMutex);

        if (startIdx < 0) startIdx = 0;
        if (endIdx >= (int)g_state.candles.size()) endIdx = (int)g_state.candles.size() - 1;
        if (startIdx > endIdx || g_state.candles.empty()) {
            return "{\"type\":\"vp_fixed\",\"poc\":0,\"vah\":0,\"val\":0,\"levels\":[]}";
        }

        candles.assign(g_state.candles.begin() + startIdx,
                       g_state.candles.begin() + endIdx + 1);
    }

    // Build a temporary VP engine for this range.
    // We distribute each candle's volume across the price levels it spans,
    // similar to how the frontend was doing it, but now with proper
    // fixed-point precision.

    // Find price range.
    double minPrice = 1e18, maxPrice = -1e18;
    for (const auto& c : candles) {
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
    }

    if (maxPrice <= minPrice) {
        return "{\"type\":\"vp_fixed\",\"poc\":0,\"vah\":0,\"val\":0,\"levels\":[]}";
    }

    const int64_t fpMin = toFixedPrice(minPrice);
    const int64_t fpMax = toFixedPrice(maxPrice);
    const size_t numLevels = (size_t)(fpMax - fpMin + 1);

    // Limit to a reasonable number of levels (max ~10000).
    const int64_t step = (numLevels > 10000) ? (int64_t)((fpMax - fpMin) / 10000 + 1) : 1;
    const size_t actualLevels = (size_t)((fpMax - fpMin) / step + 1);

    std::vector<PriceLevel> levels(actualLevels);
    for (size_t i = 0; i < actualLevels; ++i) {
        levels[i].price = fpMin + (int64_t)i * step;
    }

    // Distribute candle volume across touched levels.
    for (const auto& c : candles) {
        const int64_t fpLow  = toFixedPrice(c.low);
        const int64_t fpHigh = toFixedPrice(c.high);

        const size_t loIdx = (size_t)std::max((int64_t)0, (fpLow  - fpMin) / step);
        const size_t hiIdx = (size_t)std::min((int64_t)(actualLevels - 1), (fpHigh - fpMin) / step);

        const size_t count = (hiIdx >= loIdx) ? (hiIdx - loIdx + 1) : 1;
        const double share = c.volume / static_cast<double>(count);

        for (size_t i = loIdx; i <= hiIdx; ++i) {
            levels[i].totalVolume += (share > 0) ? share : 1;
        }
    }

    // Compute POC, VAH, VAL.
    double maxVol = 0;
    size_t pocIdx = 0;
    double totalVol = 0;

    for (size_t i = 0; i < actualLevels; ++i) {
        totalVol += levels[i].totalVolume;
        if (levels[i].totalVolume > maxVol) {
            maxVol = levels[i].totalVolume;
            pocIdx = i;
        }
    }

    int64_t poc = levels[pocIdx].price;
    int64_t vah = poc;
    int64_t val = poc;

    if (totalVol > 0) {
        const double target = totalVol * VALUE_AREA_PCT;
        double area = levels[pocIdx].totalVolume;
        size_t lo = pocIdx, hi = pocIdx;

        while (area < target) {
            const double upVol   = (hi + 1 < actualLevels) ? levels[hi + 1].totalVolume : 0;
            const double downVol = (lo > 0) ? levels[lo - 1].totalVolume : 0;
            if (upVol == 0 && downVol == 0) break;

            if (upVol >= downVol) { ++hi; area += upVol; }
            else                  { --lo; area += downVol; }
        }

        val = levels[lo].price;
        vah = levels[hi].price;
    }

    // Build JSON response.
    std::string json;
    json.reserve(8192);

    json += "{\"type\":\"vp_fixed\",\"poc\":";
    json += std::to_string(fromFixedPrice(poc));
    json += ",\"vah\":";
    json += std::to_string(fromFixedPrice(vah));
    json += ",\"val\":";
    json += std::to_string(fromFixedPrice(val));
    json += ",\"start_idx\":";
    json += std::to_string(startIdx);
    json += ",\"end_idx\":";
    json += std::to_string(endIdx);
    json += ",\"levels\":[";

    bool first = true;
    for (size_t i = 0; i < actualLevels; ++i) {
        if (levels[i].totalVolume == 0) continue;

        if (!first) json += ',';
        first = false;

        json += "{\"p\":";
        json += std::to_string(fromFixedPrice(levels[i].price));
        json += ",\"b\":";
        json += volumeNumber(levels[i].buyVolume);
        json += ",\"s\":";
        json += volumeNumber(levels[i].sellVolume);
        json += ",\"t\":";
        json += volumeNumber(levels[i].totalVolume);
        json += ",\"d\":";
        json += volumeNumber(levels[i].delta);
        json += '}';
    }

    json += "]}";
    return json;
}
