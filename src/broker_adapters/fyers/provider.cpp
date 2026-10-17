#include "broker/limit_order.h"
#include "broker_adapters/fyers/config.h"
#include "broker_adapters/fyers/data_live.h"
#include "broker_adapters/fyers/limit_order.h"
#include "broker_adapters/fyers/limit_order_adapter.h"
#include "config.h"

#include "fyers_data_ws.h"

#include <cstdio>
#include <thread>

namespace {
fyers_data_ws_t* g_fyers = nullptr;
}

namespace providers::fyers {
void runMarketData()
{
    fyers_init();
    g_fyers = fyers_data_ws_create(fyersAccessToken().c_str(), false, nullptr, false, true,
                                   onMessage, onError, onConnect, onClose, 5);
    if (!g_fyers) {
        std::fprintf(stderr, "Failed to create Fyers WebSocket.\n");
        g_state.running.store(false);
        fyers_cleanup();
        return;
    }
    const fyers_error_t err = fyers_data_ws_connect(g_fyers);
    if (err != FYERS_OK) {
        std::fprintf(stderr, "Fyers connect failed: %d\n", err);
        fyers_data_ws_destroy(g_fyers);
        g_fyers = nullptr;
        fyers_cleanup();
        g_state.running.store(false);
        return;
    }

    std::thread depthThread(limitOrderWorker);
    fyers_data_ws_keep_running(g_fyers);
    g_state.running.store(false);
    if (depthThread.joinable()) depthThread.join();
    fyers_data_ws_close(g_fyers);
    fyers_data_ws_destroy(g_fyers);
    g_fyers = nullptr;
    fyers_cleanup();
}

void selectDepthSymbol(const std::string& symbol)
{
    if (FyersTBT* book = g_limitOrderBook.load()) book->selectSymbol(symbol);
}

std::string latestDepthSnapshot(const std::string& symbol)
{
    if (FyersTBT* book = g_limitOrderBook.load()) return book->latestSnapshot(symbol);
    return {};
}
} // namespace providers::fyers
