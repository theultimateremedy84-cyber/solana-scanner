// =============================================================================
// leaderboard.functions.ts  (P3-A — Smart Money Leaderboard)
//
// Server functions for the /smart-money leaderboard page.
//
// Exports:
//   getLeaderboard       — paginated wallet list with rich score data
//   getLeaderboardStats  — aggregate counts used in the summary bar
//   getEnrichmentStatus  — live enrichment coverage for the progress indicator
//
// All functions use the service-role key so they can read wallets regardless
// of RLS policies (the leaderboard is an intelligence surface, not a public
// data endpoint).
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
// P2-D: consolidated to canonical service-role singleton — no anon-key fallback,
// no local raw-fetch helpers. supabaseAdmin throws at construction if env vars
// are missing, surfacing the misconfiguration immediately.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getEnrichmentCoverage } from "./enrich-unenriched-scheduler";

const CLASSIFICATION_VALUES = [
  "smart_money",
  "sniper",
  "whale",
  "bot",
  "retail",
  "unknown",
] as const;

type Classification = (typeof CLASSIFICATION_VALUES)[number];

// scoring-patch v7 (2026-07-13, architecture review — leaderboard gating):
// minimum wallet age and maximum inactivity window for leaderboard eligibility.
// Read-time filters only — no schema change, no rescore dependency.
const MIN_WALLET_AGE_DAYS  = 3;
const MAX_INACTIVITY_DAYS  = 90;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LeaderboardWallet {
  wallet_address:        string;
  wallet_classification: Classification | null;
  intelligence_score:    number | null;
  discovery_score:       number | null;
  discovery_tier:        string | null;
  win_rate:              number | null;
  average_roi:           number | null;
  conviction_score:      number | null;
  total_tokens_traded:   number;
  total_buys:            number;
  total_sells:           number;
  realized_pnl:          number;
  unrealized_pnl:        number;
  first_seen_timestamp:  string | null;
  last_seen_timestamp:   string | null;
  updated_at:            string;
}

export interface LeaderboardStats {
  total:       number;
  smart_money: number;
  sniper:      number;
  whale:       number;
  bot:         number;
  retail:      number;
  unknown:     number;
  with_score:  number;   // wallets where intelligence_score IS NOT NULL
  without_score: number; // wallets where intelligence_score IS NULL (unenriched)
}

export interface EnrichmentStatus {
  totalWallets:    number;
  enrichedWallets: number;
  hollowWallets:   number;
  coveragePct:     number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paginated, filterable leaderboard query.
 * Sorted by intelligence_score DESC, nulls last (unenriched wallets sink to bottom).
 */
export const getLeaderboard = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      limit:          z.number().int().min(1).max(200).optional().default(50),
      offset:         z.number().int().min(0).optional().default(0),
      classification: z.enum(CLASSIFICATION_VALUES).optional(),
      minScore:       z.number().min(0).max(1).optional(),
      sortBy:         z.enum(["intelligence_score", "discovery_score", "win_rate", "average_roi"]).optional().default("intelligence_score"),
      // scoring-patch v6 (2026-07-12): the leaderboard had zero quality gates —
      // any wallet with a non-null intelligence_score could top it, including
      // wallets with a single unrealized trade and 0 realized PnL (confirmed
      // live: every top-20 wallet by score before this patch). Default to
      // qualified-only; set includeUnqualified=true for admin/debug views.
      includeUnqualified: z.boolean().optional().default(false),
    }),
  )
  .handler(async ({ data }): Promise<{ wallets: LeaderboardWallet[]; total: number; error: string | null }> => {
    const { limit, offset, classification, minScore, sortBy, includeUnqualified } = data;

    const COLS = [
      "wallet_address", "wallet_classification", "intelligence_score",
      "discovery_score", "discovery_tier", "win_rate", "average_roi",
      "conviction_score", "total_tokens_traded", "total_buys", "total_sells",
      "realized_pnl", "unrealized_pnl", "first_seen_timestamp",
      "last_seen_timestamp", "updated_at",
    ].join(",");

    let q = supabaseAdmin
      .from("wallets")
      .select(COLS, { count: "exact" })
      .order(sortBy, { ascending: false, nullsFirst: false })
      .order("wallet_address", { ascending: true })
      .range(offset, offset + limit - 1);

    if (classification) q = q.eq("wallet_classification", classification);
    if (minScore !== undefined) q = q.gte("intelligence_score", minScore);

    // ── Leaderboard eligibility gates ────────────────────────────────────────
    // A wallet must have an actual track record before it can rank:
    //   - win_rate not null           (at least one CLOSED, real-money position)
    //   - total_buys >= 3             (more than a single lucky/unlucky trade)
    //   - intelligence_score >= 0.30  (above pure participation-floor noise)
    //   - classification != bot/unknown (bots and no-evidence wallets never rank)
    //   - first_seen_timestamp older than MIN_WALLET_AGE_DAYS
    //       (architecture review, 2026-07-13: a wallet seen for the first time
    //       hours ago has had no time to build a real track record — exclude
    //       brand-new wallets even if they happen to clear the other gates)
    //   - last_seen_timestamp within MAX_INACTIVITY_DAYS
    //       (architecture review, 2026-07-13: a wallet dormant for months is
    //       stale intelligence — its historical stats no longer describe an
    //       active trader, so it shouldn't occupy a leaderboard slot)
    // These two use existing timestamp columns already selected above; no
    // schema change or rescore is required for this gate.
    if (!includeUnqualified) {
      const now = Date.now();
      const minAgeCutoff    = new Date(now - MIN_WALLET_AGE_DAYS    * 86_400_000).toISOString();
      const maxInactiveCutoff = new Date(now - MAX_INACTIVITY_DAYS * 86_400_000).toISOString();

      q = q
        .not("win_rate", "is", null)
        .gte("total_buys", 3)
        .gte("intelligence_score", 0.30)
        .not("wallet_classification", "in", '("bot","unknown")')
        .not("first_seen_timestamp", "is", null)
        .lte("first_seen_timestamp", minAgeCutoff)
        .not("last_seen_timestamp", "is", null)
        .gte("last_seen_timestamp", maxInactiveCutoff);
    }

    const { data: rows, error, count } = await q;

    if (error) return { wallets: [], total: 0, error: error.message };
    return {
      wallets: (rows ?? []) as LeaderboardWallet[],
      total:   count ?? rows?.length ?? 0,
      error:   null,
    };
  });

/**
 * Aggregate classification counts for the stats bar.
 */
export const getLeaderboardStats = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async (): Promise<{ stats: LeaderboardStats; error: string | null }> => {
    // Fetch all classification counts in a single query.
    // (835 rows is trivial — count client-side rather than multiple RPC calls)
    const { data: rows, error } = await supabaseAdmin
      .from("wallets")
      .select("wallet_classification,intelligence_score");

    if (error || !rows) {
      return {
        stats: { total: 0, smart_money: 0, sniper: 0, whale: 0, bot: 0, retail: 0, unknown: 0, with_score: 0, without_score: 0 },
        error: error?.message ?? "No data",
      };
    }
    const stats: LeaderboardStats = {
      total:         rows.length,
      smart_money:   0,
      sniper:        0,
      whale:         0,
      bot:           0,
      retail:        0,
      unknown:       0,
      with_score:    0,
      without_score: 0,
    };

    for (const r of rows) {
      const cls = r.wallet_classification ?? "unknown";
      if (cls in stats) (stats as Record<string, number>)[cls]++;
      if (r.intelligence_score != null) stats.with_score++;
      else stats.without_score++;
    }

    return { stats, error: null };
  });

/**
 * Live enrichment coverage — used by the progress bar on the leaderboard.
 *
 * Delegates to getEnrichmentCoverage() from enrich-unenriched-scheduler so the
 * counting logic lives in exactly one place. That function uses the Supabase JS
 * client with a service-role key and paginates wallet_raw_tx_metrics to count
 * DISTINCT enriched wallets accurately.
 */
export const getEnrichmentStatus = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async (): Promise<{ status: EnrichmentStatus; error: string | null }> => {
    try {
      const coverage = await getEnrichmentCoverage();
      return { status: coverage, error: null };
    } catch (err) {
      return {
        status: { totalWallets: 0, enrichedWallets: 0, hollowWallets: 0, coveragePct: 0 },
        error:  err instanceof Error ? err.message : String(err),
      };
    }
  });
