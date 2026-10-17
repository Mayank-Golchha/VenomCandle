// ============================================================
// BROKER/OPTIONS_CHAIN.CPP — Dispatch shim (mirrors market_data.cpp)
// ============================================================
// server.cpp and main.cpp only ever include broker/options_chain.h.
// The broker-specific implementation is pulled in here and nowhere else.

#include "broker/options_chain.h"

#ifdef TRADING_BROKER_COINBASE
// Coinbase has no options chain — stubs only.
void startOptionsChainPolling(int /*pollIntervalSeconds*/) {}
void fetchAndBroadcastOptionsGex() {}
void fetchAndBroadcastOptionsGex(const std::string& /*symbol*/) {}
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
