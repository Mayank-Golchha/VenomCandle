#pragma once

// ============================================================
// Fyers live feed adapter. Converts provider messages into shared Tick values.
// ============================================================

#include "fyers_data_ws.h"
#include <string>

// Fyers SDK callbacks
void onMessage(fyers_data_ws_t* ws, const char* json);
void onError(fyers_data_ws_t* ws, int code, const char* message);
void onConnect(fyers_data_ws_t* ws);
void onClose(fyers_data_ws_t* ws, const char* reason);
namespace providers::fyers {
void requestSymbolSubscription(const std::string& symbol);
}
