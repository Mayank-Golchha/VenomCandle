#include "broker/data_live.h"
#include "broker/limit_order.h"

#ifdef TRADING_BROKER_COINBASE
#include "broker_adapters/coinbase/data_live.h"
#include "broker_adapters/coinbase/limit_order.h"
namespace selected_provider = providers::coinbase;
#else
#include "broker_adapters/fyers/data_live.h"
#include "broker_adapters/fyers/limit_order_adapter.h"
namespace selected_provider = providers::fyers;
#endif

void requestSymbolSubscription(const std::string& symbol)
{
    selected_provider::requestSymbolSubscription(symbol);
}

void runBrokerMarketData()
{
    selected_provider::runMarketData();
}

void selectDepthSymbol(const std::string& symbol)
{
    selected_provider::selectDepthSymbol(symbol);
}

std::string latestDepthSnapshot(const std::string& symbol)
{
    return selected_provider::latestDepthSnapshot(symbol);
}
