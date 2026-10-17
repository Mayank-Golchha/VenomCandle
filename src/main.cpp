// ============================================================
// MAIN.CPP — TradingEngine Orchestrator
// ============================================================
//
// This is the entry point that wires together:
//   - Historical candle fetch  (data_historical.h)
//   - Live tick feed           (data_live.h)
//   - Tick processing + flow   (tick_processor.h)
//   - Volume Profile engine    (volume_profile.h)
//   - Browser HTTP/WS server   (server.h)

#include "config.h"
#include "broker/data_historical.h"
#include "broker/provider.h"
#include "server.h"
#include "volume_profile.h"
#include "broker/limit_order.h"
#include "broker/options_chain.h"

#include <cstdio>
#include <thread>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "winhttp.lib")

// ============================================================
// GLOBAL STATE DEFINITION
// ============================================================

State g_state;

// ============================================================
// MAIN
// ============================================================

int main()
{
    std::printf("=== TradingEngine ===\n");
    std::printf("Symbol: %s\n", DEFAULT_SYMBOL);
    std::printf("Aggregation: %d ms\n", AGGREGATION_MS);

    WSADATA wsa{};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::fprintf(stderr, "WSAStartup failed.\n");
        return 1;
    }

    // 1. Get the session's 1-minute history before live flow starts.
    std::string historyJson;
    DWORD historyStatus = 0;
    if (httpGetHistory(DEFAULT_SYMBOL, historyJson, historyStatus)) {
        if (!parseHistory(DEFAULT_SYMBOL, historyJson, historyStatus)) {
            std::fprintf(stderr, "[HISTORY] Chart will start empty and only fill in as live "
                                  "ticks arrive, until this is resolved.\n");
        }
    } else {
        std::fprintf(stderr, "[HISTORY] HTTP request itself failed (see WinHTTP error above). "
                              "Check network and provider availability.\n");
    }

    // 2. Refresh the NSE symbol list for providers that use the NSE catalog.
#ifndef TRADING_BROKER_COINBASE
    if (!prepareSymbolCatalog())
        std::fprintf(stderr, "[SYMBOLS] NSE list unavailable; symbol search will be empty until it can be fetched.\n");
#endif

    // 2b. Start options GEX polling (NIFTY50, refreshes every 5 minutes).
    startOptionsChainPolling(300);

    // 3. Start browser HTTP/WebSocket server.
    std::thread(browserServer).detach();

    std::printf("[READY] Open http://localhost:%d\n", HTTP_PORT);
    std::printf("[READY] Waiting for broker market data...\n");
    std::printf("[VP] Volume Profile engine active (PRICE_SCALE=%lld, broadcast every %d ms)\n",
                (long long)PRICE_SCALE, VP_BROADCAST_MS);

    runBrokerMarketData();

    g_state.running.store(false);

    WSACleanup();
    return 0;
}
