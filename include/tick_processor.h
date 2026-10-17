#pragma once

// ============================================================
// TICK_PROCESSOR.H — Aggressor classification + flow aggregation
// ============================================================

#include "config.h"

// Classify a trade as Buy, Sell, or Other based on LTP vs bid/ask.
Side classifyTrade(const Tick& tick, const Tick& previous);

// Process a single tick: classify, aggregate into flow buckets,
// broadcast completed buckets, and feed the Volume Profile engine.
void processTick(const Tick& tick);
