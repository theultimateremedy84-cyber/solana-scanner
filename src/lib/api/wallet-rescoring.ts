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
import { supabaseAdmin } from "@/integrations/supabase/client.server";
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

  const sb = supabaseAdmin;
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

  // ══════════════════════════════════════════════════════════════════════════
  // PASS 3 — total_tokens_traded refresh
  //
  // The refresh_wallet_token_counts() Supabase RPC is silently failing for
  // rescoring runs (DB reality: 338/835 wallets show total_tokens_traded=0).
  // This pass computes the count directly in JS from wallet_performance_history
  // and upserts it into wallets, bypassing the RPC entirely.
  //
  // This is lightweight: 864 perf-history rows across 835 wallets takes < 1s.
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`${LOG} ─── Pass 3: total_tokens_traded refresh`);
  const tokenCountsUpdated = await refreshTokenCounts(sb, result.errors);
  console.log(`${LOG} ─── Pass 3 complete: updated ${tokenCountsUpdated} wallets`);

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

// getSupabase() consolidated → supabaseAdmin from client.server

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pass 3: total_tokens_traded refresh (bypasses broken RPC)
// ---------------------------------------------------------------------------

/**
 * Compute total_tokens_traded for every wallet directly from
 * wallet_performance_history (COUNT DISTINCT token_address per wallet) and
 * upsert it into the wallets table.
 *
 * Runs in O(perf_history_rows) time — at 864 rows this is < 500 ms.
 * Replaces the unreliable refresh_wallet_token_counts() RPC call.
 *
 * @returns number of wallet rows updated
 */
async function refreshTokenCounts(
  sb:     ReturnType<typeof createClient>,
  errors: string[],
): Promise<number> {
  // ── Step 1: fetch all (wallet_address, token_address) from perf history ──
  // On any page error we abort entirely (return 0) rather than writing
  // partial counts — a partial upsert would undercount wallets whose pages
  // hadn't been fetched yet.
  const allRows: Array<{ wallet_address: string; token_address: string }> = [];
  try {
    let page = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("wallet_performance_history")
        .select("wallet_address,token_address")
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) {
        errors.push(`refreshTokenCounts page ${page}: ${error.message} — aborting to avoid partial writes`);
        return 0;   // abort: do not write any counts
      }
      if (!data?.length) break;
      for (const row of data) {
        allRows.push({
          wallet_address: row.wallet_address as string,
          token_address:  row.token_address  as string,
        });
      }
      if (data.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(`refreshTokenCounts fetch: ${err instanceof Error ? err.message : String(err)} — aborting`);
    return 0;
  }

  // ── Step 2: compute distinct token count per wallet ──────────────────────
  const countByWallet = new Map<string, Set<string>>();
  for (const { wallet_address, token_address } of allRows) {
    if (!countByWallet.has(wallet_address)) {
      countByWallet.set(wallet_address, new Set());
    }
    countByWallet.get(wallet_address)!.add(token_address);
  }

  // ── Step 3: batch upsert into wallets.total_tokens_traded ────────────────
  const upsertRows = Array.from(countByWallet.entries()).map(([wallet_address, tokens]) => ({
    wallet_address,
    total_tokens_traded: tokens.size,
  }));

  const CHUNK = 200;
  let updated = 0;
  for (let i = 0; i < upsertRows.length; i += CHUNK) {
    const chunk = upsertRows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("wallets")
      .upsert(chunk, { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) {
      errors.push(`refreshTokenCounts upsert chunk ${i}: ${error.message}`);
    } else {
      updated += chunk.length;
    }
  }

  return updated;
}
