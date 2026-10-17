#pragma once

#include <string>

// ============================================================
// BROKER/OPTIONS_CHAIN.H — Broker-neutral options GEX facade
// ============================================================
// Keep names stable here; callers (server.cpp, main.cpp) never
// include any broker-adapter headers directly.

// Start the periodic options-chain polling loop (detached thread).
// pollIntervalSeconds: how often to re-fetch. 0 = fetch once and exit.
void startOptionsChainPolling(int pollIntervalSeconds = 300);

// Fetch + compute + broadcast one options GEX snapshot right now.
// Thread-safe; safe to call from the WS message handler.
void fetchAndBroadcastOptionsGex();

// Fetch a snapshot for the explicitly selected symbol.
void fetchAndBroadcastOptionsGex(const std::string& symbol);
