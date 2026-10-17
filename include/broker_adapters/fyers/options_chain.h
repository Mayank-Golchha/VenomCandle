#pragma once

// ============================================================
// OPTIONS_CHAIN.H — Fyers Options Chain GEX Engine
// ============================================================
// Fetches the NIFTY50 (or any NSE index/stock) options chain,
// computes GEX-based Call Wall and Put Wall across all expiries
// (or the first 3 for stocks), and broadcasts the result to all
// connected WebSocket clients as a JSON "options_gex" message.
//
// GEX formula used:
//   gex = gamma × OI × lot_size × spot² × 0.01
//
// Call Wall = argmax_{K > spot} Σ gex_CE(K)   (across expiries)
// Put  Wall = argmax_{K < spot} Σ gex_PE(K)
// ============================================================

#include <string>

namespace providers::fyers {

// Start the periodic options-chain polling loop.
// Runs in its own detached thread; calls broadcast() internally.
// pollIntervalSeconds: how often to re-fetch (0 = fetch once and stop).
void startOptionsChainLoop(int pollIntervalSeconds = 300);

// Fetch, compute, and broadcast a single options GEX snapshot right now.
// Thread-safe; can be called from the server WS handler.
void fetchAndBroadcastOptionsGex();

// Fetch a snapshot for the explicitly selected symbol.
void fetchAndBroadcastOptionsGex(const std::string& symbol);

} // namespace providers::fyers
