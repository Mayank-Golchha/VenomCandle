# VenomCandle

A high-performance, real-time trading engine for Indian and global markets, written in C++17. VenomCandle connects directly to your broker's WebSocket feed, classifies every trade as an aggressive buy or sell, and renders professional-grade charting tools in the browser — no Python runtime, no Electron, no paid data vendor, no subscription fees.

Everything runs as a single native executable on Windows. Point it at your broker, open `http://localhost:8080`, and your chart is live in seconds.

---

## What it looks like

**Cluster Chart — Footprint candles with aggressive buy/sell volume at every price level**

![Cluster Chart](images/clusterchart.png)

**Footprint — Full bid/ask volume breakdown inside every candle**

![Footprint](images/footprint.png)

**Liquidity Heatmap — Historical order book depth rendered across time**

![Liquidity Heatmap](images/heatmap1.png)

![Liquidity Heatmap Detail](images/heatmap2.png)

---

## Features

**Aggressive trade classification**
Every tick is classified as an aggressive buy (traded at the ask), aggressive sell (traded at the bid), or neutral using a Lee-Ready tick test fallback. This classification drives every volume tool in the platform.

**Real-time Volume Profile**
A fixed-point, cache-friendly volume profile engine processes every tick with O(1) updates. Point of Control, Value Area High, and Value Area Low update live. Only changed price levels are sent to the browser — the wire traffic stays minimal even on high-volume instruments like NIFTY or BTC.

**Footprint and Cluster Charts**
See the buy and sell volume transacted at each price level inside every 1-minute candle. Identify absorption, imbalances, and initiative activity without relying on external indicator services.

**Fixed Range Volume Profile**
Select any range of historical candles in the chart and compute the volume profile for that exact window on demand.

**50-Level Limit Order Book**
A live tick-by-tick depth feed shows all 50 bid and ask levels with price, quantity, and order count updating in real time.

**Liquidity Heatmap**
Historical order book snapshots rendered as a color-graded heatmap across time. Identify persistent liquidity walls and swept levels at a glance.

**Gamma Exposure (GEX)**
Fetches the full NSE options chain, computes gamma exposure for every strike and expiry using the formula `gamma * OI * lot_size * spot^2 * 0.01`, and broadcasts the Call Wall and Put Wall to the chart. Refreshes every 5 minutes automatically and on demand per symbol.

**Symbol switching without restart**
Subscribe to any symbol during a live session. Historical candles are fetched in the background via the broker REST API, and the volume profile begins building from the first arriving tick.

**No external services**
All data comes directly from your broker. No third-party data feed, no cloud relay, no telemetry.

---

## Broker support

VenomCandle currently supports two brokers:

**Fyers** — Full support for NSE, BSE, and MCX instruments. Live tick feed via the Fyers Data WebSocket (protobuf binary format). Historical 1-minute OHLCV candles via Fyers History REST API. 50-level tick-by-tick depth via the Fyers TBT WebSocket. Options chain GEX via the Fyers Options Chain API. Works with equities, indices, futures, and options.

**Coinbase** — Full support for Coinbase spot market pairs (BTC-USD, ETH-USD, and others). Live ticker, trades, and level-2 depth via the Coinbase Advanced Trade WebSocket. Historical candles via the Coinbase Exchange REST API. No API key required for public market data.

---

## Roadmap

The broker layer is fully abstracted behind a stable interface. Adding a new broker requires creating one directory with three to five files — the engine core, charting server, and volume profile engine are never touched. Adding your broker takes roughly an afternoon with the guide in `docs/ADDING_A_BROKER.md`.

Planned broker integrations for Indian markets:

| Broker | API |
|---|---|
| Zerodha | Kite Connect WebSocket |
| Upstox | Market Data WebSocket v3 |
| Angel One | SmartAPI WebSocket |
| ICICI Direct | Breeze Connect |
| Shoonya (Finvasia) | NorenApi WebSocket |
| Dhan | Market Feed WebSocket |
| Motilal Oswal | MO Trader API |

The goal is for every Indian retail broker to plug into the same tick pipeline and deliver the same footprint, volume profile, heatmap, and GEX tools with no chart-side changes.

---

## Building from source

**Requirements**

- Windows 10 or later (uses WinHTTP and Winsock2)
- CMake 3.15 or later
- C++17 compiler — MinGW-w64 via MSYS2 (recommended) or MSVC
- Protocol Buffers (`libprotobuf`)
- `libwebsockets`
- `pkg-config`

**Install dependencies via MSYS2**

Open the MSYS2 MinGW64 shell and run:

```bash
pacman -S mingw-w64-x86_64-cmake
pacman -S mingw-w64-x86_64-protobuf
pacman -S mingw-w64-x86_64-libwebsockets
pacman -S mingw-w64-x86_64-pkg-config
```

**Step 1 — Select your broker**

Open `include/config.h` and set one line:

```cpp
// Indian markets (NSE, BSE, MCX):
#define TRADING_BROKER_NAME "FYERS"

// Crypto spot markets:
#define TRADING_BROKER_NAME "COINBASE"
```

**Step 2 — Set credentials (Fyers only)**

Open `include/broker_adapters/fyers/config.h` and fill in your Fyers app ID and access token:

```cpp
inline std::string fyersAppId()       { return "YOUR_APP_ID-100"; }
inline std::string fyersAccessToken() { return "YOUR_ACCESS_TOKEN"; }
```

For Coinbase, no credentials are required for public market data.

**Step 3 — Configure**

From the MSYS2 MinGW64 shell, at the project root:

```bash
mkdir build && cd build
cmake -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release ..
```

CMake reads `TRADING_BROKER_NAME` from `config.h` automatically and includes only the relevant adapter sources and protobuf schema. No extra CMake variables are needed.

**Step 4 — Build**

```bash
cmake --build . --config Release
```

**Step 5 — Run**

```bash
./TradingEngine.exe
```

Open your browser at `http://localhost:8080`. The chart loads with up to 5 sessions of 1-minute historical candles and begins streaming live ticks immediately.

---

## How it works

```
Broker WebSocket / REST
        |
        v
  data_live.cpp  ->  Tick { symbol, ltp, qty, bid, ask, time }
                          |
                          v
                  tick_processor.cpp
                  /                 \
                 v                   v
           FlowPacket          VolumeProfileEngine
                |                        |
                v                        v
        broadcast("flow")        broadcast("vp")
                |
                v
    Browser  (frontend.html + app.js + Vela chart library)
```

The engine is split into three layers. The charting server and volume profile engine call only the broker-neutral functions declared in `include/broker/`. The dispatch shims in `src/broker/` route those calls to whichever broker adapter was compiled in. Broker adapters live entirely in `src/broker_adapters/<name>/` and know nothing about the chart.

---

## Documentation

- `docs/README.md` — internal file-by-file reference for every header and source file in the project
- `docs/ADDING_A_BROKER.md` — step-by-step guide to integrating a new broker, with annotated code templates, data contracts, and a common-mistakes table

---

## Contributing

Pull requests for new broker adapters are welcome. The `docs/ADDING_A_BROKER.md` guide covers exactly what files to create, what contracts they must satisfy, and what to update in the dispatch shims and CMake build. Each adapter is self-contained and does not affect any other broker or the engine core.

---

## License

See `LICENSE` for terms.