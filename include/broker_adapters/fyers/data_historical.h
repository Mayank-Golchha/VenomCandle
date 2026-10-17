#pragma once

// ============================================================
// Fyers REST adapter for the shared candle history contract.
// ============================================================

#include <string>
#include <winsock2.h>
#include <windows.h>

// Fetch today's 1-min candles via Fyers History API (WinHTTP).
// Returns true if the HTTP transport succeeded (response body is in `response`).
// `outStatus` receives the HTTP status code (0 if no response at all).
namespace providers::fyers {
bool httpGetHistory(const std::string& symbol, std::string& response, DWORD& outStatus);

// Parse the JSON response into g_state.candles.
// Returns true only if actual candles were parsed.
bool parseHistory(const std::string& symbol, const std::string& json, DWORD httpStatus);
}
