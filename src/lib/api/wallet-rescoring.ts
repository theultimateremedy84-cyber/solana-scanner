// =============================================================================
// Wallet Rescoring  (v2 — adds P2-B Discovery Score computation)
//
// Changes from v1:
//   ADDED  Step 2: computeDiscoveryScores() — runs after wallet classification
//          to populate discovery_score, discovery_confidence, discovery_tier,
//          total_discoveries, successful_discoveries, avg_entry_market_cap
//          on the wallets table.
//
// Unchanged from v1:
//   Step 1: classifyWallets() — re-classifies ALL existing wallets from
//   wallet_raw_tx_metrics (primary) or wallet_performance_history (fallback)
//   and writes wallet_classification, intelligence_score, win_rate,
//   average_roi, conviction_score to wallets table.
//
// Standalone bulk rescorer — no Helius API calls required.
//
// Run via: POST /api/rescore-wallets
//
// When to run:
//   - After deploying P2-B prerequisites migration (one-time backfill)
//   - After any tuning change to wallet-classifier.ts or wallet-discovery-score.ts
//   - Periodically (e.g. every 20 min via rescore-scheduler.ts) to keep scores fresh
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { classifyWallets } from "./wallet-enricher";
import { computeDiscoveryScores } from "./wallet-discovery-score";

const LOG = "[WalletRescoring]";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RescoringResult {
  totalWallets:      number;
  classified:        number;
  discoveryScored:   number;
  batches:           number;
  errors:            string[];
  durationMs:        number;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Re-score all wallets in the database from their existing raw metrics.
 *
 * Runs two sequential passes:
 *   Pass 1 — Intelligence classification (classifyWallets via wallet-enricher)
 *   Pass 2 — Discovery score computation  (computeDiscoveryScores via wallet-discovery-score)
 *
 * @param batchSize  Wallets to classify per batch (default 200).
 * @param delayMs    Pause between classification batches in ms (default 0).
 */
export async function rescoreAllWallets(opts: {
  batchSize?: number;
  delayMs?:   number;
} = {}): Promise<RescoringResult> {
  const batchSize = opts.batchSize ?? 200;
  const delayMs   = opts.delayMs   ?? 0;
  const startTime = Date.now();

  const result: RescoringResult = {
    totalWallets:    0,
    classified:      0,
    discoveryScored: 0,
    batches:         0,
    errors:          [],
    durationMs:      0,
  };

  const sb = getSupabase();
  if (!sb) {
    result.errors.push("Supabase credentials not configured");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(`${LOG} ═══ Starting full wallet rescore (intelligence + discovery)`);

  // ── Collect all distinct wallet addresses ────────────────────────────────
  const walletAddresses = await collectAllWalletAddresses(sb, result.errors);

  if (walletAddresses.length === 0) {
    console.log(`${LOG} No wallets found to rescore`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  result.totalWallets = walletAddresses.length;
  console.log(`${LOG} Found ${walletAddresses.length} wallets to rescore`);

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 1 — Intelligence classification
  // classifyWallets() reads wallet_raw_tx_metrics, runs classifyWallet(),
  // and upserts wallet_classification, intelligence_score, win_rate,
  // average_roi, conviction_score into wallets table.
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${LOG} ─── Pass 1: Intelligence classification`);

  for (let offset = 0; offset < walletAddresses.length; offset += batchSize) {
    const batch = walletAddresses.slice(offset, offset + batchSize);
    const batchErrors: string[] = [];

    // Pass empty tokenAddress — classifyWallets uses cross-token data from
    // wallet_raw_tx_metrics; the tokenAddress parameter scopes no query here.
    const classified = await classifyWallets(sb, batch, "", batchErrors);

    result.classified += classified;
    result.batches++;
    result.errors.push(...batchErrors);

    console.log(
      `${LOG} Pass 1 batch ${result.batches}: classified ${classified}/${batch.length} ` +
      `(${offset + batch.length}/${walletAddresses.length} total)`,
    );

    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(
    `${LOG} ─── Pass 1 complete: ${result.classified}/${result.totalWallets} classified`,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 2 — Discovery score computation  (P2-B)
  // computeDiscoveryScores() reads wallet_performance_history and
  // wallet_token_activity, computes the 5-factor weighted score with
  // confidence weighting, and upserts discovery_score, discovery_confidence,
  // discovery_tier, total_discoveries, successful_discoveries,
  // avg_entry_market_cap into wallets table.
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${LOG} ─── Pass 2: Discovery score computation`);

  const discoveryResult = await computeDiscoveryScores(sb, walletAddresses, result.errors);
  result.discoveryScored = discoveryResult.walletsScored;

  console.log(
    `${LOG} ─── Pass 2 complete: ${result.discoveryScored}/${result.totalWallets} discovery-scored`,
  );

  // ── Final summary ─────────────────────────────────────────────────────────
  result.durationMs = Date.now() - startTime;
  console.log(
    `${LOG} ═══ DONE — wallets=${result.totalWallets} ` +
    `classified=${result.classified} discovery=${result.discoveryScored} ` +
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
 * Primary source: wallet_raw_tx_metrics (most wallets with real evidence).
 * Fallback:       wallets table (guarantees full 835-wallet coverage).
 */
async function collectAllWalletAddresses(
  sb:     ReturnType<typeof createClient>,
  errors: string[],
): Promise<string[]> {
  const seen = new Set<string>();

  // Source 1: wallet_raw_tx_metrics
  try {
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

  // Source 2: wallets table (catches any wallets not yet in raw_metrics)
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
