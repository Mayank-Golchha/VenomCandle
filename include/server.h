#pragma once

// ============================================================
// SERVER.H — Browser HTTP/WebSocket server + broadcast
// ============================================================

#include "config.h"
#include <string>

// Send raw bytes over a socket (blocks until all sent or error).
bool sendAll(SOCKET s, const char* data, size_t len);

// Send a WebSocket text frame to a single client.
bool sendWsText(SOCKET s, const std::string& payload);

// Remove a client from the global client list.
void removeClient(SOCKET s);

// Broadcast a WebSocket text message to all connected clients.
void broadcast(const std::string& payload);

// Build the history JSON message for initial client connection.
std::string buildHistoryMessage(const std::string& symbol);

// Serve static files and handle WebSocket upgrades.
// This blocks and runs the accept loop. Call from a detached thread.
void browserServer();
bool prepareSymbolCatalog();

// Read frontend.html from disk (or app.js / indicator.js).
std::string readFile(const char* filename);

// Serve a static file with the given content type.
void serveStaticFile(SOCKET client, const char* filename, const char* contentType);
