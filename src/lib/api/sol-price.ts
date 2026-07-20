// =============================================================================
// src/lib/api/sol-price.ts
//
// PURPOSE (P1 #8 fix — Singleton SOL Price):
//   getSolPriceUsd() was duplicated in wallet-collection-worker.ts and
//   token-discovery.ts (and possibly postLaunchWatcher.ts) each with their
//   own module-level cache. Under load this multiplied CoinGecko call rate
//   proportionally to the number of running modules. CoinGecko's free tier
//   allows ~10K calls/month; three independent caches blow through it under
//   sustained operation.
//
//   This module is the single source of truth. One cache, one caller.
//   Import getSolPriceUsd() from here and delete all local copies.
//
// USAGE:
//   import { getSolPriceUsd } from "@/lib/api/sol-price";
//   const solPrice = await getSolPriceUsd();
// =============================================================================

const CACHE_TTL_MS   = 10 * 60 * 1_000; // 10 minutes
const FALLBACK_PRICE = 150;             // conservative fallback if CoinGecko is down

let _cachedPrice      = FALLBACK_PRICE;
let _lastFetchedAt    = 0;
let _fetchInFlight: Promise<number> | null = null;

/**
 * Returns the current SOL/USD price from CoinGecko, using a 10-minute
 * module-level cache shared by all callers in this process.
 *
 * FIX (P1 #8): This is the canonical singleton. Delete the local
 * getSolPriceUsd() copies from wallet-collection-worker.ts and
 * token-discovery.ts and import this function instead.
 *
 * - Cache TTL: 10 minutes (same as the original per-module caches).
 * - Concurrent callers during a cache miss share a single in-flight request
 *   via promise coalescing — no thundering-herd CoinGecko calls.
 * - Falls back to the last known good price (or $150) on any error.
 */
export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (now - _lastFetchedAt < CACHE_TTL_MS) return _cachedPrice;

  // Coalesce concurrent callers: if a fetch is already in flight, await it
  // rather than firing a second request.
  if (_fetchInFlight) return _fetchInFlight;

  _fetchInFlight = (async () => {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { signal: AbortSignal.timeout(5_000) },
      );
      if (res.ok) {
        const json = (await res.json()) as { solana?: { usd?: number } };
        if (json.solana?.usd && json.solana.usd > 0) {
          _cachedPrice   = json.solana.usd;
          _lastFetchedAt = Date.now();
        }
      }
    } catch {
      // Non-fatal — return the cached / fallback value
    } finally {
      _fetchInFlight = null;
    }
    return _cachedPrice;
  })();

  return _fetchInFlight;
}

/** Force-invalidate the cache (useful for tests). */
export function invalidateSolPriceCache(): void {
  _lastFetchedAt = 0;
}
