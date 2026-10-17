cmake_minimum_required(VERSION 3.15)
project(TradingEngine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Read the selected provider from the shared application configuration.
set(BROKER_CONFIG_HEADER "${CMAKE_SOURCE_DIR}/include/config.h")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${BROKER_CONFIG_HEADER}")
file(READ "${BROKER_CONFIG_HEADER}" BROKER_CONFIG_CONTENT)
if(BROKER_CONFIG_CONTENT MATCHES "(^|\n)[ \t]*#define[ \t]+TRADING_BROKER_NAME[ \t]+\"(FYERS|COINBASE)\"")
    set(TRADING_BROKER "${CMAKE_MATCH_2}")
else()
    message(FATAL_ERROR "Set TRADING_BROKER_NAME to FYERS or COINBASE in include/config.h")
endif()
string(TOUPPER "${TRADING_BROKER}" TRADING_BROKER)
if(NOT TRADING_BROKER STREQUAL "FYERS" AND NOT TRADING_BROKER STREQUAL "COINBASE")
    message(FATAL_ERROR "TRADING_BROKER_NAME in include/config.h must be FYERS or COINBASE")
endif()
message(STATUS "Selected broker from include/config.h: ${TRADING_BROKER}")

# Generate the schema used by the selected provider.
find_package(Protobuf REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(PROTOBUF REQUIRED IMPORTED_TARGET protobuf)
pkg_check_modules(LIBWEBSOCKETS REQUIRED libwebsockets)
# Keep pkg-config's protobuf headers on the normal include path. GCC's
# include_next handling fails when this MinGW path is marked system-only.
get_target_property(PROTOBUF_INCLUDE_DIRS PkgConfig::PROTOBUF INTERFACE_INCLUDE_DIRECTORIES)
set_target_properties(PkgConfig::PROTOBUF PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES ""
    INTERFACE_SYSTEM_INCLUDE_DIRECTORIES ""
)
if(TRADING_BROKER STREQUAL "FYERS")
    add_subdirectory(fyers-c-sdk)
    protobuf_generate_cpp(TBT_PROTO_SRCS TBT_PROTO_HDRS proto/broker_schemas/fyers/msg.proto)
else()
    protobuf_generate_cpp(TBT_PROTO_SRCS TBT_PROTO_HDRS proto/broker_schemas/coinbase/coinbase_market_data.proto)
endif()

# ---- Sources ----
set(SOURCES
    src/main.cpp
    src/ws_handshake.cpp
    src/broker/data_historical.cpp
    src/broker/market_data.cpp
    src/broker/options_chain.cpp
    src/tick_processor.cpp
    src/volume_profile.cpp
    ${TBT_PROTO_SRCS}
    src/server.cpp
)

if(TRADING_BROKER STREQUAL "FYERS")
    list(APPEND SOURCES
        src/broker_adapters/fyers/data_historical.cpp
        src/broker_adapters/fyers/data_live.cpp
        src/broker_adapters/fyers/limit_order.cpp
        src/broker_adapters/fyers/provider.cpp
        src/broker_adapters/fyers/options_chain.cpp
    )
else()
    list(APPEND SOURCES
        src/broker_adapters/coinbase/data_historical.cpp
        src/broker_adapters/coinbase/data_live.cpp
        src/broker_adapters/coinbase/limit_order.cpp
    )
endif()

add_executable(TradingEngine ${SOURCES})

# ---- Include directories ----
target_include_directories(TradingEngine PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_CURRENT_BINARY_DIR}
    ${PROTOBUF_INCLUDE_DIRS}
    ${LIBWEBSOCKETS_INCLUDE_DIRS}
)
target_link_directories(TradingEngine PRIVATE
    ${PROTOBUF_LIBRARY_DIRS}
    ${LIBWEBSOCKETS_LIBRARY_DIRS}
)
target_compile_options(TradingEngine PRIVATE
    ${PROTOBUF_CFLAGS_OTHER}
    ${LIBWEBSOCKETS_CFLAGS_OTHER}
)

if(TRADING_BROKER STREQUAL "COINBASE")
    target_compile_definitions(TradingEngine PRIVATE TRADING_BROKER_COINBASE=1)
endif()

# ---- Link libraries ----
target_link_libraries(TradingEngine PRIVATE
    ws2_32
    winhttp
    PkgConfig::PROTOBUF
    ${LIBWEBSOCKETS_LIBRARIES}
)
if(TRADING_BROKER STREQUAL "FYERS")
    target_link_libraries(TradingEngine PRIVATE fyers-api-c)
endif()

# ---- Optimizations for Release ----
if(MSVC)
    target_compile_options(TradingEngine PRIVATE
        /W4           # High warning level
        /O2           # Full optimization in Release
        /Oi           # Enable intrinsics
        /GL           # Whole-program optimization
    )
    target_link_options(TradingEngine PRIVATE
        /LTCG         # Link-time code generation
    )
endif()

if(TRADING_BROKER STREQUAL "FYERS")
    add_custom_command(TARGET TradingEngine POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:fyers-api-c>" "$<TARGET_FILE_DIR:TradingEngine>"
        COMMENT "Copying Fyers SDK runtime dependency"
    )
endif()
