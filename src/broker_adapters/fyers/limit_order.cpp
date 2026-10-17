// ============================================================
// LIMIT_ORDER.CPP — Fyers TBT depth client (order book handler)
// ============================================================
// Ported from the standalone backend.cpp. Auth header, subscribe/resume
// handshake, ping/pong heartbeat, and incremental protobuf depth parsing
// are byte-for-byte the same logic, same variable names.
//
// What changed structurally: this file no longer runs its own local
// WebSocket server for browsers. broadcast_snapshot() now calls the
// TradingEngine's existing broadcast() (server.cpp) so every depth update
// fans out over the same socket that already carries candle history and
// the volume profile.
//
// Build: link libwebsockets + protobuf + ssl/crypto into the TradingEngine
// executable (previously its own binary), in addition to ws2_32/winhttp.

#include "broker_adapters/fyers/limit_order.h"
#include "broker_adapters/fyers/config.h"
#include "config.h"
#include "server.h"
#include "msg.pb.h"

#include <cstring>
#include <cctype>
#include <iostream>
#include <sstream>
#include <vector>
#include <google/protobuf/util/json_util.h>

namespace {

std::string canonical_symbol(std::string symbol) {
    for (char& c : symbol) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (!symbol.empty() && symbol.find(':') == std::string::npos) symbol = "NSE:" + symbol;
    return symbol;
}

std::string escape_json(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            default:   out += c;      break;
        }
    }
    return out;
}

} // namespace

FyersTBT* FyersTBT::instance_ = nullptr;
std::atomic<FyersTBT*> g_limitOrderBook{nullptr};

FyersTBT::FyersTBT(const std::string& app_id, const std::string& access_token, const std::string& symbol)
    : app_id_(app_id), access_token_(access_token), symbol_(canonical_symbol(symbol)), requestedSymbol_(canonical_symbol(symbol)) {}

void FyersTBT::selectSymbol(const std::string& symbol) {
    const std::string normalized = canonical_symbol(symbol);
    {
        std::lock_guard<std::mutex> lock(symbolMutex_);
        if (requestedSymbol_ == normalized) return;
        requestedSymbol_ = normalized;
    }
    if (lws_context* context = context_.load()) lws_cancel_service(context);
}

std::string FyersTBT::latestSnapshot(const std::string& symbol) const {
    std::lock_guard<std::mutex> lock(jsonMutex_);
    const auto it = latestJsonBySymbol_.find(canonical_symbol(symbol));
    return it == latestJsonBySymbol_.end() ? std::string{} : it->second;
}

// ================= Fyers (outbound) side =================

void FyersTBT::send_text(lws* wsi, const std::string& message) {
    std::vector<unsigned char> buffer(LWS_PRE + message.size());
    std::memcpy(buffer.data() + LWS_PRE, message.data(), message.size());

    int written = lws_write(
        wsi,
        buffer.data() + LWS_PRE,
        message.size(),
        LWS_WRITE_TEXT
    );

    if (message == "ping") {
        std::cout << "[Heartbeat] PING sent\n";
    } else {
        std::cout << "TX [" << written << "/" << message.size() << "]: " << message << '\n';
    }

    if (written < 0 || static_cast<size_t>(written) != message.size()) {
        std::cerr << "lws_write failed\n";
        running_ = false;
    }
}

// Merge one repeated field of DepthLevel entries into a book map,
// honoring per-field presence so partial/incremental updates never
// clobber values with zero.
template <typename Repeated>
void FyersTBT::merge_levels(std::map<int64_t, BookLevel>& book, const Repeated& levels) {
    for (const auto& lvl : levels) {
        if (!lvl.has_num()) continue; // can't place this level without an index
        int64_t num = lvl.num().value();
        BookLevel& entry = book[num];
        if (lvl.has_price()) entry.price = lvl.price().value() / 100.0;
        if (lvl.has_qty())   entry.qty   = lvl.qty().value();
        if (lvl.has_nord())  entry.nord  = lvl.nord().value();
        entry.seen = true;
    }
}

std::string FyersTBT::build_depth_json(const std::string& symbol, const DepthBook& book) const {
    std::ostringstream os;
    os << "{";
    os << "\"type\":\"depth\","; // new: lets the browser tell this apart from "history"/VP messages on the same socket
    os << "\"symbol\":\"" << escape_json(symbol) << "\",";
    os << "\"tbq\":" << book.tbq << ",";
    os << "\"tsq\":" << book.tsq;
    if (book.hasLtp) os << ",\"ltp\":" << book.ltp;

    os << ",\"bids\":[";
    bool first = true;
    for (const auto& [num, lvl] : book.bids) {
        if (!lvl.seen || lvl.price <= 0 || lvl.qty <= 0) continue;
        if (!first) os << ",";
        first = false;
        os << "{\"num\":" << num
           << ",\"price\":" << lvl.price
           << ",\"qty\":" << lvl.qty
           << ",\"nord\":" << lvl.nord << "}";
    }
    os << "],";

    os << "\"asks\":[";
    first = true;
    for (const auto& [num, lvl] : book.asks) {
        if (!lvl.seen || lvl.price <= 0 || lvl.qty <= 0) continue;
        if (!first) os << ",";
        first = false;
        os << "{\"num\":" << num
           << ",\"price\":" << lvl.price
           << ",\"qty\":" << lvl.qty
           << ",\"nord\":" << lvl.nord << "}";
    }
    os << "]}";
    return os.str();
}

// Push the current book state to every connected browser tab via
// server.cpp's broadcast(), same fan-out the volume profile and candle
// history already use.
void FyersTBT::broadcast_snapshot(const std::string& symbol, const DepthBook& book) {
    const std::string json = build_depth_json(symbol, book);
    {
        std::lock_guard<std::mutex> lock(jsonMutex_);
        latestJsonBySymbol_[symbol] = json;
    }
    broadcast(json);
}

void FyersTBT::process_message(const void* data, size_t len) {
    SocketMessage message;

    if (!message.ParseFromArray(data, static_cast<int>(len))) {
        std::cerr << "Protobuf parse FAILED. Bytes: " << len << '\n';
        return;
    }

    // Forward every schema field to browser consumers, including quote,
    // extended/daily quote, OHLCV, depth, timestamps, and symbol metadata.
    std::string protoJson;
    const auto jsonStatus = google::protobuf::util::MessageToJsonString(message, &protoJson);
    if (jsonStatus.ok())
        broadcast("{\"type\":\"tbt_proto\",\"payload\":" + protoJson + "}");

    if (message.error()) {
        std::cerr << "FYERS TBT ERROR: " << message.msg() << '\n';
        return;
    }

    for (const auto& entry : message.feeds()) {
        const std::string symbol = canonical_symbol(entry.first);
        const MarketFeed& feed = entry.second;
        DepthBook& book = booksBySymbol_[symbol];

        if (message.snapshot() || feed.snapshot()) {
            book.bids.clear();
            book.asks.clear();
            book.tbq = 0;
            book.tsq = 0;
        }

        if (feed.has_quote() && feed.quote().has_ltp()) {
            book.hasLtp = true;
            book.ltp = feed.quote().ltp().value() / 100.0;
        }

        if (!feed.has_depth()) continue;
        const Depth& depth = feed.depth();

        if (depth.has_tbq()) book.tbq = depth.tbq().value();
        if (depth.has_tsq()) book.tsq = depth.tsq().value();

        merge_levels(book.bids, depth.bids());
        merge_levels(book.asks, depth.asks());

        // std::cout << "Depth update for " << symbol
                //    << " | bid levels: " << bid_book_.size()
                //    << " | ask levels: " << ask_book_.size() << '\n';

        broadcast_snapshot(symbol, book);
    }
}

int FyersTBT::handle_callback(lws* wsi, lws_callback_reasons reason, void* user, void* in, size_t len) {
    switch (reason) {

    case LWS_CALLBACK_EVENT_WAIT_CANCELLED:
        if (wsi_) lws_callback_on_writable(wsi_);
        break;

    case LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER: {
        unsigned char** p = static_cast<unsigned char**>(in);
        unsigned char* end = (*p) + len;

        std::string auth_val = app_id_ + ":" + access_token_;

        if (lws_add_http_header_by_name(
                wsi,
                reinterpret_cast<const unsigned char*>("Authorization:"),
                reinterpret_cast<const unsigned char*>(auth_val.data()),
                auth_val.size(),
                p,
                end
            ) != 0) {
            return -1;
        }
        break;
    }

    case LWS_CALLBACK_CLIENT_ESTABLISHED:
        std::cout << "\nCONNECTED TO FYERS TBT (" << symbol_ << ")\n";
        state_ = 0;
        needs_ping_ = false;
        lws_set_timer_usecs(wsi, 30 * LWS_USEC_PER_SEC);
        lws_callback_on_writable(wsi);
        break;

    case LWS_CALLBACK_TIMER:
        needs_ping_ = true;
        lws_callback_on_writable(wsi);
        lws_set_timer_usecs(wsi, 30 * LWS_USEC_PER_SEC);
        break;

    case LWS_CALLBACK_CLIENT_WRITEABLE: {
        if (needs_ping_) {
            send_text(wsi, "ping");
            needs_ping_ = false;
            bool pendingSymbolChange = false;
            if (state_ == 2) {
                std::lock_guard<std::mutex> lock(symbolMutex_);
                pendingSymbolChange = depthSubscribePending_ || requestedSymbol_ != symbol_;
            }
            if (state_ < 2 || pendingSymbolChange) lws_callback_on_writable(wsi);
            break;
        }

        if (state_ == 0) {
            std::string subscribe =
                "{\"type\":1,\"data\":{\"subs\":1,\"symbols\":[\"" + symbol_ + "\"],\"mode\":\"depth\",\"channel\":\"1\"}}";
            send_text(wsi, subscribe);
            state_ = 1;
            lws_callback_on_writable(wsi);
            break;
        }

        if (state_ == 1) {
            std::string resume =
                "{\"type\":2,\"data\":{\"resumeChannels\":[\"1\"],\"pauseChannels\":[]}}";
            send_text(wsi, resume);
            state_ = 2;
            break;
        }
        if (state_ == 2) {
            std::string requested;
            { std::lock_guard<std::mutex> lock(symbolMutex_); requested = requestedSymbol_; }
            if (depthSubscribePending_) {
                symbol_ = requested;
                std::string subscribe =
                    "{\"type\":1,\"data\":{\"subs\":1,\"symbols\":[\"" + symbol_ + "\"],\"mode\":\"depth\",\"channel\":\"1\"}}";
                send_text(wsi, subscribe);
                depthSubscribePending_ = false;
            } else if (requested != symbol_) {
                const std::string previous = symbol_;
                symbol_ = requested;
                std::string unsubscribe =
                    "{\"type\":1,\"data\":{\"subs\":-1,\"symbols\":[\"" + previous + "\"],\"mode\":\"depth\",\"channel\":\"1\"}}";
                send_text(wsi, unsubscribe);
                depthSubscribePending_ = true;
                lws_callback_on_writable(wsi);
            }
        }
        break;
    }

    case LWS_CALLBACK_CLIENT_RECEIVE: {
        if (len == 4 && std::memcmp(in, "pong", 4) == 0) {
            std::cout << "[Heartbeat] PONG received\n";
            break;
        }
        process_message(in, len);
        break;
    }

    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
        std::cerr << "\nFYERS CONNECTION ERROR\n";
        if (in) std::cerr << "Context: " << static_cast<char*>(in) << "\n";
        running_ = false;
        break;

    case LWS_CALLBACK_CLIENT_CLOSED:
        std::cout << "\nFYERS TBT CONNECTION CLOSED\n";
        running_ = false;
        break;

    default:
        break;
    }

    return 0;
}

int FyersTBT::fyers_callback(lws* wsi, lws_callback_reasons reason, void* user, void* in, size_t len) {
    return instance_->handle_callback(wsi, reason, user, in, len);
}

bool FyersTBT::start() {
    static const lws_protocols protocols[] = {
        {"fyers-tbt", fyers_callback, 0, 1024 * 1024, 0, nullptr, 0}, // outbound Fyers connection only now
        {nullptr, nullptr, 0, 0, 0, nullptr, 0}
    };

    lws_context_creation_info info{};
    info.port = CONTEXT_PORT_NO_LISTEN; // no local UI server anymore -- server.cpp's broadcast() owns the browser-facing socket
    info.protocols = protocols;
    info.options = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;
    info.gid = -1;
    info.uid = -1;

    lws_context* context = lws_create_context(&info);
    context_.store(context);
    if (!context) return false;

    lws_client_connect_info connection{};
    connection.context = context;
    connection.address = "rtsocket-api.fyers.in";
    connection.port = 443;
    connection.path = "/versova";
    connection.host = connection.address;
    connection.origin = connection.address;
    connection.protocol = "fyers-tbt";
    connection.ssl_connection = LCCSCF_USE_SSL;

    wsi_ = lws_client_connect_via_info(&connection);
    if (!wsi_) {
        lws_context_destroy(context);
        context_.store(nullptr);
        return false;
    }

    std::cout << "[LimitOrder] Fyers TBT depth feed connecting, broadcasting through http://localhost:" << HTTP_PORT << "\n";

    while (running_.load() && g_state.running.load()) {
        lws_service(context, 10);
    }

    lws_context_destroy(context);
    context_.store(nullptr);
    return true;
}

// Entry point run on its own thread from main.cpp, same pattern as
// browserServer(). Same hardcoded credentials/symbol as the standalone
// backend.cpp this was lifted from -- move these into config.h alongside
// FYERS_ACCESS_TOKEN and SYMBOL when you get a chance (see note in main.cpp).
void limitOrderWorker() {
    // const std::string APP_ID = FYERS_APP_ID;
    // const std::string ACCESS_TOKEN = FYERS_ACCESS_TOKEN;
    // const std::string SYMBOL = "NSE:SBIN-EQ";

    static FyersTBT client(fyersAppId(), fyersAccessToken(), DEFAULT_SYMBOL);
    FyersTBT::instance_ = &client;
    g_limitOrderBook.store(&client);
    client.start();
}

// IMPORTANT: Fyers TBT sends incremental depth updates.
// A level may contain only qty/orders without price, so missing protobuf
// fields return 0 by default. Never overwrite the stored price with 0;
// update only fields for which has_price()/has_qty()/has_nord() is true.
// (Handled above in merge_levels().)
