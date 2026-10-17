// ============================================================
// DATA_LIVE.CPP — Fyers WebSocket live tick feed + callbacks
// ============================================================

#include "broker_adapters/fyers/data_live.h"
#include "config.h"
#include "core/json_parser.h"
#include "tick_processor.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <mutex>
#include <set>

// ============================================================
// CALLBACKS
// ============================================================

// SymbolUpdate can repeat last_traded_qty while quote fields continue changing.
// Use changes in the cumulative traded volume as the per-update trade quantity.
static std::mutex g_subscriptionsMutex;
static fyers_data_ws_t* g_liveWs = nullptr;
static std::set<std::string> g_subscribedSymbols;
static std::string normalizeSymbol(std::string s) {
    if (s.find(':') == std::string::npos) s = "NSE:" + s;
    return s;
}

namespace providers::fyers {
void requestSymbolSubscription(const std::string& rawSymbol) {
    const std::string symbol = normalizeSymbol(rawSymbol);
    std::lock_guard<std::mutex> lock(g_subscriptionsMutex);
    if (!g_liveWs || !g_subscribedSymbols.insert(symbol).second) return;
    std::vector<const char*> symbols;
    symbols.reserve(g_subscribedSymbols.size());
    for (const auto& item : g_subscribedSymbols) symbols.push_back(item.c_str());
    const fyers_error_t err = fyers_data_ws_subscribe(g_liveWs, symbols.data(), symbols.size(), FYERS_DATA_TYPE_SYMBOL_UPDATE, 11);
    std::printf("[FYERS] Updated %zu symbol subscriptions (result=%d)\n", symbols.size(), err);
    if (err != FYERS_OK) g_subscribedSymbols.erase(symbol);
}
} // namespace providers::fyers

void onMessage(fyers_data_ws_t*, const char* json)
{
    if (!json) return;

    const size_t len = std::strlen(json);
    const bool isIndexFeed = isType(json, len, "if");
    if (!isIndexFeed && !isType(json, len, "sf"))
        return;

    Tick tick{};
    size_t pos = 0;
    if (!getString(json, len, "symbol", pos, tick.symbol)) return;
    tick.symbol = normalizeSymbol(tick.symbol);
    pos = 0;

    if (!getDouble(json, len, "ltp", pos, tick.ltp)) return;
    tick.hasCumulativeVolume = getUInt64(json, len, "vol_traded_today", pos, tick.volumeTradedToday);
    // Preserve the original feed contract: flow and candle buckets follow the
    // exchange feed timestamp, including quote updates with zero traded volume.
    if (!getUInt64(json, len, "exch_feed_time", pos, tick.time)) return;

    // Keep cursor order matching the Fyers feed parser:
    // bid_size, ask_size, bid_price, ask_price, last_traded_qty.
    uint32_t ignoredBidSize = 0, ignoredAskSize = 0;
    getUInt32(json, len, "bid_size", pos, ignoredBidSize);
    getUInt32(json, len, "ask_size", pos, ignoredAskSize);
    getDouble(json, len, "bid_price", pos, tick.bid);
    getDouble(json, len, "ask_price", pos, tick.ask);

    if (isIndexFeed) {
        // Index feed messages carry price updates but no traded quantity or
        // aggressor side. Keep the price stream for candles; volume tools will
        // correctly remain empty for these updates.
        tick.qty = 0;
    } else {
        uint32_t lastTradedQty = 0;
        const bool hasLastTradedQty = getUInt32(json, len, "last_traded_qty", pos, lastTradedQty);
        static std::map<std::string, std::pair<bool, uint64_t>> cumulativeBySymbol;
        static std::mutex cumulativeMutex;
        if (tick.hasCumulativeVolume) {
            // Establish a baseline on first connection. Subsequent quantity is the
            // volume delta, so repeated quote updates cannot count the same trade twice.
            std::lock_guard<std::mutex> lock(cumulativeMutex);
            auto& prior = cumulativeBySymbol[tick.symbol];
            if (prior.first && tick.volumeTradedToday >= prior.second) {
                const uint64_t delta = tick.volumeTradedToday - prior.second;
                tick.qty = static_cast<uint32_t>(std::min<uint64_t>(delta, std::numeric_limits<uint32_t>::max()));
            } else {
                tick.qty = 0;
            }
            prior.second = tick.volumeTradedToday;
            prior.first = true;
        } else {
            // Backward-compatible fallback for feeds that omit cumulative volume.
            if (!hasLastTradedQty) return;
            tick.qty = lastTradedQty;
        }
    }

    processTick(tick);
}

void onError(fyers_data_ws_t*, int code, const char* message)
{
    std::fprintf(stderr, "[FYERS ERROR] %d: %s\n", code, message ? message : "");
}

void onConnect(fyers_data_ws_t* ws)
{
    { std::lock_guard<std::mutex> lock(g_subscriptionsMutex); g_liveWs = ws; }
    providers::fyers::requestSymbolSubscription(DEFAULT_SYMBOL);
}

void onClose(fyers_data_ws_t*, const char* reason)
{
    std::printf("[FYERS] Closed: %s\n", reason ? reason : "");
}
