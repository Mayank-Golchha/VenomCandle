#pragma once

#include <string>

// Broker-neutral live market data entry points.
void requestSymbolSubscription(const std::string& symbol);
void runBrokerMarketData();
