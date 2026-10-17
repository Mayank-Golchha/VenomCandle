# Backend and broker selection

Shared engine code calls stable entry points under `include/broker/`:

- `data_historical.h` exposes `httpGetHistory` and `parseHistory`.
- `data_live.h` exposes `requestSymbolSubscription` and `runBrokerMarketData`.
- `limit_order.h` exposes the browser-facing depth snapshot functions.

`src/broker/` dispatches those calls to the provider selected by `TRADING_BROKER_NAME` in `include/config.h`. Set it to `"FYERS"` or `"COINBASE"`, then reconfigure/build; CMake reads the setting and includes that provider's adapter and schema. Provider implementations, wire-format parsing, credentials, and schemas belong under `broker_adapters/<name>/` and `proto/broker_schemas/<name>/`. Shared engine processing remains under `src/` and `include/`.

Coinbase support targets public spot market data and needs no API key. To use it, configure the Coinbase build and use Coinbase product IDs such as `BTC-USD`; the build sets that as the default symbol. Shared volume fields retain fractional trade sizes. History uses Coinbase Exchange REST; live ticker, trades, and level-2 depth use the Advanced Trade WebSocket JSON feed. `proto/broker_schemas/coinbase/coinbase_market_data.proto` is a project-owned normalized protobuf schema, not a schema published or used by Coinbase.

The shared JSON field readers are in `include/core/json_parser.h`. Broker-specific field names and interpretation stay inside each provider adapter.

Official Coinbase references:

- [Exchange WebSocket overview](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview)
- [Exchange WebSocket channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)
- [Exchange product candles endpoint](https://docs.cdp.coinbase.com/exchange/rest-api/products/get-product-candles)
