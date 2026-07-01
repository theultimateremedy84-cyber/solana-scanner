// =============================================================================
// Wallet Rescoring  (scoring-patch v1)
//
// Standalone bulk rescorer that re-classifies ALL existing wallets from
// data already in the database — no Helius API call required.
//
// Reads from: wallet_raw_tx_metrics (primary)
//             wallet_performance_history (fallback when raw metrics absent)
// Writes to:  wallets (wallet_classification, intelligence_score, win_rate,
//                      average_roi, conviction_score)
//
// Run via: POST /api/rescore-wallets
//
// When to run:
//   - After deploying the scoring-patch (one-time backfill of 835 wallets)
//   - After any change to wallet-classifier.ts tuning constants
//   - Periodically (e.g. daily) to catch wallets enriched by other workers
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { classifyWallets } from "./wallet-enricher";

const LOG = "[WalletRescoring]";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RescoringResult {
  totalWallets:  number;
  classified:    number;
  batches:       number;
  errors:        string[];
  durationMs:    number;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Re-score all wallets in the database from their existing raw metrics.
 * Processes wallets in batches of `batchSize` to stay within Supabase
 * request size limits.
 *
 * @param batchSize  Wallets to classify per batch (default 200).
 * @param delayMs    Pause between batches in ms (default 0 — safe since
 *                   we're only reading/writing Supabase, not Helius).
 */
export async function rescoreAllWallets(opts: {
  batchSize?: number;
  delayMs?:   number;
} = {}): Promise<RescoringResult> {
  const batchSize = opts.batchSize ?? 200;
  const delayMs   = opts.delayMs   ?? 0;
  const startTime = Date.now();

  const result: RescoringResult = {
    totalWallets: 0,
    classified:   0,
    batches:      0,
    errors:       [],
    durationMs:   0,
  };

  const sb = getSupabase();
  if (!sb) {
    result.errors.push("Supabase credentials not configured");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(`${LOG} ═══ Starting full wallet rescore`);

  // ── Step 1: collect all distinct wallet addresses ─────────────────────────
  // Primary source: wallet_raw_tx_metrics (most accurate — has buy/sell counts)
  // Fallback:       wallets table (all 835 wallets are here)
  const walletAddresses = await collectAllWalletAddresses(sb, result.errors);

  if (walletAddresses.length === 0) {
    console.log(`${LOG} No wallets found to rescore`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  result.totalWallets = walletAddresses.length;
  console.log(`${LOG} Found ${walletAddresses.length} wallets to rescore`);

  // ── Step 2: process in batches ────────────────────────────────────────────
  // classifyWallets() reads wallet_raw_tx_metrics for the given address list,
  // groups by wallet, runs classifyWallet(), and upserts into wallets table.
  // We pass a dummy tokenAddress (empty string) since classifyWallets uses
  // cross-token data from wallet_raw_tx_metrics (the tokenAddress parameter
  // was only used to scope a previous DB query that has since been removed).
  for (let offset = 0; offset < walletAddresses.length; offset += batchSize) {
    const batch = walletAddresses.slice(offset, offset + batchSize);
    const batchErrors: string[] = [];

    const classified = await classifyWallets(sb, batch, "", batchErrors);

    result.classified += classified;
    result.batches++;
    result.errors.push(...batchErrors);

    console.log(
      `${LOG} Batch ${result.batches}: classified ${classified}/${batch.length} ` +
      `(${offset + batch.length}/${walletAddresses.length} total)`,
    );

    if (delayMs > 0) await sleep(delayMs);
  }

  result.durationMs = Date.now() - startTime;
  console.log(
    `${LOG} ═══ DONE — wallets=${result.totalWallets} classified=${result.classified} ` +
    `batches=${result.batches} errors=${result.errors.length} ` +
    `duration=${result.durationMs}ms`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all distinct wallet addresses from the database.
 * Tries wallet_raw_tx_metrics first (subset with real data),
 * then unions in any additional wallets from the wallets table.
 */
async function collectAllWalletAddresses(
  sb:     ReturnType<typeof createClient>,
  errors: string[],
): Promise<string[]> {
  const seen = new Set<string>();

  // Source 1: wallet_raw_tx_metrics — all wallets with any metrics data
  try {
    // Fetch in pages to handle > 1000 rows
    let page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("wallet_raw_tx_metrics")
        .select("wallet_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) { errors.push(`raw_metrics page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const row of data) seen.add(row.wallet_address as string);
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`collectWallets raw_metrics: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Source 2: wallets table — catches any wallets not yet in raw_metrics
  try {
    let page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("wallets")
        .select("wallet_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) { errors.push(`wallets page ${page}: ${error.message}`); break; }
      if (!data?.length) break;
      for (const row of data) seen.add(row.wallet_address as string);
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`collectWallets wallets: ${err instanceof Error ? err.message : String(err)}`);
  }

  return Array.from(seen);
}

function getSupabase(): ReturnType<typeof createClient> | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
