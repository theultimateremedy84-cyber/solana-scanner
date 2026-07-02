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

const CLASSIFICATION_VALUES = [
  "smart_money",
  "sniper",
  "whale",
  "bot",
  "retail",
  "unknown",
] as const;

type Classification = (typeof CLASSIFICATION_VALUES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function supabaseHeaders(): Record<string, string> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars");
  }

  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function baseUrl(): string {
  return process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
}

async function sbGet<T>(path: string): Promise<{ data: T | null; error: string | null; count?: number }> {
  try {
    const res = await fetch(`${baseUrl()}/rest/v1/${path}`, {
      headers: { ...supabaseHeaders(), Prefer: "count=exact" },
    });

    const totalCount = res.headers.get("content-range")
      ? parseInt(res.headers.get("content-range")!.split("/")[1] ?? "0", 10)
      : undefined;

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      return { data: null, error: `Supabase ${res.status}: ${body}` };
    }

    const text = await res.text();
    const data: T = text ? JSON.parse(text) : null;
    return { data, error: null, count: totalCount };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

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
    }),
  )
  .handler(async ({ data }): Promise<{ wallets: LeaderboardWallet[]; total: number; error: string | null }> => {
    const { limit, offset, classification, minScore, sortBy } = data;

    const params = new URLSearchParams({
      select: [
        "wallet_address",
        "wallet_classification",
        "intelligence_score",
        "discovery_score",
        "discovery_tier",
        "win_rate",
        "average_roi",
        "conviction_score",
        "total_tokens_traded",
        "total_buys",
        "total_sells",
        "realized_pnl",
        "unrealized_pnl",
        "first_seen_timestamp",
        "last_seen_timestamp",
        "updated_at",
      ].join(","),
      order:  `${sortBy}.desc.nullslast,wallet_address.asc`,
      limit:  String(limit),
      offset: String(offset),
    });

    if (classification) {
      params.set("wallet_classification", `eq.${classification}`);
    }
    if (minScore !== undefined) {
      params.set("intelligence_score", `gte.${minScore}`);
    }

    const result = await sbGet<LeaderboardWallet[]>(`wallets?${params.toString()}`);

    if (result.error || !result.data) {
      return { wallets: [], total: 0, error: result.error };
    }

    return {
      wallets: result.data,
      total:   result.count ?? result.data.length,
      error:   null,
    };
  });

/**
 * Aggregate classification counts for the stats bar.
 */
export const getLeaderboardStats = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async (): Promise<{ stats: LeaderboardStats; error: string | null }> => {
    // Fetch all classification counts in a single query using grouping
    // (Supabase REST doesn't support GROUP BY directly — fetch all rows with just
    //  the classification column and count client-side; 835 rows is trivial)
    const result = await sbGet<Array<{ wallet_classification: Classification | null; intelligence_score: number | null }>>(
      "wallets?select=wallet_classification,intelligence_score",
    );

    if (result.error || !result.data) {
      return {
        stats: { total: 0, smart_money: 0, sniper: 0, whale: 0, bot: 0, retail: 0, unknown: 0, with_score: 0, without_score: 0 },
        error: result.error,
      };
    }

    const rows = result.data;
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
 * Uses Supabase count=exact for total wallets (single HEAD round-trip) and
 * paginates through wallet_raw_tx_metrics to count DISTINCT enriched wallets
 * accurately — a wallet enriched across 10 tokens has 10 rows but counts once.
 */
export const getEnrichmentStatus = createServerFn({ method: "GET" })
  .inputValidator(z.object({}))
  .handler(async (): Promise<{ status: EnrichmentStatus; error: string | null }> => {
    const headers = supabaseHeaders();
    const base    = baseUrl();

    // ── Total wallets (count=exact HEAD — zero row transfer) ─────────────────
    let totalWallets = 0;
    try {
      const res = await fetch(`${base}/rest/v1/wallets?select=wallet_address`, {
        method:  "HEAD",
        headers: { ...headers, Prefer: "count=exact" },
      });
      const cr = res.headers.get("content-range");
      totalWallets = cr ? parseInt(cr.split("/")[1] ?? "0", 10) : 0;
    } catch (err) {
      return {
        status: { totalWallets: 0, enrichedWallets: 0, hollowWallets: 0, coveragePct: 0 },
        error:  err instanceof Error ? err.message : String(err),
      };
    }

    // ── Distinct enriched wallets — paginate to avoid undercounting ───────────
    // wallet_raw_tx_metrics has multiple rows per wallet (one per token).
    // We need COUNT(DISTINCT wallet_address), which we approximate by fetching
    // all wallet_address values with helius_full_history and deduplicating.
    const enrichedSet = new Set<string>();
    let page = 0;
    const PAGE = 1_000;

    while (true) {
      const from  = page * PAGE;
      const to    = (page + 1) * PAGE - 1;
      const res   = await sbGet<Array<{ wallet_address: string }>>(
        `wallet_raw_tx_metrics?select=wallet_address&data_source=eq.helius_full_history&limit=${PAGE}&offset=${from}`,
      );
      if (res.error || !res.data?.length) break;
      for (const r of res.data) enrichedSet.add(r.wallet_address);
      if (res.data.length < PAGE) break;
      page++;
    }

    const enrichedWallets = enrichedSet.size;
    const hollowWallets   = Math.max(0, totalWallets - enrichedWallets);
    const coveragePct     = totalWallets > 0 ? Math.round((enrichedWallets / totalWallets) * 100) : 0;

    return {
      status: { totalWallets, enrichedWallets, hollowWallets, coveragePct },
      error:  null,
    };
  });
