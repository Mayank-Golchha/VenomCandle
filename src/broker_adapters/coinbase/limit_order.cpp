#include "broker/limit_order.h"
#include "broker_adapters/coinbase/data_live.h"
#include "broker_adapters/coinbase/limit_order.h"

// Coinbase's public level-2 feed provides depth snapshots; it does not place
// orders. These functions adapt that public book to the engine's depth facade.
namespace providers::coinbase {
void selectDepthSymbol(const std::string& symbol)
{
    detail::selectDepthSymbol(symbol);
}

std::string latestDepthSnapshot(const std::string& symbol)
{
    return detail::latestDepthSnapshot(symbol);
}
} // namespace providers::coinbase
