#pragma once

// ============================================================
// VOLUME_PROFILE.H — Ultra-high-performance Volume Profile Engine
// ============================================================
//
// DESIGN GOALS:
//   - O(1) per-tick updates
//   - Fixed-point integer prices (no FP in hot path)
//   - Contiguous cache-friendly storage (flat vector, no map)
//   - Zero unnecessary allocations after warm-up
//   - Incremental dirty-level tracking for minimal recomputation
//   - Batched compact frontend messages (only changed levels)
//   - True aggressive buy/sell classification from bid/ask data
//
// TWO MODES:
//   1. Session Volume Profile — full trading session, auto-maintained
//   2. Fixed Range Volume Profile — arbitrary candle range, on-demand
//
// WHAT IT TRACKS PER PRICE LEVEL:
//   - buyVolume    (aggressive buying qty)
//   - sellVolume   (aggressive selling qty)
//   - totalVolume  (buyVolume + sellVolume + unclassified)
//   - delta        (buyVolume - sellVolume)
//
// DERIVED (recomputed only when dirty):
//   - POC  (Point of Control — price level with highest totalVolume)
//   - VAH  (Value Area High — upper bound of VALUE_AREA_PCT)
//   - VAL  (Value Area Low  — lower bound of VALUE_AREA_PCT)
//
// ============================================================

#include "config.h"
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

// ============================================================
// PRICE LEVEL — price-keyed traded volume, including fractional units
// ============================================================

struct PriceLevel {
    int64_t  price       = 0;  // fixed-point: actual_price * PRICE_SCALE
    double buyVolume   = 0.0;
    double sellVolume  = 0.0;
    double totalVolume = 0.0;
    double delta       = 0.0;  // buyVolume - sellVolume
};

// ============================================================
// VOLUME PROFILE ENGINE
// ============================================================

class VolumeProfileEngine {
public:
    VolumeProfileEngine();

    // ---- Hot path: called on every classified tick ----

    // Add a tick at the given price with the given side and quantity.
    // O(1) amortized — direct index into the flat vector.
    void addTick(double rawPrice, Side side, double qty);

    // Set the display step (actual instrument tick size in real price).
    // This is included in the JSON output so the frontend can render
    // rows at the correct width instead of defaulting to 0.01.
    void setDisplayStep(double step) { displayStep_ = step; }
    double getDisplayStep() const { return displayStep_; }

    // ---- Snapshot / query (called on broadcast timer) ----

    // Recompute POC, VAH, VAL if anything is dirty. O(N) over levels
    // but only when dirty, and N is typically small (hundreds).
    void recomputeIfDirty();

    // Build a compact JSON message with only the dirty levels since
    // the last call. Returns empty string if nothing changed.
    // Format: {"type":"vp","poc":<price>,"vah":<price>,"val":<price>,
    //          "levels":[{"p":<price>,"b":<buy>,"s":<sell>,"t":<total>,"d":<delta>}, ...]}
    std::string buildDirtyMessage();

    // Build a full snapshot JSON message (for new client connections).
    std::string buildFullSnapshot() const;

    // Reset the entire profile (e.g. new session).
    void reset();

    // ---- Fixed Range Volume Profile ----

    // Compute a VP for a specific price range. This creates a temporary
    // snapshot from the candle data and returns it as a JSON message.
    // startIdx/endIdx are candle indices in g_state.candles.
    // Returns: {"type":"vp_fixed","poc":..,"vah":..,"val":..,"levels":[...]}
    static std::string computeFixedRange(int startIdx, int endIdx);

    // ---- Accessors ----
    int64_t getPOC() const { return poc_; }
    int64_t getVAH() const { return vah_; }
    int64_t getVAL() const { return val_; }
    size_t  levelCount() const { return levels_.size(); }

private:
    // Convert raw double price to fixed-point integer
    static int64_t toFixedPrice(double price);

    // Convert fixed-point integer back to double
    static double fromFixedPrice(int64_t fp);

    // Ensure the levels_ vector covers the given fixed-point price.
    // Returns the index into levels_ for that price.
    size_t ensureLevel(int64_t fixedPrice);

    // ---- Storage ----

    // Contiguous array of price levels, sorted by price ascending.
    // The base price (levels_[0].price) is set on the first tick.
    // New prices extend the vector at either end (rare after warm-up).
    std::vector<PriceLevel> levels_;

    // The fixed-point price of levels_[0].
    int64_t basePrice_ = 0;

    // Tick size in fixed-point units (1 for PRICE_SCALE=100 means 0.01).
    // For instruments with a known tick size, set this in the constructor.
    int64_t tickSize_ = 1;

    // Whether basePrice_ has been initialized.
    bool initialized_ = false;

    // ---- Dirty tracking ----

    // Bitset of dirty level indices. Grows with levels_.
    // We use a simple vector<bool> (bitset) for cache efficiency.
    std::vector<bool> dirty_;
    bool anyDirty_ = false;

    // ---- Cached derived values ----
    int64_t poc_ = 0;
    int64_t vah_ = 0;
    int64_t val_ = 0;

    // Display tick size in real price units (e.g. 0.05 for Reliance).
    // Set via setDisplayStep() from the tick processor.
    double displayStep_ = 0.0;

    // ---- Thread safety ----
    // The engine is designed to be called from a single thread (the tick
    // processing thread). If you need multi-thread access, lock externally.
};

// ============================================================
// GLOBAL INSTANCE
// ============================================================

extern std::mutex g_volumeProfileMutex;
extern std::unordered_map<std::string, VolumeProfileEngine> g_volumeProfilesBySymbol;
VolumeProfileEngine& volumeProfileForSymbol(const std::string& symbol);
