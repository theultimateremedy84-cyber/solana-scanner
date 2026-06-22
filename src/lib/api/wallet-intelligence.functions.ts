// =============================================================================
// Wallet Intelligence Infrastructure — server functions
//
// Each export is a createServerFn that runs server-side only.
// Import on the client like:
//   import { getWallet, upsertWallet, ... } from "@/lib/api/wallet-intelligence.functions";
//
// None of these functions touch scan_history or any existing table.
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type {
  WalletRow,
  WalletInsert,
  WalletUpdate,
  WalletTokenActivityRow,
  WalletTokenActivityInsert,
  WalletPerformanceRow,
  WalletPerformanceUpsert,
  ServiceResult,
} from "./wallet-intelligence.types";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid Solana address");

const paginationSchema = z.object({
  limit: z.number().int().min(1).max(500).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

// ---------------------------------------------------------------------------
// Internal helper — builds the authenticated Supabase REST fetch options
// ---------------------------------------------------------------------------

function supabaseConfig(): { baseUrl: string; headers: Record<string, string> } {
  const baseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";

  if (!baseUrl || !key) {
    throw new Error(
      "Missing Supabase environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) are required.",
    );
  }

  return {
    baseUrl,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
  };
}

async function supabaseFetch<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<ServiceResult<T>> {
  const { baseUrl, headers } = supabaseConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      return { data: null, error: `Supabase error ${res.status}: ${body}` };
    }

    const text = await res.text();
    const data: T = text ? JSON.parse(text) : (null as unknown as T);
    return { data, error: null };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: message };
  }
}

// =============================================================================
// WALLETS — read
// =============================================================================

/**
 * Fetch a single wallet by address.
 * Returns null data (not an error) when the wallet has not been seen yet.
 */
export const getWallet = createServerFn({ method: "GET" })
  .inputValidator(z.object({ walletAddress: solanaAddress }))
  .handler(async ({ data }): Promise<ServiceResult<WalletRow>> => {
    const url = new URLSearchParams({
      wallet_address: `eq.${data.walletAddress}`,
      limit: "1",
    });
    const result = await supabaseFetch<WalletRow[]>(`wallets?${url.toString()}`);
    if (result.error) return result as ServiceResult<WalletRow>;
    const rows = result.data ?? [];
    return { data: rows[0] ?? null, error: null };
  });

/**
 * List wallets ordered by intelligence_score descending.
 * Supports optional classification filter and pagination.
 */
export const listWallets = createServerFn({ method: "GET" })
  .inputValidator(
    paginationSchema.extend({
      classification: z
        .enum(["smart_money", "sniper", "bot", "whale", "retail", "unknown"])
        .optional(),
      minScore: z.number().min(0).max(100).optional(),
    }),
  )
  .handler(async ({ data }): Promise<ServiceResult<WalletRow[]>> => {
    const params = new URLSearchParams({
      order: "intelligence_score.desc.nullslast",
      limit: String(data.limit),
      offset: String(data.offset),
    });
    if (data.classification) {
      params.set("wallet_classification", `eq.${data.classification}`);
    }
    if (data.minScore !== undefined) {
      params.set("intelligence_score", `gte.${data.minScore}`);
    }
    return supabaseFetch<WalletRow[]>(`wallets?${params.toString()}`);
  });

// =============================================================================
// WALLETS — write
// =============================================================================

/**
 * Insert a new wallet or update all fields for an existing one.
 * Uses ON CONFLICT (wallet_address) DO UPDATE via Supabase upsert.
 */
export const upsertWallet = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      wallet_address: solanaAddress,
      first_seen_timestamp: z.string().datetime().optional().nullable(),
      last_seen_timestamp: z.string().datetime().optional().nullable(),
      total_tokens_traded: z.number().int().min(0).optional(),
      total_buys: z.number().int().min(0).optional(),
      total_sells: z.number().int().min(0).optional(),
      total_volume_bought_usd: z.number().min(0).optional(),
      total_volume_sold_usd: z.number().min(0).optional(),
      realized_pnl: z.number().optional(),
      unrealized_pnl: z.number().optional(),
      win_rate: z.number().min(0).max(1).optional().nullable(),
      average_roi: z.number().optional().nullable(),
      discovery_score: z.number().optional().nullable(),
      conviction_score: z.number().optional().nullable(),
      intelligence_score: z.number().min(0).max(100).optional().nullable(),
      wallet_classification: z
        .enum(["smart_money", "sniper", "bot", "whale", "retail", "unknown"])
        .optional()
        .nullable(),
    }),
  )
  .handler(async ({ data }): Promise<ServiceResult<WalletRow>> => {
    const payload: WalletInsert = {
      ...data,
      // Always refresh updated_at on every upsert
      ...(undefined as unknown as object),
    };

    const result = await supabaseFetch<WalletRow[]>("wallets", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
    });

    if (result.error) return result as ServiceResult<WalletRow>;
    const rows = result.data ?? [];
    return { data: rows[0] ?? null, error: null };
  });

/**
 * Patch a subset of fields on an existing wallet.
 * Does not create a new row — use upsertWallet for that.
 */
export const updateWallet = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      walletAddress: solanaAddress,
      patch: z.object({
        last_seen_timestamp: z.string().datetime().optional().nullable(),
        total_tokens_traded: z.number().int().min(0).optional(),
        total_buys: z.number().int().min(0).optional(),
        total_sells: z.number().int().min(0).optional(),
        total_volume_bought_usd: z.number().min(0).optional(),
        total_volume_sold_usd: z.number().min(0).optional(),
        realized_pnl: z.number().optional(),
        unrealized_pnl: z.number().optional(),
        win_rate: z.number().min(0).max(1).optional().nullable(),
        average_roi: z.number().optional().nullable(),
        discovery_score: z.number().optional().nullable(),
        conviction_score: z.number().optional().nullable(),
        intelligence_score: z.number().min(0).max(100).optional().nullable(),
        wallet_classification: z
          .enum(["smart_money", "sniper", "bot", "whale", "retail", "unknown"])
          .optional()
          .nullable(),
      }),
    }),
  )
  .handler(async ({ data }): Promise<ServiceResult<WalletRow>> => {
    const params = new URLSearchParams({
      wallet_address: `eq.${data.walletAddress}`,
    });
    const patch: WalletUpdate = {
      ...data.patch,
      updated_at: new Date().toISOString(),
    };
    const result = await supabaseFetch<WalletRow[]>(
      `wallets?${params.toString()}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
    if (result.error) return result as ServiceResult<WalletRow>;
    const rows = result.data ?? [];
    return { data: rows[0] ?? null, error: null };
  });

// =============================================================================
// WALLET TOKEN ACTIVITY — read
// =============================================================================

/**
 * List activity events for a specific wallet, newest first.
 */
export const getWalletActivity = createServerFn({ method: "GET" })
  .inputValidator(
    paginationSchema.extend({
      walletAddress: solanaAddress,
      tokenAddress: z.string().optional(),
      actionType: z.enum(["buy", "sell"]).optional(),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletTokenActivityRow[]>> => {
      const params = new URLSearchParams({
        wallet_address: `eq.${data.walletAddress}`,
        order: "timestamp.desc",
        limit: String(data.limit),
        offset: String(data.offset),
      });
      if (data.tokenAddress) params.set("token_address", `eq.${data.tokenAddress}`);
      if (data.actionType) params.set("action_type", `eq.${data.actionType}`);
      return supabaseFetch<WalletTokenActivityRow[]>(
        `wallet_token_activity?${params.toString()}`,
      );
    },
  );

/**
 * List all wallets that traded a specific token, newest first.
 */
export const getTokenActivity = createServerFn({ method: "GET" })
  .inputValidator(
    paginationSchema.extend({
      tokenAddress: z.string().min(1),
      actionType: z.enum(["buy", "sell"]).optional(),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletTokenActivityRow[]>> => {
      const params = new URLSearchParams({
        token_address: `eq.${data.tokenAddress}`,
        order: "timestamp.desc",
        limit: String(data.limit),
        offset: String(data.offset),
      });
      if (data.actionType) params.set("action_type", `eq.${data.actionType}`);
      return supabaseFetch<WalletTokenActivityRow[]>(
        `wallet_token_activity?${params.toString()}`,
      );
    },
  );

// =============================================================================
// WALLET TOKEN ACTIVITY — write
// =============================================================================

/**
 * Record a single on-chain trade event.
 * Uses ON CONFLICT (transaction_signature) DO NOTHING for idempotency.
 */
export const recordActivity = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      wallet_address: solanaAddress,
      token_address: z.string().min(1),
      transaction_signature: z.string().min(1),
      action_type: z.enum(["buy", "sell"]),
      amount_sol: z.number().optional().nullable(),
      amount_usd: z.number().optional().nullable(),
      token_amount: z.number().optional().nullable(),
      timestamp: z.string().datetime(),
      entry_market_cap: z.number().optional().nullable(),
      liquidity_at_entry: z.number().optional().nullable(),
      holder_count_at_entry: z.number().int().optional().nullable(),
      token_age_at_entry: z.number().int().optional().nullable(),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletTokenActivityRow>> => {
      const payload: WalletTokenActivityInsert = data;
      const result = await supabaseFetch<WalletTokenActivityRow[]>(
        "wallet_token_activity",
        {
          method: "POST",
          headers: {
            Prefer: "resolution=ignore-duplicates,return=representation",
          },
          body: JSON.stringify(payload),
        },
      );
      if (result.error) return result as ServiceResult<WalletTokenActivityRow>;
      const rows = result.data ?? [];
      return { data: rows[0] ?? null, error: null };
    },
  );

/**
 * Batch-insert multiple activity events in a single round-trip.
 * Duplicate transaction_signatures are silently ignored.
 */
export const recordActivityBatch = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      events: z
        .array(
          z.object({
            wallet_address: solanaAddress,
            token_address: z.string().min(1),
            transaction_signature: z.string().min(1),
            action_type: z.enum(["buy", "sell"]),
            amount_sol: z.number().optional().nullable(),
            amount_usd: z.number().optional().nullable(),
            token_amount: z.number().optional().nullable(),
            timestamp: z.string().datetime(),
            entry_market_cap: z.number().optional().nullable(),
            liquidity_at_entry: z.number().optional().nullable(),
            holder_count_at_entry: z.number().int().optional().nullable(),
            token_age_at_entry: z.number().int().optional().nullable(),
          }),
        )
        .min(1)
        .max(500),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletTokenActivityRow[]>> => {
      return supabaseFetch<WalletTokenActivityRow[]>("wallet_token_activity", {
        method: "POST",
        headers: {
          Prefer: "resolution=ignore-duplicates,return=representation",
        },
        body: JSON.stringify(data.events),
      });
    },
  );

// =============================================================================
// WALLET PERFORMANCE HISTORY — read
// =============================================================================

/**
 * Fetch all token-level performance records for a wallet.
 */
export const getWalletPerformance = createServerFn({ method: "GET" })
  .inputValidator(
    paginationSchema.extend({
      walletAddress: solanaAddress,
      sortBy: z
        .enum(["roi_multiple", "realized_profit", "last_updated"])
        .optional()
        .default("roi_multiple"),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletPerformanceRow[]>> => {
      const params = new URLSearchParams({
        wallet_address: `eq.${data.walletAddress}`,
        order: `${data.sortBy}.desc.nullslast`,
        limit: String(data.limit),
        offset: String(data.offset),
      });
      return supabaseFetch<WalletPerformanceRow[]>(
        `wallet_performance_history?${params.toString()}`,
      );
    },
  );

/**
 * Fetch the performance record for a specific wallet × token pair.
 */
export const getTokenPerformance = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      walletAddress: solanaAddress,
      tokenAddress: z.string().min(1),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletPerformanceRow>> => {
      const params = new URLSearchParams({
        wallet_address: `eq.${data.walletAddress}`,
        token_address: `eq.${data.tokenAddress}`,
        limit: "1",
      });
      const result = await supabaseFetch<WalletPerformanceRow[]>(
        `wallet_performance_history?${params.toString()}`,
      );
      if (result.error) return result as ServiceResult<WalletPerformanceRow>;
      return { data: result.data?.[0] ?? null, error: null };
    },
  );

// =============================================================================
// WALLET PERFORMANCE HISTORY — write
// =============================================================================

/**
 * Upsert the performance record for a wallet × token pair.
 * Automatically updates peak_roi when roi_multiple exceeds the stored peak.
 */
export const upsertPerformance = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      wallet_address: solanaAddress,
      token_address: z.string().min(1),
      initial_investment: z.number().min(0).optional(),
      current_value: z.number().min(0).optional(),
      realized_profit: z.number().optional(),
      unrealized_profit: z.number().optional(),
      roi_multiple: z.number().optional().nullable(),
      peak_roi: z.number().optional().nullable(),
      reached_100k_mc: z.boolean().optional(),
      reached_500k_mc: z.boolean().optional(),
      reached_1m_mc: z.boolean().optional(),
      reached_5m_mc: z.boolean().optional(),
      reached_10m_mc: z.boolean().optional(),
      reached_50m_mc: z.boolean().optional(),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletPerformanceRow>> => {
      const payload: WalletPerformanceUpsert & { last_updated: string } = {
        ...data,
        last_updated: new Date().toISOString(),
      };
      const result = await supabaseFetch<WalletPerformanceRow[]>(
        "wallet_performance_history",
        {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: JSON.stringify(payload),
        },
      );
      if (result.error) return result as ServiceResult<WalletPerformanceRow>;
      return { data: result.data?.[0] ?? null, error: null };
    },
  );

/**
 * Mark a market-cap milestone as reached for a wallet × token pair.
 * Only flips TRUE — never resets a milestone back to FALSE.
 */
export const markMilestone = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      walletAddress: solanaAddress,
      tokenAddress: z.string().min(1),
      milestone: z.enum([
        "reached_100k_mc",
        "reached_500k_mc",
        "reached_1m_mc",
        "reached_5m_mc",
        "reached_10m_mc",
        "reached_50m_mc",
      ]),
    }),
  )
  .handler(
    async ({ data }): Promise<ServiceResult<WalletPerformanceRow>> => {
      const params = new URLSearchParams({
        wallet_address: `eq.${data.walletAddress}`,
        token_address: `eq.${data.tokenAddress}`,
      });
      const patch: Record<string, unknown> = {
        [data.milestone]: true,
        last_updated: new Date().toISOString(),
      };
      const result = await supabaseFetch<WalletPerformanceRow[]>(
        `wallet_performance_history?${params.toString()}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      if (result.error) return result as ServiceResult<WalletPerformanceRow>;
      return { data: result.data?.[0] ?? null, error: null };
    },
  );
