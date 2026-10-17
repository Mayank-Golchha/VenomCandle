// ============================================================
// SERVER.CPP — Browser HTTP/WebSocket server + broadcast
// ============================================================

#include "server.h"
#include "config.h"
#include "broker/limit_order.h"
#include "volume_profile.h"
#include "ws_handshake.h"
#include "core/json_parser.h"
#include "broker/data_historical.h"
#include "broker/data_live.h"
#include "broker/options_chain.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iterator>
#include <string>
#include <thread>
#include <fstream>
#include <sstream>
#include <ctime>
#include <set>
#include <cwchar>
#include <cctype>
#include <utility>

#pragma comment(lib, "ws2_32.lib")

static std::filesystem::path g_symbolCsvPath;
static std::mutex g_symbolCatalogMutex;
static std::mutex g_historyJobsMutex;
static std::set<std::string> g_historyJobs;

static std::string withSymbol(std::string json, const std::string& symbol)
{
    if (!json.empty() && json.front() == '{')
        json.insert(1, "\"symbol\":\"" + symbol + "\",");
    return json;
}

bool prepareSymbolCatalog()
{
    std::lock_guard<std::mutex> catalogLock(g_symbolCatalogMutex);
    wchar_t tempPath[MAX_PATH]{};
    const DWORD n = GetTempPathW(MAX_PATH, tempPath);
    if (!n || n >= MAX_PATH) return false;
    SYSTEMTIME now{}; GetLocalTime(&now);
    wchar_t filename[64]{};
    swprintf_s(filename, sizeof(filename) / sizeof(filename[0]), L"TradingEngineVela_EQ_%04u%02u%02u.csv", now.wYear, now.wMonth, now.wDay);
    g_symbolCsvPath = std::filesystem::path(tempPath) / filename;
    std::error_code ec;
    if (std::filesystem::exists(g_symbolCsvPath, ec) && std::filesystem::file_size(g_symbolCsvPath, ec) > 0) {
        std::ifstream cached(g_symbolCsvPath, std::ios::binary);
        std::string header;
        std::getline(cached, header);
        if (header.find("SYMBOL") != std::string::npos && header.find("NAME OF COMPANY") != std::string::npos) return true;
    }

    HINTERNET session = WinHttpOpen(L"TradingEngineVela/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return false;
    WinHttpSetTimeouts(session, 5000, 5000, 10000, 10000);
    DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
    WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
    HINTERNET connection = WinHttpConnect(session, L"archives.nseindia.com", INTERNET_DEFAULT_HTTPS_PORT, 0);
    HINTERNET request = connection ? WinHttpOpenRequest(connection, L"GET", L"/content/equities/EQUITY_L.csv",
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : nullptr;
    if (request) WinHttpAddRequestHeaders(request,
        L"User-Agent: Mozilla/5.0 TradingEngineVela\r\nAccept: text/csv,*/*\r\n",
        static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD);
    bool ok = request && WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        && WinHttpReceiveResponse(request, nullptr);
    DWORD status = 0, statusSize = sizeof(status);
    if (ok) ok = WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX) && status == 200;
    std::string body;
    while (ok) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available)) { ok = false; break; }
        if (!available) break;
        const size_t old = body.size(); body.resize(old + available);
        DWORD read = 0;
        if (!WinHttpReadData(request, body.data() + old, available, &read)) { ok = false; break; }
        body.resize(old + read);
    }
    if (request) WinHttpCloseHandle(request);
    if (connection) WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);
    if (!ok || body.find("SYMBOL") == std::string::npos || body.find("NAME OF COMPANY") == std::string::npos) return false;
    auto partialPath = g_symbolCsvPath;
    partialPath += L".part-" + std::to_wstring(GetCurrentProcessId());
    std::ofstream output(partialPath, std::ios::binary | std::ios::trunc);
    output.write(body.data(), static_cast<std::streamsize>(body.size()));
    output.close();
    if (!output.good()) { std::filesystem::remove(partialPath, ec); return false; }
    return MoveFileExW(partialPath.c_str(), g_symbolCsvPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
}

bool sendAll(SOCKET s, const char* data, size_t len)
{
    while (len) {
        const int n = send(s, data, (int)std::min<size_t>(len, INT_MAX), 0);
        if (n <= 0) return false;
        data += n;
        len -= n;
    }
    return true;
}

bool sendWsText(SOCKET s, const std::string& payload)
{
    std::string frame;
    frame.reserve(payload.size() + 16);
    frame.push_back((char)0x81);
    const uint64_t n = payload.size();
    if (n < 126) {
        frame.push_back((char)n);
    } else if (n <= 0xFFFF) {
        frame.push_back(126);
        frame.push_back((char)(n >> 8));
        frame.push_back((char)n);
    } else {
        frame.push_back(127);
        for (int i = 7; i >= 0; --i) frame.push_back((char)(n >> (i * 8)));
    }
    frame.append(payload);
    return sendAll(s, frame.data(), frame.size());
}

static bool sendToClient(SOCKET client, const std::string& payload)
{
    std::lock_guard<std::mutex> lock(g_state.clientsMutex);
    if (std::find(g_state.clients.begin(), g_state.clients.end(), client) == g_state.clients.end()) return false;
    return sendWsText(client, payload);
}

void removeClient(SOCKET s)
{
    std::lock_guard<std::mutex> lock(g_state.clientsMutex);
    auto it = std::find(g_state.clients.begin(), g_state.clients.end(), s);
    if (it != g_state.clients.end()) g_state.clients.erase(it);
}

void broadcast(const std::string& payload)
{
    std::lock_guard<std::mutex> lock(g_state.clientsMutex);
    for (size_t i = 0; i < g_state.clients.size();) {
        if (!sendWsText(g_state.clients[i], payload)) {
            closesocket(g_state.clients[i]);
            g_state.clients.erase(g_state.clients.begin() + i);
        } else {
            ++i;
        }
    }
}

static bool headerContains(const std::string& request, const char* needle)
{
    std::string a = request;
    std::string b = needle;
    std::transform(a.begin(), a.end(), a.begin(), [](unsigned char c){ return (char)std::tolower(c); });
    std::transform(b.begin(), b.end(), b.begin(), [](unsigned char c){ return (char)std::tolower(c); });
    return a.find(b) != std::string::npos;
}

std::string readFile(const char* filename)
{
    FILE* f = nullptr;
    fopen_s(&f, filename, "rb");
    if (!f) return "";
    fseek(f, 0, SEEK_END);
    const long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::string content((size_t)size, '\0');
    if (size > 0) fread(content.data(), 1, (size_t)size, f);
    fclose(f);
    return content;
}

// Resolve frontend assets from the source project, not from a copied build
// directory or an unrelated parent directory. This lets app.js/frontend.html
// be edited and refreshed without rebuilding the C++ executable.
static std::filesystem::path frontendRoot()
{
    wchar_t executablePath[32768]{};
    const DWORD length = GetModuleFileNameW(nullptr, executablePath,
        static_cast<DWORD>(std::size(executablePath)));
    std::filesystem::path directory = (length > 0 && length < std::size(executablePath))
        ? std::filesystem::path(executablePath).parent_path()
        : std::filesystem::current_path();

    for (int depth = 0; depth < 5 && !directory.empty(); ++depth) {
        if (std::filesystem::exists(directory / "src" / "server.cpp") &&
            std::filesystem::exists(directory / "frontend.html")) {
            return directory;
        }
        const auto parent = directory.parent_path();
        if (parent == directory) break;
        directory = parent;
    }
    return std::filesystem::current_path();
}

static std::string readFrontendFile(const char* filename)
{
    const auto path = frontendRoot() / filename;
    const std::string nativePath = path.string();
    return readFile(nativePath.c_str());
}

void serveStaticFile(SOCKET client, const char* filename, const char* contentType)
{
    const std::string content = readFrontendFile(filename);

    if (content.empty()) {
        const std::string nr = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        sendAll(client, nr.data(), nr.size());
        return;
    }
    const std::string r = "HTTP/1.1 200 OK\r\nContent-Type: " + std::string(contentType)
        + "\r\nCache-Control: no-store\r\nContent-Length: " + std::to_string(content.size())
        + "\r\nConnection: close\r\n\r\n" + content;
    sendAll(client, r.data(), r.size());
}

std::string buildHistoryMessage(const std::string& symbol)
{
    std::vector<Candle> candles;
    { std::lock_guard<std::mutex> lock(g_state.marketMutex); const auto it = g_state.candlesBySymbol.find(symbol); if (it != g_state.candlesBySymbol.end()) candles = it->second; }
    std::string json = "{\"type\":\"history\",\"symbol\":\"" + symbol + "\",\"candles\":[";
    for (size_t i = 0; i < candles.size(); ++i) {
        if (i) json += ',';
        const Candle& c = candles[i];
        json += "{\"timestamp\":";
        json += std::to_string((uint64_t)c.time * 1000ULL);
        json += ",\"open\":"; json += std::to_string(c.open);
        json += ",\"high\":"; json += std::to_string(c.high);
        json += ",\"low\":"; json += std::to_string(c.low);
        json += ",\"close\":"; json += std::to_string(c.close);
        json += ",\"volume\":"; json += std::to_string(c.volume);
        json += '}';
    }
    json += "]}";
    return json;
}

// Decode masked WS payload from browser
static std::string decodeWsPayload(const char* data, size_t len)
{
    if (len < 2) return "";
    const bool masked = (data[1] & 0x80) != 0;
    uint64_t payloadLen = data[1] & 0x7F;
    size_t offset = 2;
    if (payloadLen == 126) { if (len < 4) return ""; payloadLen = ((uint64_t)(unsigned char)data[2] << 8) | (unsigned char)data[3]; offset = 4; }
    else if (payloadLen == 127) { if (len < 10) return ""; payloadLen = 0; for (int i = 0; i < 8; ++i) payloadLen = (payloadLen << 8) | (unsigned char)data[2+i]; offset = 10; }
    const unsigned char* maskKey = nullptr;
    if (masked) { if (len < offset + 4) return ""; maskKey = (const unsigned char*)(data + offset); offset += 4; }
    if (len < offset + payloadLen) return "";
    std::string payload(payloadLen, '\0');
    for (uint64_t i = 0; i < payloadLen; ++i) payload[i] = data[offset + i] ^ (masked ? maskKey[i % 4] : 0);
    return payload;
}

static void handleWsMessage(SOCKET client, const std::string& payload)
{
    const char* d = payload.c_str();
    const size_t l = payload.size();
    size_t pos = 0;
    std::string type;
    if (!getString(d, l, "type", pos, type)) return;
    if (type == "select_symbol") {
        size_t p = 0; std::string symbol;
        if (!getString(d, l, "symbol", p, symbol)) return;
#ifdef TRADING_BROKER_COINBASE
        if (symbol.size() > 32) return;
        for (char c : symbol) if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '.')) return;
#else
        if (symbol.find(':') == std::string::npos) symbol = "NSE:" + symbol;
        if ((symbol.rfind("NSE:", 0) != 0 && symbol.rfind("BSE:", 0) != 0) || symbol.size() > 48) return;
        for (char c : symbol) if (!(std::isalnum(static_cast<unsigned char>(c)) || c == ':' || c == '-' || c == '&' || c == '.')) return;
#endif
        requestSymbolSubscription(symbol);
        bool cached = false;
        { std::lock_guard<std::mutex> lock(g_state.marketMutex); auto it = g_state.candlesBySymbol.find(symbol); cached = it != g_state.candlesBySymbol.end() && !it->second.empty(); }
        {
            std::scoped_lock lock(g_state.marketMutex, g_volumeProfileMutex);
            g_state.activeSymbol = symbol;
            auto it = g_state.candlesBySymbol.find(symbol);
            std::lock_guard<std::mutex> candlesLock(g_state.candleMutex);
            g_state.candles = it == g_state.candlesBySymbol.end() ? std::vector<Candle>{} : it->second;
        }
        sendToClient(client, buildHistoryMessage(symbol));
        std::string vpSnapshot;
        { std::lock_guard<std::mutex> lock(g_volumeProfileMutex); auto& profile = volumeProfileForSymbol(symbol); profile.recomputeIfDirty(); vpSnapshot = profile.buildFullSnapshot(); }
        broadcast(withSymbol(std::move(vpSnapshot), symbol));
        selectDepthSymbol(symbol);
        const std::string depthSnapshot = latestDepthSnapshot(symbol);
        if (!depthSnapshot.empty()) sendToClient(client, depthSnapshot);
        if (!cached) {
            bool startJob = false;
            { std::lock_guard<std::mutex> lock(g_historyJobsMutex); startJob = g_historyJobs.insert(symbol).second; }
            if (startJob) std::thread([symbol]() {
                std::string history; DWORD status = 0;
                if (httpGetHistory(symbol, history, status) && parseHistory(symbol, history, status))
                    broadcast(buildHistoryMessage(symbol));
                std::lock_guard<std::mutex> lock(g_historyJobsMutex); g_historyJobs.erase(symbol);
            }).detach();
        }
    } else if (type == "vp_fixed_range") {
        size_t p1 = 0, p2 = 0; double s = 0, e = 0;
        if (!getDouble(d, l, "start", p1, s)) return;
        if (!getDouble(d, l, "end", p2, e)) return;
        std::string active; { std::lock_guard<std::mutex> lock(g_state.marketMutex); active = g_state.activeSymbol; }
        sendToClient(client, withSymbol(VolumeProfileEngine::computeFixedRange((int)s, (int)e), active));
    } else if (type == "vp_request") {
        std::string active; { std::lock_guard<std::mutex> lock(g_state.marketMutex); active = g_state.activeSymbol; }
        { std::lock_guard<std::mutex> lock(g_volumeProfileMutex); sendToClient(client, withSymbol(volumeProfileForSymbol(active).buildFullSnapshot(), active)); }
    } else if (type == "depth_request") {
        std::string active;
        { std::lock_guard<std::mutex> lock(g_state.marketMutex); active = g_state.activeSymbol; }
        const std::string snapshot = latestDepthSnapshot(active);
        if (!snapshot.empty()) sendToClient(client, snapshot);
    } else if (type == "options_request") {
        // Client explicitly asks for a fresh GEX snapshot for its selected symbol.
        // Runs in its own thread so the WS reader is not blocked.
        size_t p = 0;
        std::string symbol;
        if (getString(d, l, "symbol", p, symbol)) {
            if (symbol.find(':') == std::string::npos) symbol = "NSE:" + symbol;
            std::thread([symbol]() { fetchAndBroadcastOptionsGex(symbol); }).detach();
        } else {
            std::thread([]() { fetchAndBroadcastOptionsGex(); }).detach();
        }
    }
}

static void handleBrowser(SOCKET client)
{
    char buffer[8192];
    const int n = recv(client, buffer, sizeof(buffer) - 1, 0);
    if (n <= 0) { closesocket(client); return; }
    buffer[n] = 0;
    const std::string request(buffer, (size_t)n);

    if (headerContains(request, "Upgrade: websocket")) {
        const std::string keyName = "Sec-WebSocket-Key:";
        size_t p = request.find(keyName);
        if (p == std::string::npos) { closesocket(client); return; }
        p += keyName.size();
        while (p < request.size() && (request[p] == ' ' || request[p] == '\t')) ++p;
        size_t end = request.find("\r\n", p);
        if (end == std::string::npos) { closesocket(client); return; }
        const std::string key = request.substr(p, end - p);
        const std::string accept = sha1Base64(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        const std::string resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
        if (!sendAll(client, resp.data(), resp.size())) { closesocket(client); return; }
        {
            std::lock_guard<std::mutex> lock(g_state.clientsMutex);
            if ((int)g_state.clients.size() >= MAX_CLIENTS) { closesocket(client); return; }
            g_state.clients.push_back(client);
        }
        std::string active; { std::lock_guard<std::mutex> lock(g_state.marketMutex); active = g_state.activeSymbol; }
        sendToClient(client, buildHistoryMessage(active));
        { std::lock_guard<std::mutex> lock(g_volumeProfileMutex); auto& profile = volumeProfileForSymbol(active); profile.recomputeIfDirty(); sendToClient(client, withSymbol(profile.buildFullSnapshot(), active)); }
        const std::string snapshot = latestDepthSnapshot(active);
        if (!snapshot.empty()) sendToClient(client, snapshot);
        char recvBuf[4096];
        while (g_state.running.load()) {
            const int r = recv(client, recvBuf, sizeof(recvBuf), 0);
            if (r <= 0) break;
            if (r >= 2 && (recvBuf[0] & 0x0F) == 0x1) {
                std::string pl = decodeWsPayload(recvBuf, (size_t)r);
                if (!pl.empty()) handleWsMessage(client, pl);
            } else if (r >= 2 && (recvBuf[0] & 0x0F) == 0x8) { break; }
        }
        removeClient(client);
        closesocket(client);
        return;
    }

    // HTTP routing
    std::string path = "/";
    size_t ps = request.find(' ');
    if (ps != std::string::npos) { size_t pe = request.find(' ', ps + 1); if (pe != std::string::npos) path = request.substr(ps + 1, pe - ps - 1); }
    const size_t queryStart = path.find('?');
    if (queryStart != std::string::npos) path.resize(queryStart);

    if (path == "/symbols.csv") {
        std::error_code catalogError;
        if (g_symbolCsvPath.empty() || !std::filesystem::exists(g_symbolCsvPath, catalogError) || std::filesystem::file_size(g_symbolCsvPath, catalogError) == 0)
            prepareSymbolCatalog();
        if (g_symbolCsvPath.empty() || !std::filesystem::exists(g_symbolCsvPath, catalogError)) {
            const std::string unavailable = "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            sendAll(client, unavailable.data(), unavailable.size());
            closesocket(client);
            return;
        }
        std::ifstream input(g_symbolCsvPath, std::ios::binary);
        std::string body((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        if (body.empty()) {
            const std::string unavailable = "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            sendAll(client, unavailable.data(), unavailable.size());
            closesocket(client);
            return;
        }
        const std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: text/csv; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
        sendAll(client, resp.data(), resp.size());
    }
    else if (path == "/favicon.png") { serveStaticFile(client, "favicon.png", "image/png"); }
    else if (path == "/favicon2.png") { serveStaticFile(client, "favicon2.png", "image/png"); }
    else if (path == "/app.js") { serveStaticFile(client, "app.js", "application/javascript; charset=utf-8"); }
    else if (path == "/indicators.js" || path == "/indicator.js") { serveStaticFile(client, "indicator.js", "application/javascript; charset=utf-8"); }
    else if (path.size() > 3 && path.compare(path.size() - 3, 3, ".js") == 0
            && path.find("..") == std::string::npos
            && path.find('/', 1) == std::string::npos
            && path.find('\\') == std::string::npos) {
        serveStaticFile(client, path.c_str() + 1, "application/javascript; charset=utf-8");
    }
    else {
        std::string html = readFrontendFile("frontend.html");
        std::string body = html.empty() ? "<h1>frontend.html not found</h1>" : html;
        const std::string defaultSymbolToken = "__BACKEND_DEFAULT_SYMBOL__";
        const size_t defaultSymbolPosition = body.find(defaultSymbolToken);
        if (defaultSymbolPosition != std::string::npos)
            body.replace(defaultSymbolPosition, defaultSymbolToken.size(), DEFAULT_SYMBOL);
        const std::string brokerToken = "__BACKEND_BROKER__";
        const size_t brokerPosition = body.find(brokerToken);
        if (brokerPosition != std::string::npos)
            body.replace(brokerPosition, brokerToken.size(), ACTIVE_BROKER);
        const std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
        sendAll(client, resp.data(), resp.size());
    }
    closesocket(client);
}

void browserServer()
{
    SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == INVALID_SOCKET) { std::fprintf(stderr, "Cannot create HTTP socket: %d\n", WSAGetLastError()); return; }
    BOOL yes = TRUE;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(HTTP_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(server, (sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR || listen(server, 16) == SOCKET_ERROR) {
        std::fprintf(stderr, "HTTP server bind/listen failed: %d\n", WSAGetLastError());
        closesocket(server); return;
    }
    std::printf("[HTTP] http://localhost:%d\n", HTTP_PORT);
    while (g_state.running.load()) {
        sockaddr_in ca{}; int cl = sizeof(ca);
        SOCKET c = accept(server, (sockaddr*)&ca, &cl);
        if (c == INVALID_SOCKET) { if (!g_state.running.load()) break; continue; }
        std::thread(handleBrowser, c).detach();
    }
    closesocket(server);
}
