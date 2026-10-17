#pragma once

#include <string>

inline std::string fyersAppId() {
    const char* value = "Your-Fyers-App-Id";
    return value ? value : "";
}

inline std::string fyersAccessToken() {
    const char* value = "Your-Fyers-Acess-Token";
    return value ? value : "";
}
