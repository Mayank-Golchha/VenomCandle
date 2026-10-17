#pragma once

#include <string>

namespace providers::coinbase {
void requestSymbolSubscription(const std::string& symbol);
void runMarketData();
}

namespace providers::coinbase::detail {
void selectDepthSymbol(const std::string& symbol);
std::string latestDepthSnapshot(const std::string& symbol);
}
