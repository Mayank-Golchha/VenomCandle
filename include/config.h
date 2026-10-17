#pragma once

// ============================================================
// CONFIG.H — Shared configuration, types, and global state
// ============================================================

#include <winsock2.h>
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>
#include <unordered_map>

// ============================================================
// CREDENTIALS & INSTRUMENT
// ============================================================


// Select the provider here. CMake reads this value and builds only that
// provider's adapter and protobuf schema. Reconfigure/build after changing it.
#define TRADING_BROKER_NAME "COINBASE" // "FYERS" or "COINBASE"
// #define TRADING_BROKER_NAME "FYERS" // "FYERS" or "COINBASE"

#ifdef TRADING_BROKER_COINBASE
static const char* DEFAULT_SYMBOL = "BTC-USD";
static const char* ACTIVE_BROKER = "COINBASE";
#else
// static const char* DEFAULT_SYMBOL = "NSE:RELIANCE-EQ";
static const char* DEFAULT_SYMBOL = "NSE:NIFTY50-INDEX";

// static const char* DEFAULT_SYMBOL = "MCX:GOLDPETAL26OCTFUT";
static const char* ACTIVE_BROKER = "FYERS";
#endif

// static const char* DEFAULT_SYMBOL = "MCX";
// static const char* DEFAULT_SYMBOL = "MCX:GOLDPETAL26OCTFUT";

static constexpr int HISTORY_DAYS = 5; // get 1min historical data for last n dats


// ============================================================
// TUNING CONSTANTS
// ============================================================

static constexpr int HTTP_PORT        = 8080;
static constexpr int AGGREGATION_MS   = 100;   // flow bucket width
static constexpr int MAX_CLIENTS      = 32;

// Volume Profile tick size: price * PRICE_SCALE gives the integer key.
// For 2-decimal instruments (e.g. INR) use 100.
static constexpr int64_t PRICE_SCALE  = 100;

// Value Area covers this percentage of total volume (standard = 70%)
static constexpr double VALUE_AREA_PCT = 0.70;

// Max dirty levels per VP broadcast batch (0 = send all dirty)
static constexpr int VP_BATCH_LIMIT   = 0;

// VP broadcast interval in milliseconds (0 = every flow broadcast)
static constexpr int VP_BROADCAST_MS  = 200;

// ============================================================
// DATA STRUCTURES
// ============================================================

struct Tick {
    std::string symbol;
    uint64_t time = 0;
    double   ltp  = 0.0;
    double   qty  = 0.0;
    uint64_t volumeTradedToday = 0;
    bool     hasCumulativeVolume = false;
    double   bid  = 0.0;
    double   ask  = 0.0;
};

struct FlowFootprintLevel {
    double buy = 0.0;
    double sell = 0.0;
    double other = 0.0;
};

struct FlowPacket {
    uint64_t time             = 0;
    double   ltp              = 0.0;
    double aggressiveBuying  = 0.0;
    double aggressiveSelling = 0.0;
    double footprintTickSize = 0.0;
    // Keyed by PRICE_SCALE units so trade volume remains grouped by price.
    std::map<int64_t, FlowFootprintLevel> footprint;
};

struct Candle {
    int64_t time   = 0;
    double  open   = 0.0;
    double  high   = 0.0;
    double  low    = 0.0;
    double  close  = 0.0;
    double  volume = 0.0;
};

// ============================================================
// AGGRESSOR CLASSIFICATION
// ============================================================

enum class Side {
    Other,
    Buy,
    Sell
};

// ============================================================
// GLOBAL STATE
// ============================================================

struct State {
    std::mutex         clientsMutex;
    std::vector<SOCKET> clients;

    std::mutex         candleMutex;
    std::vector<Candle> candles;
    std::mutex marketMutex;
    std::string activeSymbol = DEFAULT_SYMBOL;
    std::unordered_map<std::string, std::vector<Candle>> candlesBySymbol;

    std::mutex flowMutex;

    std::atomic<bool> running{true};
};

// Single global state instance — declared in main.cpp, referenced everywhere.
extern State g_state;
