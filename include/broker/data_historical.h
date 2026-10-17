#pragma once

#include <string>
#include <winsock2.h>
#include <windows.h>

// Broker-neutral history entry points. The selected broker implementation is
// chosen by TRADING_BROKER_NAME in config.h; keep names stable for engine callers.
bool httpGetHistory(const std::string& symbol, std::string& response, DWORD& outStatus);
bool parseHistory(const std::string& symbol, const std::string& json, DWORD httpStatus);
