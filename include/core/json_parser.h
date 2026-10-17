#pragma once

// ============================================================
// JSON_PARSER.H — Small format-neutral JSON field readers
// ============================================================
// Used by broker adapters and the browser server to read small JSON messages.
// No allocation-heavy JSON library is used on the hot tick path.
// Header-only: include wherever needed.

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

// ============================================================
// CORE FIND
// ============================================================

inline bool findValue(const char* data, size_t len, const char* key, size_t& pos, const char*& value)
{
    const size_t keyLen = std::strlen(key);
    for (size_t i = pos; i + keyLen + 3 <= len; ++i) {
        if (data[i] != '"' || std::memcmp(data + i + 1, key, keyLen) != 0 ||
            data[i + keyLen + 1] != '"' || data[i + keyLen + 2] != ':')
            continue;

        const char* p = data + i + keyLen + 3;
        while ((size_t)(p - data) < len && (*p == ' ' || *p == '\t')) ++p;
        value = p;
        pos = i + keyLen + 3;
        return true;
    }
    return false;
}

// ============================================================
// TYPED EXTRACTORS
// ============================================================

inline bool getDouble(const char* data, size_t len, const char* key, size_t& pos, double& out)
{
    const char* p = nullptr;
    if (!findValue(data, len, key, pos, p)) return false;

    char buf[48];
    size_t n = 0;
    while ((size_t)(p - data) < len && n < sizeof(buf) - 1) {
        const char c = *p;
        if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E')
            buf[n++] = c;
        else
            break;
        ++p;
    }
    if (!n) return false;

    buf[n] = 0;
    char* end = nullptr;
    out = std::strtod(buf, &end);
    return end != buf;
}

inline bool getUInt64(const char* data, size_t len, const char* key, size_t& pos, uint64_t& out)
{
    const char* p = nullptr;
    if (!findValue(data, len, key, pos, p)) return false;

    uint64_t result = 0;
    bool found = false;
    while ((size_t)(p - data) < len && *p >= '0' && *p <= '9') {
        found = true;
        result = result * 10 + (uint64_t)(*p - '0');
        ++p;
    }
    if (!found) return false;
    out = result;
    return true;
}

inline bool getUInt32(const char* data, size_t len, const char* key, size_t& pos, uint32_t& out)
{
    uint64_t v = 0;
    if (!getUInt64(data, len, key, pos, v) || v > UINT32_MAX) return false;
    out = (uint32_t)v;
    return true;
}

inline bool getString(const char* data, size_t len, const char* key, size_t& pos, std::string& out)
{
    const char* p = nullptr;
    if (!findValue(data, len, key, pos, p)) return false;
    if ((size_t)(p - data) >= len || *p != '"') return false;
    ++p;
    const char* start = p;
    while ((size_t)(p - data) < len && *p != '"') ++p;
    out.assign(start, (size_t)(p - start));
    return true;
}

inline bool isType(const char* data, size_t len, const char* wanted)
{
    size_t pos = 0;
    const char* p = nullptr;
    if (!findValue(data, len, "type", pos, p) || *p != '"') return false;
    ++p;
    const char* start = p;
    while ((size_t)(p - data) < len && *p != '"') ++p;
    const size_t n = (size_t)(p - start);
    return n == std::strlen(wanted) && std::memcmp(start, wanted, n) == 0;
}

