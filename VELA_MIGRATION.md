# TradingEngine — Vela™ frontend

The C++ backend, Fyers feed, tick processing, aggressive buy/sell classification,
WebSocket protocol, candle aggregation, and volume-profile calculations remain unchanged.

The browser chart has been migrated from KLineCharts to **LuxAlgo Vela™ VelaWorkspace**.

## Architecture

- **VelaWorkspace** provides the complete chart UI out of the box:
  - ~67 built-in drawing tools (trendlines, Fibonacci, boxes, channels, etc.)
  - Symbol / timeframe / chart-style chrome (top bar)
  - Keyboard shortcuts (`Alt+T` for trendline, `?` for shortcuts panel, etc.)
  - Built-in indicators (70+ native studies — SMA, EMA, VWAP, SuperTrend, etc.)
  - Object tree, sync groups, state persistence
  - WebGL2 renderer with canvas2d fallback

- **Custom FyersProvider** bridges the existing `/ws` WebSocket stream into Vela's
  data port. It implements the standard Vela DataProvider contract:
  - `getBars(symbol, timeframe, from, to)` — returns cached history from the C++ server
  - `subscribe(symbol, timeframe, onTick)` — forwards live forming candles
  - `listSymbols()` / `getSymbolInfo()` — returns MCX symbol metadata

- **Volume Profile** is rendered as a Vela-native indicator layer from the C++ backend's
  tick-level price rows, including aggressive buy/sell volume, POC, VAH, and VAL. The
  layer uses Vela's chart coordinates and indicator legend, and updates from snapshots
  plus incremental changed-level messages.

## CDN dependency

```
https://esm.sh/@luxalgo/vela@0.7.0/workspace?bundle=false
https://esm.sh/@luxalgo/vela@0.7.0/plugin?bundle=false
```

Both imports use an unbundled module graph so the workspace and plugin SDK share
Vela's native-indicator and renderer-layer registries.

## No logic changes

WebSocket candle aggregation and the C++ volume-profile engine remain unchanged. Fixed-
range VP server requests remain available to backend consumers.

## License

Vela™ is Apache-2.0. The VelaWorkspace renders its own attribution watermark.
