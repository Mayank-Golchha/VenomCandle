#include "broker/data_live.h"
#include "broker/limit_order.h"
#include "broker_adapters/coinbase/data_live.h"
#include "config.h"
#include "core/json_parser.h"
#include "server.h"
#include "tick_processor.h"

#include <libwebsockets.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <functional>
#include <iomanip>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace providers::coinbase {
namespace {
using BookSide = std::map<double, double, std::greater<double>>;
struct ProductBook { BookSide bids; std::map<double, double> asks; double ltp = 0.0; };
std::mutex g_mutex;
std::set<std::string> g_subscriptions;
std::deque<std::string> g_outbound;
std::map<std::string, ProductBook> g_books;
std::map<std::string, std::string> g_snapshots;
lws_context* g_context = nullptr;
lws* g_socket = nullptr;
std::string g_activeDepthSymbol;

std::string productId(std::string symbol)
{
    if (symbol.rfind("COINBASE:", 0) == 0) symbol.erase(0, 9);
    return symbol;
}

bool stringField(const std::string& json, const char* key, std::string& value)
{
    size_t pos = 0;
    return getString(json.c_str(), json.size(), key, pos, value);
}

bool field(const std::string& json, const char* key, std::string& value)
{
    return stringField(json, key, value);
}

std::vector<std::string> arrayObjects(const std::string& json, const char* key)
{
    std::vector<std::string> result;
    const std::string needle = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(needle);
    if (keyPos == std::string::npos) return result;
    const size_t begin = json.find('[', keyPos + needle.size());
    if (begin == std::string::npos) return result;
    bool inString = false;
    bool escaped = false;
    int arrayDepth = 0;
    size_t end = begin;
    for (; end < json.size(); ++end) {
        const char c = json[end];
        if (inString) {
            if (escaped) escaped = false;
            else if (c == '\\') escaped = true;
            else if (c == '"') inString = false;
            continue;
        }
        if (c == '"') inString = true;
        else if (c == '[') ++arrayDepth;
        else if (c == ']' && --arrayDepth == 0) break;
    }
    if (end >= json.size()) return result;
    for (size_t pos = begin + 1; pos < end;) {
        if (json[pos] != '{') { ++pos; continue; }
        const size_t objectBegin = pos;
        int objectDepth = 0;
        inString = false;
        escaped = false;
        for (; pos < end; ++pos) {
            const char c = json[pos];
            if (inString) {
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') inString = true;
            else if (c == '{') ++objectDepth;
            else if (c == '}' && --objectDepth == 0) {
                result.emplace_back(json.substr(objectBegin, pos - objectBegin + 1));
                ++pos;
                break;
            }
        }
    }
    return result;
}

uint64_t parseTimeMs(const std::string& value)
{
    std::tm tm{};
    std::istringstream input(value.substr(0, 19));
    input >> std::get_time(&tm, "%Y-%m-%dT%H:%M:%S");
    if (input.fail()) return static_cast<uint64_t>(std::time(nullptr)) * 1000ULL;
    const std::time_t seconds = _mkgmtime(&tm);
    uint64_t millis = 0;
    const size_t dot = value.find('.');
    if (dot != std::string::npos && dot + 1 < value.size()) {
        int place = 100;
        for (size_t i = dot + 1; i < value.size() && std::isdigit(static_cast<unsigned char>(value[i])) && place; ++i, place /= 10)
            millis += static_cast<uint64_t>(value[i] - '0') * place;
    }
    return static_cast<uint64_t>(seconds) * 1000ULL + millis;
}

std::string depthJson(const std::string& symbol, const ProductBook& book)
{
    std::ostringstream out;
    out << "{\"type\":\"depth\",\"symbol\":\"" << symbol << "\",\"ltp\":" << book.ltp << ",\"tbq\":0,\"tsq\":0,\"bids\":[";
    bool first = true;
    for (const auto& [price, size] : book.bids) {
        if (size <= 0) continue;
        if (!first) out << ','; first = false;
        out << "{\"price\":" << price << ",\"qty\":" << size << ",\"nord\":0}";
    }
    out << "],\"asks\":["; first = true;
    for (const auto& [price, size] : book.asks) {
        if (size <= 0) continue;
        if (!first) out << ','; first = false;
        out << "{\"price\":" << price << ",\"qty\":" << size << ",\"nord\":0}";
    }
    out << "]}";
    return out.str();
}

std::string subscriptionMessage(const std::string& product, const char* channel)
{
    return "{\"type\":\"subscribe\",\"product_ids\":[\"" + product +
           "\"],\"channel\":\"" + channel + "\"}";
}

void processBookEvent(const std::string& event)
{
    std::string eventType, product;
    if (!field(event, "type", eventType) || !field(event, "product_id", product)) return;
    std::string snapshot;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        ProductBook& book = g_books[product];
        if (eventType == "snapshot") { book.bids.clear(); book.asks.clear(); }
        for (const std::string& update : arrayObjects(event, "updates")) {
            std::string side, priceText, quantityText;
            if (!field(update, "side", side) || !field(update, "price_level", priceText) ||
                !field(update, "new_quantity", quantityText)) continue;
            const double price = std::strtod(priceText.c_str(), nullptr);
            const double quantity = std::strtod(quantityText.c_str(), nullptr);
            if (price <= 0) continue;
            if (side == "bid" || side == "buy") {
                if (quantity <= 0) book.bids.erase(price); else book.bids[price] = quantity;
            } else if (side == "ask" || side == "offer" || side == "sell") {
                if (quantity <= 0) book.asks.erase(price); else book.asks[price] = quantity;
            }
        }
        g_snapshots[product] = depthJson(product, book);
        snapshot = g_snapshots[product];
    }
    if (!snapshot.empty()) broadcast(snapshot);
}

void processTickerEvent(const std::string& ticker, const std::string& rootTime)
{
    std::string product, priceText, timeText, bidText, askText;
    if (!field(ticker, "product_id", product) || !field(ticker, "price", priceText)) return;
    field(ticker, "time", timeText);
    if (timeText.empty()) timeText = rootTime;
    Tick tick{};
    tick.symbol = product;
    tick.ltp = std::strtod(priceText.c_str(), nullptr);
    tick.time = timeText.empty() ? static_cast<uint64_t>(std::time(nullptr)) * 1000ULL : parseTimeMs(timeText);
    tick.hasCumulativeVolume = false;
    field(ticker, "best_bid", bidText);
    field(ticker, "best_ask", askText);
    tick.bid = std::strtod(bidText.c_str(), nullptr);
    tick.ask = std::strtod(askText.c_str(), nullptr);
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        ProductBook& book = g_books[product];
        book.ltp = tick.ltp;
        g_snapshots[product] = depthJson(product, book);
    }
    processTick(tick); // quote-only updates have zero quantity; trades come from market_trades.
}

void processTrade(const std::string& trade, const std::string& rootTime)
{
    std::string product, priceText, sizeText, timeText;
    if (!field(trade, "product_id", product) || !field(trade, "price", priceText) ||
        !field(trade, "size", sizeText)) return;
    field(trade, "time", timeText);
    if (timeText.empty()) timeText = rootTime;
    Tick tick{};
    tick.symbol = product;
    tick.ltp = std::strtod(priceText.c_str(), nullptr);
    tick.qty = (std::max)(0.0, std::strtod(sizeText.c_str(), nullptr));
    tick.time = timeText.empty() ? static_cast<uint64_t>(std::time(nullptr)) * 1000ULL : parseTimeMs(timeText);
    tick.hasCumulativeVolume = false;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        const auto found = g_books.find(product);
        if (found != g_books.end()) {
            if (!found->second.bids.empty()) tick.bid = found->second.bids.begin()->first;
            if (!found->second.asks.empty()) tick.ask = found->second.asks.begin()->first;
        }
        g_books[product].ltp = tick.ltp;
    }
    processTick(tick);
}

void processMessage(const std::string& json)
{
    std::string channel, rootTime;
    if (!field(json, "channel", channel)) {
        std::string type;
        if (field(json, "type", type) && (type == "error" || type == "subscriptions"))
            std::fprintf(stderr, "[COINBASE] WebSocket %s: %.400s\n", type.c_str(), json.c_str());
        return;
    }
    field(json, "timestamp", rootTime);
    const auto events = arrayObjects(json, "events");
    if (channel == "l2_data") {
        for (const auto& event : events) processBookEvent(event);
    } else if (channel == "ticker") {
        for (const auto& event : events)
            for (const auto& ticker : arrayObjects(event, "tickers")) processTickerEvent(ticker, rootTime);
    } else if (channel == "market_trades") {
        for (const auto& event : events)
            for (const auto& trade : arrayObjects(event, "trades")) processTrade(trade, rootTime);
    } else if (channel == "subscriptions") {
        std::printf("[COINBASE] Public WebSocket subscriptions acknowledged.\n");
    }
}

int callback(lws* socket, lws_callback_reasons reason, void* user, void* in, size_t len)
{
    (void)user;
    switch (reason) {
    case LWS_CALLBACK_CLIENT_ESTABLISHED:
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_socket = socket;
            if (g_subscriptions.empty()) g_subscriptions.insert(productId(DEFAULT_SYMBOL));
            for (const auto& product : g_subscriptions) {
                g_outbound.push_back(subscriptionMessage(product, "level2"));
                g_outbound.push_back(subscriptionMessage(product, "ticker"));
                g_outbound.push_back(subscriptionMessage(product, "market_trades"));
            }
            g_outbound.push_back("{\"type\":\"subscribe\",\"channel\":\"heartbeats\"}");
        }
        lws_callback_on_writable(socket);
        break;
    case LWS_CALLBACK_EVENT_WAIT_CANCELLED:
        if (g_socket) lws_callback_on_writable(g_socket);
        break;
    case LWS_CALLBACK_CLIENT_WRITEABLE: {
        std::string message;
        { std::lock_guard<std::mutex> lock(g_mutex); if (!g_outbound.empty()) { message = std::move(g_outbound.front()); g_outbound.pop_front(); } }
        if (!message.empty()) {
            std::vector<unsigned char> data(LWS_PRE + message.size());
            std::copy(message.begin(), message.end(), data.begin() + LWS_PRE);
            lws_write(socket, data.data() + LWS_PRE, message.size(), LWS_WRITE_TEXT);
            std::lock_guard<std::mutex> lock(g_mutex);
            if (!g_outbound.empty()) lws_callback_on_writable(socket);
        }
        break;
    }
    case LWS_CALLBACK_CLIENT_RECEIVE:
        processMessage(std::string(static_cast<const char*>(in), len));
        break;
    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
        std::fprintf(stderr, "[COINBASE] WebSocket connection error: %s\n", in ? static_cast<const char*>(in) : "unknown");
        g_socket = nullptr;
        break;
    case LWS_CALLBACK_CLIENT_CLOSED:
        g_socket = nullptr;
        break;
    default: break;
    }
    return 0;
}

const lws_protocols protocols[] = {{"coinbase-public", callback, 0, 65536, 0, nullptr, 0}, {nullptr, nullptr, 0, 0, 0, nullptr, 0}};
}

void requestSymbolSubscription(const std::string& rawSymbol)
{
    const std::string symbol = productId(rawSymbol);
    if (symbol.empty()) return;
    lws_context* context = nullptr;
    lws* socket = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        if (!g_subscriptions.insert(symbol).second) return;
        socket = g_socket;
        if (socket) {
            g_outbound.push_back(subscriptionMessage(symbol, "level2"));
            g_outbound.push_back(subscriptionMessage(symbol, "ticker"));
            g_outbound.push_back(subscriptionMessage(symbol, "market_trades"));
        }
        context = g_context;
    }
    if (socket) lws_cancel_service(context);
}

void runMarketData()
{
    lws_context_creation_info info{};
    info.port = CONTEXT_PORT_NO_LISTEN;
    info.protocols = protocols;
    info.options = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;
    info.gid = -1; info.uid = -1;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_context = lws_create_context(&info);
    }
    if (!g_context) { std::fprintf(stderr, "[COINBASE] Could not create WebSocket context.\n"); g_state.running.store(false); return; }
    lws_client_connect_info connection{};
    connection.context = g_context;
    connection.address = "advanced-trade-ws.coinbase.com";
    connection.port = 443; connection.path = "/";
    connection.host = connection.address; connection.origin = connection.address;
    connection.protocol = nullptr; connection.ssl_connection = LCCSCF_USE_SSL;
    if (!lws_client_connect_via_info(&connection)) {
        std::fprintf(stderr, "[COINBASE] Could not start public market-data connection.\n");
        lws_context_destroy(g_context); g_context = nullptr; g_state.running.store(false); return;
    }
    std::printf("[COINBASE] Connected to Advanced Trade public market data (no API key required).\n");
    while (g_state.running.load()) lws_service(g_context, 100);
    lws_context_destroy(g_context);
    { std::lock_guard<std::mutex> lock(g_mutex); g_context = nullptr; g_socket = nullptr; }
}

void detail::selectDepthSymbol(const std::string& symbol)
{
    const std::string product = productId(symbol);
    { std::lock_guard<std::mutex> lock(g_mutex); g_activeDepthSymbol = product; }
    requestSymbolSubscription(product);
}

std::string detail::latestDepthSnapshot(const std::string& symbol)
{
    const std::string product = productId(symbol);
    std::lock_guard<std::mutex> lock(g_mutex);
    const auto it = g_snapshots.find(product);
    return it == g_snapshots.end() ? std::string{} : it->second;
}
} // namespace providers::coinbase

