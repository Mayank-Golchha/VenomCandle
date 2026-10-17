// ============================================================
// TICK_PROCESSOR.CPP — Aggressor classification + flow aggregation
// ============================================================
//
// This is the hot path. Every normalized broker tick flows through
// here. It classifies the trade, aggregates into flow buckets,
// broadcasts completed buckets, and feeds the Volume Profile engine.
//

#include "tick_processor.h"
#include "config.h"
#include "server.h"
#include "volume_profile.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <unordered_map>

static std::string volumeNumber(double value)
{
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.12g", value);
    return buffer;
}

// ============================================================
// AGGRESSOR CLASSIFICATION
// ============================================================

Side classifyTrade(const Tick& tick, const Tick& previous)
{
    // Strongest signal: trade printed at/through the current quote.
    if (tick.ask > 0.0 && tick.ltp >= tick.ask)
        return Side::Buy;

    if (tick.bid > 0.0 && tick.ltp <= tick.bid)
        return Side::Sell;

    // Quote movement can make the current quote differ from the quote
    // that existed when the trade actually occurred.
    if (previous.ask > 0.0 && tick.ltp >= previous.ask)
        return Side::Buy;

    if (previous.bid > 0.0 && tick.ltp <= previous.bid)
        return Side::Sell;

    // A trade inside the spread cannot be reliably classified from
    // LTP + top-of-book alone.
    return Side::Other;
}

// ============================================================
// FLOW BUCKET TIME
// ============================================================

static uint64_t bucketTime(uint64_t t)
{
    // Provider timestamps are normalized to epoch milliseconds by the adapter.
    // If a feed gives seconds, normalize it here.
    if (t < 100000000000ULL) t *= 1000ULL;
    return (t / AGGREGATION_MS) * AGGREGATION_MS;
}

static bool isNseCashSymbol(const std::string& symbol)
{
    return symbol.rfind("NSE:", 0) == 0 && symbol.size() >= 3 &&
        symbol.compare(symbol.size() - 3, 3, "-EQ") == 0;
}

static bool isInsideNseSession(int64_t epochMs)
{
    constexpr int64_t INDIA_OFFSET_MS = 19'800'000;
    constexpr int64_t DAY_MS = 86'400'000;
    const int64_t localMs = epochMs + INDIA_OFFSET_MS;
    const int64_t day = localMs / DAY_MS;
    const int64_t withinDayMs = localMs % DAY_MS;
    const int weekday = static_cast<int>((day + 4) % 7); // 0=Sun, 6=Sat
    const int minuteOfDay = static_cast<int>(withinDayMs / 60'000);
    return weekday >= 1 && weekday <= 5 && minuteOfDay >= 9 * 60 + 15 && minuteOfDay < 15 * 60 + 30;
}

static bool isRecentExchangeTime(const std::string& symbol, uint64_t timestamp)
{
    if (timestamp < 100000000000ULL) timestamp *= 1000ULL;
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    constexpr int64_t MAX_AGE_MS = 90'000;
    constexpr int64_t MAX_FUTURE_MS = 10'000;
    const int64_t tickTime = static_cast<int64_t>(timestamp);
    if (tickTime > now + MAX_FUTURE_MS || tickTime < now - MAX_AGE_MS) return false;
    // The original project used an MCX future (09:00–23:30). Search now
    // selects NSE cash equities, whose session ends at 15:30 India time.
    if (isNseCashSymbol(symbol) && (!isInsideNseSession(tickTime) || !isInsideNseSession(now))) return false;
    return true;
}

static double equityTickSize(const std::string& symbol, double price)
{
    // NSE cash instruments trade in 5 paise increments. Keep the legacy
    // price-tier grid for futures and other instruments.
    if (symbol.rfind("NSE:", 0) == 0 && symbol.find("-EQ") != std::string::npos) return 0.05;
    if (price < 250.0) return 0.01;
    if (price <= 1000.0) return 0.05;
    if (price <= 5000.0) return 0.10;
    // if (price <= 5000.0) return 0.20;
    if (price <= 10000.0) return 0.50;
    if (price <= 20000.0) return 1.00;
    return 5.00;
}

static bool isCryptoProduct(const std::string& symbol)
{
    // Coinbase spot product IDs are formatted as BASE-QUOTE (for example BTC-USD).
    return symbol.find(':') == std::string::npos && symbol.find('-') != std::string::npos;
}

static double cryptoFootprintTickSize(double price)
{
    // Display aggregation, not the exchange's minimum order price increment.
    // Scale the rows with the asset price so BTC does not create hundreds of
    // nearly indistinguishable levels in an ordinary candle.
    if (price >= 10000.0) return 50.0;
    if (price >= 1000.0) return 5.0;
    if (price >= 100.0) return 0.5;
    if (price >= 10.0) return 0.05;
    return 0.01;
}

static uint64_t candleTime(uint64_t t)
{
    if (t < 100000000000ULL) t *= 1000ULL;
    return (t / 60000ULL) * 60000ULL;
}

// Use one tick size for a candle so every footprint level shares the same grid.
static double footprintTickSize(const std::string& symbol, uint64_t time, double price)
{
    static std::unordered_map<std::string, std::pair<uint64_t, double>> activeBySymbol;
    const uint64_t candle = candleTime(time);
    auto& active = activeBySymbol[symbol];
    if (candle != active.first) {
        active.first = candle;
        active.second = isCryptoProduct(symbol) ? cryptoFootprintTickSize(price) : equityTickSize(symbol, price);
    }
    return active.second;
}

// ============================================================
// VP BROADCAST TIMER
// ============================================================

static auto g_lastVpBroadcast = std::chrono::steady_clock::now();

// ============================================================
// PROCESS TICK
// ============================================================

void processTick(const Tick& tick)
{
    if (tick.symbol.empty()) return;
    // Some feeds may repeat a cached quote carrying the last exchange timestamp.
    // Do not let yesterday's last tick mutate a historical candle or session VP.
    if (!isRecentExchangeTime(tick.symbol, tick.time)) return;
    Side side = Side::Other;
    Tick previous;
    static std::unordered_map<std::string, Tick> previousBySymbol;
    static std::unordered_map<std::string, bool> havePreviousBySymbol;
    if (havePreviousBySymbol[tick.symbol]) {
        previous = previousBySymbol[tick.symbol];
            side = classifyTrade(tick, previous);
    }
    previousBySymbol[tick.symbol] = tick;
    havePreviousBySymbol[tick.symbol] = true;

    // ---- Feed Volume Profile Engine (O(1) per tick) ----
    bool isActive = false;
    const double levelTickSize = footprintTickSize(tick.symbol, tick.time, tick.ltp);
    {
        std::scoped_lock lock(g_state.marketMutex, g_volumeProfileMutex);
        isActive = tick.symbol == g_state.activeSymbol;
        auto& profile = volumeProfileForSymbol(tick.symbol);
        profile.addTick(tick.ltp, side, tick.qty);
        // Session VP levels remain stored at PRICE_SCALE resolution. Footprint
        // aggregation uses its own instrument tick grid.
        profile.setDisplayStep(1.0 / static_cast<double>(PRICE_SCALE));
    }

    const double levelPrice = std::round(tick.ltp / levelTickSize) * levelTickSize;
    const int64_t levelKey = static_cast<int64_t>(std::llround(levelPrice * PRICE_SCALE));

    // ---- Flow aggregation (unchanged from original) ----
    const uint64_t b = bucketTime(tick.time);

    FlowPacket toSend{};
    bool shouldSend = false;
    static std::unordered_map<std::string, FlowPacket> flowsBySymbol;
    static std::unordered_map<std::string, bool> flowHasDataBySymbol;
    {
        std::lock_guard<std::mutex> lock(g_state.flowMutex);
        auto& flow = flowsBySymbol[tick.symbol];
        auto& hasData = flowHasDataBySymbol[tick.symbol];
        if (!hasData) {
            flow = {};
            flow.time = b;
            hasData = true;
        } else if (b != flow.time) {
            toSend = flow;
            shouldSend = true;
            flow = {};
            flow.time = b;
        }
        flow.footprintTickSize = levelTickSize;
        flow.ltp = tick.ltp;
        if (tick.qty > 0) {
            FlowFootprintLevel& level = flow.footprint[levelKey];
            if (side == Side::Buy) level.buy += tick.qty;
            else if (side == Side::Sell) level.sell += tick.qty;
            else level.other += tick.qty;
        }

        if (side == Side::Buy)
            flow.aggressiveBuying += tick.qty;
        else if (side == Side::Sell)
            flow.aggressiveSelling += tick.qty;
    }

    if (shouldSend) {
        std::string json = "{\"type\":\"flow\",\"symbol\":\"" + tick.symbol + "\",\"time\":";
        json += std::to_string(toSend.time);
        json += ",\"ltp\":";
        json += std::to_string(toSend.ltp);
        json += ",\"aggressive_buying\":";
        json += volumeNumber(toSend.aggressiveBuying);
        json += ",\"aggressive_selling\":";
        json += volumeNumber(toSend.aggressiveSelling);
        json += ",\"footprint_tick_size\":";
        json += std::to_string(toSend.footprintTickSize);
        json += ",\"footprint\":[";
        bool firstLevel = true;
        for (const auto& [priceKey, level] : toSend.footprint) {
            if (!firstLevel) json += ',';
            firstLevel = false;
            json += "{\"price\":";
            json += std::to_string(static_cast<double>(priceKey) / PRICE_SCALE);
            json += ",\"buy\":" + volumeNumber(level.buy);
            json += ",\"sell\":" + volumeNumber(level.sell);
            json += ",\"other\":" + volumeNumber(level.other) + "}";
        }
        json += ']';
        json += '}';
        broadcast(json);

        // ---- VP broadcast on timer ----
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - g_lastVpBroadcast).count();

        if (isActive && (VP_BROADCAST_MS == 0 || elapsed >= VP_BROADCAST_MS)) {
            std::scoped_lock lock(g_state.marketMutex, g_volumeProfileMutex);
            if (tick.symbol != g_state.activeSymbol) return;
            auto& profile = volumeProfileForSymbol(tick.symbol);
            profile.recomputeIfDirty();
            std::string vpMsg = profile.buildDirtyMessage();
            if (!vpMsg.empty()) {
                const auto marker = vpMsg.find("\"type\":\"vp\"");
                if (marker != std::string::npos) vpMsg.insert(marker, "\"symbol\":\"" + tick.symbol + "\",");
                broadcast(vpMsg);
            }
            g_lastVpBroadcast = now;
        }
    }
}
