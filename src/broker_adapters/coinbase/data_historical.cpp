#include "broker_adapters/coinbase/data_historical.h"
#include "config.h"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <string>
#include <vector>

#pragma comment(lib, "winhttp.lib")

namespace providers::coinbase {
namespace {
std::string isoTime(std::time_t value)
{
    std::tm utc{};
    gmtime_s(&utc, &value);
    char buffer[32]{};
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%S", &utc);
    return buffer;
}

std::string urlEncode(const std::string& value)
{
    static const char hex[] = "0123456789ABCDEF";
    std::string encoded;
    for (unsigned char c : value) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded.push_back(static_cast<char>(c));
        } else {
            encoded.push_back('%'); encoded.push_back(hex[c >> 4]); encoded.push_back(hex[c & 15]);
        }
    }
    return encoded;
}

bool readNumber(const std::string& json, size_t& pos, double& value)
{
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\r' || json[pos] == '\n' || json[pos] == '\t')) ++pos;
    const char* begin = json.c_str() + pos;
    char* end = nullptr;
    value = std::strtod(begin, &end);
    if (end == begin) return false;
    pos = static_cast<size_t>(end - json.c_str());
    return true;
}
}

bool httpGetHistory(const std::string& symbol, std::string& response, DWORD& outStatus)
{
    outStatus = 0;
    response.clear();
    std::string product = symbol;
    if (product.rfind("COINBASE:", 0) == 0) product.erase(0, 9);
    const std::time_t end = std::time(nullptr);
    const std::time_t start = end - static_cast<std::time_t>(HISTORY_DAYS - 1) * 86400;
    DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
    protocols |= WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
#endif
    response = "[";
    bool first = true;
    for (std::time_t pageStart = start; pageStart < end; pageStart += 299 * 60) {
        const std::time_t pageEnd = (std::min)(end, pageStart + 298 * 60);
        const std::string route = "/products/" + urlEncode(product) + "/candles?granularity=60&start=" +
                                  isoTime(pageStart) + "Z&end=" + isoTime(pageEnd) + "Z";
        const std::wstring path(route.begin(), route.end());
        HINTERNET session = WinHttpOpen(L"TradingEngine/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!session) return false;
        WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
        HINTERNET connect = WinHttpConnect(session, L"api.exchange.coinbase.com", INTERNET_DEFAULT_HTTPS_PORT, 0);
        if (!connect) { WinHttpCloseHandle(session); return false; }
        HINTERNET request = WinHttpOpenRequest(connect, L"GET", path.c_str(), nullptr,
                                               WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
        if (!request) { WinHttpCloseHandle(connect); WinHttpCloseHandle(session); return false; }
        bool ok = WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                  WinHttpReceiveResponse(request, nullptr);
        std::string page;
        if (ok) {
            DWORD status = 0, statusSize = sizeof(status);
            WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
            outStatus = status;
            DWORD available = 0;
            while (WinHttpQueryDataAvailable(request, &available) && available) {
                const size_t oldSize = page.size();
                page.resize(oldSize + available);
                DWORD read = 0;
                if (!WinHttpReadData(request, page.data() + oldSize, available, &read)) { ok = false; break; }
                page.resize(oldSize + read);
            }
        }
        WinHttpCloseHandle(request); WinHttpCloseHandle(connect); WinHttpCloseHandle(session);
        if (!ok) return false;
        if (outStatus < 200 || outStatus >= 300) { response = std::move(page); return true; }
        const size_t firstRow = page.find('[');
        const size_t lastRow = page.find_last_of(']');
        if (firstRow != std::string::npos && lastRow > firstRow + 1) {
            if (!first) response.push_back(',');
            response.append(page, firstRow + 1, lastRow - firstRow - 1);
            first = false;
        }
    }
    response.push_back(']');
    return true;
}

bool parseHistory(const std::string& symbol, const std::string& json, DWORD httpStatus)
{
    if (httpStatus < 200 || httpStatus >= 300) {
        std::fprintf(stderr, "[HISTORY] Coinbase returned HTTP %lu: %.250s\n", httpStatus, json.c_str());
        return false;
    }
    std::vector<Candle> candles;
    size_t pos = 0;
    while ((pos = json.find('[', pos)) != std::string::npos) {
        ++pos;
        double values[6]{};
        bool valid = true;
        for (int i = 0; i < 6; ++i) {
            if (!readNumber(json, pos, values[i])) { valid = false; break; }
            while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
            if (i < 5) {
                if (pos >= json.size() || json[pos] != ',') { valid = false; break; }
                ++pos;
            }
        }
        if (valid) {
            // Coinbase Exchange candle order: time, low, high, open, close, volume.
            candles.push_back({static_cast<int64_t>(values[0]), values[3], values[2], values[1], values[4], values[5]});
            pos = json.find(']', pos);
            if (pos == std::string::npos) break;
            ++pos;
        }
    }
    if (candles.empty()) {
        std::fprintf(stderr, "[HISTORY] Coinbase returned no candles (HTTP %lu).\n", httpStatus);
        return false;
    }
    std::sort(candles.begin(), candles.end(), [](const Candle& a, const Candle& b) { return a.time < b.time; });
    candles.erase(std::unique(candles.begin(), candles.end(), [](const Candle& a, const Candle& b) { return a.time == b.time; }), candles.end());
    const size_t candleCount = candles.size();
    {
        std::lock_guard<std::mutex> lock(g_state.marketMutex);
        g_state.candlesBySymbol[symbol] = candles;
        if (symbol == g_state.activeSymbol) {
            std::lock_guard<std::mutex> candlesLock(g_state.candleMutex);
            g_state.candles = std::move(candles);
        }
    }
    std::printf("[HISTORY] Loaded %zu one-minute Coinbase candles for %s.\n", candleCount, symbol.c_str());
    return true;
}
} // namespace providers::coinbase
