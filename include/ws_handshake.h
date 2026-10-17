#pragma once

// ============================================================
// WS_HANDSHAKE.H — Base64 + SHA1 for the browser WebSocket handshake
// ============================================================

#include <string>

std::string base64Encode(const unsigned char* data, size_t len);
std::string sha1Base64(const std::string& input);
