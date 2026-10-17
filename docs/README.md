# VenomCandle — Codebase Documentation

> A high-performance C++ trading engine that streams real-time market data, builds candle history, computes volume profiles, and serves a browser-based charting frontend over HTTP/WebSocket.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Directory Structure](#directory-structure)
3. [Root Files](#root-files)
4. [include/ — Headers](#include--headers)
   - [include/config.h](#includecconfigh)
   - [include/server.h](#includeserverh)
   - [include/tick_processor.h](#includetick_processorh)
   - [include/volume_profile.h](#includevolume_profileh)
   - [include/ws_handshake.h](#includews_handshareh)
   - [include/core/json_parser.h](#includecorehjson_parserh)
   - [include/broker/ — Broker-Neutral Facades](#includebroker--broker-neutral-facades)
   - [include/broker_adapters/ — Broker-Specific Headers](#includebroker_adapters--broker-specific-headers)
5. [src/ — Implementations](#src--implementations)
   - [src/main.cpp](#srcmaincpp)
   - [src/server.cpp](#srcsservercpp)
   - [src/tick_processor.cpp](#srctick_processorcpp)
   - [src/volume_profile.cpp](#srcvolume_profilecpp)
   - [src/ws_handshake.cpp](#srcws_handshakecpp)
   - [src/broker/ — Dispatch Shims](#srcbroker--dispatch-shims)
   - [src/broker_adapters/fyers/ — Fyers Implementations](#srcbroker_adaptersfyers--fyers-implementations)
   - [src/broker_adapters/coinbase/ — Coinbase Implementations](#srcbroker_adapterscoinbase--coinbase-implementations)
6. [proto/ — Protobuf Schemas](#proto--protobuf-schemas)
7. [Frontend Files](#frontend-files)
8. [Build System](#build-system)
9. [Data Flow Diagram](#data-flow-diagram)

---

## Project Overview

VenomCandle (internally called **TradingEngine**) is a single-process Windows application written in C++17. It:

- Fetches historical 1-minute OHLCV candles from a broker REST API on startup.
- Subscribes to a live tick feed (WebSocket) from the same broker.
- Classifies every tick as an aggressive buy, aggressive sell, or neutral trade.
- Maintains a real-time **Volume Profile** (POC / VAH / VAL) across all subscribed symbols.
- Streams candle updates, flow packets, and volume-profile deltas to any connected browser over a hand-rolled HTTP/WebSocket server.
- Provides a **50-Level Depth / Limit Order Book** feed from the broker's tick-by-tick WebSocket.
- Optionally polls an **Options Chain** for GEX (Gamma Exposure) computation and broadcasts Call Wall / Put Wall data.

The broker is selected at compile time by setting `TRADING_BROKER_NAME` in `include/config.h` to either `"FYERS"` or `"COINBASE"`.

---

## Directory Structure

```
VenomCandle/
├── CMakeLists.txt               # Build configuration
├── include/                     # All header files
│   ├── config.h                 # Global types, constants, State
│   ├── server.h                 # HTTP/WebSocket server interface
│   ├── tick_processor.h         # Tick classification interface
│   ├── volume_profile.h         # Volume Profile engine class
│   ├── ws_handshake.h           # SHA-1/Base64 for WS upgrade
│   ├── core/
│   │   └── json_parser.h        # Zero-alloc JSON field reader
│   ├── broker/                  # Broker-neutral facade headers
│   │   ├── provider.h
│   │   ├── data_historical.h
│   │   ├── data_live.h
│   │   ├── limit_order.h
│   │   └── options_chain.h
│   └── broker_adapters/
│       ├── fyers/               # Fyers-specific headers
│       └── coinbase/            # Coinbase-specific headers
├── src/                         # All implementation files
│   ├── main.cpp
│   ├── server.cpp
│   ├── tick_processor.cpp
│   ├── volume_profile.cpp
│   ├── ws_handshake.cpp
│   ├── broker/                  # Compile-time dispatch shims
│   │   ├── data_historical.cpp
│   │   ├── market_data.cpp
│   │   └── options_chain.cpp
│   └── broker_adapters/
│       ├── fyers/               # Fyers adapter implementations
│       └── coinbase/            # Coinbase adapter implementations
├── proto/
│   └── broker_schemas/
│       ├── fyers/msg.proto
│       └── coinbase/coinbase_market_data.proto
├── frontend.html                # Single-page charting UI
├── app.js                       # Frontend chart logic (~165 KB)
├── indicator.js                 # Custom indicator entry point
├── candlestyles.js              # Candle rendering style helpers
├── vela.global.js               # Vela charting library bundle
└── fyers-c-sdk/                 # Fyers C SDK (git submodule / vendored)
```

---

## Root Files

### `CMakeLists.txt`
The CMake build script. It reads `TRADING_BROKER_NAME` from `include/config.h` at configure time and selects:
- Which broker-adapter source files to compile.
- Which protobuf schema to generate.
- Which compile-time preprocessor macro to define (`TRADING_BROKER_COINBASE=1` for Coinbase, nothing extra for Fyers).
- Which third-party libraries to link (`fyers-api-c` for Fyers; libwebsockets + protobuf for both).

**You must re-run CMake after changing the broker in `config.h`.**

### `frontend.html`
The single HTML page served at `http://localhost:8080/`. It contains the shell structure for the charting UI, imports `vela.global.js`, `app.js`, and `indicator.js`, and provides the canvas/DOM elements used by the chart. The backend injects `DEFAULT_SYMBOL` and `ACTIVE_BROKER` into the HTML at serve time via template tokens (`__BACKEND_DEFAULT_SYMBOL__` and `__BACKEND_BROKER__`).

### `app.js`
The main frontend JavaScript file (~165 KB). It owns:
- WebSocket connection lifecycle (reconnect on drop).
- Parsing all incoming `type`-discriminated JSON messages (`history`, `flow`, `vp`, `vp_fixed`, `depth`, `options_gex`).
- Driving the Vela chart (renders candles, overlays, volume profile bars, limit order book).
- Symbol search UI and symbol switching (sends `select_symbol` to the backend).
- Fixed Range Volume Profile selection.
- Options GEX panel.

### `indicator.js`
A thin entry-point for user-defined custom indicators. Receives chart context from `app.js` and runs user scripts without modifying the core chart logic.

### `candlestyles.js`
Helper module that defines candle colour palettes and rendering style variants (standard, hollow, Heikin-Ashi, etc.) used by the chart renderer inside `app.js`.

### `vela.global.js`
The bundled Vela charting library. This is a third-party dependency and is **not** modified. It exposes the `Vela` global used by `app.js` to create the chart canvas, add series, overlays, and indicators.

### `BACKEND_LAYOUT.md`
A short developer note explaining the broker-selection architecture. Superseded by this documentation but kept for historical context.

### `VELA_MIGRATION.md`
Developer notes from the migration to the Vela chart library.

### `bugs.txt`
An informal scratchpad of known issues and open tasks.

---

## include/ — Headers

### `include/config.h`
**The central configuration file. Every other translation unit includes this.**

Key responsibilities:
- Declares `TRADING_BROKER_NAME` — the compile-time broker selector string.
- Declares the `DEFAULT_SYMBOL` and `ACTIVE_BROKER` constants (conditional on `TRADING_BROKER_COINBASE`).
- Defines all shared **data structures**:
  - `Tick` — one raw market event (symbol, timestamp, LTP, qty, bid, ask, cumulative volume).
  - `Candle` — one OHLCV bar.
  - `FlowFootprintLevel` / `FlowPacket` — aggregated aggressive buy/sell volume for one time bucket.
  - `Side` enum — `Buy`, `Sell`, `Other`.
  - `State` — the global mutable state (connected clients, candles by symbol, active symbol, flow mutex, running flag).
- Declares the global `g_state` instance (defined in `main.cpp`).
- Defines tuning constants: `HTTP_PORT`, `AGGREGATION_MS`, `MAX_CLIENTS`, `PRICE_SCALE`, `VALUE_AREA_PCT`, `VP_BATCH_LIMIT`, `VP_BROADCAST_MS`, `HISTORY_DAYS`.

**Edit this file to change the active broker, default symbol, server port, or volume-profile parameters.**

---

### `include/server.h`
Public interface of the HTTP/WebSocket server.

| Function | Description |
|---|---|
| `browserServer()` | Blocking accept loop. Run in a detached thread. |
| `broadcast(payload)` | Send a WS text frame to every connected client. |
| `sendWsText(s, payload)` | Send a WS text frame to one socket. |
| `sendAll(s, data, len)` | Raw blocking socket send. |
| `removeClient(s)` | Remove a socket from the client list. |
| `buildHistoryMessage(symbol)` | Serialize `g_state.candlesBySymbol[symbol]` to `{"type":"history",...}` JSON. |
| `readFile(filename)` | Read a file from disk into a string. |
| `serveStaticFile(client, filename, contentType)` | Serve a file with an HTTP 200 response. |
| `prepareSymbolCatalog()` | Download NSE equity list and cache it as a CSV (Fyers only). |

---

### `include/tick_processor.h`
Interface for the tick classification and flow aggregation engine.

| Function | Description |
|---|---|
| `classifyTrade(tick, previous)` | Returns `Side::Buy`, `Side::Sell`, or `Side::Other` using LTP vs bid/ask and Lee-Ready tick-test fallback. |
| `processTick(tick)` | The hot path: classifies the tick, adds it to the current flow bucket, closes buckets on timer, broadcasts completed `flow` packets, and feeds the Volume Profile engine. |

---

### `include/volume_profile.h`
The `VolumeProfileEngine` class — a high-performance, cache-friendly volume-profile accumulator.

**Design highlights:**
- Prices stored as fixed-point integers (`actual_price × PRICE_SCALE`) to avoid floating-point in the hot path.
- Single contiguous `std::vector<PriceLevel>` — no map, no heap thrashing per tick.
- Dirty-bit tracking: only changed levels are serialized per broadcast.
- Two modes: **Session VP** (full session, updated live) and **Fixed Range VP** (arbitrary candle range, computed on demand via `computeFixedRange(startIdx, endIdx)`).

Key members:
- `addTick(rawPrice, side, qty)` — O(1) update.
- `recomputeIfDirty()` — recomputes POC/VAH/VAL when needed.
- `buildDirtyMessage()` — returns compact JSON of only changed levels.
- `buildFullSnapshot()` — returns full VP JSON for a newly connected client.
- `reset()` — clears the profile (e.g. new session).

Global accessors (defined in `volume_profile.cpp`):
- `g_volumeProfilesBySymbol` — per-symbol engine map.
- `g_volumeProfileMutex` — mutex guarding the map.
- `volumeProfileForSymbol(symbol)` — creates or retrieves the engine for a symbol.

---

### `include/ws_handshake.h`
Provides the two utilities needed to complete the RFC 6455 WebSocket upgrade handshake without any external crypto library:
- `sha1Base64(input)` — computes SHA-1 then Base64-encodes the result.
- `base64Encode(data, len)` — standard Base64 encoding.

---

### `include/core/json_parser.h`
A **header-only**, zero-allocation JSON field extractor used by broker adapters and `server.cpp` on the tick hot path. It avoids pulling in any large JSON library.

| Function | Description |
|---|---|
| `findValue(data, len, key, pos, value)` | Finds a JSON key and sets `value` pointer to the start of its value. |
| `getDouble(...)` | Extracts a `double` for the given key. |
| `getUInt64(...)` | Extracts a `uint64_t`. |
| `getUInt32(...)` | Extracts a `uint32_t`. |
| `getString(...)` | Extracts a quoted `std::string`. |
| `isType(data, len, wanted)` | Returns `true` if the JSON `"type"` field equals `wanted`. |

All functions take a `pos` cursor by reference and search forward from it, so multiple fields can be extracted in one forward pass.

---

### `include/broker/` — Broker-Neutral Facades

These headers define interfaces that the **engine** (main.cpp, server.cpp, tick_processor.cpp) calls. They never mention any specific broker. The actual implementation is routed by the dispatch shims in `src/broker/`.

| File | Exposed Functions | Purpose |
|---|---|---|
| `provider.h` | `runBrokerMarketData()` | Starts the live feed loop (blocks until disconnected). |
| `data_historical.h` | `httpGetHistory()`, `parseHistory()` | Fetch and parse historical candles. |
| `data_live.h` | `requestSymbolSubscription()`, `runBrokerMarketData()` | Subscribe to a symbol on the live feed. |
| `limit_order.h` | `selectDepthSymbol()`, `latestDepthSnapshot()` | Switch the active depth symbol; get the latest LOB JSON snapshot. |
| `options_chain.h` | `startOptionsChainPolling()`, `fetchAndBroadcastOptionsGex()` | Start periodic GEX polling; on-demand GEX fetch+broadcast. |

---

### `include/broker_adapters/` — Broker-Specific Headers

These headers are included **only** by the dispatch shims in `src/broker/` or by the adapter's own `.cpp` files. Engine code never includes them directly.

**Fyers** (`include/broker_adapters/fyers/`):

| File | Description |
|---|---|
| `config.h` | Returns `fyersAppId()` and `fyersAccessToken()` — inline functions holding credentials. |
| `data_historical.h` | Declares `providers::fyers::httpGetHistory()` and `providers::fyers::parseHistory()`. |
| `data_live.h` | Declares the Fyers SDK callbacks (`onMessage`, `onConnect`, `onClose`, `onError`) and `providers::fyers::requestSymbolSubscription()`. |
| `limit_order.h` | Declares `FyersTBT` (Tick-By-Tick depth class), `BookLevel`, `g_limitOrderBook`, and `limitOrderWorker()`. |
| `limit_order_adapter.h` | Declares `providers::fyers::runMarketData()`, `selectDepthSymbol()`, `latestDepthSnapshot()` — the functions called by `provider.cpp` and the shims. |
| `options_chain.h` | Declares `providers::fyers::startOptionsChainLoop()` and both overloads of `fetchAndBroadcastOptionsGex()`. |

**Coinbase** (`include/broker_adapters/coinbase/`):

| File | Description |
|---|---|
| `data_historical.h` | Declares `providers::coinbase::httpGetHistory()` and `providers::coinbase::parseHistory()`. |
| `data_live.h` | Declares `providers::coinbase::requestSymbolSubscription()`, `runMarketData()`, and the depth helpers under `providers::coinbase::detail`. |
| `limit_order.h` | Declares `providers::coinbase::selectDepthSymbol()` and `latestDepthSnapshot()`. |

---

## src/ — Implementations

### `src/main.cpp`
**Application entry point and orchestrator.**

Startup sequence:
1. Initializes Winsock (`WSAStartup`).
2. Calls `httpGetHistory` + `parseHistory` to pre-fill `g_state.candles` with today's 1-minute bars.
3. (Fyers only) calls `prepareSymbolCatalog()` to download the NSE equity list for symbol search.
4. Calls `startOptionsChainPolling(300)` to begin 5-minute GEX refresh cycles.
5. Launches `browserServer()` in a detached thread (HTTP + WebSocket server).
6. Calls `runBrokerMarketData()` — blocks here until the broker disconnects or the engine shuts down.
7. Cleans up Winsock.

---

### `src/server.cpp`
**The HTTP/WebSocket server — ~466 lines.**

Responsibilities:
- `browserServer()`: TCP accept loop; spawns a `handleBrowser` thread per connection.
- `handleBrowser()`: Detects WS upgrade vs plain HTTP; routes HTTP requests to static files or the symbol catalog.
- HTTP routes: `/` → `frontend.html` (with token substitution), `/app.js`, `/indicator.js`, `/candlestyles.js`, any `.js` file, `/symbols.csv`, `/favicon.png`.
- WebSocket message dispatch (`handleWsMessage`):

| Message `type` | Action |
|---|---|
| `select_symbol` | Subscribe live feed, switch active symbol, send history + VP snapshot + depth snapshot, start async history fetch if not cached. |
| `vp_fixed_range` | Compute and return a fixed-range VP for the given candle index range. |
| `vp_request` | Return the current full VP snapshot. |
| `depth_request` | Return the latest limit order book snapshot. |
| `options_request` | Trigger an async GEX fetch+broadcast for the requested symbol. |

- On new WS client connection: sends history, full VP snapshot, and depth snapshot immediately.
- `prepareSymbolCatalog()`: downloads `EQUITY_L.csv` from NSE and caches it in the system temp directory.

---

### `src/tick_processor.cpp`
**Tick classification and flow aggregation.**

- `classifyTrade(tick, previous)`: compares LTP to bid/ask. If LTP ≥ ask → `Buy`; if LTP ≤ bid → `Sell`; otherwise uses a Lee-Ready tick-test fallback (compare to previous LTP).
- `processTick(tick)`:
  1. Classifies the tick.
  2. Routes aggressive volume into the current `AGGREGATION_MS`-wide time bucket.
  3. Builds footprint data per price level within the bucket.
  4. When a bucket closes (time advances past its end), broadcasts the completed `FlowPacket` as a `{"type":"flow",...}` JSON message.
  5. Calls `volumeProfileForSymbol(symbol).addTick(...)` to update the live VP.
  6. On `VP_BROADCAST_MS` timer: calls `buildDirtyMessage()` on the session VP and broadcasts it.
  7. Updates live candle bars in `g_state.candlesBySymbol` and broadcasts candle updates.

---

### `src/volume_profile.cpp`
**Volume Profile engine implementation.**

- `addTick`: converts the raw price to a fixed-point integer, maps it to an index in `levels_`, increments buy/sell/total volume, marks the level dirty.
- `recomputeIfDirty`: O(N) scan to find the max-volume level (POC) and compute the 70% value area (VAH/VAL).
- `buildDirtyMessage` / `buildFullSnapshot`: serialize levels to `{"type":"vp",...}` JSON.
- `computeFixedRange(startIdx, endIdx)`: builds a temporary VP from historical candle volume (no aggressor side info, so all volume goes to `total`) and returns a `{"type":"vp_fixed",...}` snapshot.
- `volumeProfileForSymbol(symbol)`: thread-safe lookup/create in `g_volumeProfilesBySymbol`.

---

### `src/ws_handshake.cpp`
Implements SHA-1 (RFC 3174) and Base64 encoding in ~100 lines of portable C++. Used exclusively by `server.cpp` during the WebSocket upgrade handshake.

---

### `src/broker/` — Dispatch Shims

These three files are the **only** translation units that include both the broker-neutral facade headers and the broker-specific adapter headers. Engine code includes only the facade headers.

| File | What it dispatches |
|---|---|
| `data_historical.cpp` | `httpGetHistory` / `parseHistory` → `providers::fyers::` or `providers::coinbase::` based on `TRADING_BROKER_COINBASE` macro. |
| `market_data.cpp` | `requestSymbolSubscription`, `runBrokerMarketData`, `selectDepthSymbol`, `latestDepthSnapshot` → aliased via `namespace selected_provider`. |
| `options_chain.cpp` | `startOptionsChainPolling`, `fetchAndBroadcastOptionsGex` → `providers::fyers::` or no-op stubs for Coinbase. |

---

### `src/broker_adapters/fyers/` — Fyers Implementations

| File | Description |
|---|---|
| `provider.cpp` | `providers::fyers::runMarketData()`: initializes the Fyers C SDK, creates the data WebSocket (`fyers_data_ws_create`), connects it (`fyers_data_ws_connect`), launches the `limitOrderWorker` thread for the TBT depth feed, then blocks on `fyers_data_ws_keep_running`. Also implements `selectDepthSymbol` and `latestDepthSnapshot` by delegating to `g_limitOrderBook`. |
| `data_live.cpp` | Fyers SDK callbacks: `onConnect` subscribes `DEFAULT_SYMBOL` on connect; `onMessage` parses the protobuf-decoded JSON (types `"sf"` and `"if"`), builds a `Tick`, computes per-update qty from cumulative volume delta or `last_traded_qty`, and calls `processTick`. `requestSymbolSubscription` calls `fyers_data_ws_subscribe` with the full symbol list. |
| `data_historical.cpp` | `httpGetHistory`: builds the Fyers History API URL (`api-t1.fyers.in/data/history`) with date range, appID + token auth header, fetches via WinHTTP over TLS 1.2+. `parseHistory`: walks the `"candles"` array in the JSON response (format: `[timestamp, open, high, low, close, volume]`) and populates `g_state.candlesBySymbol`. |
| `limit_order.cpp` | `FyersTBT` class: connects to the Fyers TBT WebSocket via libwebsockets, subscribes to the selected symbol's 50-level depth feed, merges bid/ask levels using protobuf-decoded messages, builds a depth JSON snapshot, and broadcasts it. `limitOrderWorker()` is the function that creates and runs the `FyersTBT` instance. |
| `options_chain.cpp` | Fetches the NSE options chain from Fyers API, computes GEX (`gamma × OI × lot_size × spot² × 0.01`) for every strike and expiry, aggregates by strike to find Call Wall (max GEX strike above spot) and Put Wall (max GEX strike below spot), then broadcasts `{"type":"options_gex",...}` to all clients. Runs on a configurable polling interval in its own thread. |

---

### `src/broker_adapters/coinbase/` — Coinbase Implementations

| File | Description |
|---|---|
| `data_historical.cpp` | Fetches 1-minute candles from the Coinbase Exchange REST API (`/products/{id}/candles`) via WinHTTP. Parses the response array (format: `[start, low, high, open, close, volume]`). No API key required. |
| `data_live.cpp` | Connects to the Coinbase Advanced Trade WebSocket (`advanced-trade-ws.coinbase.com`). Subscribes to `ticker`, `market_trades`, and `level2` channels for the active symbol. Parses JSON messages: `ticker` → LTP/bid/ask; `market_trades` → trade qty + side; `level2` → incremental depth updates. Feeds ticks to `processTick`. Also implements depth snapshot via `selectDepthSymbol` / `latestDepthSnapshot`. |
| `limit_order.cpp` | Stub — Coinbase depth is handled inside `data_live.cpp`. These functions delegate to the detail namespace inside that file. |

---

## proto/ — Protobuf Schemas

### `proto/broker_schemas/fyers/msg.proto`
Defines the Fyers SDK wire format for the live data WebSocket. Key messages:
- `MarketFeed` — contains `Quote` (LTP, volume, OI), `ExtendedQuote`, `DailyQuote`, `Ohlcv`, `Depth` (50-level bids/asks), tick size, and symbol token.
- `SocketMessage` — top-level envelope with `MessageType` enum and a map of symbol → `MarketFeed`.
- `DepthLevel` — single bid or ask level: price, quantity, order count.

This schema is compiled by protobuf at build time (`TBT_PROTO_SRCS`).

### `proto/broker_schemas/coinbase/coinbase_market_data.proto`
A project-owned normalized protobuf schema for Coinbase market data. Not published by Coinbase. Used internally to normalize the Coinbase feed into the same `Tick` structure consumed by `tick_processor.cpp`.

---

## Frontend Files

| File | Description |
|---|---|
| `frontend.html` | HTML shell. Imports all JS files. Template tokens replaced by server at serve time. |
| `app.js` | All chart logic: WS client, message parsing, Vela chart API, symbol switching, VP overlays, LOB rendering, GEX panel. |
| `indicator.js` | Entry point for custom user indicators. |
| `candlestyles.js` | Candle color/style definitions used by `app.js`. |
| `vela.global.js` | Bundled Vela charting library (third-party, do not modify). |

---

## Build System

```
# 1. Set broker in include/config.h:
#define TRADING_BROKER_NAME "FYERS"   # or "COINBASE"

# 2. Configure (run from build directory):
cmake -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release ..

# 3. Build:
cmake --build . --config Release

# 4. Run:
./TradingEngine.exe
# Open browser: http://localhost:8080
```

CMake automatically:
- Detects the broker from `config.h`.
- Includes only the correct adapter sources.
- Compiles only the correct protobuf schema.
- Links `fyers-api-c` (Fyers) or excludes it (Coinbase).

---

## Data Flow Diagram

```
Broker WebSocket/REST
        │
        │  (Historical candles on startup)
        ▼
data_historical.cpp ──► g_state.candlesBySymbol
                              │
                              ▼
                    server.cpp  ──► {"type":"history"} ──► Browser

Broker Live Feed
        │
        ▼
data_live.cpp  ──► Tick{}
                      │
                      ▼
              tick_processor.cpp
               │           │
               ▼           ▼
         FlowPacket     VolumeProfileEngine.addTick()
               │               │
               ▼               ▼
     broadcast("flow")   buildDirtyMessage()
                                │
                                ▼
                       broadcast("vp")

limit_order.cpp / data_live.cpp (depth)
        │
        ▼
broadcast("depth")  ──► Browser

options_chain.cpp
        │  (every 5 min or on-demand)
        ▼
broadcast("options_gex")  ──► Browser
```
