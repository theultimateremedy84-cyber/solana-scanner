// =============================================================================
// graduation-tracker.ts — Developer Graduation Rate Tracker
//
// Polls DexScreener every 30 minutes for tokens in scan_history (source =
// 'discovery') that have not yet graduated from Pump.fun to Raydium.
// When a Raydium or Meteora pair is found, sets graduated_at + records the
// graduation market cap, enabling plan Tasks A10 (developer graduation
// probability) and A12 (developer fingerprinting).
//
// PREREQUISITES (run migrations before deploying this file):
//   supabase/migrations/20260716000001_scan_history_discovery_columns.sql
//   supabase/migrations/20260716000002_backfill_scan_history_from_discovery.sql
//
// HOW IT WORKS
//   1. Fetch up to BATCH_SIZE ungraduated discovery tokens (oldest first).
//   2. Check DexScreener for each (batched into groups of 30 comma-separated
//      addresses — DexScreener supports multi-token lookups).
//   3. Any token with a Raydium or Meteora pair is considered graduated.
//   4. Update scan_history.graduated_at + graduation_market_cap_usd for those.
//   5. Sleep INTERVAL_MS then repeat.
//
// RATE LIMITING
//   DexScreener's public API: 300 req/min, no API key required. Batching 30
//   tokens per request with 300 ms inter-batch delay keeps well within limits.
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG           = "[GraduationTracker]";
const INTERVAL_MS   = 30 * 60 * 1_000; // check every 30 minutes
const BATCH_SIZE    = 150;              // tokens to check per interval tick
const DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex/tokens";

let _running = false;

// ---------------------------------------------------------------------------
// One tick — fetch ungraduated tokens, check DexScreener, update DB
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (_running) return;
  _running = true;

  try {
    // Fetch ungraduated discovery tokens, oldest first.
    // "Oldest first" intentionally surfaces tokens that have been in the queue
    // longest — they are the most likely to have graduated by now.
    const { data: rows, error: fetchErr } = await supabaseAdmin
      .from("scan_history")
      .select("token_address, scanned_at")
      .eq("source", "discovery")
      .is("graduated_at", null)
      .order("scanned_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchErr) {
      console.error(`${LOG} Failed to fetch ungraduated tokens:`, fetchErr.message);
      return;
    }

    if (!rows?.length) {
      console.log(`${LOG} No ungraduated discovery tokens to check.`);
      return;
    }

    console.log(`${LOG} Checking ${rows.length} tokens for Raydium graduation…`);

    let graduatedCount = 0;

    // Process in sub-batches of 30 — DexScreener multi-token endpoint supports
    // up to 30 addresses per comma-separated request.
    for (let i = 0; i < rows.length; i += 30) {
      const batch   = rows.slice(i, i + 30);
      const addrs   = batch.map((r) => r.token_address).join(",");

      try {
        const res = await fetch(`${DEXSCREENER_URL}/${addrs}`, {
          signal: AbortSignal.timeout(10_000),
          headers: { "Accept": "application/json" },
        });

        if (!res.ok) {
          console.warn(`${LOG} DexScreener returned ${res.status} for batch ${i / 30}`);
          await sleep(1_000);
          continue;
        }

        const json = await res.json() as {
          pairs?: Array<{
            baseToken:  { address: string };
            dexId:      string;
            marketCap?: number;
            fdv?:       number;
          }>;
        };

        // A token is graduated when it has a Raydium or Meteora pair.
        // Pump.fun bonding-curve tokens only have "pumpfun" pairs until they
        // complete at ~$69k market cap and migrate to Raydium.
        const graduated = new Map<string, { marketCapUsd: number | null }>();
        for (const pair of json.pairs ?? []) {
          const dex  = pair.dexId ?? "";
          const addr = pair.baseToken?.address ?? "";
          if (!addr) continue;
          if (dex === "raydium" || dex === "meteora") {
            if (!graduated.has(addr)) {
              graduated.set(addr, { marketCapUsd: pair.marketCap ?? pair.fdv ?? null });
            }
          }
        }

        if (graduated.size === 0) {
          await sleep(300); // rate limit headroom
          continue;
        }

        // Write graduated_at for each confirmed graduation
        for (const [tokenAddress, info] of graduated) {
          const { error: updateErr } = await supabaseAdmin
            .from("scan_history")
            .update({
              graduated_at:              new Date().toISOString(),
              graduation_market_cap_usd: info.marketCapUsd,
            })
            .eq("token_address", tokenAddress)
            .eq("source", "discovery");

          if (updateErr) {
            console.warn(
              `${LOG} Failed to mark ${tokenAddress.slice(0, 8)}… as graduated:`,
              updateErr.message,
            );
          } else {
            graduatedCount++;
            console.log(
              `${LOG} ✓ ${tokenAddress.slice(0, 8)}… graduated — ` +
              `mcap=$${(info.marketCapUsd ?? 0).toFixed(0)}`,
            );
          }
        }

        await sleep(300); // respect DexScreener rate limit
      } catch (err) {
        console.warn(
          `${LOG} Batch ${i / 30} check failed:`,
          err instanceof Error ? err.message : String(err),
        );
        await sleep(1_000);
      }
    }

    console.log(
      `${LOG} Tick complete — ${graduatedCount} tokens marked as graduated ` +
      `(checked ${rows.length}).`,
    );
  } finally {
    _running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the graduation tracker. Safe to call multiple times — subsequent
 * calls are no-ops if already running. Fires immediately on first call, then
 * every INTERVAL_MS (30 minutes).
 *
 * Returns a stop function that clears the interval.
 */
export function startGraduationTracker(): () => void {
  if (_intervalHandle !== null) {
    console.log(`${LOG} Already running — ignoring duplicate start call.`);
    return () => { /* noop */ };
  }

  console.log(
    `${LOG} Starting — checks DexScreener for Raydium graduation every ` +
    `${INTERVAL_MS / 60_000} minutes. ` +
    `Requires migration 20260716000001 (graduated_at column).`,
  );

  // Initial tick after a 60-second warmup so other schedulers start first
  const warmupHandle = setTimeout(() => {
    void tick().catch((err) =>
      console.error(`${LOG} Initial tick failed:`, err instanceof Error ? err.message : String(err)),
    );
  }, 60_000);

  _intervalHandle = setInterval(() => {
    void tick().catch((err) =>
      console.error(`${LOG} Tick failed:`, err instanceof Error ? err.message : String(err)),
    );
  }, INTERVAL_MS);

  return () => {
    clearTimeout(warmupHandle);
    if (_intervalHandle !== null) {
      clearInterval(_intervalHandle);
      _intervalHandle = null;
    }
    console.log(`${LOG} Stopped.`);
  };
}
