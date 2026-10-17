// ============================================================
// DATA_HISTORICAL.CPP — Fyers REST API for 1-minute candle history
// ============================================================

#include "broker_adapters/fyers/data_historical.h"
#include "config.h"
#include "broker_adapters/fyers/config.h"
#include "core/json_parser.h"

#include <windows.h>
#include <winhttp.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace providers::fyers {

#pragma comment(lib, "winhttp.lib")

// ============================================================
// DATE HELPER
// ============================================================

// static std::string todayDate()
// {
//     SYSTEMTIME st{};
//     GetLocalTime(&st);

//     char buf[16];
//     std::snprintf(buf, sizeof(buf), "%04u-%02u-%02u", st.wYear, st.wMonth, st.wDay);
//     return buf;
// }


static std::string formatDate(const SYSTEMTIME& st)
{
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%04u-%02u-%02u", st.wYear, st.wMonth, st.wDay);
    return buf;
}

static std::string dateDaysAgo(int daysAgo)
{
    SYSTEMTIME st{};
    GetLocalTime(&st);
    FILETIME ft{};
    SystemTimeToFileTime(&st, &ft);
    ULARGE_INTEGER value{};
    value.LowPart = ft.dwLowDateTime;
    value.HighPart = ft.dwHighDateTime;
    value.QuadPart -= static_cast<ULONGLONG>(daysAgo) * 24ULL * 60ULL * 60ULL * 10000000ULL;
    ft.dwLowDateTime = value.LowPart;
    ft.dwHighDateTime = value.HighPart;
    FileTimeToSystemTime(&ft, &st);
    return formatDate(st);
}

static std::string urlEncode(const std::string& value)
{
    static const char hex[] = "0123456789ABCDEF";
    std::string encoded;
    for (unsigned char c : value) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded.push_back(static_cast<char>(c));
        } else {
            encoded.push_back('%');
            encoded.push_back(hex[c >> 4]);
            encoded.push_back(hex[c & 0x0F]);
        }
    }
    return encoded;
}

// ============================================================
// HTTP GET
// ============================================================

bool httpGetHistory(const std::string& symbol, std::string& response, DWORD& outStatus)
{
    outStatus = 0;
    response.clear();

    // const std::string date = todayDate();
    const std::string rangeFrom = dateDaysAgo(HISTORY_DAYS - 1);
    const std::string rangeTo = dateDaysAgo(0);
    
    std::string fyersSymbol = symbol;
    if (fyersSymbol.rfind("NSE:", 0) != 0 && fyersSymbol.rfind("BSE:", 0) != 0 && fyersSymbol.rfind("MCX:", 0) != 0)
        fyersSymbol = "NSE:" + fyersSymbol;
    const std::string encodedSymbol = urlEncode(fyersSymbol);

    const std::wstring host = L"api-t1.fyers.in";
    const std::wstring path =
        L"/data/history?symbol=" + std::wstring(encodedSymbol.begin(), encodedSymbol.end()) +
        L"&resolution=1&date_format=1&range_from=" + std::wstring(rangeFrom.begin(), rangeFrom.end()) +
        L"&range_to=" + std::wstring(rangeTo.begin(), rangeTo.end()) +
        L"&cont_flag=1";

        // L"&resolution=1&date_format=1&range_from=" +
        // std::wstring(date.begin(), date.end()) +
        // L"&range_to=" + std::wstring(date.begin(), date.end()) +
        // L"&cont_flag=1";

    HINTERNET session = WinHttpOpen(L"TradingEngine/1.0",
                                    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                    WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) {
        std::fprintf(stderr, "[HISTORY] WinHttpOpen failed: %lu\n", GetLastError());
        return false;
    }

    // Force modern TLS.
    {
        DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
                         | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
#endif
                         ;
        WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
    }

    HINTERNET connect = WinHttpConnect(session, host.c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0);
    if (!connect) {
        std::fprintf(stderr, "[HISTORY] WinHttpConnect failed: %lu\n", GetLastError());
        WinHttpCloseHandle(session);
        return false;
    }

    HINTERNET request = WinHttpOpenRequest(connect, L"GET", path.c_str(),
                                           nullptr, WINHTTP_NO_REFERER,
                                           WINHTTP_DEFAULT_ACCEPT_TYPES,
                                           WINHTTP_FLAG_SECURE);
    if (!request) {
        std::fprintf(stderr, "[HISTORY] WinHttpOpenRequest failed: %lu\n", GetLastError());
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        return false;
    }

    const std::string auth = std::string("Authorization: ") + fyersAppId() + ":" + fyersAccessToken();
    const std::wstring whAuth(auth.begin(), auth.end());

    WinHttpAddRequestHeaders(request, whAuth.c_str(), (DWORD)-1L, WINHTTP_ADDREQ_FLAG_ADD);

    bool transportOk = false;

    if (WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                           WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(request, nullptr)) {

        transportOk = true;

        DWORD status = 0;
        DWORD statusSize = sizeof(status);
        WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
        outStatus = status;

        DWORD size = 0;
        do {
            if (!WinHttpQueryDataAvailable(request, &size)) break;
            if (!size) break;

            const size_t oldSize = response.size();
            response.resize(oldSize + size);

            DWORD read = 0;
            if (!WinHttpReadData(request, response.data() + oldSize, size, &read)) break;

            response.resize(oldSize + read);
        } while (size);
    } else {
        std::fprintf(stderr, "[HISTORY] WinHttpSendRequest/ReceiveResponse failed: %lu\n", GetLastError());
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return transportOk;
}

// ============================================================
// PARSE HISTORY JSON
// ============================================================

bool parseHistory(const std::string& symbol, const std::string& json, DWORD httpStatus)
{
    // Surface Fyers' own error envelope if present
    {
        size_t pos = 0;
        std::string status;
        if (getString(json.c_str(), json.size(), "s", pos, status) && status == "error") {
            size_t p2 = 0;
            std::string message;
            double code = 0;
            getDouble(json.c_str(), json.size(), "code", p2, code);
            size_t p3 = 0;
            getString(json.c_str(), json.size(), "message", p3, message);
            std::fprintf(stderr, "[HISTORY] Fyers returned an error (HTTP %lu): code=%.0f message=%s\n",
                         httpStatus, code, message.c_str());
            return false;
        }
    }

    const size_t start = json.find("\"candles\"");
    if (start == std::string::npos) {
        std::fprintf(stderr, "[HISTORY] No \"candles\" field in response (HTTP %lu).\n", httpStatus);
        std::fprintf(stderr, "[HISTORY] Raw response: %.500s\n", json.c_str());
        return false;
    }

    size_t p = json.find('[', start);
    if (p == std::string::npos) return false;

    std::vector<Candle> candles;

    while (p < json.size()) {
        p = json.find('[', p + 1);
        if (p == std::string::npos) break;

        ++p;

        char* end = nullptr;
        const char* base = json.c_str() + p;

        const int64_t ts = std::strtoll(base, &end, 10);
        if (end == base) continue;
        p = (size_t)(end - json.c_str());

        if (p >= json.size() || json[p] != ',') continue;
        ++p;

        const double open = std::strtod(json.c_str() + p, &end);
        if (end == json.c_str() + p) continue;
        p = (size_t)(end - json.c_str());

        if (p >= json.size() || json[p] != ',') continue;
        ++p;

        const double high = std::strtod(json.c_str() + p, &end);
        if (end == json.c_str() + p) continue;
        p = (size_t)(end - json.c_str());

        if (p >= json.size() || json[p] != ',') continue;
        ++p;

        const double low = std::strtod(json.c_str() + p, &end);
        if (end == json.c_str() + p) continue;
        p = (size_t)(end - json.c_str());

        if (p >= json.size() || json[p] != ',') continue;
        ++p;

        const double close = std::strtod(json.c_str() + p, &end);
        if (end == json.c_str() + p) continue;
        p = (size_t)(end - json.c_str());

        if (p >= json.size() || json[p] != ',') continue;
        ++p;

        const double volume = std::strtod(json.c_str() + p, &end);
        if (end == json.c_str() + p) continue;
        p = (size_t)(end - json.c_str());

        candles.push_back({ts, open, high, low, close, volume});
    }

    if (candles.empty()) {
        std::fprintf(stderr, "[HISTORY] \"candles\" array was present but empty (HTTP %lu). "
                              "This is normal if the market hasn't opened yet today.\n", httpStatus);
        return false;
    }

    const size_t candleCount = candles.size();
    {
        std::lock_guard<std::mutex> lock(g_state.marketMutex);
        g_state.candlesBySymbol[symbol] = candles;
        if (symbol == g_state.activeSymbol) {
            std::lock_guard<std::mutex> candlesLock(g_state.candleMutex);
            g_state.candles = std::move(candles);
        }
    }

    std::printf("[HISTORY] Loaded %zu one-minute candles for %s.\n", candleCount, symbol.c_str());
    return true;
}

} // namespace providers::fyers
