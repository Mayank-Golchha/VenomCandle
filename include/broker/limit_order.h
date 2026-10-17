#pragma once

#include <string>

// Broker-neutral depth feed facade used by the browser server.
void selectDepthSymbol(const std::string& symbol);
std::string latestDepthSnapshot(const std::string& symbol);
