// ============================================================
// WS_HANDSHAKE.CPP — Base64 + SHA1 for the browser WebSocket handshake
// ============================================================

#include "ws_handshake.h"
#include <cstdint>
#include <vector>

std::string base64Encode(const unsigned char* data, size_t len)
{
    static const char table[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    std::string out;
    out.reserve(((len + 2) / 3) * 4);

    for (size_t i = 0; i < len; i += 3) {
        const uint32_t a = data[i];
        const uint32_t b = i + 1 < len ? data[i + 1] : 0;
        const uint32_t c = i + 2 < len ? data[i + 2] : 0;
        const uint32_t n = (a << 16) | (b << 8) | c;

        out.push_back(table[(n >> 18) & 63]);
        out.push_back(table[(n >> 12) & 63]);
        out.push_back(i + 1 < len ? table[(n >> 6) & 63] : '=');
        out.push_back(i + 2 < len ? table[n & 63] : '=');
    }
    return out;
}

static uint32_t rol(uint32_t x, uint32_t n)
{
    return (x << n) | (x >> (32 - n));
}

std::string sha1Base64(const std::string& input)
{
    std::vector<unsigned char> msg(input.begin(), input.end());
    const uint64_t bitLen = (uint64_t)msg.size() * 8;

    msg.push_back(0x80);
    while ((msg.size() % 64) != 56) msg.push_back(0);

    for (int i = 7; i >= 0; --i) msg.push_back((unsigned char)(bitLen >> (i * 8)));

    uint32_t h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE;
    uint32_t h3 = 0x10325476, h4 = 0xC3D2E1F0;

    for (size_t chunk = 0; chunk < msg.size(); chunk += 64) {
        uint32_t w[80]{};

        for (int i = 0; i < 16; ++i) {
            const unsigned char* p = msg.data() + chunk + i * 4;
            w[i] = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
                   ((uint32_t)p[2] << 8) | p[3];
        }

        for (int i = 16; i < 80; ++i)
            w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

        uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;

        for (int i = 0; i < 80; ++i) {
            uint32_t f, k;
            if (i < 20) {
                f = (b & c) | ((~b) & d);
                k = 0x5A827999;
            } else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ED9EBA1;
            } else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8F1BBCDC;
            } else {
                f = b ^ c ^ d;
                k = 0xCA62C1D6;
            }

            const uint32_t temp = rol(a, 5) + f + e + k + w[i];
            e = d;
            d = c;
            c = rol(b, 30);
            b = a;
            a = temp;
        }

        h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
    }

    unsigned char digest[20];
    const uint32_t h[5] = {h0, h1, h2, h3, h4};

    for (int i = 0; i < 5; ++i) {
        digest[i * 4 + 0] = (unsigned char)(h[i] >> 24);
        digest[i * 4 + 1] = (unsigned char)(h[i] >> 16);
        digest[i * 4 + 2] = (unsigned char)(h[i] >> 8);
        digest[i * 4 + 3] = (unsigned char)h[i];
    }

    return base64Encode(digest, sizeof(digest));
}
