// =============================================================================
// wallet-enrichment-queue.ts  (v1 — selective priority enrichment)
//
// Priority-ordered Helius enrichment that targets high-value wallets first
// within a configurable CU budget — replacing the previous first-come-first-
// served approach used by Step 7 of the wallet-collection-worker and the
// enrich-hollow-wallets.mjs script.
//
// PRIORITY ORDER (descending):
//   Tier 1 — whale + bot classifications (highest signal value)
//   Tier 2 — unenriched wallets (data_source = holder_scan) with largest
//             total_sol_invested (biggest traders first)
//   Tier 3 — remaining holder_scan wallets sorted by total_tokens_bought
//
// BUDGET MODEL:
//   Hourly budget: reads from globalThis.__heliusHourly__ (shared singleton
//   maintained by _consumeHC in wallet-collection-worker.ts). We READ the
//   counter to decide how many wallets we can afford, but we do NOT write to
//   it — the actual CU deductions happen inside enrichWalletsForToken via the
//   existing _consumeHC calls. This prevents double-counting.
//
//   Monthly budget: tracked separately in globalThis.__heliusMonthly__ as a
//   best-estimate accumulator (not authoritative — Helius does not expose a
//   live monthly counter via API). It provides an additional soft ceiling to
//   prevent month-level runaway spend.
//
// USAGE:
//   a) wallet-collection-worker.ts Step 7 (replaces the flat walletAddresses slice)
//   b) A dedicated Railway Cron Job for background batch enrichment
//   c) POST /api/enrich-priority (optional manual trigger)
//
// ENV VARS (all optional — sensible defaults for free tier):
//   HELIUS_ENRICH_WALLETS      max wallets per job call    (default 0 = disabled)
//   HELIUS_HOURLY_BUDGET       CU cap per hour             (default 1000)
//   HELIUS_MONTHLY_BUDGET      CU cap per month            (default 1_000_000)
//   HELIUS_CU_PER_WALLET       estimated CU per wallet     (default 20)
// =============================================================================

import { createClient }          from "@supabase/supabase-js";
import { getSupabase, getHeliusKey } from "./wallet-collection-worker";
import { enrichWalletsForToken }  from "./wallet-enricher";
import type { TokenPriceData }    from "./wallet-collection.types";

const LOG = "[EnrichQueue]";

// ── Tuning ────────────────────────────────────────────────────────────────────

/** Estimated Helius CU cost per wallet (2 signature pages × ~10 CU each). */
const EST_CU_PER_WALLET = parseInt(process.env.HELIUS_CU_PER_WALLET ?? "20", 10) || 20;

/** Classification tiers — lower number = higher priority. */
const CLASSIFICATION_PRIORITY: Record<string, number> = {
  whale:       1,
  bot:         2,
  smart_money: 3,
  sniper:      4,
  retail:      5,
  unknown:     6,
};

/** Supabase IN clause limit — paginate in chunks of this size. */
const SUPABASE_IN_LIMIT = 1000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface EnrichQueueResult {
  walletsEnqueued:  number;   // wallets selected for enrichment this run
  walletsEnriched:  number;   // wallets successfully Helius-enriched
  walletsSkipped:   number;   // already at helius_full_history — skipped
  walletsTruncated: number;   // budget ran out before processing all candidates
  errors:           string[];
  durationMs:       number;
}

export interface EnrichQueueOpts {
  /** Maximum wallets to enrich this run. Hard ceiling regardless of budget. */
  maxWallets?:     number;
  /** Delay (ms) between Helius calls. Default 1000ms. */
  delayMs?:        number;
  /** When provided, enrichment is scoped to a single token's wallets only. */
  tokenAddress?:   string;
  /** Price data for the token (required when tokenAddress is set). */
  priceData?:      TokenPriceData;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run a priority-ordered enrichment pass.
 *
 * Selects candidate wallets from wallet_raw_tx_metrics WHERE data_source =
 * 'holder_scan' (unenriched), sorts them by classification tier then by
 * total_sol_invested DESC, then enriches them via Helius within the hourly
 * and monthly CU budget.
 *
 * Graceful truncation: the loop stops as soon as the next wallet would exceed
 * the remaining budget. CU deductions happen inside enrichWalletsForToken
 * via the existing _consumeHC mechanism — this function only reads the budget
 * counter to decide how many wallets to attempt, never writes to it directly.
 */
export async function runPriorityEnrichmentQueue(
  opts: EnrichQueueOpts = {},
): Promise<EnrichQueueResult> {
  const {
    maxWallets = parseInt(process.env.HELIUS_ENRICH_WALLETS ?? "0", 10) || 0,
    delayMs    = 1000,
    tokenAddress,
    priceData,
  } = opts;

  const startTime = Date.now();
  const result: EnrichQueueResult = {
    walletsEnqueued: 0, walletsEnriched: 0, walletsSkipped: 0,
    walletsTruncated: 0, errors: [], durationMs: 0,
  };

  if (maxWallets <= 0) {
    console.log(
      `${LOG} Enrichment disabled (HELIUS_ENRICH_WALLETS=0). ` +
      "Set HELIUS_ENRICH_WALLETS=N in Railway Variables to enable.",
    );
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const heliusKey = getHeliusKey();
  if (!heliusKey) {
    result.errors.push("HELIUS_API_KEY not set — priority enrichment requires Helius");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const sb = getSupabase();
  if (!sb) {
    result.errors.push("Supabase unavailable");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── Budget pre-check (READ ONLY — actual deductions happen in _consumeHC) ──
  // We read the shared hourly counter to estimate how many wallets the remaining
  // budget can cover. We do NOT write to it here — enrichWalletsForToken calls
  // _consumeHC internally which is the authoritative write path.
  const remainingCu    = getRemainingCu();
  const walletBudget   = Math.min(
    maxWallets,
    remainingCu === Infinity ? maxWallets : Math.floor(remainingCu / EST_CU_PER_WALLET),
  );

  if (walletBudget <= 0) {
    console.warn(
      `${LOG} Budget exhausted before enrichment started ` +
      `(remaining: ${remainingCu === Infinity ? "∞" : remainingCu} CU — need ${EST_CU_PER_WALLET} per wallet)`,
    );
    result.durationMs = Date.now() - startTime;
    return result;
  }

  console.log(
    `${LOG} ═══ Priority enrichment START ` +
    `maxWallets=${maxWallets} walletBudget=${walletBudget} ` +
    `remainingCu=${remainingCu === Infinity ? "∞" : remainingCu}`,
  );

  // ── Build priority candidate list ─────────────────────────────────────────
  const candidates = await buildPriorityCandidates(
    sb, walletBudget * 3, tokenAddress, result.errors,
  );

  if (candidates.length === 0) {
    console.log(`${LOG} No unenriched holder_scan wallets found — nothing to do`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  result.walletsEnqueued = Math.min(candidates.length, walletBudget);
  console.log(
    `${LOG} Selected ${result.walletsEnqueued} wallets from ${candidates.length} candidates`,
  );

  // ── Enrich in priority order ───────────────────────────────────────────────
  let processed = 0;

  for (const candidate of candidates) {
    if (processed >= walletBudget) {
      result.walletsTruncated++;
      continue;
    }

    // Re-check remaining budget before each wallet (authoritative counter).
    // _consumeHC may have been called by concurrent jobs since we started.
    const remaining = getRemainingCu();
    if (remaining !== Infinity && remaining < EST_CU_PER_WALLET) {
      console.warn(
        `${LOG} Budget ceiling reached mid-queue ` +
        `(${remaining} CU remaining < ${EST_CU_PER_WALLET} needed) — stopping gracefully. ` +
        `${candidates.length - processed} wallets deferred to next run.`,
      );
      result.walletsTruncated += candidates.length - processed;
      break;
    }

    const token  = candidate.tokenAddress;
    const wallet = candidate.walletAddress;

    // Resolve priceData: use provided arg for single-token mode, else fetch
    let tokenPrice: TokenPriceData;
    if (priceData && tokenAddress === token) {
      tokenPrice = priceData;
    } else {
      const { fetchTokenPrice } = await import("./wallet-collection-worker");
      tokenPrice = await fetchTokenPrice(token);
    }

    try {
      const enrichResult = await enrichWalletsForToken({
        tokenAddress:    token,
        walletAddresses: [wallet],
        priceData:       tokenPrice,
        maxWallets:      1,
        delayMs:         0, // delay handled below between wallets
      });

      result.walletsEnriched  += enrichResult.walletsEnriched;
      result.walletsSkipped   += enrichResult.walletsSkipped;
      result.errors.push(...enrichResult.errors);

      // Update monthly estimate (best-effort accumulator)
      recordMonthlyUsage(EST_CU_PER_WALLET);

      console.log(
        `${LOG} [${processed + 1}/${result.walletsEnqueued}] ` +
        `${wallet.slice(0, 8)}… token=${token.slice(0, 8)}… ` +
        `class=${candidate.classification} sol=${candidate.solInvested.toFixed(3)} ` +
        `enriched=${enrichResult.walletsEnriched} skipped=${enrichResult.walletsSkipped}`,
      );
    } catch (err) {
      const msg = `${wallet.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`${LOG} ✗ ${msg}`);
      result.errors.push(msg);
    }

    processed++;
    if (processed < result.walletsEnqueued && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  result.durationMs = Date.now() - startTime;
  console.log(
    `${LOG} ═══ DONE — enqueued=${result.walletsEnqueued} ` +
    `enriched=${result.walletsEnriched} skipped=${result.walletsSkipped} ` +
    `truncated=${result.walletsTruncated} ` +
    `errors=${result.errors.length} duration=${result.durationMs}ms`,
  );
  return result;
}

// ── Candidate builder ─────────────────────────────────────────────────────────

interface EnrichCandidate {
  walletAddress:  string;
  tokenAddress:   string;
  classification: string;
  solInvested:    number;
  tokensBought:   number;
  priorityTier:   number;
}

/**
 * Builds a priority-sorted list of unenriched wallets.
 *
 * Only reads wallets at data_source = 'holder_scan' — wallets already at
 * 'helius_full_history' are excluded (no wasted CUs re-enriching them).
 *
 * Classification lookup is paginated in chunks of SUPABASE_IN_LIMIT (1000)
 * to handle arbitrarily large candidate sets without silently truncating.
 *
 * Sort order:
 *   1. Classification priority tier (whale=1, bot=2, smart_money=3, …)
 *   2. total_sol_invested DESC (biggest traders within each tier)
 *   3. total_tokens_bought DESC (tiebreaker)
 */
async function buildPriorityCandidates(
  sb:           ReturnType<typeof createClient>,
  fetchLimit:   number,
  tokenAddress: string | undefined,
  errors:       string[],
): Promise<EnrichCandidate[]> {
  // Step A: fetch unenriched raw metrics rows (holder_scan only)
  let query = sb
    .from("wallet_raw_tx_metrics")
    .select("wallet_address, token_address, total_sol_invested, total_tokens_bought")
    .eq("data_source", "holder_scan")
    .limit(Math.min(fetchLimit * 2, 5000));

  if (tokenAddress) {
    query = query.eq("token_address", tokenAddress);
  }

  const { data: rawRows, error: rawErr } = await query;
  if (rawErr) {
    errors.push(`candidate fetch: ${rawErr.message}`);
    return [];
  }
  if (!rawRows?.length) return [];

  // Step B: fetch wallet classifications in paginated chunks (handles > 1000)
  const walletAddrs = [...new Set(rawRows.map((r) => r.wallet_address as string))];
  const classMap = new Map<string, { classification: string; score: number }>();

  for (let i = 0; i < walletAddrs.length; i += SUPABASE_IN_LIMIT) {
    const chunk = walletAddrs.slice(i, i + SUPABASE_IN_LIMIT);
    const { data: walletRows, error: wErr } = await sb
      .from("wallets")
      .select("wallet_address, wallet_classification, intelligence_score")
      .in("wallet_address", chunk);

    if (wErr) {
      errors.push(`classification fetch chunk ${Math.floor(i / SUPABASE_IN_LIMIT)}: ${wErr.message}`);
      // Non-fatal — wallets missing from the map default to 'unknown' tier
    } else {
      for (const w of walletRows ?? []) {
        classMap.set(w.wallet_address as string, {
          classification: (w.wallet_classification as string) ?? "unknown",
          score:          Number(w.intelligence_score ?? 0),
        });
      }
    }
  }

  // Step C: build candidates with priority metadata
  const candidates: EnrichCandidate[] = rawRows.map((r) => {
    const walletInfo = classMap.get(r.wallet_address as string);
    const classification = walletInfo?.classification ?? "unknown";
    return {
      walletAddress:  r.wallet_address as string,
      tokenAddress:   r.token_address  as string,
      classification,
      solInvested:    Number(r.total_sol_invested ?? 0),
      tokensBought:   Number(r.total_tokens_bought ?? 0),
      priorityTier:   CLASSIFICATION_PRIORITY[classification] ?? 6,
    };
  });

  // Step D: sort by (tier ASC, solInvested DESC, tokensBought DESC)
  candidates.sort((a, b) => {
    if (a.priorityTier !== b.priorityTier) return a.priorityTier - b.priorityTier;
    if (b.solInvested  !== a.solInvested)  return b.solInvested  - a.solInvested;
    return b.tokensBought - a.tokensBought;
  });

  return candidates.slice(0, fetchLimit);
}

// ── Budget helpers ────────────────────────────────────────────────────────────
//
// getRemainingCu() reads the shared globalThis.__heliusHourly__ counter that
// _consumeHC (wallet-collection-worker.ts) maintains as the authoritative
// hourly budget. We READ it here to gate how many wallets we attempt but we
// never write to it — _consumeHC is the single writer for hourly CU.
//
// recordMonthlyUsage() updates a separate monthly accumulator that is NOT
// shared with _consumeHC (which only tracks hourly). This is a best-estimate
// soft ceiling; it does not reflect Helius's own monthly counter precisely.

function getRemainingCu(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const now = Date.now();

  // Initialise hourly window if not already set by _consumeHC
  if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
    g.__heliusHourly__ = {
      budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "1000", 10) || 0,
      used:   0,
      window: now,
      warned: false,
    };
  }

  const hourlyBudget = g.__heliusHourly__.budget as number;
  const hourlyUsed   = g.__heliusHourly__.used   as number;
  const remainingHourly = hourlyBudget > 0
    ? Math.max(0, hourlyBudget - hourlyUsed)
    : Infinity;

  // Monthly soft ceiling
  if (!g.__heliusMonthly__ || now - g.__heliusMonthly__.window >= 30 * 86_400_000) {
    g.__heliusMonthly__ = {
      budget: parseInt(process.env.HELIUS_MONTHLY_BUDGET ?? "1000000", 10) || 0,
      used:   0,
      window: now,
    };
  }

  const monthlyBudget = g.__heliusMonthly__.budget as number;
  const monthlyUsed   = g.__heliusMonthly__.used   as number;
  const remainingMonthly = monthlyBudget > 0
    ? Math.max(0, monthlyBudget - monthlyUsed)
    : Infinity;

  return Math.min(remainingHourly, remainingMonthly);
}

function recordMonthlyUsage(cu: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.__heliusMonthly__?.budget > 0) {
    g.__heliusMonthly__.used += cu;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
