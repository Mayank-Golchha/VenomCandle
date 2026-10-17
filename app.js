/* TradingEngine frontend — Vela™ (LuxAlgo) renderer, broker-selected market data.
   Symbol selection uses the catalog for the active broker.
   ──────────────────────────────────────────────────────────────────────
   This file uses VelaWorkspace (the batteries-included chart app) for:
     • Candlestick rendering (WebGL2, canvas2d fallback)
     • Built-in drawing tools (~67 tools: trendlines, fib, boxes, etc.)
     • Symbol / timeframe / theme / indicators chrome
     • Keyboard shortcuts, object tree, sync groups
   The custom data provider bridges the existing C++ WebSocket feed
   into Vela's data port — no extra REST calls or polling added.
   ──────────────────────────────────────────────────────────────────── */

import {
  FOOTPRINT_PRICE_SCALE,
  FOOTPRINT_SYMBOL_SUFFIXES,
  parseFootprintSeries,
  asFootprintSeriesBar,
  getCandleProfile
} from "./candlestyles.js";

// ── Config ────────────────────────────────────────────────────────────
const CONFIG = {
  // The server replaces this HTML meta value from DEFAULT_SYMBOL in config.h.
  symbol: document.querySelector('meta[name="backend-default-symbol"]')?.content || "",
  broker: document.querySelector('meta[name="backend-broker"]')?.content || "FYERS",
  timeframe: "1",
  websocketPath: "/ws",
  reconnectMs: 1000,
  candleSpanMs: 60000,
  timezone: "Asia/Kolkata",
  upColor: "rgb(237, 230, 230)",
  downColor: "rgba(253, 60, 60, 0.89)",
};

const FYERS_INDEX_SYMBOLS = [
  { ticker: "NIFTY50-INDEX", description: "NIFTY 50 Index", prefix: "NSE", type: "index" },
  { ticker: "NIFTYBANK-INDEX", description: "BANKNIFTY / NIFTY BANK Index", prefix: "NSE", type: "index" },
  { ticker: "FINNIFTY-INDEX", description: "FINNIFTY / NIFTY Financial Services Index", prefix: "NSE", type: "index" },
  { ticker: "MIDCPNIFTY-INDEX", description: "MIDCPNIFTY / NIFTY Midcap Select Index", prefix: "NSE", type: "index" },
  { ticker: "NIFTYNXT50-INDEX", description: "NIFTY NEXT 50 Index", prefix: "NSE", type: "index" },
  { ticker: "SENSEX-INDEX", description: "SENSEX Index", prefix: "BSE", type: "index" },
  { ticker: "BANKEX-INDEX", description: "BANKEX Index", prefix: "BSE", type: "index" }
];

// Feed providers have emitted both `RELIANCE-EQ` and `NSE:RELIANCE-EQ` in
// different message types. Keep routing tolerant of that representation while
// still requiring an exact instrument match.
function symbolKey(value) {
  let symbol = String(value || "").trim().toUpperCase();
  if (!symbol) return "";
  if (symbol.startsWith("FYERS:") || symbol.startsWith("COINBASE:")) symbol = symbol.slice(symbol.indexOf(":") + 1);
  if (CONFIG.broker === "FYERS" && !symbol.includes(":")) symbol = "NSE:" + symbol;
  return symbol;
}
const providerPrefix = CONFIG.broker.toLowerCase() + ":";

// ── DOM refs ──────────────────────────────────────────────────────────
let nseCompanyCatalogPromise;
function loadNseCompanyCatalog() {
  if (CONFIG.broker === "COINBASE") return Promise.resolve([
    ["BTC-USD", "Bitcoin / US Dollar"], ["ETH-USD", "Ethereum / US Dollar"],
    ["SOL-USD", "Solana / US Dollar"], ["XRP-USD", "XRP / US Dollar"],
    ["LTC-USD", "Litecoin / US Dollar"], ["DOGE-USD", "Dogecoin / US Dollar"],
    ["BTC-USDC", "Bitcoin / USDC"], ["ETH-USDC", "Ethereum / USDC"]
  ].map(([ticker, description]) => ({ ticker, description, prefix: "", type: "crypto" })));
  if (!nseCompanyCatalogPromise) nseCompanyCatalogPromise = fetch("/symbols.csv", { cache: "no-store" }).then(async response => {
    if (!response.ok) throw new Error("NSE symbols unavailable (" + response.status + ")");
    const rows = (await response.text()).replace(/^\uFEFF/, "").split(/\r?\n/);
    const headers = parseCsvLine(rows.shift() || "").map(x => x.trim().toUpperCase());
    const symbolColumn = headers.indexOf("SYMBOL");
    const nameColumn = headers.indexOf("NAME OF COMPANY");
    const seriesColumn = headers.indexOf("SERIES");
    if (symbolColumn < 0 || nameColumn < 0 || seriesColumn < 0) throw new Error("Unexpected NSE CSV format");
    const companies = rows.flatMap(row => {
      if (!row.trim()) return [];
      const fields = parseCsvLine(row);
      if (fields[seriesColumn]?.trim() !== "EQ") return [];
      const ticker = fields[symbolColumn]?.trim();
      const description = fields[nameColumn]?.trim();
      return ticker && description ? [{ ticker: ticker + "-EQ", description, prefix: "NSE", type: "stock" }] : [];
    });
    return CONFIG.broker === "FYERS" ? [...FYERS_INDEX_SYMBOLS, ...companies] : companies;
  }).catch(error => {
    nseCompanyCatalogPromise = null;
    // Keep common index symbols searchable even when the NSE equity catalog is
    // temporarily unavailable.
    if (CONFIG.broker === "FYERS") return [...FYERS_INDEX_SYMBOLS];
    throw error;
  });
  return nseCompanyCatalogPromise;
}

// ── State ─────────────────────────────────────────────────────────────
let historyBars = [];
let currentCandle = null;
let ws = null;
let historyReadyResolve;
let historyReady = new Promise(resolve => { historyReadyResolve = resolve; });
const chartCache = new Map();
const MAX_CACHED_SYMBOLS = 12;
const MAX_PERSISTED_SYMBOLS = 100;
let chartRequestId = 0;
const cacheWriteTimers = new Map();
let chartCacheDbPromise;

function tradingDayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return value.year + "-" + value.month + "-" + value.day;
}

function isFreshLiveTimestamp(value, symbol = CONFIG.symbol) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp < 100_000_000_000) timestamp *= 1000;
  const now = Date.now();
  const ageMs = now - timestamp;
  if (ageMs > 90_000 || ageMs < -10_000) return false;
  if (/^NSE:.*-EQ$/i.test(String(symbol || ""))) {
    const inNseSession = epoch => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: CONFIG.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(new Date(epoch));
      const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
      const minute = Number(values.hour) * 60 + Number(values.minute);
      return values.weekday !== "Sat" && values.weekday !== "Sun" && minute >= 555 && minute < 930;
    };
    if (!inNseSession(timestamp) || !inNseSession(now)) return false;
  }
  return true;
}

function openChartCacheDb() {
  if (chartCacheDbPromise) return chartCacheDbPromise;
  chartCacheDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("trading-engine-chart-cache", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("markets", { keyPath: "symbol" });
      store.createIndex("savedAt", "savedAt", { unique: false });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        chartCacheDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => { chartCacheDbPromise = null; reject(request.error); };
  });
  return chartCacheDbPromise;
}

async function persistChartCache(symbol, value) {
  try {
    const db = await openChartCacheDb();
    const tx = db.transaction("markets", "readwrite");
    const store = tx.objectStore("markets");
    store.put({ symbol, savedAt: Date.now(), dayKey: value.dayKey, bars: value.bars, current: value.current, footprints: value.footprints, liveFootprints: value.liveFootprints });
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      let removeCount = countRequest.result - MAX_PERSISTED_SYMBOLS;
      if (removeCount <= 0) return;
      const cursorRequest = store.index("savedAt").openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || removeCount <= 0) return;
        if (cursor.value.symbol !== symbol) { cursor.delete(); removeCount--; }
        cursor.continue();
      };
    };
    tx.onabort = () => console.warn("Chart cache write was interrupted", tx.error);
  } catch (error) { console.warn("Chart cache could not be saved", error); }
}

async function readChartCache(symbol) {
  const inMemory = chartCache.get(symbol);
  if (inMemory?.dayKey === tradingDayKey()) return inMemory;
  if (inMemory) chartCache.delete(symbol);
  try {
    const db = await openChartCacheDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction("markets", "readonly");
      const request = tx.objectStore("markets").get(symbol);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error || new Error("Chart cache read was interrupted"));
    });
    if (!value || value.dayKey !== tradingDayKey()) return null;
    chartCache.set(symbol, value);
    while (chartCache.size > MAX_CACHED_SYMBOLS) chartCache.delete(chartCache.keys().next().value);
    return value;
  } catch (error) { console.warn("Saved chart cache could not be loaded", error); return null; }
}

function parseCsvLine(line) {
  const fields = []; let field = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { fields.push(field); field = ""; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}
function cacheActiveChart(persist = true, deepCopy = true) {
  chartCache.delete(CONFIG.symbol);
  chartCache.set(CONFIG.symbol, {
    dayKey: tradingDayKey(),
    bars: deepCopy ? historyBars.map(bar => ({ ...bar, footprint: bar.footprint ? structuredClone(bar.footprint) : undefined })) : historyBars,
    current: currentCandle?.isLive
      ? (deepCopy ? { ...currentCandle, footprint: currentCandle.footprint ? structuredClone(currentCandle.footprint) : undefined } : currentCandle)
      : null,
    footprints: deepCopy ? [...footprintCandlesByTime.entries()].map(([time, candle]) => [time, structuredClone(candle)]) : footprintCandlesByTime,
    liveFootprints: deepCopy ? [...liveFootprints.entries()].map(([time, footprint]) => [time, structuredClone(footprint)]) : liveFootprints
  });
  while (chartCache.size > MAX_CACHED_SYMBOLS) chartCache.delete(chartCache.keys().next().value);
  if (persist) persistChartCache(CONFIG.symbol, chartCache.get(CONFIG.symbol));
}

function queueChartCacheWrite() {
  const symbol = CONFIG.symbol;
  if (cacheWriteTimers.has(symbol)) return;
  const timer = setTimeout(() => {
    cacheWriteTimers.delete(symbol);
    if (symbol === CONFIG.symbol) cacheActiveChart();
    else if (chartCache.has(symbol)) persistChartCache(symbol, chartCache.get(symbol));
  }, 30000);
  cacheWriteTimers.set(symbol, timer);
}

async function switchChartSymbol(symbol, velaAlreadyChanged = false) {
  symbol = symbolKey(symbol);
  if (!symbol || symbol === CONFIG.symbol) return;
  cacheActiveChart();
  const switchId = ++chartRequestId;
  CONFIG.symbol = symbol;
  
  publishOptionsWalls({ callWall: 0, putWall: 0 });
  publishGexHeatmap({ spot: 0, gexLevels: [] });
  publishOiProfile({ spot: 0, gexLevels: [] });   // add


  workspace.chart.renderer?.renderer?.scheduler?.invalidate?.(4);
  const cached = await readChartCache(symbol);
  if (switchId !== chartRequestId) return;
  historyBars = [];
  currentCandle = null;
  liveFootprints = new Map();
  footprintCandlesByTime = new Map();
  backendVpLevels.clear();
  publishBackendVolumeProfile({ levels: [], poc: 0, vah: 0, val: 0, step: 0.01 });
  window.lastFyersTbt = null;
  clearOrderBook();
  if (cached) {
    chartCache.delete(symbol); chartCache.set(symbol, cached);
    historyBars = cached.bars
      .filter(bar => !bar.isLive || isFreshLiveTimestamp(bar.time, symbol))
      .map(bar => ({ ...bar, footprint: bar.footprint ? structuredClone(bar.footprint) : undefined }));
    currentCandle = cached.current?.isLive && isFreshLiveTimestamp(cached.current.time, symbol) ? { ...cached.current } : null;
    footprintCandlesByTime = new Map([...(cached.footprints || [])]
      .filter(([time]) => isFreshLiveTimestamp(time, symbol))
      .map(([time, candle]) => [time, structuredClone(candle)]));
    liveFootprints = new Map([...(cached.liveFootprints || [])]
      .filter(([time]) => isFreshLiveTimestamp(time, symbol))
      .map(([time, footprint]) => [time, structuredClone(footprint)]));
  } else liveFootprints = new Map();
  historyReadyResolve();
  historyReady = Promise.resolve();
  // Load through the selected provider so `live: true` subscribes to backend
  // flow messages. Passing inline `data` makes Vela synthesize random offline
  // ticks and candles, even when the backend WebSocket is disconnected.
  if (!velaAlreadyChanged) await workspace.chart.setMarket({ symbol: providerPrefix + symbol, timeframe: CONFIG.timeframe });
  ws?.send(JSON.stringify({ type: "select_symbol", symbol, request_id: switchId }));
  ws?.send(JSON.stringify({ type: "options_request", symbol }));
}

const flowListeners = new Set();
// const FOOTPRINT_PRICE_SCALE = 100;
let liveFootprints = new Map();

// ── Bar conversion ────────────────────────────────────────────────────
function toVelaBar(b) {
  return {
    time: Number(b.timestamp ?? b.time),
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
    volume: Number(b.volume) || 0,
    buy: Number(b.buy ?? b.aggressive_buying) || 0,
    sell: Number(b.sell ?? b.aggressive_selling) || 0
  };
}

function normalizeHistory(candles) {
  const byTime = new Map();
  for (const candle of candles || []) {
    const b = toVelaBar(candle);
    if (!Number.isFinite(b.time)) continue;
    if (!Number.isFinite(b.open)) continue;
    if (!Number.isFinite(b.high)) continue;
    if (!Number.isFinite(b.low)) continue;
    if (!Number.isFinite(b.close)) continue;
    byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function updateLiveFootprint(candleTime, deltas, tickSize) {
  for (const time of liveFootprints.keys()) {
    if (time < candleTime - CONFIG.candleSpanMs) liveFootprints.delete(time);
  }
  if (!Array.isArray(deltas) || deltas.length === 0) return null;

  const step = Number(tickSize);
  if (!Number.isFinite(step) || step <= 0) return null;

  let footprint = liveFootprints.get(candleTime);
  if (!footprint) {
    footprint = { tickSize: step, lowKey: Infinity, highKey: -Infinity, trades: new Map() };
    liveFootprints.set(candleTime, footprint);
  }

  for (const delta of deltas) {
    const price = Number(delta.price);
    if (!Number.isFinite(price)) continue;
    const key = Math.round(price * FOOTPRINT_PRICE_SCALE);
    footprint.lowKey = Math.min(footprint.lowKey, key);
    footprint.highKey = Math.max(footprint.highKey, key);
    let level = footprint.trades.get(key);
    if (!level) {
      level = { price: key / FOOTPRINT_PRICE_SCALE, buy: 0, sell: 0, other: 0 };
      footprint.trades.set(key, level);
    }
    level.buy += Number(delta.buy) || 0;
    level.sell += Number(delta.sell) || 0;
    level.other += Number(delta.other) || 0;
  }

  const stepKeys = Math.max(1, Math.round(footprint.tickSize * FOOTPRINT_PRICE_SCALE));
  const count = Math.floor((footprint.highKey - footprint.lowKey) / stepKeys + 0.5) + 1;
  if (!Number.isFinite(count) || count <= 0 || count > 100000) return null;

  const levels = [];
  for (let i = 0, key = footprint.lowKey; i < count; ++i, key += stepKeys) {
    const trades = footprint.trades.get(key);
    const buy = trades?.buy || 0;
    const sell = trades?.sell || 0;
    const other = trades?.other || 0;
    levels.push({
      price: key / FOOTPRINT_PRICE_SCALE,
      buy,
      sell,
      other,
      total: buy + sell + other,
      delta: buy - sell
    });
  }

  return {
    source: "live-ticks",
    tickSize: footprint.tickSize,
    low: footprint.lowKey / FOOTPRINT_PRICE_SCALE,
    high: footprint.highKey / FOOTPRINT_PRICE_SCALE,
    levelCount: levels.length,
    levels
  };
}

function storeLiveCandle(candle) {
  const index = historyBars.findIndex(bar => bar.time === candle.time);
  if (index >= 0) historyBars[index] = { ...candle };
  else {
    historyBars.push({ ...candle });
    historyBars.sort((a, b) => a.time - b.time);
  }
}

// PineTS receives ordinary OHLCV bars from Vela. These synthetic symbol suffixes
// let Pine request the live footprint series through the same data provider.
// const FOOTPRINT_SERIES = new Set([
//   "DELTA", "BUY", "SELL", "OTHER", "READY", "TICK",
//   "BUY_IMBALANCE_PRICE", "BUY_IMBALANCE_RATIO",
//   "SELL_IMBALANCE_PRICE", "SELL_IMBALANCE_RATIO"
// ]);
// const FOOTPRINT_SYMBOL_SUFFIXES = [
//   ...[...FOOTPRINT_SERIES].map(series => `.FP_${series}`)
// ];

// ── Custom broker DataProvider ────────────────────────────────────────
class BrokerDataProvider {
  requestedBase(symbol) {
    const footprint = parseFootprintSeries(symbol);
    return symbolKey(String(footprint?.base || symbol || "").replace(/^(fyers|coinbase):/i, ""));
  }

  async getBars(symbol, _timeframe, range) {
    await historyReady;

    const footprintRequest = parseFootprintSeries(symbol);
    const base = this.requestedBase(symbol);
    if (base !== CONFIG.symbol.toUpperCase()) return [];
    let bars = historyBars.slice();
    const from = Number(range?.from);
    const to = Number(range?.to);
    const limit = Number(range?.limit);

    if (Number.isFinite(from)) bars = bars.filter(b => b.time >= from);
    if (Number.isFinite(to)) bars = bars.filter(b => b.time <= to);
    if (Number.isFinite(limit) && limit > 0 && bars.length > limit) {
      bars = bars.slice(-limit);
    }

    return footprintRequest ? bars.map(bar => asFootprintSeriesBar(bar, footprintRequest)) : bars;
  }

  subscribe(symbol, _timeframe, onBar) {
    const footprintRequest = parseFootprintSeries(symbol);
    const base = this.requestedBase(symbol);
    const listener = {
      onBar: bar => {
        if (base !== CONFIG.symbol.toUpperCase()) return;
        onBar(footprintRequest ? asFootprintSeriesBar(bar, footprintRequest) : bar);
      },
      active: true
    };
    flowListeners.add(listener);
    return () => {
      listener.active = false;
      flowListeners.delete(listener);
    };
  }

  async listSymbols() {
    const companies = await loadNseCompanyCatalog();
    // Publish the finite synthetic series as provider symbols so Vela's symbol
    // index and Pine request.security resolver recognize them as first-class.
    // Price-keyed .FP_*_AT_<key> requests remain handled by parseFootprintSeries.
    const exchange = CONFIG.symbol.match(/^([A-Z]+):/i)?.[1] || "NSE";
    const ticker = CONFIG.broker === "FYERS" ? CONFIG.symbol.replace(/^[A-Z]+:/i, "") : CONFIG.symbol;
    return [...companies, ...FOOTPRINT_SYMBOL_SUFFIXES.map(suffix => ({
      ticker: `${ticker}${suffix}`,
      description: `${CONFIG.symbol}${suffix}`,
      prefix: CONFIG.broker === "FYERS" ? exchange : "",
      type: "synthetic"
    }))];
  }

  async getSymbolInfo(symbol) {
    const baseTicker = String(symbol || "").replace(/^(NSE:|BSE:|COINBASE:)/i, "").toUpperCase();
    const company = (await loadNseCompanyCatalog()).find(item => item.ticker.toUpperCase() === baseTicker);
    return {
      ticker: symbol || CONFIG.symbol,
      description: company?.description || symbol || CONFIG.symbol,
      pricescale: 100,
      minmov: 1,
      session: CONFIG.broker === "FYERS" ? "0915-1530" : "24x7",
      timezone: CONFIG.timezone,
      type: company?.type || (CONFIG.broker === "FYERS" ? "stock" : "crypto")
    };
  }
}

// ── Vela Workspace initialisation ─────────────────────────────────────
// Keep the workspace and plugin SDK on one unbundled module graph. Bundling each
// subpath separately creates separate indicator/layer registries.
import { registerChartType, registerNativeIndicator, registerRendererLayer, registerWidgetAction } from 'https://esm.sh/@luxalgo/vela@0.7.0/plugin?bundle=false';
import { VelaWorkspace } from 'https://esm.sh/@luxalgo/vela@0.7.0/workspace?bundle=false';

let openOrderTicket = null;
registerWidgetAction({
  id: "order-buy",
  target: "topbar",
  label: "BUY",
  align: "right",
  order: -2,
  run: () => openOrderTicket?.({ side: "buy" })
});
registerWidgetAction({
  id: "order-sell",
  target: "topbar",
  label: "SELL",
  align: "right",
  order: -1,
  run: () => openOrderTicket?.({ side: "sell" })
});

registerWidgetAction({
  id: "pine-editor",
  target: "topbar",
  label: "Pine Editor",
  align: "right",
  run: togglePineEditor
});

const BIG_TRADES_STORAGE_KEY = "tradingengine.bigTrades.v1";
const BIG_TRADES_ANALYSIS_KEY = `${BIG_TRADES_STORAGE_KEY}.aggregated-flow.v4`;
const BIG_TRADES_DEFAULTS = {
  sampleCount: 500, inputType: "quantity", filterMode: "automatic", minTradeSize: 0, maxTradeSize: 0,
  minSizePercentile: 95,
  intensity: "Medium", recalibration: "weekly", shape: "circle", hollow: true, showText: false,
  stdScaling: true, minSize: 5, maxSize: 28, minOpacity: 25, maxOpacity: 90,
  askColor: "#22c55e", bidColor: "#ef4444", insideBar: false, textSize: 11, textColor: "#ffffff"
};
let bigTradeSettings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(BIG_TRADES_STORAGE_KEY) || "{}");
    if (saved.minSizePercentile == null && saved.minAggressorShare != null) saved.minSizePercentile = saved.minAggressorShare;
    delete saved.minAggressorShare;
    return { ...BIG_TRADES_DEFAULTS, ...saved };
  }
  catch { return { ...BIG_TRADES_DEFAULTS }; }
})();
const bigTradeSamples = [];
let bigTradeSampleStart = 0;
const bigTradeBubbles = [];
let bigTradeBubbleStart = 0;
let bigTradeSum = 0, bigTradeSumSq = 0, bigTradeThresholds = { low: Infinity, medium: Infinity, strong: Infinity };
let bigTradeLastAnalysis = 0, bigTradeAnalysisRecord = null;
let bigTradePreviousPrice = 0, bigTradeVolatility = 0, bigTradeTrend = 0;
let bigTradesEnabled = true;
let bigTradeBuyDominantPackets = 0, bigTradeSellDominantPackets = 0;
let bigTradeGreenBubbles = 0, bigTradeRedBubbles = 0, bigTradeLastStatsPaint = 0;
const bigTradeSinks = new Set();
function notifyBigTrades() { for (const sink of bigTradeSinks) sink.refresh(); }
function toggleBigTrades() {
  const panel = document.getElementById("big-trades-panel");
  if (panel) panel.hidden = !panel.hidden;
}
// registerWidgetAction({ id: "big-trades", target: "topbar", label: "Big Trades", align: "right", run: toggleBigTrades });

function addBigTradeSample(value) {
  if (!(value > 0) || !Number.isFinite(value)) return;
  const cap = Math.max(20, Math.min(20000, Number(bigTradeSettings.sampleCount) || 500));
  bigTradeSamples.push(value); bigTradeSum += value; bigTradeSumSq += value * value;
  while (bigTradeSamples.length - bigTradeSampleStart > cap) {
    const old = bigTradeSamples[bigTradeSampleStart++]; bigTradeSum -= old; bigTradeSumSq -= old * old;
  }
  if (bigTradeSampleStart > 4096 && bigTradeSampleStart * 2 > bigTradeSamples.length) {
    bigTradeSamples.splice(0, bigTradeSampleStart); bigTradeSampleStart = 0;
  }
}
function recalibrateBigTrades(now = Date.now(), force = false) {
  // const interval = bigTradeSettings.recalibration === "monthly" ? 30 * 86400000 : 7 * 86400000;
  if (bigTradeSamples.length - bigTradeSampleStart < 1000) return;   // need a real sample
  if (!force && now - bigTradeLastAnalysis < 5000) return;          // refresh every 5s

  // if (!force && now - bigTradeLastAnalysis < interval) return;
  if (bigTradeSamples.length - bigTradeSampleStart < 10) return;
  bigTradeLastAnalysis = now;
  const sorted = bigTradeSamples.slice(bigTradeSampleStart).sort((a, b) => a - b);
  const pick = q => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
  const intensity = bigTradeSettings.intensity;
  const percentile = Math.max(0.5, Math.min(0.99, (Number(bigTradeSettings.minSizePercentile) || 95) / 100));
  bigTradeThresholds = {
    low: pick(Math.max(percentile, intensity === "Low" ? 0.65 : 0.78)),
    medium: pick(Math.max(percentile, intensity === "Strong" ? 0.94 : intensity === "Low" ? 0.84 : 0.88)),
    strong: pick(Math.max(percentile, intensity === "Low" ? 0.94 : 0.97))
  };
  bigTradeAnalysisRecord = {
    at: now, cadence: bigTradeSettings.recalibration, sampleCount: sorted.length, dataSource: "aggregated-flow",
    thresholds: { ...bigTradeThresholds }, volatility: bigTradeVolatility, trend: bigTradeTrend
  };
  try { localStorage.setItem(BIG_TRADES_ANALYSIS_KEY, JSON.stringify(bigTradeAnalysisRecord)); } catch { }
  const status = document.getElementById("big-trades-status");
  if (status) status.textContent = `Calibrated ${new Date(now).toLocaleString()} · ${sorted.length} samples · ${bigTradeSettings.recalibration} recalibration · Low ${formatBigTradeNumber(bigTradeThresholds.low)}, Medium ${formatBigTradeNumber(bigTradeThresholds.medium)}, Strong ${formatBigTradeNumber(bigTradeThresholds.strong)}.`;
}
function formatBigTradeNumber(value) { return Number.isFinite(value) ? Number(value.toPrecision(4)).toString() : "—"; }
function onBigTradeFlow(msg) {
  const time = Number(msg.time), price = Number(msg.ltp);
  if (!Number.isFinite(time) || !Number.isFinite(price)) return;
  const returns = bigTradePreviousPrice ? Math.abs(price / bigTradePreviousPrice - 1) : 0;
  bigTradeVolatility = bigTradeVolatility * 0.94 + returns * 0.06;
  bigTradeTrend = bigTradeTrend * 0.9 + (bigTradePreviousPrice ? price / bigTradePreviousPrice - 1 : 0) * 0.1;
  bigTradePreviousPrice = price;
  const liveVolatilityFactor = Math.max(0.7, Math.min(1.6, 1 + bigTradeVolatility * 40 - Math.abs(bigTradeTrend) * 8));
  const buy = Math.max(0, Number(msg.aggressive_buying) || 0);
  const sell = Math.max(0, Number(msg.aggressive_selling) || 0);
  const totalAggressorVolume = buy + sell;
  if (!(totalAggressorVolume > 0)) return;
  if (buy > sell) bigTradeBuyDominantPackets++;
  else if (sell > buy) bigTradeSellDominantPackets++;
  const now = Date.now();
  if (now - bigTradeLastStatsPaint >= 1000) {
    bigTradeLastStatsPaint = now;
    const stats = document.getElementById("big-trades-flow-stats");
    if (stats) stats.textContent = `Packets buy/sell-dominant: ${bigTradeBuyDominantPackets}/${bigTradeSellDominantPackets} · plotted green/red: ${bigTradeGreenBubbles}/${bigTradeRedBubbles}`;
  }
  const dominantAggressorVolume = Math.max(buy, sell);
  const sizeBase = bigTradeSettings.inputType === "side" ? dominantAggressorVolume : totalAggressorVolume;
  const mode = bigTradeSettings.filterMode;
  const sampleSize = bigTradeSettings.inputType === "notional" ? sizeBase * price : sizeBase;
  addBigTradeSample(sampleSize);
  if (mode === "automatic") recalibrateBigTrades(now);
  const side = buy >= sell ? "ask" : "bid";
  const min = Number(bigTradeSettings.minTradeSize) || 0;
  const max = Number(bigTradeSettings.maxTradeSize) || 0;
  const size = bigTradeSettings.inputType === "notional" ? sizeBase * price : sizeBase;
  if (size < min || (max > 0 && size > max)) return;
  const intensity = mode === "manual" ? "Low"
    : size > bigTradeThresholds.strong * liveVolatilityFactor ? "Strong"
      : size > bigTradeThresholds.medium * liveVolatilityFactor ? "Medium"
        : size > bigTradeThresholds.low * liveVolatilityFactor ? "Low" : null;
  if (!intensity) return;
  const activeSampleCount = bigTradeSamples.length - bigTradeSampleStart;
  const mean = bigTradeSum / Math.max(1, activeSampleCount);
  const sampleStd = activeSampleCount > 1 ? Math.sqrt(Math.max(0, bigTradeSumSq / activeSampleCount - mean ** 2)) : 0;
  const score = bigTradeSettings.stdScaling && sampleStd > 0 ? Math.max(0, Math.min(1, (size - mean) / (3 * sampleStd))) :
    (intensity === "Strong" ? 1 : intensity === "Medium" ? 0.65 : 0.3);
  bigTradeBubbles.push({ time, price, size, side, intensity, score });
  if (side === "ask") bigTradeGreenBubbles++; else bigTradeRedBubbles++;
  const cutoff = time - 2 * 86400000;
  while (bigTradeBubbleStart < bigTradeBubbles.length &&
    (bigTradeBubbles.length - bigTradeBubbleStart > 12000 || bigTradeBubbles[bigTradeBubbleStart].time < cutoff)) bigTradeBubbleStart++;
  if (bigTradeBubbleStart > 4096 && bigTradeBubbleStart * 2 > bigTradeBubbles.length) {
    bigTradeBubbles.splice(0, bigTradeBubbleStart); bigTradeBubbleStart = 0;
  }
  notifyBigTrades();
}
function initBigTradesPanel() {
  const panel = document.getElementById("big-trades-panel");
  if (!panel) return;
  for (const input of panel.querySelectorAll("[data-bt]")) {
    const key = input.dataset.bt;
    if (input.type === "checkbox") input.checked = !!bigTradeSettings[key]; else input.value = bigTradeSettings[key];
    input.addEventListener("change", () => {
      bigTradeSettings[key] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
      if (key === "sampleCount") {
        const cap = Math.max(20, Math.min(20000, Number(bigTradeSettings.sampleCount) || 500));
        while (bigTradeSamples.length - bigTradeSampleStart > cap) {
          const old = bigTradeSamples[bigTradeSampleStart++]; bigTradeSum -= old; bigTradeSumSq -= old * old;
        }
      }
      try { localStorage.setItem(BIG_TRADES_STORAGE_KEY, JSON.stringify(bigTradeSettings)); } catch { }
      if (key === "intensity" || key === "recalibration" || key === "minSizePercentile" || key === "sampleCount") recalibrateBigTrades(Date.now(), true);
      notifyBigTrades();
    });
  }
  document.getElementById("big-trades-close")?.addEventListener("click", () => { panel.hidden = true; });
  try { bigTradeAnalysisRecord = JSON.parse(localStorage.getItem(BIG_TRADES_ANALYSIS_KEY) || "null"); } catch { }
  if (bigTradeAnalysisRecord) {
    bigTradeLastAnalysis = Number(bigTradeAnalysisRecord.at) || 0;
    bigTradeThresholds = bigTradeAnalysisRecord.thresholds || bigTradeThresholds;
    const status = document.getElementById("big-trades-status");
    if (status) status.textContent = `Saved analysis ${new Date(bigTradeLastAnalysis).toLocaleString()} · ${bigTradeAnalysisRecord.sampleCount || 0} samples.`;
  }
}
initBigTradesPanel();

const BACKEND_VP_TYPE = "backend-volume-profile";
let backendVp = { levels: [], poc: 0, vah: 0, val: 0, step: 0.01 };
let backendVpVisible = true;
const backendVpSinks = new Set();

const BIG_TRADES_LAYER_ID = "big-trades";

registerNativeIndicator({
  type: BIG_TRADES_LAYER_ID, title: "Big Trades", shortTitle: "Big Trades", overlay: true, paneHint: "price",
  inputsSchema: () => [
    { key: "sampleCount", title: "Recent samples (N)", type: "int", defval: BIG_TRADES_DEFAULTS.sampleCount, min: 20, max: 20000, step: 1, group: "Data" },
    { key: "inputType", title: "Input type", type: "string", defval: "quantity", options: ["quantity", "notional", "side"], group: "Data" },
    { key: "filterMode", title: "Filter mode", type: "string", defval: "automatic", options: ["automatic", "manual"], group: "Data" },
    { key: "minTradeSize", title: "Minimum trade size", type: "float", defval: 0, min: 0, step: 0.01, group: "Data" },
    { key: "maxTradeSize", title: "Maximum trade size (0 = unlimited)", type: "float", defval: 0, min: 0, step: 0.01, group: "Data" },
    { key: "minSizePercentile", title: "Minimum recent size percentile", type: "int", defval: 95, min: 50, max: 99, step: 1, group: "Data" },
    { key: "intensity", title: "Intensity", type: "string", defval: "Medium", options: ["Low", "Medium", "Strong"], group: "Automatic analysis" },
    { key: "recalibration", title: "Recalibration", type: "string", defval: "weekly", options: ["weekly", "monthly"], group: "Automatic analysis" },
    { key: "hollow", title: "Hollow circles", type: "bool", defval: true, group: "Plot" },
    { key: "showText", title: "Show text", type: "bool", defval: false, group: "Plot" },
    { key: "stdScaling", title: "Standard deviation scaling", type: "bool", defval: true, group: "Plot" },
    { key: "minSize", title: "Minimum marker size", type: "int", defval: 5, min: 2, max: 100, step: 1, group: "Plot" },
    { key: "maxSize", title: "Maximum marker size", type: "int", defval: 28, min: 2, max: 100, step: 1, group: "Plot" },
    { key: "minOpacity", title: "Minimum opacity", type: "int", defval: 25, min: 0, max: 100, step: 1, group: "Plot" },
    { key: "maxOpacity", title: "Maximum opacity", type: "int", defval: 90, min: 0, max: 100, step: 1, group: "Plot" },
    { key: "askColor", title: "Ask color", type: "color", defval: "#22c55e", group: "Plot" },
    { key: "bidColor", title: "Bid color", type: "color", defval: "#ef4444", group: "Plot" },
    { key: "insideBar", title: "Plot only inside bar", type: "bool", defval: false, group: "Plot" },
    { key: "textSize", title: "Text size", type: "int", defval: 11, min: 7, max: 32, step: 1, group: "Plot" },
    { key: "textColor", title: "Text color", type: "color", defval: "#ffffff", group: "Plot" }
  ],
  defaultInputs: () => Object.fromEntries(Object.keys(BIG_TRADES_DEFAULTS).filter(key => key !== "shape").map(key => [key, bigTradeSettings[key]])),
  create: () => ({
    context: null, start(context) { this.context = context; bigTradesEnabled = true; context.emit({}); context.pushData({ enabled: true }); bigTradeSinks.add(this); },
    refresh() { this.context?.pushData({ enabled: bigTradesEnabled, updatedAt: Date.now() }); }, onBars() { }, onViewport() { },
    suspend() { bigTradesEnabled = false; this.context?.pushData({ enabled: false, updatedAt: Date.now() }); },
    resume() { bigTradesEnabled = true; this.refresh(); },
    setInputs(inputs) {
      if (!inputs) return;
      for (const key of Object.keys(BIG_TRADES_DEFAULTS)) if (key !== "shape" && inputs[key] !== undefined) bigTradeSettings[key] = inputs[key];
      try { localStorage.setItem(BIG_TRADES_STORAGE_KEY, JSON.stringify(bigTradeSettings)); } catch { }
      if (inputs.intensity !== undefined || inputs.recalibration !== undefined || inputs.minSizePercentile !== undefined || inputs.sampleCount !== undefined) recalibrateBigTrades(Date.now(), true);
      notifyBigTrades();
    },
    stop() { bigTradesEnabled = false; bigTradeSinks.delete(this); this.context = null; }
  })
});

registerRendererLayer({
  id: BIG_TRADES_LAYER_ID, placement: "above-data",
  create: () => {
    let canvas, ctx;
    return {
      mount(element) { canvas = element; ctx = element.getContext("2d"); },
      render({ bars, data, coords, scale, bounds, dpr = coords.dpr }) {
        if (!ctx || !canvas) return;
        const ratio = coords.dpr || dpr || 1;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
        if (!bigTradesEnabled || !data?.enabled) return;
        const range = coords.visibleLogicalRange();
        const first = Math.max(0, Math.floor(range.from)), last = Math.min((bars?.length || 0) - 1, Math.ceil(range.to));
        if (last < first) return;
        const spacing = coords.bodySpacing();
        const toMs = value => Number(value) * (Number(value) < 1e11 ? 1000 : 1);
        const barStartAt = index => toMs(bars[index].time);
        const barSpanAt = index => {
          const start = barStartAt(index);
          if (index + 1 < bars.length) {
            const next = barStartAt(index + 1) - start;
            if (next > 0) return next;
          }
          if (index > 0) {
            const prior = start - barStartAt(index - 1);
            if (prior > 0) return prior;
          }
          return CONFIG.candleSpanMs;
        };
        ctx.save(); ctx.beginPath(); ctx.rect(0, bounds.top, coords.width, bounds.height); ctx.clip();
        const visibleStart = barStartAt(first);
        const visibleEnd = barStartAt(last) + barSpanAt(last);
        let bubbleIndex = bigTradeBubbleStart, upper = bigTradeBubbles.length;
        while (bubbleIndex < upper) {
          const mid = (bubbleIndex + upper) >> 1;
          const mt = toMs(bigTradeBubbles[mid].time);
          if (mt < visibleStart) bubbleIndex = mid + 1; else upper = mid;
        }
        let barIndex = first;
        for (; bubbleIndex < bigTradeBubbles.length; ++bubbleIndex) {
          const bubble = bigTradeBubbles[bubbleIndex];
          const t = toMs(bubble.time);
          if (t >= visibleEnd) break;
          while (barIndex <= last) {
            const startTime = barStartAt(barIndex);
            if (startTime + barSpanAt(barIndex) > t) break;
            barIndex++;
          }
          const index = barIndex;
          if (index > last) break;
          const bar = bars[index];
          const barStart = barStartAt(index);
          if (t < barStart) continue;
          const price = Number(bubble.price), low = Number(bar.low), high = Number(bar.high);
          if (bigTradeSettings.insideBar && (price < low || price > high)) continue;
          const x = coords.logicalToX(index);
          const y = coords.priceToY(price, scale, bounds);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          const minSize = Math.max(2, Number(bigTradeSettings.minSize) || 5), maxSize = Math.max(minSize, Number(bigTradeSettings.maxSize) || 28);
          const radius = minSize / 2 + (maxSize - minSize) / 2 * Math.max(0, Math.min(1, bubble.score));
          const minAlpha = Math.max(0, Math.min(100, Number(bigTradeSettings.minOpacity) || 0)) / 100;
          const maxAlpha = Math.max(minAlpha, Math.min(100, Number(bigTradeSettings.maxOpacity) || 90) / 100);
          ctx.globalAlpha = minAlpha + (maxAlpha - minAlpha) * Math.max(0, Math.min(1, bubble.score));
          ctx.strokeStyle = bubble.side === "ask" ? bigTradeSettings.askColor : bubble.side === "bid" ? bigTradeSettings.bidColor : "#94a3b8";
          ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
          if (bigTradeSettings.hollow) ctx.stroke(); else ctx.fill();
          if (bigTradeSettings.showText) {
            ctx.globalAlpha = 1; ctx.fillStyle = bigTradeSettings.textColor;
            ctx.font = `${Math.max(7, Math.min(32, Number(bigTradeSettings.textSize) || 11))}px Arial`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(formatBigTradeNumber(bubble.size), x, y);
          }
        }
        ctx.restore();
      }
    };
  }
});
const FOOTPRINT_CHART_TYPE = "footprint";
// This style paints only bars for which we have tick-level footprint data.
registerChartType({ id: FOOTPRINT_CHART_TYPE, label: "Footprint", basePainting: "none" });
let footprintCandlesByTime = new Map();
const volumeDeltaSinks = new Set();

function footprintForBarTime(time) {
  const value = Number(time);
  if (!Number.isFinite(value)) return null;
  // Vela providers and older saved chart data can express epoch timestamps in
  // either seconds or milliseconds. Footprints are keyed by minute in ms.
  const candidates = [value, value * 1000, value / 1000];
  for (const candidate of candidates) {
    const exact = footprintCandlesByTime.get(candidate);
    if (exact) return exact;
    const minute = Math.floor(candidate / CONFIG.candleSpanMs) * CONFIG.candleSpanMs;
    const byMinute = footprintCandlesByTime.get(minute);
    if (byMinute) return byMinute;
  }
  return null;
}

registerRendererLayer({
  id: BACKEND_VP_TYPE,
  placement: "above-data",
  create: () => {
    let canvas = null;
    let ctx = null;
    return {
      mount(element) {
        canvas = element;
        ctx = element.getContext("2d");
      },
      render({ data, coords, scale, bounds, theme }) {
        if (!ctx || !canvas) return;
        const dpr = coords.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

        if (!backendVpVisible || !data?.levels?.length || bounds.height <= 0) return;
        // if (!data?.levels?.length || bounds.height <= 0) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();

        const step = Number(data.step) > 0 ? Number(data.step) : 0.01;
        const rightX = coords.width;
        const maxWidth = coords.width * 0.3;
        const upColor = theme.upColor || "#089981";
        const downColor = theme.downColor || "#f23645";
        // Aggregate only levels that resolve to the same screen pixel. A wider
        // band merges distinct bid/ask sequences and makes the profile look like
        // one oversized bar with only a couple of color blocks.
        // Combine nearby prices into 4px visual bands: this cuts down the hairline
        // count while keeping the session profile readable at normal chart zoom.
        const rowHeight = 4;
        const visibleRows = new Map();

        // The backend stores one row per minimum tick. Combine adjacent ticks that
        // land in the same screen band so the profile remains legible at chart scale.
        for (const level of data.levels) {
          const price = Number(level.p);
          const total = Number(level.t) || 0;
          if (!Number.isFinite(price) || total <= 0) continue;
          const y0 = coords.priceToY(price, scale, bounds);
          const y1 = coords.priceToY(price + step, scale, bounds);
          const yCenter = (y0 + y1) / 2;
          if (yCenter < bounds.top || yCenter >= bounds.top + bounds.height) continue;
          const band = Math.floor((yCenter - bounds.top) / rowHeight);
          let row = visibleRows.get(band);
          if (!row) {
            row = { band, buy: 0, sell: 0, total: 0, inValueArea: false };
            visibleRows.set(band, row);
          }
          row.buy += Math.max(0, Number(level.b) || 0);
          row.sell += Math.max(0, Number(level.s) || 0);
          row.total += total;
          row.inValueArea ||= price >= Number(data.val) && price <= Number(data.vah);
        }

        if (visibleRows.size === 0) {
          ctx.restore();
          return;
        }
        const maxVolume = Math.max(...[...visibleRows.values()].map(row => row.total));
        if (maxVolume <= 0) {
          ctx.restore();
          return;
        }

        for (const row of visibleRows.values()) {
          const yTop = bounds.top + row.band * rowHeight;
          const height = Math.max(1, Math.min(rowHeight, bounds.top + bounds.height - yTop));
          const total = row.total;
          // Keep real but low-volume prices visible instead of letting their
          // normalized width fall below a physical canvas pixel.
          const width = Math.min(maxWidth, Math.max(1.5, total / maxVolume * maxWidth));
          const other = Math.max(0, total - row.buy - row.sell);
          // Match the original two-color profile: unclassified trade volume
          // is shared evenly between the buy and sell sides.
          const displayBuy = row.buy + other / 2;
          const displaySell = row.sell + other / 2;
          const displayBuyWidth = width * displayBuy / total;
          const displaySellWidth = width * displaySell / total;

          ctx.globalAlpha = row.inValueArea ? 0.62 : 0.28;
          let x = rightX - width;
          if (displayBuyWidth > 0) {
            ctx.fillStyle = upColor;
            ctx.fillRect(x, yTop, displayBuyWidth, height);
            x += displayBuyWidth;
          }
          if (displaySellWidth > 0) {
            ctx.fillStyle = downColor;
            ctx.fillRect(x, yTop, displaySellWidth, height);
            x += displaySellWidth;
          }
        }

        ctx.restore();
      },
      destroy() {
        canvas = null;
        ctx = null;
      }
    };
  }
});

registerNativeIndicator({
  type: BACKEND_VP_TYPE,
  title: "Volume Profile",
  shortTitle: "VP",
  overlay: true,
  paneHint: "price",
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => ({
    context: null,
    start(context) {
      this.context = context;
      context.emit({});
      context.pushData(backendVp);
      backendVpSinks.add(this);
    },
    update(profile) {
      this.context?.pushData(profile);
    },
    onBars() { },
    onViewport() { },
    suspend() {
      backendVpVisible = false;
      this.context?.pushData({ levels: [], poc: 0, vah: 0, val: 0, step: 0.01 });
    },
    resume() {
      backendVpVisible = true;
      this.context?.pushData(backendVp);
    },
    setInputs() { },
    stop() {
      backendVpSinks.delete(this);
      this.context = null;
    }
  })
});

function publishBackendVolumeProfile(profile) {
  backendVp = profile;
  for (const sink of backendVpSinks) sink.update(profile);
}


registerRendererLayer({
  id: FOOTPRINT_CHART_TYPE,
  placement: "above-data",
  create: () => {
    let canvas = null;
    let ctx = null;
    return {
      mount(element) {
        canvas = element;
        ctx = element.getContext("2d");
      },
      render({ bars, coords, scale, bounds, theme, priceStyle }) {
        if (!ctx || !canvas) return;
        const dpr = coords.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        if (priceStyle !== FOOTPRINT_CHART_TYPE || !bars?.length || bounds.height <= 0) return;

        const range = coords.visibleLogicalRange();
        const first = Math.max(0, Math.floor(range.from));
        const last = Math.min(bars.length - 1, Math.ceil(range.to));
        const spacing = coords.bodySpacing();
        // Footprint rows need more room than ordinary candle bodies to show values.
        // Keep each footprint candle within its own bar slot to prevent overlap.
        const candleWidth = Math.max(1, Math.min(180, spacing * 0.94));
        const halfWidth = candleWidth / 2;
        const bidColor = theme.downColor || "#f23645";
        const askColor = theme.upColor || "#089981";
        const background = theme.background || "#15171c";

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();

        for (let i = first; i <= last; ++i) {
          const bar = bars[i];
          const candle = footprintForBarTime(bar.time);
          const footprint = candle?.footprint;
          if (!footprint?.levels?.length) continue;

          let maxSide = 0;
          for (const level of footprint.levels) {
            maxSide = Math.max(maxSide, Number(level.buy) || 0, Number(level.sell) || 0);
          }
          const x = coords.logicalToX(i);
          const xLeft = x - halfWidth;

          const levels = [...footprint.levels].sort((a, b) => Number(a.price) - Number(b.price));
          const tickSize = Number(footprint.tickSize);
          if (!Number.isFinite(tickSize) || tickSize <= 0) continue;
          // Draw the footprint against the same OHLC candle that collected its
          // ticks. Its high/low are expanded from actual traded footprint prices
          // when the live candle is assembled below.
          // const candleBar = candle || bar;
          // const candleHigh = Number(candleBar.high);
          // const candleLow = Number(candleBar.low);
          // const candleTop = coords.priceToY(candleHigh, scale, bounds);
          // const candleBottom = coords.priceToY(candleLow, scale, bounds);

          const candleBar = candle || bar;
          // Levels are dense (no gaps), so the first/last level are the bucket extremes.
          // Draw the wick/outline over the full buckets so it contains every row.
          const gridHigh = Number(levels[levels.length - 1].price) + tickSize / 2;
          const gridLow = Number(levels[0].price) - tickSize / 2;
          const candleHigh = Math.max(Number(candleBar.high), gridHigh);
          const candleLow = Math.min(Number(candleBar.low), gridLow);
          const candleTop = coords.priceToY(candleHigh, scale, bounds);
          const candleBottom = coords.priceToY(candleLow, scale, bounds);



          if (!Number.isFinite(candleTop) || !Number.isFinite(candleBottom)) continue;
          const bodyWidth = Math.min(10, Math.max(2, candleWidth * 0.2));
          const gutter = Math.min(0.5, Math.max(0, (candleWidth - bodyWidth) / 2));
          const columnWidth = Math.max(0, (candleWidth - bodyWidth - gutter * 2) / 2);
          const sellerX = xLeft;
          const wickX = sellerX + columnWidth + gutter;
          const buyerX = wickX + bodyWidth + gutter;
          const directionColor = candleBar.close >= candleBar.open ? askColor : bidColor;
          const candlePriceY = price => coords.priceToY(price, scale, bounds);

          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = directionColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(wickX + bodyWidth / 2, Math.min(candleTop, candleBottom));
          ctx.lineTo(wickX + bodyWidth / 2, Math.max(candleTop, candleBottom));
          ctx.stroke();
          const openY = candlePriceY(candleBar.open);
          const closeY = candlePriceY(candleBar.close);
          ctx.fillStyle = directionColor;
          ctx.fillRect(wickX, Math.min(openY, closeY), bodyWidth, Math.max(2, Math.abs(closeY - openY)));

          for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
            const level = levels[levelIndex];
            const price = Number(level.price);
            if (!Number.isFinite(price)) continue;
            // Each row is centered on its actual price. Never spread rows
            // evenly across the candle: that detaches volume from price.
            const y0 = coords.priceToY(price + tickSize / 2, scale, bounds);
            const y1 = coords.priceToY(price - tickSize / 2, scale, bounds);
            const y = Math.min(y0, y1);
            const height = Math.abs(y1 - y0);
            if (!Number.isFinite(y) || !Number.isFinite(height)) continue;
            if (height <= 0 || y + height < bounds.top || y > bounds.top + bounds.height) continue;

            const bid = Math.max(0, Number(level.sell) || 0);
            const ask = Math.max(0, Number(level.buy) || 0);
            ctx.globalAlpha = 0.78;
            ctx.fillStyle = background;
            ctx.fillRect(sellerX, y, columnWidth, height);
            ctx.fillRect(buyerX, y, columnWidth, height);

            if (maxSide > 0 && bid > 0) {
              ctx.globalAlpha = 0.18 + 0.72 * bid / maxSide;
              ctx.fillStyle = bidColor;
              ctx.fillRect(sellerX, y, columnWidth, height);
            }
            if (maxSide > 0 && ask > 0) {
              ctx.globalAlpha = 0.18 + 0.72 * ask / maxSide;
              ctx.fillStyle = askColor;
              ctx.fillRect(buyerX, y, columnWidth, height);
            }

            if (columnWidth >= 10 && height >= 6) {
              const fontSize = Math.min(12, Math.max(6, Math.min(height - 1, columnWidth * 0.72)));
              ctx.globalAlpha = 1;
              ctx.fillStyle = "#f3f4f6";
              ctx.font = `${fontSize}px Arial`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              const label = value => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
              ctx.fillText(label(bid), sellerX + columnWidth / 2, y + height / 2, Math.max(1, columnWidth - 2));
              ctx.fillText(label(ask), buyerX + columnWidth / 2, y + height / 2, Math.max(1, columnWidth - 2));
            }
          }
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = directionColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(xLeft + 0.5, Math.min(candleTop, candleBottom), Math.max(1, candleWidth - 1), Math.max(1, Math.abs(candleBottom - candleTop)));
        }
        ctx.restore();
      },
      destroy() {
        canvas = null;
        ctx = null;
      }
    };
  }
});


// The id equals the lower-cased label on purpose: the style button's aria-label
// is parsed in readChartStyle(), and priceStyle must match this id.
// const PROFILE_CHART_TYPE = "profile";
const PROFILE_CHART_TYPE = "ClusterChart";
// registerChartType({ id: PROFILE_CHART_TYPE, label: "Profile", basePainting: "none" });
registerChartType({ id: PROFILE_CHART_TYPE, label: "ClusterChart", basePainting: "none" });

registerRendererLayer({
  id: PROFILE_CHART_TYPE,
  placement: "above-data",
  create: () => {
    let canvas = null, ctx = null;
    return {
      mount(element) { canvas = element; ctx = element.getContext("2d"); },
      render({ bars, coords, scale, bounds, theme, priceStyle }) {
        if (!ctx || !canvas) return;
        const dpr = coords.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        if (priceStyle !== PROFILE_CHART_TYPE || !bars?.length || bounds.height <= 0) return;

        const range = coords.visibleLogicalRange();
        const first = Math.max(0, Math.floor(range.from));
        const last = Math.min(bars.length - 1, Math.ceil(range.to));
        const slot = Math.max(1, Math.min(240, coords.bodySpacing() * 0.94));
        const upColor = theme.upColor || "#089981";
        const downColor = theme.downColor || "#f23645";
        const pocColor = "#facc15";
        const Y = p => coords.priceToY(p, scale, bounds);

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();

        for (let i = first; i <= last; ++i) {
          const bar = bars[i];
          const candle = footprintForBarTime(bar.time);
          const footprint = candle?.footprint;
          const profile = getCandleProfile(footprint);
          // Profile style is based on the same tick-level data as Footprint.
          // Historical OHLCV bars have no per-price trades, so don't draw them.
          if (!profile) continue;
          const src = candle;
          const tick = Number(footprint.tickSize);
          if (!Number.isFinite(tick) || tick <= 0) continue;
          const tradedRows = profile.rows.filter(row => row.total > 0);
          if (!tradedRows.length) continue;
          // Footprint prices are rounded to display buckets. Include the outer
          // half-tick of those buckets in the wick so every profile row remains
          // inside the candle's displayed high/low range.
          const profileLow = tradedRows[0].price - tick / 2;
          const profileHigh = tradedRows[tradedRows.length - 1].price + tick / 2;
          const candleHigh = Math.max(Number(src.high), profileHigh);
          const candleLow = Math.min(Number(src.low), profileLow);
          const x = coords.logicalToX(i);
          const xLeft = x - slot / 2;
          const color = src.close >= src.open ? upColor : downColor;

          const highY = Y(candleHigh), lowY = Y(candleLow);
          const openY = Y(Number(src.open)), closeY = Y(Number(src.close));
          if (![highY, lowY, openY, closeY].every(Number.isFinite)) continue;

          // Candle: narrow body at the left of the slot, profile to its right.
          const bodyW = Math.min(8, Math.max(2, slot * 0.18));
          const bodyX = xLeft;
          const wickX = bodyX + bodyW / 2;

          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = ctx.fillStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(wickX, Math.min(highY, lowY));
          ctx.lineTo(wickX, Math.max(highY, lowY));
          ctx.stroke();
          ctx.fillRect(bodyX, Math.min(openY, closeY), bodyW, Math.max(1, Math.abs(closeY - openY)));

          const profileX = bodyX + bodyW + 1;
          const profileW = Math.max(0, xLeft + slot - profileX);
          if (profileW < 2) continue;

          profile.rows.forEach((row, idx) => {
            if (row.total <= 0) return;
            const rowHigh = Math.min(row.price + tick / 2, candleHigh);
            const rowLow = Math.max(row.price - tick / 2, candleLow);
            const y0 = Y(rowHigh), y1 = Y(rowLow);
            const y = Math.min(y0, y1);
            const h = Math.max(1, Math.abs(y1 - y0) - 0.5);
            if (!Number.isFinite(y) || y + h < bounds.top || y > bounds.top + bounds.height) return;

            const w = Math.max(1, (row.total / profile.maxTotal) * profileW);
            // Unclassified volume is shared evenly, like the session VP.
            const buyShare = (row.buy + row.other / 2) / row.total;
            const buyW = w * buyShare;
            const inVA = idx >= profile.vaLow && idx <= profile.vaHigh;

            const relativeVolume = Math.sqrt(row.total / profile.maxTotal);
            // Keep low-volume prices visible while making stronger prices stand
            // out, with a modest value-area boost.
            ctx.globalAlpha = Math.min(0.95, 0.12 + relativeVolume * 0.68 + (inVA ? 0.12 : 0));
            ctx.fillStyle = upColor;
            ctx.fillRect(profileX, y, buyW, h);
            ctx.fillStyle = downColor;
            ctx.fillRect(profileX + buyW, y, w - buyW, h);

            const delta = Math.round(row.buy - row.sell);
            if (h >= 7 && profileW >= 10) {
              const label = delta > 0 ? `${delta}` : String(delta);
              const fontSize = Math.max(6, Math.min(11, h - 1));
              ctx.globalAlpha = 1;
              ctx.font = `bold ${fontSize}px Arial`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.lineWidth = 2;
              ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
              ctx.strokeText(label, profileX + profileW / 2, y + h / 2, profileW - 2);
              ctx.fillStyle = "#f3f4f6";
              ctx.fillText(label, profileX + profileW / 2, y + h / 2, profileW - 2);
            }

            if (idx === profile.pocIdx) {
              ctx.globalAlpha = 1;
              ctx.strokeStyle = pocColor;
              ctx.lineWidth = 1;
              ctx.strokeRect(profileX + 0.5, y + 0.5, w, Math.max(1, h - 1));
            }
          });
        }
        ctx.restore();
      },
      destroy() { canvas = null; ctx = null; }
    };
  }
});

function storeFootprintCandle(candle) {
  if (!candle?.footprint?.levels?.length) return;
  footprintCandlesByTime.set(candle.time, {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    footprint: candle.footprint
  });
  while (footprintCandlesByTime.size > 1000) {
    footprintCandlesByTime.delete(footprintCandlesByTime.keys().next().value);
  }
}

// const FOOTPRINT_DELTA_TYPE = "footprint-volume-delta";
// const DELTA_BUY_COLOR = "#089981";
// const DELTA_SELL_COLOR = "#f23645";
// registerNativeIndicator({
//   type: FOOTPRINT_DELTA_TYPE,
//   title: "Volume Delta",
//   shortTitle: "Delta",
//   overlay: false,
//   paneHint: "new",
//   inputsSchema: () => [],
//   defaultInputs: () => ({}),
//   create: () => ({
//     context: null,
//     start(context) {
//       this.context = context;
//       volumeDeltaSinks.add(this);
//       context.emit({});
//       this.refresh();
//     },
//     refresh() {
//       if (!this.context) return;
//       const bars = this.context.bars();
//       const points = bars.map(bar => {
//         const liveBar = historyBarForTime(bar.time) || bar;
//         const buy = Number(liveBar.buy) || 0;
//         const sell = Number(liveBar.sell) || 0;
//         if (buy === 0 && sell === 0) return { time: bar.time, value: null };
//         const delta = buy - sell;
//         return {
//           time: bar.time,
//           value: delta,
//           color: delta >= 0 ? DELTA_BUY_COLOR : DELTA_SELL_COLOR
//         };
//       });
//       this.context.emit({
//         series: [{
//           id: "footprint-volume-delta-series",
//           title: "Buy − Sell",
//           paneId: "",
//           kind: "histogram",
//           points,
//           style: { color: DELTA_BUY_COLOR, width: 1, base: 0 }
//         }],
//         priceLines: [{
//           id: "footprint-volume-delta-zero",
//           price: 0,
//           color: "#8290a0",
//           lineStyle: "dashed",
//           width: 1,
//           title: "Zero"
//         }]
//       });
//     },
//     onBars() { this.refresh(); },
//     onViewport() { },
//     suspend() { },
//     resume() { this.refresh(); },
//     setInputs() { },
//     stop() {
//       volumeDeltaSinks.delete(this);
//       this.context = null;
//     }
//   })
// });

const FOOTPRINT_DELTA_TYPE = "footprint-volume-delta";
const DELTA_BUY_COLOR = "#089981";
const DELTA_SELL_COLOR = "#f23645";

registerNativeIndicator({
  type: FOOTPRINT_DELTA_TYPE,
  title: "Volume Delta",
  shortTitle: "Delta",
  overlay: false,
  paneHint: "new",
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => ({
    context: null,

    start(context) {
      this.context = context;
      volumeDeltaSinks.add(this);
      this.refresh();
    },

    refresh() {
      if (!this.context) return;

      const bars = this.context.bars();

      const points = bars.map(bar => {
        const liveBar = historyBarForTime(bar.time) || bar;
        const buy = Number(liveBar.buy) || 0;
        const sell = Number(liveBar.sell) || 0;
        const delta = buy - sell;

        if (buy === 0 && sell === 0) {
          return { time: bar.time, value: null };
        }

        return {
          time: bar.time,
          value: delta,
          color: delta >= 0 ? DELTA_BUY_COLOR : DELTA_SELL_COLOR
        };
      });

      this.context.emit({
        series: [{
          id: "footprint-volume-delta-series",
          title: "Volume Delta",
          kind: "histogram",
          points,
          style: {
            color: DELTA_BUY_COLOR,
            width: 1,
            base: 0
          }
        }],
        priceLines: [{
          id: "footprint-volume-delta-zero",
          price: 0,
          color: "#8290a0",
          lineStyle: "dashed",
          width: 1,
          title: "Zero"
        }]
      });
    },

    onBars() {
      this.refresh();
    },
    onViewport() { },

    suspend() { },

    resume() {
      this.refresh();
    },

    setInputs() { },

    stop() {
      volumeDeltaSinks.delete(this);
      this.context = null;
    }
  })
});

const BOOK_LAYER_ID = "broker-limit-order-book";
const BOOK_STALE_MS = 5000;
let orderBookData = { bids: [], asks: [], updatedAt: 0 };
let orderBookVisible = true;
const orderBookSinks = new Set();

// Liquidity heatmap keeps a compact, time-sampled depth history. One sample per
// second bounds both memory and render work while retaining the requested window.
const LIQUIDITY_HEATMAP_ID = "liquidity-heatmap";
const LIQUIDITY_HEATMAP_DEFAULTS = {
  bidColor: "#089981", askColor: "#F23645", historyWindow: 10, maxOpacity: 70,
  intensityScaling: "Logarithmic", minimumLiquidity: 0, fadeOldLiquidity: false,
  showSides: "Both", highlightLargeWalls: true,
  priceDistanceTicks: 0, maximumLevels: 0, tickSize: 0.01
};
const LIQUIDITY_HEATMAP_STORAGE_KEY = "tradingengine.liquidityHeatmap.v2";
const LIQUIDITY_HEATMAP_LEGACY_STORAGE_KEY = "tradingengine.liquidityHeatmap.v1";
let liquidityHeatmapSettings = (() => {
  try {
    const current = localStorage.getItem(LIQUIDITY_HEATMAP_STORAGE_KEY);
    const isLegacy = current === null;
    const saved = JSON.parse(current || localStorage.getItem(LIQUIDITY_HEATMAP_LEGACY_STORAGE_KEY) || "{}");
    const settings = { ...LIQUIDITY_HEATMAP_DEFAULTS, ...saved };
    if (isLegacy) {
      // Migrate prior built-in limits/fading to the new unrestricted defaults.
      if (Number(saved.maximumLevels) === 20) settings.maximumLevels = 0;
      if (Number(saved.priceDistanceTicks) === 20) settings.priceDistanceTicks = 0;
      if (saved.fadeOldLiquidity === true) settings.fadeOldLiquidity = false;
    }
    return settings;
  }
  catch { return { ...LIQUIDITY_HEATMAP_DEFAULTS }; }
})();
const liquidityHeatmapHistory = [];
let liquidityHeatmapLastSampleAt = 0;
let liquidityHeatmapLastPublishAt = 0;
let liquidityHeatmapSettingsVersion = 0;
const liquidityHeatmapSinks = new Set();
let liquidityHeatmapHandle = null;
function packLiquidityLevels(levels) {
  const packed = new Float64Array((levels || []).length * 2);
  let count = 0;
  for (const level of levels || []) {
    const price = Number(level.price), qty = Number(level.qty);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
    packed[count++] = price;
    packed[count++] = qty;
  }
  return count === packed.length ? packed : packed.slice(0, count);
}
function trimLiquidityHeatmapHistory(now = Date.now()) {
  const retentionMs = Math.max(1, Math.min(10, Number(liquidityHeatmapSettings.historyWindow) || 10)) * 60 * 1000;
  const cutoff = now - retentionMs;
  while (liquidityHeatmapHistory.length && liquidityHeatmapHistory[0].at < cutoff) liquidityHeatmapHistory.shift();
}
function publishLiquidityHeatmap(data = null) {
  const snapshot = data || { updatedAt: orderBookData.updatedAt, bids: orderBookData.bids, asks: orderBookData.asks };
  const now = Number(snapshot.updatedAt) || Date.now();
  if (now - liquidityHeatmapLastSampleAt >= 1000 || !liquidityHeatmapHistory.length) {
    liquidityHeatmapHistory.push({ at: now, bids: packLiquidityLevels(snapshot.bids), asks: packLiquidityLevels(snapshot.asks) });
    liquidityHeatmapLastSampleAt = now;
  }
  trimLiquidityHeatmapHistory(now);
  if (now - liquidityHeatmapLastPublishAt >= 500 || !liquidityHeatmapLastPublishAt) {
    liquidityHeatmapLastPublishAt = now;
    const payload = { updatedAt: now, history: liquidityHeatmapHistory, settingsVersion: liquidityHeatmapSettingsVersion };
    for (const sink of liquidityHeatmapSinks) sink.context?.pushData(payload);
  }
}

registerNativeIndicator({
  type: LIQUIDITY_HEATMAP_ID, title: "Liquidity Heatmap", shortTitle: "Liquidity Heatmap", overlay: true, paneHint: "price",
  inputsSchema: () => [
    { key: "bidColor", title: "Bid color", type: "color", defval: LIQUIDITY_HEATMAP_DEFAULTS.bidColor, group: "Appearance" },
    { key: "askColor", title: "Ask color", type: "color", defval: LIQUIDITY_HEATMAP_DEFAULTS.askColor, group: "Appearance" },
    { key: "historyWindow", title: "History window (minutes)", type: "int", defval: 10, min: 1, max: 10, step: 1, group: "Liquidity" },
    { key: "maxOpacity", title: "Maximum opacity (%)", type: "int", defval: 70, min: 1, max: 70, step: 1, group: "Appearance" },
    { key: "intensityScaling", title: "Intensity scaling", type: "string", defval: "Logarithmic", options: ["Logarithmic", "Linear"], group: "Liquidity" },
    { key: "minimumLiquidity", title: "Minimum liquidity", type: "float", defval: 0, min: 0, step: 0.01, group: "Liquidity" },
    { key: "fadeOldLiquidity", title: "Fade liquidity toward left of view", type: "bool", defval: false, group: "Appearance" },
    { key: "showSides", title: "Show bids and asks", type: "string", defval: "Both", options: ["Both", "Bids", "Asks"], group: "Appearance" },
    { key: "highlightLargeWalls", title: "Highlight large walls", type: "bool", defval: true, group: "Appearance" },
    { key: "priceDistanceTicks", title: "Price distance from LTP (ticks, 0 = all)", type: "int", defval: 0, min: 0, max: 500, step: 1, group: "Liquidity" },
    { key: "maximumLevels", title: "Maximum levels per side (0 = all)", type: "int", defval: 0, min: 0, max: 500, step: 1, group: "Liquidity" },
    { key: "tickSize", title: "Tick size", type: "float", defval: 0.01, min: 0.00000001, step: "any", group: "Liquidity" }
  ],
  defaultInputs: () => ({ ...liquidityHeatmapSettings }),
  create: () => ({
    context: null,
    start(context) { this.context = context; context.emit({}); context.pushData({ updatedAt: Date.now(), history: liquidityHeatmapHistory, settingsVersion: liquidityHeatmapSettingsVersion }); liquidityHeatmapSinks.add(this); },
    onBars() {}, onViewport() {}, suspend() {}, resume() { this.context?.pushData({ updatedAt: Date.now(), history: liquidityHeatmapHistory, settingsVersion: liquidityHeatmapSettingsVersion }); },
    setInputs(inputs) {
      if (!inputs) return;
      Object.assign(liquidityHeatmapSettings, inputs);
      liquidityHeatmapSettingsVersion++;
      try { localStorage.setItem(LIQUIDITY_HEATMAP_STORAGE_KEY, JSON.stringify(liquidityHeatmapSettings)); } catch {}
      const now = Date.now();
      trimLiquidityHeatmapHistory(now);
      const payload = { updatedAt: now, history: liquidityHeatmapHistory, settingsVersion: liquidityHeatmapSettingsVersion };
      for (const sink of liquidityHeatmapSinks) sink.context?.pushData(payload);
    },
    stop() { liquidityHeatmapSinks.delete(this); this.context = null; }
  })
});

registerRendererLayer({
  id: LIQUIDITY_HEATMAP_ID, placement: "above-data",
  create: () => {
    let canvas, ctx, cacheCanvas, cacheCtx;
    let cacheValid = false, cacheDataStamp = "", cacheViewKey = "";
    let lastObservedViewKey = "", lastViewChangeAt = 0, viewportTimer = null;
    let cachedBarsLength = -1, cachedBarsFirst = NaN, cachedBarsQuarter = NaN, cachedBarsMiddle = NaN, cachedBarsLast = NaN;
    let barTimes = new Float64Array(0), timeframeSpanMs = CONFIG.candleSpanMs;
    let scratchCapacity = 0, sampleX0 = new Float64Array(0), sampleX1 = new Float64Array(0);
    let sampleLogicalMid = new Float64Array(0), columnSamples = new Int32Array(0);
    let cellAlpha = new Float32Array(0), cellWall = new Uint8Array(0), cellCapacity = 0;
    let normalizedMaximum = 1, normalizationStamp = "", tickCacheAt = NaN, tickCacheValue = null;
    const maxDrawCalls = 6000;
    const toMs = value => {
      const time = Number(value);
      return Number.isFinite(time) ? (time < 100_000_000_000 ? time * 1000 : time) : NaN;
    };
    const blit = () => {
      if (!ctx || !canvas || !cacheCanvas) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (cacheValid) ctx.drawImage(cacheCanvas, 0, 0);
    };
    const resizeCache = () => {
      if (!canvas || !cacheCanvas || (cacheCanvas.width === canvas.width && cacheCanvas.height === canvas.height)) return false;
      cacheCanvas.width = canvas.width;
      cacheCanvas.height = canvas.height;
      cacheValid = false;
      return true;
    };
    const ensureScratch = length => {
      if (length <= scratchCapacity) return;
      scratchCapacity = Math.max(length, scratchCapacity ? scratchCapacity * 2 : 64);
      sampleX0 = new Float64Array(scratchCapacity);
      sampleX1 = new Float64Array(scratchCapacity);
      sampleLogicalMid = new Float64Array(scratchCapacity);
    };
    return {
      mount(element) {
        canvas = element;
        ctx = element.getContext("2d");
        cacheCanvas = document.createElement("canvas");
        cacheCtx = cacheCanvas.getContext("2d");
        resizeCache();
      },
      render({ data, bars, coords, scale, bounds }) {
        if (!ctx || !canvas || document.hidden) return;
        resizeCache();
        const history = data?.history;
        const dpr = coords.dpr || 1;
        const now = Date.now();
        if (!history?.length || !bars?.length || bounds.height <= 0 || coords.width <= 0) {
          cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
          cacheCtx.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
          cacheValid = true;
          cacheDataStamp = "empty";
          cacheViewKey = "";
          blit();
          return;
        }

        const firstTime = toMs(bars[0]?.time), lastTime = toMs(bars[bars.length - 1]?.time);
        const quarterTime = toMs(bars[Math.floor((bars.length - 1) / 4)]?.time);
        const middleTime = toMs(bars[Math.floor((bars.length - 1) / 2)]?.time);
        const liveTime = currentCandle?.isLive ? toMs(currentCandle.time) : NaN;
        const hasVirtualLiveBar = Number.isFinite(liveTime) && liveTime > lastTime;
        const effectiveBarCount = bars.length + (hasVirtualLiveBar ? 1 : 0);
        const effectiveLastTime = hasVirtualLiveBar ? liveTime : lastTime;
        if (effectiveBarCount !== cachedBarsLength || firstTime !== cachedBarsFirst || quarterTime !== cachedBarsQuarter || middleTime !== cachedBarsMiddle || effectiveLastTime !== cachedBarsLast) {
          barTimes = new Float64Array(effectiveBarCount);
          for (let i = 0; i < bars.length; i++) barTimes[i] = toMs(bars[i]?.time);
          if (hasVirtualLiveBar) barTimes[bars.length] = liveTime;
          cachedBarsLength = effectiveBarCount;
          cachedBarsFirst = firstTime;
          cachedBarsQuarter = quarterTime;
          cachedBarsMiddle = middleTime;
          cachedBarsLast = effectiveLastTime;
          const intervals = new Float64Array(Math.min(64, Math.max(0, barTimes.length - 1)));
          let intervalCount = 0;
          for (let i = barTimes.length - 1; i > 0 && intervalCount < intervals.length; i--) {
            const delta = barTimes[i] - barTimes[i - 1];
            if (Number.isFinite(delta) && delta > 0) intervals[intervalCount++] = delta;
          }
          if (intervalCount) {
            intervals.subarray(0, intervalCount).sort();
            timeframeSpanMs = intervals[Math.floor((intervalCount - 1) / 2)] || CONFIG.candleSpanMs;
          } else timeframeSpanMs = CONFIG.candleSpanMs;
        }

        const logicalAt = time => {
          if (!Number.isFinite(time) || time < barTimes[0]) return NaN;
          let low = 0, high = barTimes.length;
          while (low < high) {
            const mid = (low + high) >>> 1;
            if (barTimes[mid] < time) low = mid + 1;
            else high = mid;
          }
          if (low < barTimes.length && barTimes[low] === time) return low;
          const index = Math.max(0, low - 1);
          const span = timeframeSpanMs > 0 ? timeframeSpanMs : CONFIG.candleSpanMs;
          return index + (time - barTimes[index]) / span;
        };

        const range = coords.visibleLogicalRange();
        const firstVisible = Math.max(0, Math.min(bars.length - 1, Math.floor(range.from)));
        const lastVisible = Math.max(0, Math.min(bars.length - 1, Math.ceil(range.to)));
        const anchorBar = bars[Math.floor((firstVisible + lastVisible) / 2)];
        const anchorHighY = coords.priceToY(Number(anchorBar?.high) || 0, scale, bounds);
        const anchorLowY = coords.priceToY(Number(anchorBar?.low) || 0, scale, bounds);
        const distanceTicks = Math.max(0, Number(liquidityHeatmapSettings.priceDistanceTicks) || 0);
        const ltp = Number(currentCandle?.close ?? historyBars.at(-1)?.close) || 0;
        const viewKey = [range.from, range.to, coords.width, coords.bodySpacing(), bounds.top, bounds.height, dpr, anchorHighY, anchorLowY, distanceTicks > 0 ? ltp : 0].join("|");
        const dataStamp = [data?.settingsVersion || 0, history.length, history[history.length - 1]?.at || 0].join("|");
        const renderAt = performance.now();
        if (viewKey !== lastObservedViewKey) {
          lastObservedViewKey = viewKey;
          lastViewChangeAt = renderAt;
          if (viewportTimer === null) viewportTimer = setTimeout(() => {
            viewportTimer = null;
            if (!document.hidden) workspace.chart.renderer?.renderer?.scheduler?.invalidate?.(4);
          }, 140);
        }
        const viewportSettled = renderAt - lastViewChangeAt >= 140;
        if (cacheValid && dataStamp === cacheDataStamp && viewKey === cacheViewKey) {
          blit();
          return;
        }
        if (cacheValid && viewKey !== cacheViewKey && !viewportSettled) {
          blit();
          return;
        }

        const configuredTick = Math.max(Number(liquidityHeatmapSettings.tickSize) || 0.01, 1e-12);
        const latest = history[history.length - 1];
        if (latest?.at !== tickCacheAt) {
          let observedTick = Infinity;
          for (const levels of [latest?.bids || [], latest?.asks || []]) {
            let previousPrice = NaN;
            for (let i = 0; i < levels.length; i += 2) {
              const price = levels[i];
              if (Number.isFinite(previousPrice)) {
                const gap = Math.abs(price - previousPrice);
                if (gap > 1e-9 && gap < observedTick) observedTick = gap;
              }
              previousPrice = price;
            }
          }
          tickCacheAt = latest?.at;
          tickCacheValue = Number.isFinite(observedTick) ? observedTick : configuredTick;
        }
        const tick = tickCacheValue || configuredTick;
        const maxDistance = tick * distanceTicks;
        const maxLevels = Math.max(0, Number(liquidityHeatmapSettings.maximumLevels) || 0);
        const historyWindow = Math.max(1, Math.min(10, Number(liquidityHeatmapSettings.historyWindow) || 10));
        const sides = liquidityHeatmapSettings.showSides === "Bids"
          ? [["bids", liquidityHeatmapSettings.bidColor]]
          : liquidityHeatmapSettings.showSides === "Asks"
            ? [["asks", liquidityHeatmapSettings.askColor]]
            : [["bids", liquidityHeatmapSettings.bidColor], ["asks", liquidityHeatmapSettings.askColor]];
        const normalizationKey = [dataStamp, historyWindow, maxLevels, distanceTicks, distanceTicks > 0 ? ltp : 0, liquidityHeatmapSettings.showSides].join("|");
        const selected = side => {
          if (maxLevels === 0) return null;
          const candidates = new Set();
          for (const sample of history) {
            const levels = sample[side];
            for (let i = 0; i < levels.length; i += 2) {
              const price = levels[i];
              if (levels[i + 1] > 0 && (!ltp || maxDistance <= 0 || Math.abs(price - ltp) <= maxDistance)) candidates.add(price);
            }
          }
          const sorted = [...candidates].sort((a, b) => side === "bids" ? b - a : a - b);
          return new Set(sorted.slice(0, maxLevels));
        };
        const selectedBySide = sides.map(([side]) => selected(side));
        if (normalizationStamp !== normalizationKey) {
          let maximum = 1;
          for (let sideIndex = 0; sideIndex < sides.length; sideIndex++) {
            const side = sides[sideIndex][0];
            const selectedPrices = selectedBySide[sideIndex];
            for (const sample of history) {
              const levels = sample[side];
              for (let i = 0; i < levels.length; i += 2) {
                const price = levels[i], qty = levels[i + 1];
                if ((!selectedPrices || selectedPrices.has(price)) && qty > 0 && (!ltp || maxDistance <= 0 || Math.abs(price - ltp) <= maxDistance)) {
                  maximum = Math.max(maximum, qty);
                }
              }
            }
          }
          normalizedMaximum = maximum;
          normalizationStamp = normalizationKey;
        }

        const visibleDataAfter = Date.now() - historyWindow * 60000;
        ensureScratch(history.length);
        const bucketCount = Math.ceil(coords.width / 3);
        if (columnSamples.length < bucketCount) columnSamples = new Int32Array(bucketCount);
        columnSamples.fill(0, 0, bucketCount);
        for (let i = 0; i < history.length; i++) {
          const sample = history[i];
          const endTime = history[i + 1]?.at ?? now;
          if (sample.at < visibleDataAfter || sample.at > now) {
            sampleX0[i] = NaN;
            sampleX1[i] = NaN;
            continue;
          }
          const logicalStart = logicalAt(sample.at);
          const logicalEnd = logicalAt(endTime);
          if (!Number.isFinite(logicalStart) || !Number.isFinite(logicalEnd) || logicalEnd < range.from || logicalStart > range.to) {
            sampleX0[i] = NaN;
            sampleX1[i] = NaN;
            continue;
          }
          const x0 = coords.logicalToX(logicalStart), x1 = coords.logicalToX(logicalEnd);
          sampleX0[i] = x0;
          sampleX1[i] = x1;
          sampleLogicalMid[i] = (logicalStart + logicalEnd) / 2;
          const firstColumn = Math.max(0, Math.floor(Math.min(x0, x1) / 3));
          const lastColumn = Math.min(bucketCount - 1, Math.floor(Math.max(x0, x1) / 3));
          for (let column = firstColumn; column <= lastColumn; column++) columnSamples[column] = i + 1;
        }

        let cellSize = Math.max(3, Math.ceil(Math.sqrt(coords.width * bounds.height * sides.length / maxDrawCalls)));
        let cellColumns = Math.ceil(coords.width / cellSize);
        let cellRows = Math.ceil(bounds.height / cellSize);
        while (cellColumns * cellRows * sides.length > maxDrawCalls) {
          cellSize++;
          cellColumns = Math.ceil(coords.width / cellSize);
          cellRows = Math.ceil(bounds.height / cellSize);
        }
        const gridSize = cellColumns * cellRows;
        const neededCells = gridSize * sides.length;
        if (neededCells > cellCapacity) {
          cellCapacity = neededCells;
          cellAlpha = new Float32Array(cellCapacity);
          cellWall = new Uint8Array(cellCapacity);
        } else {
          cellAlpha.fill(0, 0, neededCells);
          cellWall.fill(0, 0, neededCells);
        }

        cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cacheCtx.clearRect(0, 0, cacheCanvas.width / dpr, cacheCanvas.height / dpr);
        cacheCtx.save();
        cacheCtx.beginPath();
        cacheCtx.rect(0, bounds.top, coords.width, bounds.height);
        cacheCtx.clip();
        const viewSpan = Math.max(1, range.to - range.from);
        const minimumLiquidity = Math.max(0, Number(liquidityHeatmapSettings.minimumLiquidity) || 0);
        for (let column = 0; column < bucketCount; column++) {
          const sampleIndex = columnSamples[column] - 1;
          if (sampleIndex < 0) continue;
          const sample = history[sampleIndex];
          const x0 = sampleX0[sampleIndex], x1 = sampleX1[sampleIndex];
          if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
          const xCell = Math.max(0, Math.min(cellColumns - 1, Math.floor((column * 3 + 1.5) / cellSize)));
          const fade = liquidityHeatmapSettings.fadeOldLiquidity
            ? Math.max(0, Math.min(1, 1 - (range.to - sampleLogicalMid[sampleIndex]) / viewSpan))
            : 1;
          if (fade <= 0) continue;
          for (let sideIndex = 0; sideIndex < sides.length; sideIndex++) {
            const [side] = sides[sideIndex];
            const levels = sample[side], selectedPrices = selectedBySide[sideIndex];
            for (let i = 0; i < levels.length; i += 2) {
              const price = levels[i], qty = levels[i + 1];
              if ((selectedPrices && !selectedPrices.has(price)) || qty < minimumLiquidity || qty <= 0 || (ltp && maxDistance > 0 && Math.abs(price - ltp) > maxDistance)) continue;
              const y = coords.priceToY(price, scale, bounds);
              if (!Number.isFinite(y) || y < bounds.top || y >= bounds.top + bounds.height) continue;
              const ratio = liquidityHeatmapSettings.intensityScaling === "Linear"
                ? qty / normalizedMaximum
                : Math.log1p(qty) / Math.log1p(normalizedMaximum);
              const alpha = Math.min(0.7, Math.max(0.03, (Number(liquidityHeatmapSettings.maxOpacity) || 70) / 100 * ratio)) * fade;
              if (alpha <= 0) continue;
              const yCell = Math.max(0, Math.min(cellRows - 1, Math.floor((y - bounds.top) / cellSize)));
              const key = sideIndex * gridSize + xCell * cellRows + yCell;
              if (alpha > cellAlpha[key]) {
                cellAlpha[key] = alpha;
                cellWall[key] = liquidityHeatmapSettings.highlightLargeWalls && ratio >= 0.8 ? 1 : 0;
              }
            }
          }
        }
        for (let sideIndex = 0; sideIndex < sides.length; sideIndex++) {
          cacheCtx.fillStyle = sides[sideIndex][1];
          const offset = sideIndex * gridSize;
          for (let cellIndex = 0; cellIndex < gridSize; cellIndex++) {
            const alpha = cellAlpha[offset + cellIndex];
            if (alpha <= 0) continue;
            cacheCtx.globalAlpha = alpha;
            const xCell = Math.floor(cellIndex / cellRows);
            const yCell = cellIndex - xCell * cellRows;
            cacheCtx.fillRect(xCell * cellSize, bounds.top + yCell * cellSize, cellSize + (cellWall[offset + cellIndex] ? 1 : 0), cellSize);
          }
        }
        cacheCtx.restore();
        cacheDataStamp = dataStamp;
        cacheViewKey = viewKey;
        cacheValid = true;
        blit();
      },
      destroy() {
        if (viewportTimer !== null) clearTimeout(viewportTimer);
        canvas = null;
        ctx = null;
        cacheCanvas = null;
        cacheCtx = null;
      }
    };
  }
});
registerRendererLayer({
  id: BOOK_LAYER_ID,
  placement: "above-data",
  create: () => {
    let canvas = null;
    let ctx = null;
    return {
      mount(element) {
        canvas = element;
        ctx = element.getContext("2d");
      },
      render({ data, coords, scale, bounds, theme }) {
        if (!ctx || !canvas) return;
        // console.log("HEATMAP CANVAS STATUS", { connected: canvas?.isConnected, canvas, parent: canvas?.parentElement, zIndex: canvas ? getComputedStyle(canvas).zIndex : null, opacity: canvas ? getComputedStyle(canvas).opacity : null });
        const dpr = coords.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

        if (!orderBookVisible || !data || bounds.height <= 0) return;
        // if (!data || bounds.height <= 0) return;

        const bandHeight = 6;
        const rows = new Map();
        for (const [side, levels] of [["ask", data.asks], ["bid", data.bids]]) {
          for (const level of levels || []) {
            const price = Number(level.price);
            const qty = Math.max(0, Number(level.qty) || 0);
            if (!Number.isFinite(price) || qty <= 0) continue;
            const y = coords.priceToY(price, scale, bounds);
            if (y < bounds.top || y >= bounds.top + bounds.height) continue;
            const band = Math.floor((y - bounds.top) / bandHeight);
            let row = rows.get(band);
            if (!row) {
              row = { band, ask: 0, bid: 0 };
              rows.set(band, row);
            }
            row[side] += qty;
          }
        }

        if (!rows.size) return;
        const maxQty = Math.max(...[...rows.values()].flatMap(row => [row.ask, row.bid]));
        if (maxQty <= 0) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();

        // Draw from the left edge, max 22% of chart width
        const maxWidth = coords.width * 0.22;
        const askColor = theme.downColor || "#f23645";
        const bidColor = theme.upColor || "#089981";

        for (const row of rows.values()) {
          const y = bounds.top + row.band * bandHeight;
          if (y + bandHeight < bounds.top || y > bounds.top + bounds.height) continue;

          if (row.ask > 0) {
            const width = (row.ask / maxQty) * maxWidth;
            ctx.globalAlpha = 0.62;
            ctx.fillStyle = askColor;
            ctx.fillRect(0, y, width, 2);
          }
          if (row.bid > 0) {
            const width = (row.bid / maxQty) * maxWidth;
            ctx.globalAlpha = 0.62;
            ctx.fillStyle = bidColor;
            ctx.fillRect(0, y + 3, width, 2);
          }
        }
        ctx.restore();
      },
      destroy() {
        canvas = null;
        ctx = null;
      }
    };
  }
});

registerNativeIndicator({
  type: BOOK_LAYER_ID,
  title: "Limit Order Book",
  shortTitle: "Depth",
  overlay: true,
  paneHint: "price",
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => ({
    context: null,
    start(context) {
      this.context = context;
      context.emit({});
      context.pushData(orderBookData);
      orderBookSinks.add(this);
    },
    update(data) {
      this.context?.pushData(data);
    },
    onBars() { },
    onViewport() { },
    suspend() {
      orderBookVisible = false;
      this.context?.pushData({ bids: [], asks: [], updatedAt: 0 });
    },
    resume() {
      orderBookVisible = true;
      this.context?.pushData(orderBookData);
    },
    setInputs() { },
    stop() {
      orderBookSinks.delete(this);
      this.context = null;
    }
  })
});

function publishOrderBook(data) {
  orderBookData = data;
  for (const sink of orderBookSinks) sink.update(data);
  publishLiquidityHeatmap(data);
}

// ── Call / Put Wall indicator ──────────────────────────────────────
const OPTIONS_WALLS_ID = "options-call-put-walls";
let optionsWalls = { callWall: 0, putWall: 0 };
let ticketOrderLabels = [];
const EMPTY_WALLS = { callWall: 0, putWall: 0 };

const optionsWallsSinks = new Set();

function publishOptionsWalls(msg) {
  optionsWalls = {
    callWall: Number(msg.callWall) || 0,
    putWall: Number(msg.putWall) || 0
  };
  for (const sink of optionsWallsSinks) {
    sink.context?.pushData({ ...optionsWalls, ticketOrderLabels });
  }
}

registerNativeIndicator({
  type: OPTIONS_WALLS_ID,
  title: "Call / Put Walls",
  shortTitle: "Call/Put Walls",
  overlay: true,
  paneHint: "price",
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => ({
    context: null,
    start(context) {
      this.context = context;
      context.emit({});
      context.pushData({ ...optionsWalls, ticketOrderLabels });
      optionsWallsSinks.add(this);
    },
    onBars() {},
    onViewport() {},
    // suspend() {},
    // resume() {
    //   this.context?.pushData(optionsWalls);
    // },
    // setInputs() {},
    // stop() {
    //   optionsWallsSinks.delete(this);
    //   this.context = null;
    // }

    suspend() { this.context?.pushData(EMPTY_WALLS); },
    resume()  { this.context?.pushData({ ...optionsWalls, ticketOrderLabels }); },
    setInputs() {},
    stop() {
      this.context?.pushData(EMPTY_WALLS);
      optionsWallsSinks.delete(this);
      this.context = null;
    }
  })
});

registerRendererLayer({
  id: OPTIONS_WALLS_ID,
  placement: "above-data",
  create: () => {
    let canvas, ctx;
    return {
      mount(element) {
        canvas = element;
        ctx = element.getContext("2d");
      },
      render({ data, coords, scale, bounds, theme }) {
        if (!ctx || !canvas) return;
        const dpr = coords.dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        if (!data || bounds.height <= 0) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();

        const walls = [
          { price: Number(data.callWall), color: "#22c55e", label: "CALL WALL" },
          { price: Number(data.putWall), color: "#ef4444", label: "PUT WALL" }
        ];

        for (const wall of walls) {
          if (!Number.isFinite(wall.price) || wall.price <= 0) continue;
          const y = coords.priceToY(wall.price, scale, bounds);
          if (!Number.isFinite(y)) continue;

          const isOffscreen = y < bounds.top || y > bounds.top + bounds.height;
          const edgeInset = Math.min(12, bounds.height / 2);
          const drawY = isOffscreen
            ? (y < bounds.top ? bounds.top + edgeInset : bounds.top + bounds.height - edgeInset)
            : y;
          // const direction = isOffscreen ? (y < bounds.top ? " ↑" : " ↓") : "";

          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = wall.color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          // Out-of-range walls get a short edge marker so it doesn't imply
          // their true price is at the chart boundary.
          ctx.moveTo(isOffscreen ? coords.width - 118 : 0, drawY);
          ctx.lineTo(coords.width, drawY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = theme.background || "#15171c";
          ctx.fillRect(coords.width - 112, drawY - 10, 110, 20);
          ctx.fillStyle = wall.color;
          ctx.font = "bold 11px Arial";
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          // ctx.fillText(`${wall.label} ${wall.price}`, coords.width, drawY);
          ctx.fillText(`${wall.label}`, coords.width, drawY);
        }

        // Trading ticket labels use the same chart-edge overlay as CALL/PUT WALL labels.
        // This runs in the active renderer layer (the chart uses the remote Vela package,
        // not the vendored standalone bundle), so the labels remain visible at the right edge.
        const drawEdgeLabel = (price, color, text, yOffset = 0) => {
          if (!(Number(price) > 0)) return;
          const y = coords.priceToY(Number(price), scale, bounds);
          if (!Number.isFinite(y)) return;
          ctx.font = "bold 11px Arial";
          const height = 20;
          const width = Math.min(coords.width, ctx.measureText(text).width + 12);
          const x = coords.width - width;
          const top = Math.max(bounds.top, Math.min(bounds.top + bounds.height - height, y - height - 3 + yOffset));
          ctx.fillStyle = theme.background || "#15171c";
          ctx.fillRect(x, top, width, height);
          ctx.fillStyle = color;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(text, coords.width - 5, top + height / 2);
        };
        for (const level of data.ticketOrderLabels || []) {
          drawEdgeLabel(level.price, level.color, level.label);
        }
        // Position rectangles keep their own prices and sizing. These labels are read-only
        // overlays; ticket edits create separate order preview lines and never move the tool.
        for (const drawing of workspace.chart.drawings.all().filter(item => item.type === "position" && item.showText !== false)) {
          const prices = drawing.prices?.();
          if (!prices) continue;
          const quantity = Number(drawing.quantity ?? drawing.positionSize?.()) || 0;
          const direction = drawing.direction === "long" ? 1 : -1;
          const currency = drawing.orderPnlCurrency || (CONFIG.broker === "FYERS" ? "₹" : "$");
          const money = value => `${value >= 0 ? "+" : "−"}${currency}${Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          if (drawing.showTargetLabel !== false) {
            const pnl = (prices.target - prices.entry) * quantity * direction;
            drawEdgeLabel(prices.target, drawing.profitColor || "#089981", `TP ${money(pnl)} @ ${Number(prices.target).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
          }
          if (drawing.showStopLabel !== false) {
            const pnl = (prices.stop - prices.entry) * quantity * direction;
            drawEdgeLabel(prices.stop, drawing.lossColor || "#f23645", `SL ${money(pnl)} @ ${Number(prices.stop).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
          }
        }

        ctx.restore();
      },
      destroy() {
        canvas = null;
        ctx = null;
      }
    };
  }
});


// ── GEX Heatmap indicator ──────────────────────────────────────────
const GEX_HEATMAP_ID = "options-gex-heatmap";
const EMPTY_GEX = { spot: 0, levels: [] };
let gexHeatmap = EMPTY_GEX;
const gexHeatmapSinks = new Set();

function publishGexHeatmap(msg) {
  const levels = Array.isArray(msg.gexLevels) ? msg.gexLevels : [];
  gexHeatmap = {
    spot: Number(msg.spot) || 0,
    levels: levels
      .map(l => ({
        strike: Number(l.strike),
        call: Number(l.callGEX) || 0,
        put: Number(l.putGEX) || 0,
      }))
      .filter(l => Number.isFinite(l.strike) && l.strike > 0)
      .map(l => ({ ...l, net: l.call - l.put })),   // +ve = call-dominated, -ve = put-dominated
  };
  for (const sink of gexHeatmapSinks) sink.context?.pushData(gexHeatmap);
}

registerNativeIndicator({
  type: GEX_HEATMAP_ID,
  title: "GEX Heatmap",
  shortTitle: "GEX Heatmap",
  overlay: true,
  paneHint: "price",
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => ({
    context: null,
    start(context) {
      this.context = context;
      context.emit({});
      context.pushData(gexHeatmap);
      gexHeatmapSinks.add(this);
    },
    onBars() {},
    onViewport() {},
    suspend() { this.context?.pushData(EMPTY_GEX); },
    resume()  { this.context?.pushData(gexHeatmap); },
    setInputs() {},
    stop() {
      this.context?.pushData(EMPTY_GEX);
      gexHeatmapSinks.delete(this);
      this.context = null;
    }

  })
});

registerRendererLayer({
  id: GEX_HEATMAP_ID,
  // placement: "below-data",          // heat bands sit behind candles; use "above-data" if this isn't supported
  placement: "above-data",
  create: () => {
    let canvas, ctx;
    return {
      mount(element) { canvas = element; ctx = element.getContext("2d"); },
      render({ data, coords, scale, bounds }) {
        if (!ctx || !canvas) return;
        const dpr = coords.dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        const levels = data?.levels;
        if (!levels?.length || bounds.height <= 0) return;

        // Strike spacing = smallest gap between neighbouring strikes
        let step = Infinity;
        for (let i = 1; i < levels.length; i++) {
          const d = levels[i].strike - levels[i - 1].strike;
          if (d > 0 && d < step) step = d;
        }
        if (!Number.isFinite(step)) step = 1;

        const maxAbs = Math.max(...levels.map(l => Math.abs(l.net)), 1e-9);
        const maxBar = Math.min(160, coords.width * 0.25);

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();

        for (const l of levels) {
          const yTop = coords.priceToY(l.strike + step / 2, scale, bounds);
          const yBot = coords.priceToY(l.strike - step / 2, scale, bounds);
          if (!Number.isFinite(yTop) || !Number.isFinite(yBot)) continue;
          if (yBot < bounds.top || yTop > bounds.top + bounds.height) continue;

          const h = Math.max(1, yBot - yTop - 1);
          const t = Math.abs(l.net) / maxAbs;           // 0..1 intensity
          const rgb = l.net >= 0 ? "34,197,94" : "239,68,68";

          // 1) full-width heat band (faint)
          ctx.fillStyle = `rgba(${rgb},${(0.04 + t * 0.22).toFixed(3)})`;
          ctx.fillRect(0, yTop, coords.width, h);

          // 2) right-anchored magnitude bar (solid-ish)
          ctx.fillStyle = `rgba(${rgb},${(0.35 + t * 0.5).toFixed(3)})`;
          ctx.fillRect(coords.width - t * maxBar, yTop, t * maxBar, h);
        }

        // Spot marker
        if (data.spot > 0) {
          const ys = coords.priceToY(data.spot, scale, bounds);
          if (Number.isFinite(ys)) {
            ctx.strokeStyle = "rgba(255,255,255,0.35)";
            ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.moveTo(0, ys); ctx.lineTo(coords.width, ys); ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        ctx.restore();
      },
      destroy() { canvas = null; ctx = null; }
    };
  }
});


// ── OI Profile indicator ───────────────────────────────────────────
const OI_PROFILE_ID = "options-oi-profile";
const EMPTY_OI = { spot: 0, levels: [], maxPain: 0, support: 0, resistance: 0 };
let oiProfile = EMPTY_OI;
const oiProfileSinks = new Set();

function computeOiLevels(levels, spot) {
  if (!levels.length) return { maxPain: 0, support: 0, resistance: 0 };

  // Max pain: strike with the lowest total buyer payout
  let maxPain = 0, best = Infinity;
  for (const k of levels) {
    let pain = 0;
    for (const l of levels) {
      if (k.strike > l.strike) pain += l.callOI * (k.strike - l.strike);
      if (k.strike < l.strike) pain += l.putOI  * (l.strike - k.strike);
    }
    if (pain < best) { best = pain; maxPain = k.strike; }
  }

  const pick = (arr, key) => arr.reduce((a, l) => (l[key] > a[key] ? l : a), arr[0]);

  const above = levels.filter(l => l.strike >= spot && l.callOI > 0);
  const below = levels.filter(l => l.strike <= spot && l.putOI > 0);
  const resistance = (above.length ? pick(above, "callOI") : pick(levels, "callOI")).strike;
  const support    = (below.length ? pick(below, "putOI")  : pick(levels, "putOI")).strike;

  return { maxPain, support, resistance };
}

// function publishOiProfile(msg) {
//   const raw = Array.isArray(msg.gexLevels) ? msg.gexLevels : [];
//   const spot = Number(msg.spot) || 0;
//   const levels = raw
//     .map(l => ({ strike: Number(l.strike), callOI: Number(l.callOI) || 0, putOI: Number(l.putOI) || 0 }))
//     .filter(l => Number.isFinite(l.strike) && l.strike > 0 && (l.callOI > 0 || l.putOI > 0));

//   oiProfile = { spot, levels, ...computeOiLevels(levels, spot) };
//   for (const sink of oiProfileSinks) if (!sink.hidden) sink.context?.pushData(oiProfile);
// }

function publishOiProfile(msg) {
  const raw = Array.isArray(msg.oiLevels) ? msg.oiLevels : [];   // was msg.gexLevels
  const spot = Number(msg.spot) || 0;
  const levels = raw
    .map(l => ({ strike: Number(l.strike), callOI: Number(l.callOI) || 0, putOI: Number(l.putOI) || 0 }))
    .filter(l => Number.isFinite(l.strike) && l.strike > 0 && (l.callOI > 0 || l.putOI > 0));

  oiProfile = { spot, levels, expiry: msg.oiExpiry || "", ...computeOiLevels(levels, spot) };
  for (const sink of oiProfileSinks) if (!sink.hidden) sink.context?.pushData(oiProfile);
}


registerNativeIndicator({
  type: OI_PROFILE_ID,
  title: "OI Profile",
  shortTitle: "OI Profile",
  overlay: true,
  paneHint: "price",
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => ({
    context: null,
    hidden: false,
    start(context) {
      this.context = context;
      context.emit({});
      context.pushData(oiProfile);
      oiProfileSinks.add(this);
    },
    onBars() {},
    onViewport() {},
    suspend() { this.hidden = true;  this.context?.pushData(EMPTY_OI); },
    resume()  { this.hidden = false; this.context?.pushData(oiProfile); },
    setInputs() {},
    stop() {
      this.context?.pushData(EMPTY_OI);
      oiProfileSinks.delete(this);
      this.context = null;
    }
  })
});

function fmtOI(v) {
  if (v >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (v >= 1e5) return (v / 1e5).toFixed(2) + "L";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

// registerRendererLayer({
//   id: OI_PROFILE_ID,
//   placement: "above-data",
//   create: () => {
//     let canvas = null, ctx = null;
//     return {
//       mount(element) { canvas = element; ctx = element.getContext("2d"); },
//       render({ data, coords, scale, bounds }) {
//         if (!ctx || !canvas) return;
//         const dpr = coords.dpr || 1;
//         ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
//         ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
//         const levels = data?.levels;
//         if (!levels?.length || bounds.height <= 0) return;

//         let step = Infinity;
//         for (let i = 1; i < levels.length; i++) {
//           const d = levels[i].strike - levels[i - 1].strike;
//           if (d > 0 && d < step) step = d;
//         }
//         if (!Number.isFinite(step)) step = 1;

//         // One shared scale so call and put bars are directly comparable
//         const maxOI = Math.max(...levels.map(l => Math.max(l.callOI, l.putOI)), 1);
//         const maxBar = Math.min(220, coords.width * 0.3);
//         const maxCall = levels.reduce((a, l) => l.callOI > a.callOI ? l : a, levels[0]);
//         const maxPut  = levels.reduce((a, l) => l.putOI  > a.putOI  ? l : a, levels[0]);

//         ctx.save();
//         ctx.beginPath();
//         ctx.rect(0, bounds.top, coords.width, bounds.height);
//         ctx.clip();
//         ctx.font = "10px sans-serif";
//         ctx.textBaseline = "middle";
//         ctx.textAlign = "right";

//         for (const l of levels) {
//           const yTop = coords.priceToY(l.strike + step / 2, scale, bounds);
//           const yBot = coords.priceToY(l.strike - step / 2, scale, bounds);
//           if (!Number.isFinite(yTop) || !Number.isFinite(yBot)) continue;
//           if (yBot < bounds.top || yTop > bounds.top + bounds.height) continue;

//           const band = yBot - yTop;
//           const barH = Math.max(1, band / 2 - 0.5);
//           const rightX = coords.width;

//           // Call OI (red) top half, Put OI (green) bottom half
//           const cw = (l.callOI / maxOI) * maxBar;
//           const pw = (l.putOI  / maxOI) * maxBar;
//           const isMaxC = l === maxCall, isMaxP = l === maxPut;

//           ctx.fillStyle = isMaxC ? "rgba(239,68,68,0.95)" : "rgba(239,68,68,0.55)";
//           ctx.fillRect(rightX - cw, yTop, cw, barH);
//           ctx.fillStyle = isMaxP ? "rgba(34,197,94,0.95)" : "rgba(34,197,94,0.55)";
//           ctx.fillRect(rightX - pw, yTop + barH + 1, pw, barH);

//           // Labels only when bands are tall enough to read, or for the max strikes
//           if (band >= 22 || isMaxC || isMaxP) {
//             ctx.fillStyle = "rgba(255,255,255,0.8)";
//             if (l.callOI > 0) ctx.fillText(fmtOI(l.callOI), rightX - cw - 4, yTop + barH / 2);
//             if (l.putOI  > 0) ctx.fillText(fmtOI(l.putOI),  rightX - pw - 4, yTop + barH * 1.5 + 1);
//           }
//         }
//         ctx.restore();
//       },
//       destroy() { canvas = null; ctx = null; }
//     };
//   }
// });


registerRendererLayer({
  id: OI_PROFILE_ID,
  placement: "above-data",
  create: () => {
    let canvas = null, ctx = null;
    return {
      mount(element) { canvas = element; ctx = element.getContext("2d"); },
      render({ data, coords, scale, bounds }) {
        if (!ctx || !canvas) return;
        const dpr = coords.dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        const levels = data?.levels;
        if (!levels?.length || bounds.height <= 0) return;

        let step = Infinity;
        for (let i = 1; i < levels.length; i++) {
          const d = levels[i].strike - levels[i - 1].strike;
          if (d > 0 && d < step) step = d;
        }
        if (!Number.isFinite(step)) step = 1;

        // One shared scale so call and put bars are directly comparable
        const maxOI = Math.max(...levels.map(l => Math.max(l.callOI, l.putOI)), 1);
        const maxBar = Math.min(220, coords.width * 0.3);

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, bounds.top, coords.width, bounds.height);
        ctx.clip();
        ctx.font = "10px sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "right";

        for (const l of levels) {
          const yTop = coords.priceToY(l.strike + step / 2, scale, bounds);
          const yBot = coords.priceToY(l.strike - step / 2, scale, bounds);
          if (!Number.isFinite(yTop) || !Number.isFinite(yBot)) continue;
          if (yBot < bounds.top || yTop > bounds.top + bounds.height) continue;

          const band = yBot - yTop;
          const barH = Math.max(1, band / 2 - 0.5);
          const rightX = coords.width;

          // Call OI (red) top half, Put OI (green) bottom half
          const cw = (l.callOI / maxOI) * maxBar;
          const pw = (l.putOI  / maxOI) * maxBar;
          const isMaxC = l.strike === data.resistance;
          const isMaxP = l.strike === data.support;

          ctx.fillStyle = isMaxC ? "rgba(239,68,68,0.95)" : "rgba(239,68,68,0.55)";
          ctx.fillRect(rightX - cw, yTop, cw, barH);
          ctx.fillStyle = isMaxP ? "rgba(34,197,94,0.95)" : "rgba(34,197,94,0.55)";
          ctx.fillRect(rightX - pw, yTop + barH + 1, pw, barH);

          // Labels only when bands are tall enough to read, or for the support/resistance strikes
          if (band >= 22 || isMaxC || isMaxP) {
            ctx.fillStyle = "rgba(255,255,255,0.8)";
            if (l.callOI > 0) ctx.fillText(fmtOI(l.callOI), rightX - cw - 4, yTop + barH / 2);
            if (l.putOI  > 0) ctx.fillText(fmtOI(l.putOI),  rightX - pw - 4, yTop + barH * 1.5 + 1);
          }
        }

        // ── Max Pain / Support / Resistance lines ──
        const marks = [
          { price: data.resistance, label: "Resistance", color: "239,68,68", dash: [6, 4] },
          { price: data.support,    label: "Support",    color: "34,197,94", dash: [6, 4] },
          { price: data.maxPain,    label: "Max Pain",   color: "250,204,21", dash: [] },
        ].filter(m => m.price > 0)
         .map(m => ({ ...m, y: coords.priceToY(m.price, scale, bounds) }))
         .filter(m => Number.isFinite(m.y))
         .sort((a, b) => a.y - b.y);

        ctx.textAlign = "left";
        ctx.font = "bold 10px sans-serif";
        let lastLabelY = -Infinity;
        for (const m of marks) {
          ctx.strokeStyle = `rgba(${m.color},0.85)`;
          ctx.lineWidth = 1.2;
          ctx.setLineDash(m.dash);
          ctx.beginPath();
          ctx.moveTo(0, m.y);
          ctx.lineTo(coords.width, m.y);
          ctx.stroke();
          ctx.setLineDash([]);

          // keep labels from stacking when two levels share a strike
          const ly = Math.max(m.y - 7, lastLabelY + 13);
          lastLabelY = ly;
          const text = `${m.label} ${m.price.toLocaleString("en-IN")}`;
          const w = ctx.measureText(text).width + 8;
          ctx.fillStyle = `rgba(${m.color},0.9)`;
          ctx.fillRect(4, ly - 6, w, 12);
          ctx.fillStyle = "#111";
          ctx.fillText(text, 8, ly);
        }
        ctx.lineWidth = 1;

        ctx.restore();
      },
      destroy() { canvas = null; ctx = null; }
    };
  }
});



const workspace = new VelaWorkspace("#chart", {
  layout: false,
  symbol: providerPrefix + CONFIG.symbol,
  timeframe: CONFIG.timeframe,
  live: true,
  theme: "dark",
  persist: false,
  bars: 1000,
  volume: true,
  timezone: CONFIG.timezone,
  watermark: false,
  upColor: CONFIG.upColor,
  downColor: CONFIG.downColor,
  providers: {
    [CONFIG.broker.toLowerCase()]: () => new BrokerDataProvider()
  }

});
window.velaWorkspace = workspace;


// Locate the Vela topbar container
const topbar = document.querySelector('.vela-widget-topbar');

if (topbar) {
  const logo = document.createElement('img');
  logo.className = 'venom-logo';
  logo.src = '/favicon2.png?v=2';
  logo.alt = 'VenomCandle';
  logo.title = 'VenomCandle';
  logo.style.width = '120px'; 
  logo.style.height = 'auto';
  topbar.insertBefore(logo, topbar.firstChild);

  const colorOrderActions = () => {
    for (const button of topbar.querySelectorAll("button")) {
      const label = button.textContent.trim().toUpperCase();
      if (label === "BUY") button.classList.add("vela-order-buy");
      else if (label === "SELL") button.classList.add("vela-order-sell");
    }
  };
  colorOrderActions();
  new MutationObserver(colorOrderActions).observe(topbar, { childList: true, subtree: true });
}


// One shared, deliberately non-submitting order ticket for chart controls and position drawings.
// The current server exposes market data only; a broker order adapter must be connected before
// this ticket can submit anything live.
function installOrderEntry() {
  const backdrop = document.createElement("div");
  backdrop.id = "order-ticket-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `<section id="order-ticket" role="dialog" aria-modal="true" aria-labelledby="order-ticket-title">
    <header><div class="ticket-instrument"><span class="tv-mark">VC</span><strong id="order-ticket-title" class="instrument-symbol"></strong><span class="timeframe-pill">${CONFIG.timeframe === "1" ? "1m" : CONFIG.timeframe}</span></div><div class="ticket-header-actions"><button type="button" aria-label="More order options">•••</button><button type="button" data-ticket-close aria-label="Close">×</button></div></header>
    <form id="order-ticket-form">
      <div class="ticket-tabs"><button type="button" data-ticket-type="Market" class="active">Market</button><button type="button" data-ticket-type="Limit">Limit</button><button type="button" data-ticket-type="Stop">Stop</button><button type="button" data-ticket-type="Stop-Limit">Stop-Limit</button><select class="form-hidden-select" name="orderType" aria-label="Order type"><option>Market</option><option>Limit</option><option>Stop</option><option>Stop-Limit</option></select></div>
      <div class="quote-strip"><div class="quote-side"><b class="quote-sell">Sell</b><span class="quote-sell" data-quote="bid">—</span></div><span class="quote-mid" data-quote="spread">—</span><div class="quote-side"><b class="quote-buy">Buy</b><span class="quote-buy" data-quote="ask">—</span></div></div>
      <label>Product<select name="product"></select></label>
      <label>Side<select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
      <label class="wide" data-field="entry">Limit price<input name="entry" type="number" min="0" step="any"></label>
      <label class="wide" data-field="trigger" hidden>Trigger price<input name="trigger" type="number" min="0" step="any"></label>
      <label class="wide">Sizing method<select name="sizing"><option value="quantity">Units</option><option value="risk">Risk amount</option></select></label>
      <label class="wide" data-field="quantity">Quantity<input name="quantity" type="number" min="0" step="any" value="1"></label>
      <label class="wide" data-field="risk" hidden>Risk amount<input name="risk" type="number" min="0" step="any"></label>
      <div class="section-title">Exits</div>
      <label class="toggle-row wide"><span>Take profit</span><input class="ticket-switch" name="targetEnabled" type="checkbox"></label>
      <label class="wide" data-field="target">Take profit price<input name="target" type="number" min="0" step="any"></label>
      <label class="toggle-row wide"><span>Stop loss</span><input class="ticket-switch" name="stopEnabled" type="checkbox"></label>
      <label class="wide" data-field="stop">Stop loss price<input name="stop" type="number" min="0" step="any"></label>
      <details class="wide"><summary>Instrument sizing and tick settings</summary><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px"><label>Broker quantity step / lot size<input name="qtyStep" type="number" min="0.00000001" step="any" placeholder="Not provided"></label><label>Broker price tick<input name="tick" type="number" min="0.00000001" step="any" readonly placeholder="Not provided"></label></div></details>
      <div id="order-ticket-status" class="wide" role="status">No broker order-placement backend is connected. Orders cannot be submitted.</div>
      <div class="action-row"><button type="submit" id="order-ticket-submit">Buy</button><small data-submit-summary>1 order · Market</small></div>
    </form>
  </section>`;
  document.body.append(backdrop);
  const form = backdrop.querySelector("form");
  const status = backdrop.querySelector("#order-ticket-status");
  const field = name => form.elements.namedItem(name);
  let positionDrawingId = null;
  let ticketLineIds = { entry: null, stop: null, target: null };
  let ticketLinesEnabled = false;
  let syncingDrawingFromTicket = false;
  let instrumentRules = null;
  const manualInstrumentRules = new Map();
  const supportedProducts = CONFIG.broker === "COINBASE"
    ? [["delivery", "Spot"]]
    : [["intraday", "Intraday"], ["delivery", "Delivery"], ["carry-forward", "Carry-forward"]];
  for (const [value, label] of supportedProducts) field("product").add(new Option(label, value));
  const latestPrice = () => Number(currentCandle?.close ?? historyBars.at(-1)?.close) || 0;
  const prettyPrice = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 8 }) : "—";
  const refreshQuotes = () => {
    const bid = orderBookData.bids.reduce((best, level) => Math.max(best, Number(level.price) || 0), 0);
    const asks = orderBookData.asks.map(level => Number(level.price) || 0).filter(price => price > 0);
    const ask = asks.length ? Math.min(...asks) : 0;
    backdrop.querySelector('[data-quote="bid"]').textContent = prettyPrice(bid);
    backdrop.querySelector('[data-quote="ask"]').textContent = prettyPrice(ask);
    backdrop.querySelector('[data-quote="spread"]').textContent = bid && ask ? prettyPrice(ask - bid) : "—";
  };
  const setStatus = message => { status.textContent = message; };
  const openTicket = ({ side = "buy", orderType = "Market", entry = latestPrice(), stop = "", target = "" } = {}) => {
    backdrop.querySelector(".instrument-symbol").textContent = CONFIG.symbol;
    field("side").value = side;
    field("orderType").value = orderType;
    field("entry").value = entry || "";
    field("trigger").value = "";
    field("stop").value = stop || "";
    field("target").value = target || "";
    field("stopEnabled").checked = Boolean(stop);
    field("targetEnabled").checked = Boolean(target);
    positionDrawingId = selectedPositionId && workspace.chart.drawings.all().some(d => d.id === selectedPositionId && d.type === "position") ? selectedPositionId : null;
    ticketLinesEnabled = Boolean(positionDrawingId);
    field("quantity").value = "1";
    field("sizing").value = "quantity";
    setStatus("No broker order-placement backend is connected. Orders cannot be submitted.");
    updateFields();
    refreshQuotes();
    // backdrop.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add("order-ticket-open");
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));

    void loadInstrumentRules();
    syncTicketLines();
    field("quantity").focus();
  };
  openOrderTicket = openTicket;
  const updateFields = () => {
    const type = field("orderType").value;
    const hasEntry = type === "Limit" || type === "Stop-Limit";
    const hasTrigger = type === "Stop" || type === "Stop-Limit";
    form.querySelector('[data-field="entry"]').hidden = !hasEntry;
    form.querySelector('[data-field="trigger"]').hidden = !hasTrigger;
    form.querySelector('[data-field="quantity"]').hidden = field("sizing").value === "risk";
    form.querySelector('[data-field="risk"]').hidden = field("sizing").value !== "risk";
    form.querySelector('[data-field="stop"]').hidden = !field("stopEnabled").checked;
    form.querySelector('[data-field="target"]').hidden = !field("targetEnabled").checked;
    backdrop.querySelectorAll("[data-ticket-type]").forEach(button => button.classList.toggle("active", button.dataset.ticketType === type));
    const side = field("side").value;
    backdrop.querySelector("#order-ticket-submit").textContent = side === "buy" ? "Buy" : "Sell";
    backdrop.querySelector("[data-submit-summary]").textContent = `${field("quantity").value || "1"} ${field("sizing").value === "risk" ? "risk sized" : "units"} · ${type}`;
    if (!backdrop.hidden) syncTicketLines();
  };
  const loadInstrumentRules = async () => {
    instrumentRules = null;
    field("tick").value = "";
    field("qtyStep").value = "";
    // Broker extension contract: getInstrumentRules(symbol) resolves to
    // { tickSize, quantityStep, lotSize? }. Never substitute chart precision or
    // footprint aggregation size for an exchange trading increment.
    const adapter = window.tradingEngineBrokerAdapter;
    if (typeof adapter?.getInstrumentRules !== "function") {
      const manual = manualInstrumentRules.get(CONFIG.symbol);
      ["entry", "trigger", "stop", "target"].forEach(name => { field(name).readOnly = false; field(name).step = manual?.tickSize ? String(manual.tickSize) : "any"; });
      field("tick").readOnly = false;
      if (manual) {
        instrumentRules = manual;
        field("tick").value = String(manual.tickSize);
        field("qtyStep").value = manual.quantityStep > 0 ? String(manual.quantityStep) : "";
        setStatus(`Using the tick and quantity step entered for ${CONFIG.symbol}. No broker order-placement backend is connected.`);
      } else {
        setStatus("Enter this instrument's broker tick and quantity step to validate prices. Orders cannot be submitted without the broker backend.");
      }
      return;
    }
    try {
      const rules = await adapter.getInstrumentRules(CONFIG.symbol);
      if (backdrop.hidden || backdrop.querySelector(".instrument-symbol").textContent !== CONFIG.symbol) return;
      const tickSize = Number(rules?.tickSize);
      const quantityStep = Number(rules?.quantityStep ?? rules?.lotSize);
      if (!(tickSize > 0) || !(quantityStep > 0)) throw new Error("Broker did not return a valid tick size and quantity step.");
      instrumentRules = { tickSize, quantityStep };
      ["entry", "trigger", "stop", "target"].forEach(name => { field(name).readOnly = false; field(name).step = String(tickSize); });
      field("tick").value = String(tickSize);
      field("tick").step = String(tickSize);
      field("qtyStep").value = String(quantityStep);
      setStatus("Instrument tick size and quantity step loaded from the connected broker.");
      syncTicketLines();
    } catch (error) {
      field("tick").readOnly = false;
      setStatus(`Broker instrument rules unavailable: ${error?.message || "unknown error"}`);
    }
  };
  const snapToBrokerTick = value => {
    const tick = instrumentRules?.tickSize;
    if (!(tick > 0) || !Number.isFinite(value)) return value;
    const decimals = Math.max(0, Math.min(10, (String(tick).split(".")[1] || "").length));
    return Number((Math.round(value / tick) * tick).toFixed(decimals));
  };
  const isBrokerTickAligned = value => {
    const tick = instrumentRules?.tickSize;
    return tick > 0 && Math.abs(value / tick - Math.round(value / tick)) < 1e-7;
  };
  const syncTicketLines = () => {
    if (backdrop.hidden || syncingDrawingFromTicket || !ticketLinesEnabled) return;
    const type = field("orderType").value;
    const entry = type === "Market" ? latestPrice() : type === "Stop" ? Number(field("trigger").value) : Number(field("entry").value);
    const stop = Number(field("stop").value);
    const target = Number(field("target").value);
    // Keep chart previews responsive while a user is editing. Tick alignment remains a hard
    // submission check below; it should not prevent an unsubmitted preview from being drawn.
    if (!(entry > 0) || !Number.isFinite(entry)) return;
    syncingDrawingFromTicket = true;
    try {
      const time = Number(historyBars.at(-1)?.time) || Date.now();
      // Ticket previews are independent horizontal order lines. In particular, a ticket
      // opened from a Long/Short position drawing must never rewrite that drawing's anchors.
      updateTicketPriceLine("entry", entry, time);
      updateTicketPriceLine("stop", field("stopEnabled").checked && stop > 0 && Number.isFinite(stop) ? stop : null, time);
      updateTicketPriceLine("target", field("targetEnabled").checked && target > 0 && Number.isFinite(target) ? target : null, time);
    } finally { syncingDrawingFromTicket = false; }
  };
  const estimatedOrderQuantity = (entry, stop) => {
    const step = Number(field("qtyStep").value);
    if (field("sizing").value === "risk") {
      const risk = Number(field("risk").value);
      if (risk > 0 && stop > 0 && entry !== stop && step > 0) return Math.floor((risk / Math.abs(entry - stop)) / step) * step;
    }
    return Number(field("quantity").value) || 0;
  };
  const publishTicketOrderLabels = () => {
    ticketOrderLabels = Object.entries(ticketLineIds).flatMap(([level, id]) => {
      if (!id) return [];
      const drawing = workspace.chart.drawings.all().find(item => item.id === id);
      const price = Number(drawing?.anchors?.[0]?.price);
      const label = drawing?.text?.value;
      if (!(price > 0) || !label) return [];
      return [{ level, price, label, color: drawing.style?.lineColor || "#2962ff" }];
    });
    for (const sink of optionsWallsSinks) sink.context?.pushData({ ...optionsWalls, ticketOrderLabels });
  };
  const updateTicketPriceLine = (level, price, time) => {
    const existingId = ticketLineIds[level];
    if (price == null) {
      if (existingId) workspace.chart.drawings.remove(existingId);
      ticketLineIds[level] = null;
      publishTicketOrderLabels();
      return;
    }
    const style = { lineColor: level === "stop" ? "#f23645" : level === "target" ? "#089981" : "#2962ff", lineWidth: 2, lineStyle: "dashed" };
    const type = field("orderType").value;
    const entry = type === "Market" ? latestPrice() : type === "Stop" ? Number(field("trigger").value) : Number(field("entry").value);
    const sign = field("side").value === "buy" ? 1 : -1;
    const quantity = estimatedOrderQuantity(entry, Number(field("stop").value));
    const currency = CONFIG.broker === "FYERS" ? "₹" : "$";
    const pnl = level === "target" ? (price - entry) * quantity * sign : level === "stop" ? (price - entry) * quantity * sign : 0;
    const quantityText = Number(quantity).toLocaleString("en-IN", { maximumFractionDigits: 8 });
    const label = level === "entry" ? `Entry ${field("side").value.toUpperCase()} ${quantityText} @ ${prettyPrice(price)}` : `${level === "target" ? "TP" : "SL"} ${quantityText} ${pnl >= 0 ? "+" : "−"}${currency}${Math.abs(pnl).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} @ ${prettyPrice(price)}`;
    if (existingId && workspace.chart.drawings.all().some(d => d.id === existingId)) {
      const drawing = workspace.chart.drawings.all().find(d => d.id === existingId);
      const anchor = drawing.anchors?.[0];
      workspace.chart.drawings.update(existingId, { anchors: [{ time: anchor?.time ?? time, price }], style, text: { value: label, color: style.lineColor } });
    } else {
      const drawing = workspace.chart.drawings.add("hline", { anchors: [{ time, price }], style, text: { value: label, color: style.lineColor } });
      ticketLineIds[level] = drawing?.id ?? null;
    }
    publishTicketOrderLabels();
  };
  const openLimitFromPosition = () => {
    const drawing = workspace.chart.drawings.all().find(d => d.id === selectedPositionId && d.type === "position");
    if (!drawing) return;
    const anchors = drawing.anchors || [];
    const entry = Number(drawing.entryPrice ?? anchors[0]?.price) || latestPrice();
    const stop = Number(drawing.stopPrice ?? anchors[1]?.price) || "";
    const target = Number(drawing.targetPrice ?? anchors[2]?.price) || "";
    const isLong = String(drawing.direction || (target && target > entry ? "long" : "short")).toLowerCase() === "long";
    openTicket({ side: isLong ? "buy" : "sell", orderType: "Limit", entry, stop, target });
  };
  const addPositionOrderIcon = () => {
    const toolbar = document.querySelector(".vela-dpop");
    if (!toolbar || !selectedPositionId || !workspace.chart.drawings.all().some(d => d.id === selectedPositionId && d.type === "position")) return;
    if (toolbar.querySelector("[data-vela-create-limit-order]")) return;
    const icon = document.createElement("button");
    icon.type = "button";
    icon.className = "vela-dpop-btn";
    icon.dataset.tip = "Create limit order";
    icon.dataset.velaCreateLimitOrder = "true";
    icon.setAttribute("aria-label", "Create limit order from this position drawing");
    icon.title = "Create limit order";
    icon.style.cssText = "width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:inherit;border:0;border-radius:5px;padding:0;background:transparent;font-size:20px;";
    icon.textContent = "⊕";
    icon.addEventListener("pointerdown", event => event.stopPropagation());
    icon.addEventListener("click", event => { event.stopPropagation(); openLimitFromPosition(); });
    const divider = document.createElement("span");
    divider.style.cssText = "width:1px;height:22px;background:var(--vela-border);margin:0 3px;";
    toolbar.querySelector(":scope > div")?.append(divider, icon);
  };
  const drawingPopupObserver = new MutationObserver(addPositionOrderIcon);
  drawingPopupObserver.observe(document.querySelector("#chart"), { childList: true, subtree: true });
  backdrop.querySelectorAll("[data-ticket-type]").forEach(button => button.addEventListener("click", () => { field("orderType").value = button.dataset.ticketType; ticketLinesEnabled = true; updateFields(); }));
  form.elements.sizing.addEventListener("change", updateFields);
  field("side").addEventListener("change", updateFields);
  ["side", "quantity", "risk", "stopEnabled", "targetEnabled", "entry", "trigger", "stop", "target", "qtyStep"].forEach(name => field(name).addEventListener("input", () => { if (name === "stopEnabled" || name === "targetEnabled" || ["entry", "trigger", "stop", "target"].includes(name)) ticketLinesEnabled = true; updateFields(); }));
  field("tick").addEventListener("change", () => {
    const tickSize = Number(field("tick").value);
    const quantityStep = Number(field("qtyStep").value) || 0;
    if (!(tickSize > 0)) { instrumentRules = null; setStatus("Enter a valid positive tick size for this instrument."); return; }
    instrumentRules = { tickSize, quantityStep };
    manualInstrumentRules.set(CONFIG.symbol, instrumentRules);
    ["entry", "trigger", "stop", "target"].forEach(name => { field(name).readOnly = false; field(name).step = String(tickSize); });
    setStatus(`Using ${tickSize} price tick for ${CONFIG.symbol}; enter the broker quantity step to validate size.`);
    updateFields();
  });
  field("qtyStep").addEventListener("change", () => {
    const quantityStep = Number(field("qtyStep").value);
    if (quantityStep > 0 && instrumentRules?.tickSize) {
      instrumentRules = { ...instrumentRules, quantityStep };
      manualInstrumentRules.set(CONFIG.symbol, instrumentRules);
    }
    updateFields();
  });
  ["stopEnabled", "targetEnabled", "sizing"].forEach(name => field(name).addEventListener("change", updateFields));
  ["entry", "trigger", "stop", "target"].forEach(name => field(name).addEventListener("change", () => {
    const input = field(name);
    if (instrumentRules?.tickSize && Number(input.value) > 0) input.value = String(snapToBrokerTick(Number(input.value)));
    updateFields();
  }));
  const closeTicket = () => {
    backdrop.hidden = true;
    document.body.classList.remove("order-ticket-open");
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    // Keep user-created preview levels visible after closing the ticket. They are not
    // created until the user edits an order, and remain draggable on the chart.
    ticketLinesEnabled = false;
  };
  backdrop.querySelectorAll("[data-ticket-close]").forEach(button => button.addEventListener("click", closeTicket));
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !backdrop.hidden) closeTicket(); });
  backdrop.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const focusable = [...backdrop.querySelectorAll("button:not(:disabled),input:not(:disabled):not([hidden]),select:not(:disabled),summary")].filter(el => el.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  let selectedPositionId = null;
  workspace.chart.on("drawing:selected", ({ id }) => { selectedPositionId = id || null; queueMicrotask(addPositionOrderIcon); });
  workspace.chart.on("drawing:created", () => queueMicrotask(addPositionOrderIcon));
  workspace.chart.on("drawing:removed", ({ id }) => { if (id === selectedPositionId) selectedPositionId = null; });
  workspace.chart.on("drawing:edited", ({ id }) => {
    if (syncingDrawingFromTicket) return;
    const drawing = workspace.chart.drawings.all().find(d => d.id === id);
    if (!drawing) return;
    if (id === positionDrawingId && drawing.type === "position") {
      if (instrumentRules?.tickSize) {
        const anchors = drawing.anchors.map(anchor => ({ ...anchor, price: snapToBrokerTick(Number(anchor.price)) }));
        if (anchors.some((anchor, index) => anchor.price !== drawing.anchors[index]?.price)) {
          syncingDrawingFromTicket = true;
          workspace.chart.drawings.update(id, { anchors });
          syncingDrawingFromTicket = false;
        }
      }
      field("entry").value = String(drawing.entryPrice ?? "");
      field("stop").value = String(drawing.stopPrice ?? "");
      field("target").value = String(drawing.targetPrice ?? "");
      field("stopEnabled").checked = true;
      field("targetEnabled").checked = true;
      updateFields();
      return;
    }
    const level = Object.keys(ticketLineIds).find(key => ticketLineIds[key] === id);
    if (level && drawing.type === "hline") {
      let price = Number(drawing.anchors?.[0]?.price);
      if (price > 0 && instrumentRules?.tickSize) {
        const snapped = snapToBrokerTick(price);
        if (snapped !== price) {
          price = snapped;
          syncingDrawingFromTicket = true;
          workspace.chart.drawings.update(id, { anchors: [{ ...drawing.anchors[0], price }] });
          syncingDrawingFromTicket = false;
        }
      }
      const name = level === "entry" ? (field("orderType").value === "Stop" ? "trigger" : "entry") : level;
      if (price > 0) field(name).value = String(price);
      updateFields();
    }
  });

  form.addEventListener("submit", event => {
    event.preventDefault();
    const type = field("orderType").value;
    const entry = type === "Market" ? latestPrice() : type === "Stop" ? Number(field("trigger").value) : Number(field("entry").value);
    const stop = field("stopEnabled").checked ? Number(field("stop").value) : 0;
    const target = field("targetEnabled").checked ? Number(field("target").value) : 0;
    const tick = Number(field("tick").value);
    const step = Number(field("qtyStep").value);
    const isRisk = field("sizing").value === "risk";
    let quantity = Number(field("quantity").value);
    if (isRisk) {
      const riskAmount = Number(field("risk").value);
      if (!Number.isFinite(riskAmount) || riskAmount <= 0 || !Number.isFinite(stop) || stop <= 0 || !Number.isFinite(entry) || entry <= 0 || Math.abs(entry - stop) <= 0) {
        setStatus("Enter a positive risk amount and valid entry and stop-loss prices to calculate quantity."); return;
      }
      quantity = Math.floor((riskAmount / Math.abs(entry - stop)) / step) * step;
      field("quantity").value = quantity;
    }
    const priceInputs = [entry, ...(type === "Stop" || type === "Stop-Limit" ? [Number(field("trigger").value)] : [])];
    const exitPrices = [stop, target].filter(price => price > 0);
    if (priceInputs.some(price => !Number.isFinite(price) || price <= 0) || (type !== "Market" && (!Number.isFinite(tick) || tick <= 0))) {
      setStatus("Enter valid positive prices and load the broker's price tick before editing a priced order."); return;
    }
    if ([...priceInputs, ...exitPrices].some(price => !isBrokerTickAligned(price))) {
      setStatus("Every order price must be an exact multiple of the current instrument's broker tick size."); return;
    }
    if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity / step - Math.round(quantity / step)) > 1e-8) {
      setStatus("Quantity must be positive and match the configured quantity step or lot size."); return;
    }
    if (stop && ((field("side").value === "buy" && stop >= entry) || (field("side").value === "sell" && stop <= entry))) {
      setStatus("Stop-loss must be below entry for a buy and above entry for a sell."); return;
    }
    if (target && ((field("side").value === "buy" && target <= entry) || (field("side").value === "sell" && target >= entry))) {
      setStatus("Take-profit must be above entry for a buy and below entry for a sell."); return;
    }
    setStatus("Order details are valid for review, but submission is disabled: no broker order-placement backend or margin validation is connected.");
  });
}
installOrderEntry();
workspace.chart.on("market:changed", ({ symbol }) => {
  const selected = String(symbol || "").replace(/^(fyers|coinbase):/i, "");
  switchChartSymbol(symbolKey(selected), true).catch(console.warn);
});
// The workspace option alone does not initialize the chart's time scale.
workspace.chart.renderer?.set("timezone", CONFIG.timezone);
let activeChartStyle = null;
function historyBarForTime(time) {
  const value = Number(time);
  if (!Number.isFinite(value)) return null;
  for (const candidate of [value, value * 1000, value / 1000]) {
    const exact = historyBars.find(bar => bar.time === candidate);
    if (exact) return exact;
    const minute = Math.floor(candidate / CONFIG.candleSpanMs) * CONFIG.candleSpanMs;
    const byMinute = historyBars.find(bar => bar.time === minute);
    if (byMinute) return byMinute;
  }
  return null;
}

function syncFootprintVolumeBars(footprintOnly) {
  const bars = workspace.chart.renderer?.renderer?.scene?.bars;
  if (!Array.isArray(bars)) return;
  for (const bar of bars) {
    if (footprintOnly) {
      const footprint = footprintForBarTime(bar.time)?.footprint;
      bar.volume = footprint?.levels?.length
        ? footprint.levels.reduce((sum, level) => sum + (Number(level.total) || 0), 0)
        : 0;
    } else {
      bar.volume = Number(historyBarForTime(bar.time)?.volume) || 0;
    }
  }
}

function scaleFootprintPriceAxis() {
  let latestFootprintTime = -Infinity;
  for (const time of footprintCandlesByTime.keys()) {
    if (time > latestFootprintTime) latestFootprintTime = time;
  }
  if (!Number.isFinite(latestFootprintTime)) return;
  syncFootprintVolumeBars(true);

  const firstVisibleTime = latestFootprintTime - 11 * CONFIG.candleSpanMs;
  let low = Infinity;
  let high = -Infinity;
  let tickSize = 0;
  for (const [time, candle] of footprintCandlesByTime) {
    if (time < firstVisibleTime || time > latestFootprintTime) continue;
    low = Math.min(low, Number(candle.low));
    high = Math.max(high, Number(candle.high));
    tickSize = Math.max(tickSize, Number(candle.footprint?.tickSize) || 0);
  }

  const renderer = workspace.chart.renderer?.renderer;
  const pricePane = renderer?.scene?.orderedPanes?.().find(pane => pane.kind === "price");
  if (!pricePane || !Number.isFinite(low) || !Number.isFinite(high) || !renderer.setManualScale) return;
  const padding = Math.max((high - low) * 0.12, tickSize * 2, 0.01);
  renderer.setManualScale(pricePane, { min: low - padding, max: high + padding });
}

function applyChartStyle(style) {
  if (!style || style === activeChartStyle) return;
  activeChartStyle = style;
  if (style === FOOTPRINT_CHART_TYPE) {
    syncFootprintVolumeBars(true);
    let latestFootprintTime = -Infinity;
    for (const time of footprintCandlesByTime.keys()) {
      if (time > latestFootprintTime) latestFootprintTime = time;
    }
    if (Number.isFinite(latestFootprintTime)) {
      workspace.chart.setVisibleRange?.({
        from: latestFootprintTime - 11 * CONFIG.candleSpanMs,
        to: latestFootprintTime + CONFIG.candleSpanMs
      });
    }
    scaleFootprintPriceAxis();
  } else {
    syncFootprintVolumeBars(false);
    workspace.chart.renderer?.set("autoScale", true);
  }
}


// This Vela indicator paints the backend's tick-level profile in the chart pane.
workspace.chart.addNativeIndicator(BACKEND_VP_TYPE);
workspace.chart.addNativeIndicator(BOOK_LAYER_ID);
liquidityHeatmapHandle = workspace.chart.addNativeIndicator(LIQUIDITY_HEATMAP_ID);
workspace.chart.addNativeIndicator(BIG_TRADES_LAYER_ID);
workspace.chart.addNativeIndicator("vwap");
workspace.chart.addNativeIndicator(OPTIONS_WALLS_ID);
workspace.chart.addNativeIndicator(GEX_HEATMAP_ID);
workspace.chart.addNativeIndicator(OI_PROFILE_ID); 

// RendererControl doesn't expose the internal price-style callback. Watch the
// public style selector instead, which is updated by Vela for every UI change.
const chartStyleButton = document.getElementById("vela-topbar-style");
if (chartStyleButton) {
  const readChartStyle = () => {
    const label = chartStyleButton.getAttribute("aria-label") || "";
    const style = label.replace(/^Chart style —?\s*/i, "").trim().toLowerCase();
    applyChartStyle(style);
  };
  new MutationObserver(readChartStyle).observe(chartStyleButton, {
    attributes: true,
    attributeFilter: ["aria-label"]
  });
  readChartStyle();
}

// ── Local Pine Script editor ────────────────────────────────────────
const PINE_STORAGE_KEY = "tradingengine.pineScripts.v1";
const PINE_DRAFT_KEY = "tradingengine.pineDrafts.v1";
const PINE_STARTER = `//@version=5
indicator("EMA 20", overlay=true)
plot(ta.ema(close, 20), color=color.orange, linewidth=2)
`;
const FOOTPRINT_PINE_TEMPLATES = {
  "live-delta": {
    name: "Live Footprint Delta",
    source: `//@version=5
indicator("Live Footprint Delta", overlay=false)
fpTicker = "${providerPrefix}${CONFIG.symbol}"
delta = request.security(fpTicker + ".FP_DELTA", timeframe.period, close)
ready = request.security(fpTicker + ".FP_READY", timeframe.period, close)
plot(ready > 0 ? delta : na, title="Buy minus sell volume", style=plot.style_columns, color=delta >= 0 ? color.lime : color.red)
`
  },
  "delta-divergence": {
    name: "Footprint Delta Divergence",
    source: `//@version=5
indicator("Footprint Delta Divergence", overlay=true)
// Synthetic symbols expose the live tick-footprint data from this chart.
fpTicker = "${providerPrefix}${CONFIG.symbol}"
delta = request.security(fpTicker + ".FP_DELTA", timeframe.period, close)
ready = request.security(fpTicker + ".FP_READY", timeframe.period, close)
// Historical candles without stored tick footprints have ready = 0.
bullish = ready > 0 and low < low[1] and delta > delta[1] and delta < 0
bearish = ready > 0 and high > high[1] and delta < delta[1] and delta > 0
plotshape(bullish, title="Bullish delta divergence", style=shape.triangleup, location=location.belowbar, color=color.lime, size=size.small)
plotshape(bearish, title="Bearish delta divergence", style=shape.triangledown, location=location.abovebar, color=color.red, size=size.small)
`
  },
  "imbalance-zones": {
    name: "Footprint Imbalance Zones",
    source: `//@version=5
indicator("Footprint Imbalance Zones", overlay=true)
minRatio = input.float(3.0, "Minimum diagonal imbalance ratio", minval=1.0)
fpTicker = "${providerPrefix}${CONFIG.symbol}"
buyPrice = request.security(fpTicker + ".FP_BUY_IMBALANCE_PRICE", timeframe.period, close)
buyRatio = request.security(fpTicker + ".FP_BUY_IMBALANCE_RATIO", timeframe.period, close)
sellPrice = request.security(fpTicker + ".FP_SELL_IMBALANCE_PRICE", timeframe.period, close)
sellRatio = request.security(fpTicker + ".FP_SELL_IMBALANCE_RATIO", timeframe.period, close)
ready = request.security(fpTicker + ".FP_READY", timeframe.period, close)
tick = request.security(fpTicker + ".FP_TICK", timeframe.period, close)
if ready > 0 and tick > 0 and buyPrice > 0 and buyRatio >= minRatio
    box.new(bar_index, buyPrice + tick, bar_index + 1, buyPrice, border_color=color.new(color.lime, 20), bgcolor=color.new(color.lime, 78))
if ready > 0 and tick > 0 and sellPrice > 0 and sellRatio >= minRatio
    box.new(bar_index, sellPrice + tick, bar_index + 1, sellPrice, border_color=color.new(color.red, 20), bgcolor=color.new(color.red, 78))
`
  },
  "level-volume": {
    name: "Footprint Volume at Price",
    source: `//@version=5
indicator("Footprint Volume at Price", overlay=false)
// Set the price to inspect. Prices are mapped to 0.01 units for this symbol.
levelPrice = input.float(15000.00, "Footprint price level")
priceKey = str.tostring(math.round(levelPrice * 100))
fpTicker = "${providerPrefix}${CONFIG.symbol}"
buyAtPrice = request.security(fpTicker + ".FP_BUY_AT_" + priceKey, timeframe.period, close)
sellAtPrice = request.security(fpTicker + ".FP_SELL_AT_" + priceKey, timeframe.period, close)
plot(buyAtPrice, title="Buy volume", color=color.lime, style=plot.style_columns)
plot(sellAtPrice, title="Sell volume", color=color.red, style=plot.style_columns)
`
  }
};
const pineEditor = document.getElementById("pine-editor");
const pineSource = document.getElementById("pine-script-source");
const pineName = document.getElementById("pine-script-name");
const pineList = document.getElementById("pine-script-list");
const pineIndicatorSearch = document.getElementById("pine-indicator-search");
const pineStatus = document.getElementById("pine-editor-status");
let pineEnginePromise = null;
let savedPineScripts = readPineScripts();
const runningPineIndicators = new Map();

function upgradeFootprintScript(source) {
  source = source.replace(
    /"(?:fyers|coinbase):"\s*\+\s*syminfo\.prefix\s*\+\s*":"\s*\+\s*syminfo\.ticker/g,
    `"${providerPrefix}${CONFIG.symbol}"`
  );
  const legacy = /syminfo\.tickerid(?=\s*\+\s*"\.FP_)/.test(source);
  if (!legacy) return source;
  let updated = source.replace(/syminfo\.tickerid(?=\s*\+\s*"\.FP_)/g, "fpTicker");
  if (!/\bfpTicker\s*=/.test(updated)) {
    const declaration = /^\s*(?:indicator|strategy|study)\s*\([^\n]*\)\s*$/m;
    const match = declaration.exec(updated);
    if (match) {
      const end = match.index + match[0].length;
      updated = `${updated.slice(0, end)}\nfpTicker = "${providerPrefix}${CONFIG.symbol}"${updated.slice(end)}`;
    }
  }
  return updated;
}

function readPineScripts() {
  try {
    const saved = JSON.parse(localStorage.getItem(PINE_STORAGE_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) return saved.map(script => ({
      ...script,
      source: upgradeFootprintScript(String(script.source || ""))
    }));
  } catch { }
  return [{ id: "example-ema", name: "Example EMA", source: PINE_STARTER }];
}

function readPineDrafts() {
  try { return JSON.parse(localStorage.getItem(PINE_DRAFT_KEY) || "{}"); }
  catch { return {}; }
}

function refreshPineList(selectedId, query = pineIndicatorSearch.value) {
  pineList.replaceChildren();
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const matches = savedPineScripts.filter(script => !normalizedQuery || String(script.name || "").toLocaleLowerCase().includes(normalizedQuery));
  for (const script of matches) {
    const option = document.createElement("option");
    option.value = script.id;
    option.textContent = script.name;
    pineList.append(option);
  }
  if (selectedId && matches.some(script => script.id === selectedId)) pineList.value = selectedId;
  if (!pineList.value && matches.length) pineList.value = matches[0].id;
  pineList.disabled = matches.length === 0;
  document.getElementById("pine-add-selected").disabled = matches.length === 0;
  loadPineScript(pineList.value);
}

function loadPineScript(id) {
  const script = savedPineScripts.find(item => item.id === id);
  if (!script) return;
  const drafts = readPineDrafts();
  pineName.value = script.name;
  pineSource.value = upgradeFootprintScript(drafts[id] ?? script.source);
  pineStatus.textContent = "Ready. Add to chart runs this script against the live chart data.";
}

function savePineScripts(selectedId = pineList.value) {
  try {
    localStorage.setItem(PINE_STORAGE_KEY, JSON.stringify(savedPineScripts));
    const drafts = readPineDrafts();
    delete drafts[selectedId];
    localStorage.setItem(PINE_DRAFT_KEY, JSON.stringify(drafts));
    pineStatus.textContent = "Saved in this browser.";
    return true;
  } catch (error) {
    pineStatus.textContent = `Could not save in this browser: ${error.message || error}`;
    return false;
  }
}

function saveCurrentPineScript() {
  const id = pineList.value || `pine-${Date.now()}`;
  const name = pineName.value.trim() || "My Indicator";
  const existing = savedPineScripts.find(item => item.id === id);
  const script = { id, name, source: pineSource.value };
  if (existing) Object.assign(existing, script);
  else savedPineScripts.push(script);
  refreshPineList(id);
  return savePineScripts(id) ? script : null;
}

async function ensurePineEngine() {
  if (!pineEnginePromise) {
    pineEnginePromise = import("https://esm.sh/@luxalgo/vela-pinets@0.2.13?bundle")
      .then(({ PineEngine }) => {
        if (typeof PineEngine !== "function") throw new Error("Pine Script engine could not be loaded.");
        workspace.chart.registerEngine("pine", new PineEngine());
      })
      .catch(error => {
        pineEnginePromise = null;
        throw error;
      });
  }
  return pineEnginePromise;
}

function togglePineEditor() {
  pineEditor.hidden = !pineEditor.hidden;
  if (!pineList.options.length) refreshPineList();
}
document.getElementById("pine-close-editor").addEventListener("click", () => { pineEditor.hidden = true; });
pineList.addEventListener("change", () => loadPineScript(pineList.value));
pineIndicatorSearch.addEventListener("input", () => refreshPineList(pineList.value, pineIndicatorSearch.value));
pineSource.addEventListener("input", () => {
  const drafts = readPineDrafts();
  if (pineList.value) {
    drafts[pineList.value] = pineSource.value;
    try { localStorage.setItem(PINE_DRAFT_KEY, JSON.stringify(drafts)); } catch { }
  }
  pineStatus.textContent = "Unsaved changes. Use Save locally to keep this version.";
});
document.getElementById("pine-script-name").addEventListener("input", () => {
  pineStatus.textContent = "Unsaved changes. Use Save locally to keep this version.";
});
// document.getElementById("pine-save-browser").addEventListener("click", () => { saveCurrentPineScript(); });

document.getElementById("pine-new-script").addEventListener("click", () => {
  const id = `pine-${Date.now()}`;
  savedPineScripts.push({ id, name: "My Indicator", source: `//@version=5\nindicator("My Indicator", overlay=true)\nplot(close)\n` });
  refreshPineList(id);
  savePineScripts(id);
  pineName.focus();
  pineName.select();
});
document.getElementById("pine-use-template").addEventListener("click", () => {
  const template = FOOTPRINT_PINE_TEMPLATES[document.getElementById("pine-template-list").value];
  if (!template) {
    pineStatus.textContent = "Choose a footprint example first.";
    return;
  }
  const id = `pine-${Date.now()}`;
  savedPineScripts.push({ id, name: template.name, source: template.source });
  refreshPineList(id);
  savePineScripts(id);
  pineStatus.textContent = "Example loaded as a new local script. Edit it or Add to chart to run it.";
});
document.getElementById("pine-save-file").addEventListener("click", async () => {
  const fileName = `${(pineName.value.trim() || "my-indicator").replace(/[\\/:*?\"<>|]/g, "-")}.pine`;
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: "Pine Script", accept: { "text/plain": [".pine"] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(pineSource.value);
      await writable.close();
      pineStatus.textContent = `Saved ${fileName} to your computer.`;
    } else {
      const url = URL.createObjectURL(new Blob([pineSource.value], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      pineStatus.textContent = `Downloaded ${fileName}.`;
    }
  } catch (error) {
    if (error.name !== "AbortError") pineStatus.textContent = `Could not save file: ${error.message || error}`;
  }
});
document.getElementById("pine-import-script").addEventListener("click", () => document.getElementById("pine-import-file").click());
document.getElementById("pine-import-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const source = await file.text();
  const id = `pine-${Date.now()}`;
  savedPineScripts.push({ id, name: file.name.replace(/\.(pine|txt)$/i, ""), source });
  refreshPineList(id);
  savePineScripts(id);
  event.target.value = "";
});
async function runSelectedPineScript() {
  if (!pineList.value) return;
  const script = saveCurrentPineScript();
  if (!script) return;
  const runButton = document.getElementById("pine-run-script");
  runButton.disabled = true;
  document.getElementById("pine-add-selected").disabled = true;
  pineStatus.textContent = "Loading Pine Script engine…";
  try {
    await ensurePineEngine();
    const previous = runningPineIndicators.get(script.id);
    previous?.remove?.();
    pineStatus.textContent = "Compiling and adding indicator to the chart…";
    const result = await workspace.chart.runScript(script.source);
    if (!result.ok) {
      pineStatus.textContent = `Pine error: ${result.error?.message || result.error || "Could not run script."}`;
      return;
    }
    runningPineIndicators.set(script.id, result.handle);
    pineStatus.textContent = `${script.name} is running on the chart.`;
  } catch (error) {
    pineStatus.textContent = `Pine error: ${error.message || error}`;
  } finally {
    runButton.disabled = false;
    document.getElementById("pine-add-selected").disabled = false;
  }
}
document.getElementById("pine-run-script").addEventListener("click", runSelectedPineScript);
document.getElementById("pine-add-selected").addEventListener("click", runSelectedPineScript);
pineSource.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    document.getElementById("pine-run-script").click();
  }
});
refreshPineList();

// ── Status helpers ────────────────────────────────────────────────────
// ── Flow → forming candle logic ───────────────────────────────────────
function applyFlowToCandle(msg, notifyChart = true) {
  if (msg.symbol && symbolKey(msg.symbol) !== symbolKey(CONFIG.symbol)) return;
  const t = Number(msg.time);
  const price = Number(msg.ltp);
  if (!Number.isFinite(t) || !Number.isFinite(price)) return;
  // Reject delayed or cached exchange buckets before they can alter a closed
  // historical candle or the per-symbol live cache.
  if (!isFreshLiveTimestamp(t)) return;

  const buy = Number(msg.aggressive_buying) || 0;
  const sell = Number(msg.aggressive_selling) || 0;
  const minuteTs = Math.floor(t / CONFIG.candleSpanMs) * CONFIG.candleSpanMs;
  const latestHistoryTime = historyBars.length ? Number(historyBars[historyBars.length - 1].time) : -Infinity;
  if (minuteTs < latestHistoryTime) return;

  if (!currentCandle || currentCandle.time !== minuteTs) {
    currentCandle = {
      time: minuteTs, open: price, high: price, low: price, close: price,
      volume: 0, buy: 0, sell: 0, isLive: true
    };
  } else {
    currentCandle.close = price;
    currentCandle.high = Math.max(currentCandle.high, price);
    currentCandle.low = Math.min(currentCandle.low, price);
  }

  currentCandle.volume += buy + sell;
  currentCandle.buy = (Number(currentCandle.buy) || 0) + buy;
  currentCandle.sell = (Number(currentCandle.sell) || 0) + sell;

  const footprint = updateLiveFootprint(
    minuteTs,
    msg.footprint,
    msg.footprint_tick_size
  );
  if (footprint) {
    // Footprint prices are rounded to display buckets (for BTC this can be
    // $50), so they must not expand candle OHLC beyond the actual live prices.
    currentCandle.footprint = footprint;
    storeFootprintCandle(currentCandle);
  }
  storeLiveCandle(currentCandle);
  if (notifyChart) queueChartCacheWrite();

  if (notifyChart) {
    onBigTradeFlow(msg);
    for (const l of flowListeners) {
      if (l.active) l.onBar({ ...currentCandle });
    }
    for (const sink of volumeDeltaSinks) sink.refresh();
    if (activeChartStyle === FOOTPRINT_CHART_TYPE) syncFootprintVolumeBars(true);
  }
}

function routeFlowBySymbol(msg) {
  if (!msg.symbol || symbolKey(msg.symbol) === symbolKey(CONFIG.symbol)) {
    applyFlowToCandle(msg);
    return;
  }
  const active = { symbol: CONFIG.symbol, bars: historyBars, current: currentCandle, live: liveFootprints, footprints: footprintCandlesByTime };
  cacheActiveChart(false, false);
  const routedSymbol = symbolKey(msg.symbol);
  const cached = chartCache.get(routedSymbol) || { bars: [], current: null, liveFootprints: [], footprints: [] };
  CONFIG.symbol = routedSymbol;
  historyBars = cached.bars || [];
  currentCandle = cached.current?.isLive && isFreshLiveTimestamp(cached.current.time, routedSymbol) ? cached.current : null;
  liveFootprints = new Map([...(cached.liveFootprints || [])].filter(([time]) => isFreshLiveTimestamp(time, routedSymbol)));
  footprintCandlesByTime = new Map([...(cached.footprints || [])].filter(([time]) => isFreshLiveTimestamp(time, routedSymbol)));
  applyFlowToCandle(msg, false);
  cacheActiveChart(false, false);
  queueChartCacheWrite();
  CONFIG.symbol = active.symbol;
  historyBars = active.bars;
  currentCandle = active.current;
  liveFootprints = active.live;
  footprintCandlesByTime = active.footprints;
}

// ── History handler ───────────────────────────────────────────────────
function handleHistory(msg) {
  // console.log("history msg", new Date().toISOString(), msg.symbol, msg.candles?.length);
  if (msg.symbol && symbolKey(msg.symbol) !== symbolKey(CONFIG.symbol)) return;
  const bars = normalizeHistory(msg.candles);
  const liveBar = currentCandle?.isLive && isFreshLiveTimestamp(currentCandle.time) ? currentCandle : null;
  historyBars = bars;
  currentCandle = null;
  const latestHistoryTime = bars.length ? Number(bars[bars.length - 1].time) : -Infinity;
  if (liveBar && liveBar.time >= latestHistoryTime) {
    currentCandle = { ...liveBar };
    const index = historyBars.findIndex(bar => bar.time === liveBar.time);
    if (index >= 0) historyBars[index] = currentCandle;
    else { historyBars.push(currentCandle); historyBars.sort((a, b) => a.time - b.time); }
  }
  historyReadyResolve();
  historyReady = Promise.resolve();
  if (msg.symbol) {
    cacheActiveChart();
    // The first history response for a symbol can be empty while the backend's
    // REST backfill is still running. setMarket() treats an unchanged market as
    // a no-op, so reapplying only the symbol when the backfill arrives leaves
    // the chart displaying the earlier empty load. Changing the requested bar
    // depth forces Vela to reload the provider's now-populated history.
    Promise.resolve(workspace.chart.setMarket({
      symbol: `${providerPrefix}${CONFIG.symbol}`,
      timeframe: CONFIG.timeframe,
      bars: Math.max(1, historyBars.length)
    })).catch(console.warn);
  }
}


// The backend sends full snapshots to new clients, then only changed price levels.
const backendVpLevels = new Map();
function applyBackendVolumeProfile(msg) {
  if (msg.symbol && symbolKey(msg.symbol) !== symbolKey(CONFIG.symbol)) return;
  if (!Array.isArray(msg.levels)) return;
  if (msg.type === "vp_snapshot") backendVpLevels.clear();

  for (const level of msg.levels) {
    const price = Number(level.p);
    if (!Number.isFinite(price)) continue;
    backendVpLevels.set(price, {
      p: price,
      b: Number(level.b) || 0,
      s: Number(level.s) || 0,
      t: Number(level.t) || 0
    });
  }

  const profile = {
    levels: [...backendVpLevels.values()],
    poc: Number(msg.poc) || 0,
    vah: Number(msg.vah) || 0,
    val: Number(msg.val) || 0,
    step: Number(msg.step) > 0 ? Number(msg.step) : 0.01
  };
  publishBackendVolumeProfile(profile);
}

function applyDepthSnapshot(msg) {
  // msg.symbol and  config.symbol not same ever
  // app.js:1631 NSE:RELIANCE-EQ
  // NSE:10100000002885

  // if (msg.symbol && symbolKey(msg.symbol) !== symbolKey(CONFIG.symbol)) return;
  const validLevels = levels => (Array.isArray(levels) ? levels : []).filter(level =>
    Number.isFinite(Number(level.price)) && Number(level.price) > 0 &&
    Number.isFinite(Number(level.qty)) && Number(level.qty) > 0
  );
  publishOrderBook({ bids: validLevels(msg.bids), asks: validLevels(msg.asks), updatedAt: Date.now() });
  window.lastDepthBook = msg;
}

function clearOrderBook() {
  window.lastDepthBook = null;
  if (!orderBookData.updatedAt && !orderBookData.bids.length && !orderBookData.asks.length) return;
  publishOrderBook({ bids: [], asks: [], updatedAt: 0 });
}

setInterval(() => {
  if (orderBookData.updatedAt && Date.now() - orderBookData.updatedAt > BOOK_STALE_MS) clearOrderBook();
}, 1000);

// ── WebSocket backend ─────────────────────────────────────────────────
function connectBackend() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}${CONFIG.websocketPath}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "depth_request" }));
    ws.send(JSON.stringify({ type: "select_symbol", symbol: CONFIG.symbol, request_id: chartRequestId }));
    ws.send(JSON.stringify({ type: "options_request", symbol: CONFIG.symbol }));
  };
  ws.onclose = () => {
    clearOrderBook();
    setTimeout(connectBackend, CONFIG.reconnectMs);
  };
  ws.onerror = () => {
    clearOrderBook();
  };
  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === "history") handleHistory(msg);
    else if (msg.type === "flow") routeFlowBySymbol(msg);
    else if (msg.type === "vp" || msg.type === "vp_snapshot") applyBackendVolumeProfile(msg);
    else if (msg.type === "depth") applyDepthSnapshot(msg);
    else if (msg.type === "options_gex") {
      if (msg.symbol && symbolKey(msg.symbol) !== symbolKey(CONFIG.symbol)) return;
      publishOptionsWalls(msg);
      publishGexHeatmap(msg); 
      publishOiProfile(msg);
     

    }
    else if (msg.type === "tbt_proto") {
      const feeds = msg.payload?.feeds || {};
      const feed = Object.entries(feeds).find(([symbol]) => symbolKey(symbol) === symbolKey(CONFIG.symbol))?.[1];
      if (!feed) return;
      window.lastFyersTbt = msg.payload;
    }
  };
}

// ── Public API ────────────────────────────────────────────────────────
window.tradingChart = {
  workspace,
  // Historical bars intentionally have no footprint because history is OHLCV-only.
  // Live bars expose dense tick-grid levels for custom footprint indicators.
  getCandles: () => historyBars.map(bar => ({ ...bar })),
  getFootprint: candleTime => {
    const time = Number(candleTime);
    return historyBars.find(bar => bar.time === time)?.footprint ?? null;
  }
};

// ── Kick off ──────────────────────────────────────────────────────────
connectBackend();


