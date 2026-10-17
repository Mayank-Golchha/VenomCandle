export const FOOTPRINT_PRICE_SCALE = 100;

export const FOOTPRINT_SERIES = new Set([
  "DELTA", "BUY", "SELL", "OTHER", "READY", "TICK",
  "BUY_IMBALANCE_PRICE", "BUY_IMBALANCE_RATIO",
  "SELL_IMBALANCE_PRICE", "SELL_IMBALANCE_RATIO"
]);
export const FOOTPRINT_SYMBOL_SUFFIXES = [
  ...[...FOOTPRINT_SERIES].map(series => `.FP_${series}`)
];

export function parseFootprintSeries(symbol) {
  const ticker = String(symbol || "");
  const atPrice = ticker.match(/\.FP_(BUY|SELL|OTHER)_AT_(\d+)$/i);
  if (atPrice) return { base: ticker.slice(0, -atPrice[0].length), series: `${atPrice[1].toUpperCase()}_AT`, priceKey: Number(atPrice[2]) };
  const match = ticker.match(/\.FP_([A-Z_]+)$/i);
  if (!match) return null;
  const series = match[1].toUpperCase();
  return FOOTPRINT_SERIES.has(series) ? { base: ticker.slice(0, -match[0].length), series } : null;
}

export function getFootprintMetrics(bar) {
  const fp = bar?.footprint;
  const levels = Array.isArray(fp?.levels) ? fp.levels : [];
  if (!levels.length) return null;
  const buy = levels.reduce((sum, level) => sum + (Number(level.buy) || 0), 0);
  const sell = levels.reduce((sum, level) => sum + (Number(level.sell) || 0), 0);
  const other = levels.reduce((sum, level) => sum + (Number(level.other) || 0), 0);
  let buyImbalance = { price: 0, ratio: 0 };
  let sellImbalance = { price: 0, ratio: 0 };
  const step = Number(fp.tickSize) || 0;
  if (step > 0) {
    const byPrice = new Map(levels.map(level => [Math.round(Number(level.price) * FOOTPRINT_PRICE_SCALE), level]));
    const stepKeys = Math.max(1, Math.round(step * FOOTPRINT_PRICE_SCALE));
    for (const level of levels) {
      const key = Math.round(Number(level.price) * FOOTPRINT_PRICE_SCALE);
      const lower = byPrice.get(key - stepKeys);
      const upper = byPrice.get(key + stepKeys);
      const buyQty = Number(level.buy) || 0;
      const sellQty = Number(level.sell) || 0;
      const buyRatio = buyQty > 0 ? buyQty / Math.max(1, Number(lower?.sell) || 0) : 0;
      const sellRatio = sellQty > 0 ? sellQty / Math.max(1, Number(upper?.buy) || 0) : 0;
      if (buyRatio > buyImbalance.ratio) buyImbalance = { price: Number(level.price), ratio: Math.min(buyRatio, 999) };
      if (sellRatio > sellImbalance.ratio) sellImbalance = { price: Number(level.price), ratio: Math.min(sellRatio, 999) };
    }
  }
  return {
    DELTA: buy - sell, BUY: buy, SELL: sell, OTHER: other, READY: 1, TICK: step,
    BUY_IMBALANCE_PRICE: buyImbalance.price, BUY_IMBALANCE_RATIO: buyImbalance.ratio,
    SELL_IMBALANCE_PRICE: sellImbalance.price, SELL_IMBALANCE_RATIO: sellImbalance.ratio
  };
}

export function asFootprintSeriesBar(bar, request) {
  const metrics = getFootprintMetrics(bar);
  let value = request.series === "READY" ? (metrics ? 1 : 0) : (metrics?.[request.series] ?? 0);
  if (request.priceKey != null) {
    const level = bar?.footprint?.levels?.find(item => Math.round(Number(item.price) * FOOTPRINT_PRICE_SCALE) === request.priceKey);
    value = metrics && level ? Number(level[request.series.slice(0, -3).toLowerCase()]) || 0 : 0;
  }
  return { time: bar.time, open: value, high: value, low: value, close: value, volume: metrics ? metrics.BUY + metrics.SELL + metrics.OTHER : 0 };
}





// Per-candle volume profile: rows sorted by price, POC and value area.
const profileCache = new WeakMap();

export function getCandleProfile(footprint, valueAreaFraction = 0.7) {
  const levels = footprint?.levels;
  if (!Array.isArray(levels) || !levels.length) return null;

  const cached = profileCache.get(levels)?.get(valueAreaFraction);
  if (cached) return cached;

  const rows = levels
    .map(l => {
      const buy = Number(l.buy) || 0, sell = Number(l.sell) || 0, other = Number(l.other) || 0;
      return { price: Number(l.price), buy, sell, other, total: buy + sell + other };
    })
    .filter(r => Number.isFinite(r.price))
    .sort((a, b) => a.price - b.price);
  if (!rows.length) return null;

  let pocIdx = 0, sum = 0;
  rows.forEach((r, i) => {
    sum += r.total;
    if (r.total > rows[pocIdx].total) pocIdx = i;
  });
  if (sum <= 0) return null;

  // Expand outward from the POC, always taking the larger neighbour,
  // until the value-area fraction of total volume is covered.
  let lo = pocIdx, hi = pocIdx, acc = rows[pocIdx].total;
  while (acc < sum * valueAreaFraction && (lo > 0 || hi < rows.length - 1)) {
    const below = lo > 0 ? rows[lo - 1].total : -1;
    const above = hi < rows.length - 1 ? rows[hi + 1].total : -1;
    if (above >= below) { hi++; acc += rows[hi].total; }
    else { lo--; acc += rows[lo].total; }
  }

  const result = { rows, pocIdx, vaLow: lo, vaHigh: hi, maxTotal: rows[pocIdx].total, sum };
  let byFraction = profileCache.get(levels);
  if (!byFraction) profileCache.set(levels, byFraction = new Map());
  byFraction.set(valueAreaFraction, result);
  return result;
}
