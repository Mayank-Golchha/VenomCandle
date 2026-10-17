#pragma once

#include <string>

namespace providers::coinbase {
void selectDepthSymbol(const std::string& symbol);
std::string latestDepthSnapshot(const std::string& symbol);
}
