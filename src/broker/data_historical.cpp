#include "broker/data_historical.h"

#ifdef TRADING_BROKER_COINBASE
#include "broker_adapters/coinbase/data_historical.h"
#else
#include "broker_adapters/fyers/data_historical.h"
#endif

bool httpGetHistory(const std::string& symbol, std::string& response, DWORD& outStatus)
{
#ifdef TRADING_BROKER_COINBASE
    return providers::coinbase::httpGetHistory(symbol, response, outStatus);
#else
    return providers::fyers::httpGetHistory(symbol, response, outStatus);
#endif
}

bool parseHistory(const std::string& symbol, const std::string& json, DWORD httpStatus)
{
#ifdef TRADING_BROKER_COINBASE
    return providers::coinbase::parseHistory(symbol, json, httpStatus);
#else
    return providers::fyers::parseHistory(symbol, json, httpStatus);
#endif
}
