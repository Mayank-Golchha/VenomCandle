// ============================================================
// OPTIONS_CHAIN.CPP — Fyers Options Chain GEX Engine
// ============================================================
//
// GEX formula:
//   gex = gamma × OI × lot_size × spot² × 0.01
//
// Call Wall = argmax_{K > spot} Σ_t gex_CE(K, t)
// Put  Wall = argmax_{K < spot} Σ_t gex_PE(K, t)
//
// For INDEX symbols (contains "-INDEX"):  use ALL expiries.
// For STOCK symbols:                      use first 3 expiries only.
//
// Lot size is fetched live from the Fyers public symbol-master CSV:
//   https://public.fyers.in/sym_details/NSE_FO.csv
// We look for the row whose underlying (col 5) matches
// the underlying of optSymbol (e.g. "NIFTY", "RELIANCE") and
// whose instrument type (col 8) is "IF" (index future) or "EF"
// (equity future) — any row for the underlying works since all
// rows for the same underlying share the same lot size.
// ============================================================

#include "broker_adapters/fyers/options_chain.h"
#include "broker_adapters/fyers/config.h"
#include "core/json_parser.h"
#include "config.h"            // g_state
#include "server.h"            // broadcast()

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#pragma comment(lib, "winhttp.lib")

// ============================================================
// INTERNAL TYPES
// ============================================================

namespace {

struct ExpiryInfo {
    std::string date;
    std::string timestamp; // numeric Unix timestamp as string
    std::string flag;      // "W"=Weekly, "M"=Monthly
};

struct GEXEntry {
    double callGEX = 0.0; // Σ gex_CE across expiries
    double putGEX  = 0.0; // Σ gex_PE across expiries
    double callOI  = 0.0; // Σ OI_CE across expiries
    double putOI   = 0.0; // Σ OI_PE across expiries
};

static bool isIndexSymbol(const std::string& symbol) {
    return symbol.find("-INDEX") != std::string::npos;
}

// Strip exchange prefix and any suffix after the base name
// e.g. "NSE:NIFTY50-INDEX" -> "NIFTY50"  "NSE:RELIANCE-EQ" -> "RELIANCE"
static std::string extractUnderlying(const std::string& symbol) {
    std::string s = symbol;
    const size_t colon = s.find(':');
    if (colon != std::string::npos) s = s.substr(colon + 1);
    const size_t dash = s.find('-');
    if (dash != std::string::npos) s = s.substr(0, dash);
    return s;
}

// ============================================================
// LOT SIZE — live lookup from Fyers public symbol master CSV
// ============================================================

static std::mutex              g_lotCacheMutex;
static std::unordered_map<std::string, int> g_lotCache; // underlying -> lot
static bool                    g_lotCacheLoaded = false;

// HTTP GET (plain HTTP, no auth) — for public.fyers.in CSV
static std::string httpGetPlain(const std::wstring& host,
                                const std::wstring& path,
                                bool useHttps = false)
{
    HINTERNET session = WinHttpOpen(L"TradingEngine/1.0",
                                    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                    WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return "";

    if (useHttps) {
        DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
                         | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
#endif
                         ;
        WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS,
                         &protocols, sizeof(protocols));
    }

    const INTERNET_PORT port = useHttps
        ? INTERNET_DEFAULT_HTTPS_PORT
        : INTERNET_DEFAULT_HTTP_PORT;
    const DWORD flags = useHttps ? WINHTTP_FLAG_SECURE : 0;

    HINTERNET connect = WinHttpConnect(session, host.c_str(), port, 0);
    HINTERNET request = connect
        ? WinHttpOpenRequest(connect, L"GET", path.c_str(),
                             nullptr, WINHTTP_NO_REFERER,
                             WINHTTP_DEFAULT_ACCEPT_TYPES, flags)
        : nullptr;

    std::string body;
    if (request &&
        WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                           WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(request, nullptr))
    {
        DWORD size = 0;
        do {
            if (!WinHttpQueryDataAvailable(request, &size)) break;
            if (!size) break;
            const size_t old = body.size();
            body.resize(old + size);
            DWORD read = 0;
            if (!WinHttpReadData(request, body.data() + old, size, &read)) break;
            body.resize(old + read);
        } while (size);
    }

    if (request) WinHttpCloseHandle(request);
    if (connect) WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return body;
}

// Fetch NSE_FO.csv from public.fyers.in and populate g_lotCache.
// CSV columns (0-indexed, comma-separated, first row = header):
//   Col 6  = Underlying symbol (e.g. "NIFTY", "RELIANCE")
//   Col 7  = Lot size (integer)
// We take the first match per underlying since all rows for the same
// underlying share an identical lot size.
static void loadLotCache()
{
    std::fprintf(stdout, "[OPTIONS] Fetching NSE F&O lot sizes from public.fyers.in...\n");

    // Try HTTPS first, fall back to HTTP
    std::string csv = httpGetPlain(L"public.fyers.in",
                                   L"/sym_details/NSE_FO.csv", true);
    if (csv.empty())
        csv = httpGetPlain(L"public.fyers.in",
                           L"/sym_details/NSE_FO.csv", false);

    if (csv.empty()) {
        std::fprintf(stderr, "[OPTIONS] Could not fetch NSE_FO.csv; lot sizes unavailable.\n");
        return;
    }

    std::unordered_map<std::string, int> cache;

    // Parse CSV line by line
    size_t lineStart = 0;
    bool   firstLine = true;
    while (lineStart < csv.size()) {
        size_t lineEnd = csv.find('\n', lineStart);
        if (lineEnd == std::string::npos) lineEnd = csv.size();

        const std::string line = csv.substr(lineStart,
                                            lineEnd - lineStart);
        lineStart = lineEnd + 1;

        if (firstLine) { firstLine = false; continue; } // skip header

        // Split by comma — simple split (no quoted fields in this CSV)
        std::vector<std::string> cols;
        cols.reserve(16);
        size_t cs = 0;
        while (true) {
            const size_t ce = line.find(',', cs);
            if (ce == std::string::npos) {
                cols.push_back(line.substr(cs));
                break;
            }
            cols.push_back(line.substr(cs, ce - cs));
            cs = ce + 1;
        }

        // We need at least 8 columns (indices 0-7)
        if (cols.size() < 8) continue;

        // Col 13 = underlying, Col 3 = lot size
        // Trim whitespace / \r
        auto trim = [](const std::string& s) {
            size_t a = 0, b = s.size();
            while (a < b && (s[a] == ' ' || s[a] == '\r' || s[a] == '\t')) ++a;
            while (b > a && (s[b-1] == ' ' || s[b-1] == '\r' || s[b-1] == '\t')) --b;
            return s.substr(a, b - a);
        };

        // const std::string underlying = trim(cols[6]);
        // const std::string lotStr     = trim(cols[7]);
        // const std::string lotStr = trim(cols[3]);
        // const std::string underlying = trim(cols[12]);
        const std::string lotStr = trim(cols[3]);
        const std::string underlying = trim(cols[13]);

        if (underlying.empty() || lotStr.empty()) continue;

        char* endp = nullptr;
        const long lot = std::strtol(lotStr.c_str(), &endp, 10);
        if (endp == lotStr.c_str() || lot <= 0) continue;

        // Insert only the first occurrence (all rows for same underlying
        // have the same lot size)
        cache.emplace(underlying, static_cast<int>(lot));
    }

    {
        std::lock_guard<std::mutex> lock(g_lotCacheMutex);
        g_lotCache        = std::move(cache);
        g_lotCacheLoaded  = true;
    }
    std::fprintf(stdout, "[OPTIONS] Loaded lot sizes for %zu underlyings.\n",
                 g_lotCache.size());
}

// Returns the lot size for optSymbol, fetching the CSV if needed.
// Falls back to 50 if the symbol cannot be found.
static int getLotSize(const std::string& optSymbol)
{
    {
        std::lock_guard<std::mutex> lock(g_lotCacheMutex);
        if (!g_lotCacheLoaded) {
            // Release lock while fetching (avoid holding it during I/O)
        }
    }

    // Fetch only once per process lifetime
    bool needLoad = false;
    {
        std::lock_guard<std::mutex> lock(g_lotCacheMutex);
        needLoad = !g_lotCacheLoaded;
    }
    if (needLoad) loadLotCache();

    const std::string underlying = extractUnderlying(optSymbol);

    std::lock_guard<std::mutex> lock(g_lotCacheMutex);
    const auto it = g_lotCache.find(underlying);
    if (it != g_lotCache.end()) return it->second;

    // Some index symbols appear without the trailing "50" in the CSV
    // e.g. "NIFTY50" -> try "NIFTY"
    if (underlying.size() > 2) {
        // Try stripping trailing digits
        size_t p = underlying.size();
        while (p > 0 && std::isdigit(static_cast<unsigned char>(underlying[p-1]))) --p;
        if (p > 0 && p < underlying.size()) {
            const auto it2 = g_lotCache.find(underlying.substr(0, p));
            if (it2 != g_lotCache.end()) return it2->second;
        }
    }

    std::fprintf(stderr, "[OPTIONS] Lot size not found for '%s' (underlying='%s'); defaulting to 50.\n",
                 optSymbol.c_str(), underlying.c_str());
    // return 50;
    return 0;
}

// ============================================================
// HTTP HELPER (authenticated) — reuses WinHTTP pattern from adapters
// ============================================================

static std::string httpGet(const std::wstring& host,
                           const std::wstring& path,
                           const std::string&  authHeader)
{
    HINTERNET session = WinHttpOpen(L"TradingEngine/1.0",
                                    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                    WINHTTP_NO_PROXY_NAME,
                                    WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return "";

    {
        DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
                         | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
#endif
                         ;
        WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS,
                         &protocols, sizeof(protocols));
    }

    HINTERNET connect = WinHttpConnect(session, host.c_str(),
                                       INTERNET_DEFAULT_HTTPS_PORT, 0);
    HINTERNET request = connect
        ? WinHttpOpenRequest(connect, L"GET", path.c_str(),
                             nullptr, WINHTTP_NO_REFERER,
                             WINHTTP_DEFAULT_ACCEPT_TYPES,
                             WINHTTP_FLAG_SECURE)
        : nullptr;

    if (!request) {
        if (connect) WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        return "";
    }

    const std::wstring wAuth(authHeader.begin(), authHeader.end());
    WinHttpAddRequestHeaders(request, wAuth.c_str(),
                             static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD);

    std::string body;
    if (WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                           WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(request, nullptr))
    {
        DWORD size = 0;
        do {
            if (!WinHttpQueryDataAvailable(request, &size)) break;
            if (!size) break;
            const size_t old = body.size();
            body.resize(old + size);
            DWORD read = 0;
            if (!WinHttpReadData(request, body.data() + old, size, &read)) break;
            body.resize(old + read);
        } while (size);
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return body;
}

// ============================================================
// EXPIRY LIST PARSER
// ============================================================

static std::vector<ExpiryInfo> parseExpiryList(const std::string& json) {
    std::vector<ExpiryInfo> list;
    const char* data = json.c_str();
    const size_t len  = json.size();

    size_t pos = 0;
    const char* val = nullptr;
    if (!findValue(data, len, "expiryData", pos, val)) return list;

    const char* p = val;
    while (p < data + len && *p != '[') ++p;
    if (p >= data + len) return list;
    ++p;

    while (p < data + len) {
        while (p < data + len && *p != '{' && *p != ']') ++p;
        if (p >= data + len || *p == ']') break;

        const char* objStart = p;
        int depth = 0;
        while (p < data + len) {
            if      (*p == '{') ++depth;
            else if (*p == '}') { if (--depth == 0) { ++p; break; } }
            ++p;
        }
        const size_t objLen = static_cast<size_t>(p - objStart);

        ExpiryInfo info;
        size_t fPos = 0;
        getString(objStart, objLen, "date", fPos, info.date);

        fPos = 0;
        if (!getString(objStart, objLen, "expiry", fPos, info.timestamp)) {
            uint64_t expNum = 0; fPos = 0;
            if (getUInt64(objStart, objLen, "expiry", fPos, expNum))
                info.timestamp = std::to_string(expNum);
        }
        fPos = 0;
        getString(objStart, objLen, "expiry_flag", fPos, info.flag);

        if (!info.timestamp.empty()) list.push_back(info);
    }
    return list;
}

// ============================================================
// GEX ACCUMULATOR — one expiry at a time
// ============================================================

static void accumulateGEX(const std::string& json,
                           std::vector<std::pair<double, GEXEntry>>& gexMap,
                           int lotSize,
                           double& spotOut)
{
    const char* data = json.c_str();
    const size_t len  = json.size();

    size_t chainPos = 0;
    const char* chainVal = nullptr;
    if (!findValue(data, len, "optionsChain", chainPos, chainVal)) return;

    const char* p = chainVal;
    while (p < data + len && *p != '[') ++p;
    if (p >= data + len) return;
    ++p;

    while (p < data + len) {
        while (p < data + len && *p != '{' && *p != ']') ++p;
        if (p >= data + len || *p == ']') break;

        const char* objStart = p;
        int depth = 0;
        while (p < data + len) {
            if      (*p == '{') ++depth;
            else if (*p == '}') { if (--depth == 0) { ++p; break; } }
            ++p;
        }
        const size_t objLen = static_cast<size_t>(p - objStart);

        double      strike  = 0.0;
        std::string optType;
        double      gamma   = 0.0;
        uint64_t    oi      = 0;
        double      ltp     = 0.0;

        size_t pos = 0;
        getDouble (objStart, objLen, "strike_price", pos, strike);
        pos = 0; getString (objStart, objLen, "option_type",  pos, optType);
        pos = 0; getDouble (objStart, objLen, "ltp",          pos, ltp);
        pos = 0; getDouble (objStart, objLen, "gamma",        pos, gamma);
        pos = 0; getUInt64 (objStart, objLen, "oi",           pos, oi);

        // Underlying summary row (no strike / option_type)
        if (strike <= 0.0 || optType.empty()) {
            if (ltp > 0.0) spotOut = ltp;
            continue;
        }

        // GEX formula: gamma × OI × lot × spot² × 0.01
        const double s   = (spotOut > 0.0) ? spotOut : 1.0;
        const double gex = gamma * static_cast<double>(oi)
                         * static_cast<double>(lotSize)
                         * s * s * 0.01;

        // bool found = false;
        // for (auto& kv : gexMap) {
        //     if (kv.first == strike) {
        //         if (optType == "CE") kv.second.callGEX += gex;
        //         else                 kv.second.putGEX  += gex;
        //         found = true;
        //         break;
        //     }
        // }
        // if (!found) {
        //     GEXEntry e;
        //     if (optType == "CE") e.callGEX = gex;
        //     else                 e.putGEX  = gex;
        //     gexMap.push_back({strike, e});
        // }

        const double oiD = static_cast<double>(oi);
        bool found = false;
        for (auto& kv : gexMap) {
            if (kv.first == strike) {
                if (optType == "CE") { kv.second.callGEX += gex; kv.second.callOI += oiD; }
                else                 { kv.second.putGEX  += gex; kv.second.putOI  += oiD; }
                found = true;
                break;
            }
        }
        if (!found) {
            GEXEntry e;
            if (optType == "CE") { e.callGEX = gex; e.callOI = oiD; }
            else                 { e.putGEX  = gex; e.putOI  = oiD; }
            gexMap.push_back({strike, e});
        }

    }
}

// ============================================================
// BUILD JSON BROADCAST
// ============================================================

static std::string buildOptionsGexJson(
    const std::string& symbol,
    double spot,
    double callWall, double callGEX,
    double putWall,  double putGEX,
    int    lotSize,
    size_t expiryCount,
    size_t contractsUsed,
    const std::vector<std::pair<double, GEXEntry>>& gexMap,
    const std::vector<std::pair<double, GEXEntry>>& oiMap,
    const std::string& oiExpiry
)
{
    auto fmt = [](double v) -> std::string {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.4f", v);
        std::string s(buf);
        if (s.find('.') != std::string::npos) {
            size_t last = s.find_last_not_of('0');
            if (last != std::string::npos && s[last] == '.') ++last;
            s.erase(last + 1);
        }
        return s;
    };
    auto fmtInt = [](double v) -> std::string {
        char buf[32]; std::snprintf(buf, sizeof(buf), "%.0f", v); return buf;
    };

    std::string json;
    json.reserve(512 + gexMap.size() * 80);
    json  = "{\"type\":\"options_gex\"";
    json += ",\"symbol\":\"";      json += symbol;                     json += "\"";
    json += ",\"spot\":";          json += fmtInt(spot);
    json += ",\"callWall\":";      json += fmtInt(callWall);
    json += ",\"putWall\":";       json += fmtInt(putWall);
    json += ",\"callGEX\":";       json += fmt(callGEX);
    json += ",\"putGEX\":";        json += fmt(putGEX);
    json += ",\"lotSize\":";       json += std::to_string(lotSize);
    json += ",\"expiryCount\":";   json += std::to_string(expiryCount);
    json += ",\"contractsUsed\":"; json += std::to_string(contractsUsed);

    auto sorted = gexMap;
    std::sort(sorted.begin(), sorted.end(),
              [](const auto& a, const auto& b){ return a.first < b.first; });

    json += ",\"gexLevels\":[";
    bool first = true;
    for (const auto& kv : sorted) {
        if (!first) json += ',';
        first = false;
        json += "{\"strike\":";   json += fmtInt(kv.first);
        json += ",\"callGEX\":";  json += fmt(kv.second.callGEX);
        json += ",\"putGEX\":";   json += fmt(kv.second.putGEX);
        // json += ",\"callOI\":";   json += fmtInt(kv.second.callOI);
        // json += ",\"putOI\":";    json += fmtInt(kv.second.putOI);
        json += "}";
    }
    json += "]";


    auto oiSorted = oiMap;
    std::sort(oiSorted.begin(), oiSorted.end(),
              [](const auto& a, const auto& b){ return a.first < b.first; });

    json += ",\"oiExpiry\":\"";  json += oiExpiry;  json += "\"";
    json += ",\"oiLevels\":[";
    bool firstOi = true;
    for (const auto& kv : oiSorted) {
        if (!firstOi) json += ',';
        firstOi = false;
        json += "{\"strike\":";  json += fmtInt(kv.first);
        json += ",\"callOI\":";  json += fmtInt(kv.second.callOI);
        json += ",\"putOI\":";   json += fmtInt(kv.second.putOI);
        json += "}";
    }
    json += "]}";

    
    return json;
}

// ============================================================
// CORE FETCH + COMPUTE
// ============================================================

static void doFetchAndBroadcast(const std::string& optSymbol)
{
    const std::wstring host  = L"api-t1.fyers.in";
    const std::string  appId = fyersAppId();
    const std::string  token = fyersAccessToken();
    const std::string  auth  = "Authorization: " + appId + ":" + token;

    const bool isIndex = isIndexSymbol(optSymbol);
    const int  lotSize = getLotSize(optSymbol); // live from CSV

    auto urlEncode = [](const std::string& s) {
        static const char hex[] = "0123456789ABCDEF";
        std::string e;
        for (unsigned char c : s) {
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.')
                e.push_back(static_cast<char>(c));
            else { e += '%'; e += hex[c >> 4]; e += hex[c & 0xF]; }
        }
        return e;
    };

    const std::string  encodedSym = urlEncode(optSymbol);
    const std::wstring basePath   =
        L"/data/options-chain-v3?symbol=" +
        std::wstring(encodedSym.begin(), encodedSym.end()) +
        L"&strikecount=1&greeks=1";

    // --- Phase 1: Fetch expiry master list ---
    const std::string masterJson = httpGet(host, basePath, auth);
    if (masterJson.empty()) {
        std::fprintf(stderr, "[OPTIONS] Failed to fetch expiry list.\n");
        return;
    }

    std::vector<ExpiryInfo> expiries = parseExpiryList(masterJson);
    if (expiries.empty()) {
        std::fprintf(stderr, "[OPTIONS] No expiries found.\n");
        return;
    }

    const size_t maxContracts = isIndex
        ? expiries.size()
        : std::min<size_t>(expiries.size(), 3);

    std::fprintf(stdout, "[OPTIONS] %s — %zu expir%s, using %zu, lot=%d\n",
                 optSymbol.c_str(), expiries.size(),
                 expiries.size() == 1 ? "y" : "ies",
                 maxContracts, lotSize);

    // --- Phase 2: Fetch each expiry chain and accumulate GEX ---
    std::vector<std::pair<double, GEXEntry>> gexMap;
    std::vector<std::pair<double, GEXEntry>> oiMap;
    std::string oiExpiry;

    double spot = 0.0;

    for (size_t i = 0; i < maxContracts; ++i) {
        const std::string& ts = expiries[i].timestamp;
        const std::wstring wts(ts.begin(), ts.end());

        const std::wstring chainPath =
            L"/data/options-chain-v3?symbol=" +
            std::wstring(encodedSym.begin(), encodedSym.end()) +
            L"&strikecount=20&greeks=1&timestamp=" + wts;

        const std::string chainJson = httpGet(host, chainPath, auth);
        if (chainJson.empty()) {
            std::fprintf(stderr, "[OPTIONS] Expiry %zu (%s) fetch failed.\n",
                         i + 1, expiries[i].date.c_str());
            continue;
        }

        accumulateGEX(chainJson, gexMap, lotSize, spot);
        if (oiExpiry.empty()) {
            accumulateGEX(chainJson, oiMap, lotSize, spot);
            oiExpiry = expiries[i].date;
        }
        // std::fprintf(stdout, "[OPTIONS]   [%zu/%zu] %s — ok\n",
                    //  i + 1, maxContracts, expiries[i].date.c_str());
    }

    if (gexMap.empty() || spot <= 0.0) {
        std::fprintf(stderr, "[OPTIONS] No GEX data — nothing to broadcast.\n");
        return;
    }

    // --- Phase 3: Resolve walls ---
    double callWall = 0.0, callGEX = 0.0;
    double putWall  = 0.0, putGEX  = 0.0;

    for (const auto& kv : gexMap) {
        const double K = kv.first;
        if (K > spot && kv.second.callGEX > callGEX) {
            callGEX  = kv.second.callGEX;
            callWall = K;
        }
        if (K < spot && kv.second.putGEX > putGEX) {
            putGEX  = kv.second.putGEX;
            putWall = K;
        }
    }

    // std::fprintf(stdout,
        // "[OPTIONS] Spot=%.0f  CallWall=%.0f (GEX=%.4f)  PutWall=%.0f (GEX=%.4f)\n",
        // spot, callWall, callGEX, putWall, putGEX);

    // --- Phase 4: Broadcast ---
    const std::string msg = buildOptionsGexJson(
        optSymbol, spot,
        callWall, callGEX,
        putWall,  putGEX,
        lotSize,
        expiries.size(), maxContracts,
        gexMap,oiMap,oiExpiry);

    // std::fprintf(stdout,"[OPTIONS] Broadcasting GEX at ");

    broadcast(msg);
}

// ============================================================
// HELPERS
// ============================================================

// Returns true if this symbol is likely to have an NSE F&O options chain.
// Skips MCX, BSE futures, and bare equity suffixes that lack option contracts.
static bool hasOptionsChain(const std::string& sym) {
    // Must be NSE-prefixed
    // if (sym.rfind("NSE:", 0) != 0) return false;
    // // Pure equity (-EQ suffix) has no options chain via this endpoint
    // const size_t len = sym.size();
    // if (len >= 3 && sym.compare(len - 3, 3, "-EQ") == 0) return false;
    // // Futures suffixes (FUT, e.g. MCX:GOLDPETAL26OCTFUT) handled above by NSE check;
    // // but also skip explicit FUT suffix just in case
    // if (sym.find("FUT") != std::string::npos) return false;
    // return true;

    // working but maybe not support bse
    if (sym.rfind("NSE:", 0) != 0) return false;
    // if (sym.rfind("BSE:", 0) != 0) return false; // not working
    if (sym.find("FUT") != std::string::npos) return false;
    if (sym.size() >= 5 && sym.compare(sym.size() - 5, 5, "-EQ") == 0) return true;
    if (sym.find("-INDEX") != std::string::npos) return true;
    return true;

    // Must be NSE-prefixed
    // const bool isNSE = sym.rfind("NSE:", 0) == 0;
    // const bool isBSE = sym.rfind("BSE:", 0) == 0;
    // if (!isNSE && !isBSE) return false;
    // if (sym.find("FUT") != std::string::npos) return false;
    // const size_t len = sym.size();
    // if (len >= 3 && sym.compare(len - 3, 3, "-EQ") == 0) return false;
    // return true;

}

} // anonymous namespace

// ============================================================
// PUBLIC API
// ============================================================

namespace providers::fyers {

void fetchAndBroadcastOptionsGex()
{
    std::string sym;
    { std::lock_guard<std::mutex> lock(g_state.marketMutex); sym = g_state.activeSymbol; }
    fetchAndBroadcastOptionsGex(sym);
}

void fetchAndBroadcastOptionsGex(const std::string& symbol)
{
    const std::string sym = symbol;
    if (!hasOptionsChain(sym)) {
        std::fprintf(stdout, "[OPTIONS] Skipping options fetch for '%s' (no NSE options chain).\n",
                     sym.c_str());
        return;
    }
    doFetchAndBroadcast(sym);
}

void startOptionsChainLoop(int pollIntervalSeconds)
{
    std::thread([pollIntervalSeconds]() {
        std::fprintf(stdout, "[OPTIONS] Chain loop started (interval=%ds).\n",
                     pollIntervalSeconds);
        while (true) {
            std::string sym;
            { std::lock_guard<std::mutex> lock(g_state.marketMutex); sym = g_state.activeSymbol; }
            if (hasOptionsChain(sym)) {
                doFetchAndBroadcast(sym);
            } else {
                std::fprintf(stdout, "[OPTIONS] Skipping options fetch for '%s' (no NSE options chain).\n",
                             sym.c_str());
            }
            if (pollIntervalSeconds <= 0) break;
            std::this_thread::sleep_for(
                std::chrono::seconds(pollIntervalSeconds));
        }
    }).detach();
}

} // namespace providers::fyers
