# Adding a New Broker to VenomCandle

This guide walks you through every file you need to create or modify to plug a brand-new broker into the VenomCandle trading engine — without touching any engine-core code.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Step-by-Step Checklist](#step-by-step-checklist)
3. [Step 1 — Register the Broker Name in `config.h`](#step-1--register-the-broker-name-in-configh)
4. [Step 2 — Create the Adapter Header Directory](#step-2--create-the-adapter-header-directory)
5. [Step 3 — Write the Adapter Headers](#step-3--write-the-adapter-headers)
   - [config.h (credentials)](#adapterconfigh--credentials)
   - [data_historical.h](#adapterdata_historicalh)
   - [data_live.h](#adapterdata_liveh)
   - [limit_order.h](#adapterlimit_orderh)
   - [options_chain.h (optional)](#adapteroptions_chainh--optional)
6. [Step 4 — Write the Adapter Implementations](#step-4--write-the-adapter-implementations)
   - [data_historical.cpp](#adapterdata_historicalcpp)
   - [data_live.cpp](#adapterdata_livecpp)
   - [limit_order.cpp](#adapterlimit_ordercpp)
   - [options_chain.cpp (optional)](#adapteroptions_chaincpp--optional)
7. [Step 5 — Create a Protobuf Schema (if needed)](#step-5--create-a-protobuf-schema-if-needed)
8. [Step 6 — Update the Dispatch Shims in `src/broker/`](#step-6--update-the-dispatch-shims-in-srcbroker)
   - [src/broker/data_historical.cpp](#srcbrokerdata_historicalcpp)
   - [src/broker/market_data.cpp](#srcbrokermarket_datacpp)
   - [src/broker/options_chain.cpp](#srcbrokeroptions_chaincpp)
9. [Step 7 — Update `CMakeLists.txt`](#step-7--update-cmakeliststxt)
10. [Step 8 — Set the Broker and Build](#step-8--set-the-broker-and-build)
11. [Contracts Every Adapter Must Satisfy](#contracts-every-adapter-must-satisfy)
12. [Reference: What the Fyers Adapter Does](#reference-what-the-fyers-adapter-does)
13. [Common Mistakes](#common-mistakes)

---

## Architecture Overview

The engine is split into three layers:

```
┌──────────────────────────────────────────────────────────┐
│  Engine Core  (main.cpp, server.cpp, tick_processor.cpp) │
│  Only includes:  include/broker/*.h                       │
└────────────────────────┬─────────────────────────────────┘
                         │ calls broker-neutral functions
┌────────────────────────▼─────────────────────────────────┐
│  Dispatch Shims  (src/broker/*.cpp)                       │
│  #ifdef TRADING_BROKER_<NAME> → route to adapter         │
└────────────────────────┬─────────────────────────────────┘
                         │ calls adapter-specific functions
┌────────────────────────▼─────────────────────────────────┐
│  Broker Adapter  (src/broker_adapters/<name>/*.cpp)       │
│  Knows the broker's wire format, credentials, and API     │
└──────────────────────────────────────────────────────────┘
```

**The engine core never knows which broker is active.** All broker-specific logic lives in the adapter. Adding a broker means:
1. Creating a new adapter directory.
2. Updating three dispatch-shim files.
3. Updating `CMakeLists.txt`.
4. Flipping one line in `config.h`.

---

## Step-by-Step Checklist

- [ ] Step 1 — Add the broker name constant in `include/config.h`
- [ ] Step 2 — Create `include/broker_adapters/<name>/` and `src/broker_adapters/<name>/`
- [ ] Step 3 — Write adapter headers (credentials, historical, live, LOB, options)
- [ ] Step 4 — Write adapter implementations
- [ ] Step 5 — Create a protobuf schema if your broker sends protobuf
- [ ] Step 6 — Update the three dispatch shims in `src/broker/`
- [ ] Step 7 — Update `CMakeLists.txt` (sources, definitions, schemas, libraries)
- [ ] Step 8 — Set `TRADING_BROKER_NAME` in `config.h`, reconfigure, build

---

## Step 1 — Register the Broker Name in `config.h`

Open `include/config.h`. You only need to understand two sections:

```cpp
// ── Broker selector ────────────────────────────────────────
// Change this value to switch brokers. Must match the name
// you add below. Re-run CMake after changing it.
#define TRADING_BROKER_NAME "MYBROKER"   // ← your new broker

// ── Symbol / broker string shown in the UI ─────────────────
#ifdef TRADING_BROKER_COINBASE
  static const char* DEFAULT_SYMBOL = "BTC-USD";
  static const char* ACTIVE_BROKER  = "COINBASE";
#elif defined(TRADING_BROKER_MYBROKER)        // ← add this block
  static const char* DEFAULT_SYMBOL = "AAPL"; // your default
  static const char* ACTIVE_BROKER  = "MYBROKER";
#else
  static const char* DEFAULT_SYMBOL = "NSE:NIFTY50-INDEX";
  static const char* ACTIVE_BROKER  = "FYERS";
#endif
```

> **Important:** do NOT change any other part of `config.h`. All types (`Tick`, `Candle`, `FlowPacket`, `State`, `Side`, tuning constants) are shared by every broker and must stay untouched.

---

## Step 2 — Create the Adapter Header Directory

Create these two directories:

```
include/broker_adapters/mybroker/
src/broker_adapters/mybroker/
```

The folder name (`mybroker`) must be consistent throughout. Use lowercase.

---

## Step 3 — Write the Adapter Headers

### `adapter/config.h` — Credentials

```cpp
// include/broker_adapters/mybroker/config.h
#pragma once
#include <string>

inline std::string myBrokerApiKey() {
    return "YOUR_API_KEY_HERE";
}

inline std::string myBrokerApiSecret() {
    return "YOUR_API_SECRET_HERE";
}
```

Store credentials here and **nowhere else**. Do not hard-code them in `.cpp` files.

---

### `adapter/data_historical.h`

This header declares the two functions the dispatch shim will call to fetch and parse historical candles.

```cpp
// include/broker_adapters/mybroker/data_historical.h
#pragma once

#include <string>
#include <winsock2.h>
#include <windows.h>

namespace providers::mybroker {

// Fetch 1-min candle history for `symbol` via your broker's REST API.
// Fill `response` with the raw response body.
// Set `outStatus` to the HTTP status code (0 if transport failed).
// Return true if the HTTP transport succeeded (even if the response
// is an error — parseHistory handles that).
bool httpGetHistory(const std::string& symbol,
                    std::string& response,
                    DWORD& outStatus);

// Parse the raw JSON/response in `json` into g_state.candlesBySymbol[symbol].
// Return true only if at least one candle was successfully parsed.
bool parseHistory(const std::string& symbol,
                  const std::string& json,
                  DWORD httpStatus);

} // namespace providers::mybroker
```

---

### `adapter/data_live.h`

Declares the live-feed subscription entry point and the market data runner.

```cpp
// include/broker_adapters/mybroker/data_live.h
#pragma once
#include <string>

namespace providers::mybroker {

// Subscribe the live WebSocket to an additional symbol.
// Called from server.cpp when the user switches symbols.
void requestSymbolSubscription(const std::string& symbol);

// Start the live feed (WebSocket connect + event loop).
// Blocks until the connection is lost or g_state.running is false.
void runMarketData();

// Depth snapshot helpers (can be no-ops if not supported).
void selectDepthSymbol(const std::string& symbol);
std::string latestDepthSnapshot(const std::string& symbol);

} // namespace providers::mybroker
```

---

### `adapter/limit_order.h`

If your broker has a separate depth/LOB WebSocket (like Fyers TBT), declare it here. If the depth data comes through the same feed as `data_live.cpp`, this file can be minimal.

```cpp
// include/broker_adapters/mybroker/limit_order.h
#pragma once
#include <string>

namespace providers::mybroker {

// Called by market_data.cpp shim; may delegate to data_live detail.
void selectDepthSymbol(const std::string& symbol);
std::string latestDepthSnapshot(const std::string& symbol);

} // namespace providers::mybroker
```

---

### `adapter/options_chain.h` — Optional

Only needed if your broker provides options chain data. If not, the dispatch shim provides no-ops automatically.

```cpp
// include/broker_adapters/mybroker/options_chain.h
#pragma once
#include <string>

namespace providers::mybroker {

void startOptionsChainLoop(int pollIntervalSeconds = 300);
void fetchAndBroadcastOptionsGex();
void fetchAndBroadcastOptionsGex(const std::string& symbol);

} // namespace providers::mybroker
```

---

## Step 4 — Write the Adapter Implementations

### `adapter/data_historical.cpp`

**Responsibilities:**
1. Make an HTTPS GET request to your broker's candle history endpoint.
2. Parse the response into a `std::vector<Candle>` and store it in `g_state.candlesBySymbol[symbol]`.

```cpp
// src/broker_adapters/mybroker/data_historical.cpp
#include "broker_adapters/mybroker/data_historical.h"
#include "broker_adapters/mybroker/config.h"
#include "config.h"          // for g_state, Candle, HISTORY_DAYS
#include "core/json_parser.h"

#include <windows.h>
#include <winhttp.h>
#include <cstdio>
#include <vector>

namespace providers::mybroker {

bool httpGetHistory(const std::string& symbol,
                    std::string& response,
                    DWORD& outStatus)
{
    outStatus = 0;
    response.clear();

    // Build URL for your broker's API.
    // Use WinHTTP (already available — no new dependencies needed).
    // See src/broker_adapters/fyers/data_historical.cpp for a complete example.

    HINTERNET session = WinHttpOpen(
        L"TradingEngine/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return false;

    // ... connect, open request, add auth headers, send, read body ...

    WinHttpCloseHandle(session);
    return true; // return true if transport succeeded
}

bool parseHistory(const std::string& symbol,
                  const std::string& json,
                  DWORD httpStatus)
{
    // Parse the broker's candle response format into a vector<Candle>.
    std::vector<Candle> candles;

    // ... your parsing logic here ...
    // Each candle: { time (unix epoch seconds), open, high, low, close, volume }

    if (candles.empty()) return false;

    // Store into global state — this is the required contract:
    const size_t count = candles.size();
    {
        std::lock_guard<std::mutex> lock(g_state.marketMutex);
        g_state.candlesBySymbol[symbol] = candles;
        if (symbol == g_state.activeSymbol) {
            std::lock_guard<std::mutex> candlesLock(g_state.candleMutex);
            g_state.candles = std::move(candles);
        }
    }
    std::printf("[HISTORY] Loaded %zu candles for %s.\n", count, symbol.c_str());
    return true;
}

} // namespace providers::mybroker
```

**Key contract:** `parseHistory` MUST write candles into `g_state.candlesBySymbol[symbol]` and, if `symbol == g_state.activeSymbol`, also into `g_state.candles`. The engine reads from these for both the chart and the VP engine.

---

### `adapter/data_live.cpp`

**Responsibilities:**
1. Connect to your broker's live WebSocket.
2. On each trade/quote message, build a `Tick` and call `processTick(tick)`.
3. Handle symbol subscription requests.

```cpp
// src/broker_adapters/mybroker/data_live.cpp
#include "broker_adapters/mybroker/data_live.h"
#include "config.h"           // for g_state, Tick, DEFAULT_SYMBOL
#include "tick_processor.h"   // for processTick()
#include "core/json_parser.h" // for zero-alloc field extraction

// Include your broker's WebSocket client library here.
// libwebsockets is already a dependency — you can reuse it.

#include <cstdio>
#include <string>

namespace providers::mybroker {

static std::string g_currentSymbol;

void requestSymbolSubscription(const std::string& symbol)
{
    g_currentSymbol = symbol;
    // Send subscription message on the open WebSocket.
    // Example for a JSON-based feed:
    // send("{\"action\":\"subscribe\",\"symbol\":\"" + symbol + "\"}");
}

void runMarketData()
{
    // 1. Connect to your broker's WebSocket endpoint.
    // 2. Subscribe to DEFAULT_SYMBOL on connect.
    // 3. For every incoming message:
    //    a. Parse fields: symbol, timestamp, ltp, qty, bid, ask.
    //    b. Build a Tick{} struct (fields defined in config.h).
    //    c. Call processTick(tick).

    // Example skeleton:
    while (g_state.running.load()) {
        // receive message from WebSocket ...
        const char* msg = "..."; // your received message
        const size_t len = 0;

        Tick tick{};
        size_t pos = 0;

        // Use json_parser helpers for fast field extraction:
        if (!getString(msg, len, "symbol", pos, tick.symbol)) continue;
        pos = 0;
        if (!getDouble(msg, len, "ltp",    pos, tick.ltp))    continue;
        pos = 0;
        getDouble(msg, len, "bid", pos, tick.bid);
        pos = 0;
        getDouble(msg, len, "ask", pos, tick.ask);
        pos = 0;
        getUInt64(msg, len, "timestamp", pos, tick.time);

        // qty: the number of shares/contracts traded in this update.
        // If your broker provides cumulative volume, compute the delta.
        tick.qty = 1; // replace with real quantity

        processTick(tick); // ← this is the main engine entry point
    }
}

// Depth helpers — implement if your broker provides order book data.
// If not, leave as empty stubs.
void selectDepthSymbol(const std::string& /*symbol*/) {}
std::string latestDepthSnapshot(const std::string& /*symbol*/) { return {}; }

} // namespace providers::mybroker
```

**Key contracts for `data_live.cpp`:**

| Field | Required? | Notes |
|---|---|---|
| `tick.symbol` | ✅ Yes | Full broker symbol string, e.g. `"AAPL"` or `"NSE:NIFTY50-INDEX"`. |
| `tick.ltp` | ✅ Yes | Last traded price. Used for candle building and VP. |
| `tick.time` | ✅ Yes | Unix epoch in **seconds**. Used to bucket flow into candles. |
| `tick.qty` | ✅ Yes | Quantity of THIS update (not cumulative). Use 0 for quote-only updates. |
| `tick.bid` | Recommended | Best bid price. Used by `classifyTrade` for aggressor detection. |
| `tick.ask` | Recommended | Best ask price. Used by `classifyTrade` for aggressor detection. |
| `tick.volumeTradedToday` | Optional | Cumulative volume. Set `hasCumulativeVolume = true` if provided. |

---

### `adapter/limit_order.cpp`

Implement the 50-level order book feed. If your broker has a separate LOB WebSocket, open it here. If the depth comes from the same feed as `data_live.cpp`, delegate:

```cpp
// src/broker_adapters/mybroker/limit_order.cpp
#include "broker_adapters/mybroker/limit_order.h"
#include "broker_adapters/mybroker/data_live.h" // re-use detail namespace

namespace providers::mybroker {

void selectDepthSymbol(const std::string& symbol)
{
    // If your depth is in data_live.cpp's detail namespace:
    // providers::mybroker::detail::selectDepthSymbol(symbol);

    // Or if you have a separate LOB WebSocket, send the subscribe msg here.
}

std::string latestDepthSnapshot(const std::string& symbol)
{
    // Return the last JSON snapshot for this symbol's order book.
    // Format expected by the frontend (see app.js):
    // {"type":"depth","symbol":"...","ltp":...,"bids":[{"p":...,"q":...,"o":...},...],
    //                                           "asks":[{"p":...,"q":...,"o":...},...]}

    return {}; // return empty string if not available
}

} // namespace providers::mybroker
```

**Depth JSON format expected by `app.js`:**
```json
{
  "type": "depth",
  "symbol": "AAPL",
  "ltp": 189.50,
  "tbq": 5000,
  "tsq": 4800,
  "bids": [
    { "p": 189.49, "q": 100, "o": 5 },
    { "p": 189.48, "q": 250, "o": 12 }
  ],
  "asks": [
    { "p": 189.51, "q": 80,  "o": 3 },
    { "p": 189.52, "q": 400, "o": 20 }
  ]
}
```

---

### `adapter/options_chain.cpp` — Optional

Only implement this if your broker provides options chain data with Greeks (delta, gamma, OI). Otherwise, provide EMPTY stubs.

```cpp
// src/broker_adapters/mybroker/options_chain.cpp
#include "broker_adapters/mybroker/options_chain.h"
#include "server.h"  // for broadcast()
#include <string>

namespace providers::mybroker {

void startOptionsChainLoop(int pollIntervalSeconds)
{
    // Launch a thread that calls fetchAndBroadcastOptionsGex()
    // every pollIntervalSeconds.
}

void fetchAndBroadcastOptionsGex()
{
    // Fetch options chain, compute GEX, broadcast:
    // GEX formula: gamma × OI × lot_size × spot² × 0.01
    //
    // Broadcast format:
    // {"type":"options_gex","symbol":"...","spot":...,"call_wall":...,"put_wall":...,"levels":[...]}
    broadcast("{}"); // replace with real payload
}

void fetchAndBroadcastOptionsGex(const std::string& symbol)
{
    fetchAndBroadcastOptionsGex(); // or use symbol
}

} // namespace providers::mybroker
```

---

## Step 5 — Create a Protobuf Schema (if needed)

If your broker's live feed uses Protocol Buffers (like Fyers), create a schema file:

```
proto/broker_schemas/mybroker/mybroker_feed.proto
```

Example minimal schema:
```protobuf
syntax = "proto3";

message Trade {
  string symbol  = 1;
  double ltp     = 2;
  double qty     = 3;
  uint64 time    = 4;
  double bid     = 5;
  double ask     = 6;
}
```

Reference it in CMakeLists.txt (Step 7). If your broker uses JSON over WebSocket, skip this step entirely.

---

## Step 6 — Update the Dispatch Shims in `src/broker/`

These three files need a new `elif` / `else` branch for your broker. **Do not remove existing Fyers or Coinbase branches.**

### `src/broker/data_historical.cpp`

```cpp
#include "broker/data_historical.h"

#ifdef TRADING_BROKER_COINBASE
#include "broker_adapters/coinbase/data_historical.h"
#elif defined(TRADING_BROKER_MYBROKER)                // ← add this block
#include "broker_adapters/mybroker/data_historical.h"
#else
#include "broker_adapters/fyers/data_historical.h"
#endif

bool httpGetHistory(const std::string& symbol, std::string& response, DWORD& outStatus)
{
#ifdef TRADING_BROKER_COINBASE
    return providers::coinbase::httpGetHistory(symbol, response, outStatus);
#elif defined(TRADING_BROKER_MYBROKER)
    return providers::mybroker::httpGetHistory(symbol, response, outStatus);
#else
    return providers::fyers::httpGetHistory(symbol, response, outStatus);
#endif
}

bool parseHistory(const std::string& symbol, const std::string& json, DWORD httpStatus)
{
#ifdef TRADING_BROKER_COINBASE
    return providers::coinbase::parseHistory(symbol, json, httpStatus);
#elif defined(TRADING_BROKER_MYBROKER)
    return providers::mybroker::parseHistory(symbol, json, httpStatus);
#else
    return providers::fyers::parseHistory(symbol, json, httpStatus);
#endif
}
```

### `src/broker/market_data.cpp`

```cpp
#include "broker/data_live.h"
#include "broker/limit_order.h"

#ifdef TRADING_BROKER_COINBASE
#include "broker_adapters/coinbase/data_live.h"
#include "broker_adapters/coinbase/limit_order.h"
namespace selected_provider = providers::coinbase;
#elif defined(TRADING_BROKER_MYBROKER)
#include "broker_adapters/mybroker/data_live.h"
#include "broker_adapters/mybroker/limit_order.h"
namespace selected_provider = providers::mybroker;
#else
#include "broker_adapters/fyers/data_live.h"
#include "broker_adapters/fyers/limit_order_adapter.h"
namespace selected_provider = providers::fyers;
#endif

void requestSymbolSubscription(const std::string& symbol)
{
    selected_provider::requestSymbolSubscription(symbol);
}

void runBrokerMarketData()
{
    selected_provider::runMarketData();
}

void selectDepthSymbol(const std::string& symbol)
{
    selected_provider::selectDepthSymbol(symbol);
}

std::string latestDepthSnapshot(const std::string& symbol)
{
    return selected_provider::latestDepthSnapshot(symbol);
}
```

> **Note:** `namespace selected_provider = providers::mybroker;` works only if all four functions are in the same namespace. If you split depth into a `detail` sub-namespace (like Coinbase does), write out each function body manually instead of using the namespace alias.

### `src/broker/options_chain.cpp`

```cpp
#include "broker/options_chain.h"

#ifdef TRADING_BROKER_COINBASE
void startOptionsChainPolling(int) {}
void fetchAndBroadcastOptionsGex() {}
void fetchAndBroadcastOptionsGex(const std::string&) {}

#elif defined(TRADING_BROKER_MYBROKER)
#include "broker_adapters/mybroker/options_chain.h"

void startOptionsChainPolling(int pollIntervalSeconds)
{
    providers::mybroker::startOptionsChainLoop(pollIntervalSeconds);
}

void fetchAndBroadcastOptionsGex()
{
    providers::mybroker::fetchAndBroadcastOptionsGex();
}

void fetchAndBroadcastOptionsGex(const std::string& symbol)
{
    providers::mybroker::fetchAndBroadcastOptionsGex(symbol);
}

#else
#include "broker_adapters/fyers/options_chain.h"

void startOptionsChainPolling(int pollIntervalSeconds)
{
    providers::fyers::startOptionsChainLoop(pollIntervalSeconds);
}

void fetchAndBroadcastOptionsGex()
{
    providers::fyers::fetchAndBroadcastOptionsGex();
}

void fetchAndBroadcastOptionsGex(const std::string& symbol)
{
    providers::fyers::fetchAndBroadcastOptionsGex(symbol);
}
#endif
```

If your broker has no options chain, use the Coinbase-style empty stubs.

---

## Step 7 — Update `CMakeLists.txt`

Add your broker's source files and compile-time macro. Find the relevant sections and extend them:

```cmake
# ── Read broker from config.h ────────────────────────────────
# Already supported: FYERS, COINBASE
# Add the new check:
if(NOT TRADING_BROKER STREQUAL "FYERS"
   AND NOT TRADING_BROKER STREQUAL "COINBASE"
   AND NOT TRADING_BROKER STREQUAL "MYBROKER")   # ← add this line
    message(FATAL_ERROR "TRADING_BROKER_NAME in include/config.h must be FYERS, COINBASE, or MYBROKER")
endif()

# ── Protobuf schema (if needed) ──────────────────────────────
if(TRADING_BROKER STREQUAL "FYERS")
    add_subdirectory(fyers-c-sdk)
    protobuf_generate_cpp(TBT_PROTO_SRCS TBT_PROTO_HDRS proto/broker_schemas/fyers/msg.proto)
elseif(TRADING_BROKER STREQUAL "MYBROKER")       # ← add elif
    # Only if you use protobuf:
    protobuf_generate_cpp(TBT_PROTO_SRCS TBT_PROTO_HDRS proto/broker_schemas/mybroker/mybroker_feed.proto)
    # Otherwise leave TBT_PROTO_SRCS empty or omit this block entirely.
else()
    protobuf_generate_cpp(TBT_PROTO_SRCS TBT_PROTO_HDRS proto/broker_schemas/coinbase/coinbase_market_data.proto)
endif()

# ── Adapter sources ──────────────────────────────────────────
if(TRADING_BROKER STREQUAL "FYERS")
    list(APPEND SOURCES
        src/broker_adapters/fyers/data_historical.cpp
        src/broker_adapters/fyers/data_live.cpp
        src/broker_adapters/fyers/limit_order.cpp
        src/broker_adapters/fyers/provider.cpp
        src/broker_adapters/fyers/options_chain.cpp
    )
elseif(TRADING_BROKER STREQUAL "MYBROKER")       # ← add elif
    list(APPEND SOURCES
        src/broker_adapters/mybroker/data_historical.cpp
        src/broker_adapters/mybroker/data_live.cpp
        src/broker_adapters/mybroker/limit_order.cpp
        # src/broker_adapters/mybroker/options_chain.cpp  # add if implemented
    )
else()
    list(APPEND SOURCES
        src/broker_adapters/coinbase/data_historical.cpp
        src/broker_adapters/coinbase/data_live.cpp
        src/broker_adapters/coinbase/limit_order.cpp
    )
endif()

# ── Compile-time macro ───────────────────────────────────────
if(TRADING_BROKER STREQUAL "COINBASE")
    target_compile_definitions(TradingEngine PRIVATE TRADING_BROKER_COINBASE=1)
elseif(TRADING_BROKER STREQUAL "MYBROKER")       # ← add elif
    target_compile_definitions(TradingEngine PRIVATE TRADING_BROKER_MYBROKER=1)
endif()

# ── Libraries ────────────────────────────────────────────────
if(TRADING_BROKER STREQUAL "FYERS")
    target_link_libraries(TradingEngine PRIVATE fyers-api-c)
elseif(TRADING_BROKER STREQUAL "MYBROKER")       # ← add elif if you need extra libs
    # target_link_libraries(TradingEngine PRIVATE mybroker-sdk)
endif()
```

---

## Step 8 — Set the Broker and Build

1. Open `include/config.h` and set:
   ```cpp
   #define TRADING_BROKER_NAME "MYBROKER"
   ```

2. Re-run CMake (the script reads `config.h` at configure time):
   ```bash
   cmake -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release ..
   ```

3. Build:
   ```bash
   cmake --build . --config Release
   ```

4. Run:
   ```bash
   ./TradingEngine.exe
   # Open http://localhost:8080
   ```

---

## Contracts Every Adapter Must Satisfy

### `httpGetHistory` / `parseHistory`

| Contract | Detail |
|---|---|
| Store candles in `g_state.candlesBySymbol[symbol]` | Required. The server reads from here. |
| Also write to `g_state.candles` if `symbol == g_state.activeSymbol` | Required. The VP engine reads `g_state.candles`. |
| Lock `g_state.marketMutex` when writing | Required. Multiple threads share this. |
| Lock `g_state.candleMutex` when writing `g_state.candles` | Required. |
| `Candle.time` in **Unix epoch seconds** | Required. The frontend multiplies by 1000 for JS timestamps. |

### `runMarketData`

| Contract | Detail |
|---|---|
| Returns only when `g_state.running` is `false` or the connection drops | Required. `main.cpp` calls this in a blocking manner. |
| Calls `processTick(tick)` for every trade event | Required. This is the engine's heartbeat. |
| Calls `requestSymbolSubscription(DEFAULT_SYMBOL)` on connect | Required. The chart starts empty otherwise. |

### `processTick` — the `Tick` struct

```cpp
struct Tick {
    std::string symbol;             // e.g. "AAPL" or "NSE:NIFTY50-INDEX"
    uint64_t    time  = 0;          // Unix epoch SECONDS
    double      ltp   = 0.0;        // Last traded price
    double      qty   = 0.0;        // Qty for THIS update (NOT cumulative)
    uint64_t    volumeTradedToday = 0;
    bool        hasCumulativeVolume = false;
    double      bid   = 0.0;        // Best bid price
    double      ask   = 0.0;        // Best ask price
};
```

Setting `qty = 0` on a pure quote update is correct — the VP engine ignores zero-qty ticks.

### `latestDepthSnapshot`

Must return either:
- An empty string `""` if no depth data is available.
- A JSON string in the exact format shown in [limit_order.cpp](#adapterlimit_ordercpp) above.

The frontend parses this format literally — any deviation will cause a silent rendering failure.

---

## Reference: What the Fyers Adapter Does

Use the Fyers adapter as the primary reference implementation:

| What to copy | Fyers file |
|---|---|
| WinHTTP REST pattern | `src/broker_adapters/fyers/data_historical.cpp` |
| JSON field parsing | `src/broker_adapters/fyers/data_live.cpp` (uses `core/json_parser.h`) |
| Cumulative volume → per-tick delta | `src/broker_adapters/fyers/data_live.cpp` lines 83–103 |
| 50-level LOB via libwebsockets | `src/broker_adapters/fyers/limit_order.cpp` |
| Depth JSON format | `FyersTBT::build_depth_json()` in `limit_order.cpp` |
| GEX computation | `src/broker_adapters/fyers/options_chain.cpp` |

---

## Common Mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Forgot to re-run CMake after changing `config.h` | Old broker still active | Run `cmake ..` again before building. |
| `tick.time` in milliseconds instead of seconds | Candles appear at wrong timestamps or don't form at all | Divide by 1000 before assigning. |
| `tick.qty` is cumulative total, not per-update delta | Volume Profile shows astronomically large numbers | Compute delta from previous cumulative value. |
| Not locking `g_state.marketMutex` in `parseHistory` | Random crashes / data corruption | Always hold the mutex when writing shared state. |
| `latestDepthSnapshot` returns malformed JSON | LOB panel blank in browser | Validate JSON with `console.log` in `app.js`. |
| Namespace typo in dispatch shim | Linker error: undefined reference | Make sure shim namespace alias matches header namespace exactly. |
| Missing source file in `CMakeLists.txt` | Linker error: undefined symbol | Add every `.cpp` file to the `list(APPEND SOURCES ...)` block. |
| Options chain stub missing | Linker error for `startOptionsChainPolling` | Add empty function bodies in `options_chain.cpp` shim for your broker. |
