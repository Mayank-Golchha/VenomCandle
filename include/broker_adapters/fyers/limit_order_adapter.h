#pragma once

#include <string>

namespace providers::fyers {
void runMarketData();
void requestSymbolSubscription(const std::string& symbol);
void selectDepthSymbol(const std::string& symbol);
std::string latestDepthSnapshot(const std::string& symbol);
}
