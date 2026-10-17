#pragma once

#include <libwebsockets.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>

struct BookLevel {
    double price = 0.0;
    int64_t qty = 0;
    int64_t nord = 0;
    bool seen = false;
};

class FyersTBT {
public:
    FyersTBT(const std::string& app_id, const std::string& access_token,
             const std::string& symbol);

    std::string latestSnapshot(const std::string& symbol) const;
    void selectSymbol(const std::string& symbol);
    bool start();

    static FyersTBT* instance_;

private:
    struct DepthBook {
        bool hasLtp = false;
        double ltp = 0.0;
        int64_t tbq = 0;
        int64_t tsq = 0;
        std::map<int64_t, BookLevel> bids;
        std::map<int64_t, BookLevel> asks;
    };

    void send_text(lws* wsi, const std::string& message);
    template <typename Repeated>
    void merge_levels(std::map<int64_t, BookLevel>& book, const Repeated& levels);
    std::string build_depth_json(const std::string& symbol, const DepthBook& book) const;
    void broadcast_snapshot(const std::string& symbol, const DepthBook& book);
    void process_message(const void* data, size_t len);
    int handle_callback(lws* wsi, lws_callback_reasons reason, void* user,
                        void* in, size_t len);
    static int fyers_callback(lws* wsi, lws_callback_reasons reason, void* user,
                              void* in, size_t len);

    std::string app_id_;
    std::string access_token_;
    std::string symbol_;
    std::string requestedSymbol_;
    mutable std::mutex symbolMutex_;
    std::atomic<lws_context*> context_{nullptr};
    lws* wsi_ = nullptr;
    std::atomic<bool> running_{true};
    int state_ = 0;
    bool needs_ping_ = false;
    bool depthSubscribePending_ = false;

    std::unordered_map<std::string, DepthBook> booksBySymbol_;

    mutable std::mutex jsonMutex_;
    std::unordered_map<std::string, std::string> latestJsonBySymbol_;
};

extern std::atomic<FyersTBT*> g_limitOrderBook;

void limitOrderWorker();
