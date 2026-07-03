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

// P2-D: consolidated to canonical service-role singleton — no anon-key fallback.
// supabaseAdmin throws at construction if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// are missing, which surfaces the misconfiguration immediately rather than
// silently degrading to a client that returns empty results under RLS.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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
// Internal helper — maps a Supabase JS result to the ServiceResult envelope
// ---------------------------------------------------------------------------

function toResult<T>(result: { data: T | null; error: { message: string } | null }): ServiceResult<T> {
  return { data: result.data ?? null, error: result.error?.message ?? null };
}

function toSingleResult<T>(result: { data: T[] | null; error: { message: string } | null }): ServiceResult<T> {
  return { data: result.data?.[0] ?? null, error: result.error?.message ?? null };
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
    const result = await supabaseAdmin
      .from("wallets")
      .select("*")
      .eq("wallet_address", data.walletAddress)
      .limit(1);
    return toSingleResult<WalletRow>(result);
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
    let q = supabaseAdmin
      .from("wallets")
      .select("*")
      .order("intelligence_score", { ascending: false, nullsFirst: false })
      .range(data.offset, data.offset + data.limit - 1);
    if (data.classification) q = q.eq("wallet_classification", data.classification);
    if (data.minScore !== undefined) q = q.gte("intelligence_score", data.minScore);
    return toResult<WalletRow[]>(await q);
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
      intelligence_score: z.number().min(0).max(1).optional().nullable(),
      wallet_classification: z
        .enum(["smart_money", "sniper", "bot", "whale", "retail", "unknown"])
        .optional()
        .nullable(),
    }),
  )
  .handler(async ({ data }): Promise<ServiceResult<WalletRow>> => {
    const payload: WalletInsert = { ...data, updated_at: new Date().toISOString() };
    const result = await supabaseAdmin
      .from("wallets")
      .upsert(payload, { onConflict: "wallet_address" })
      .select();
    return toSingleResult<WalletRow>(result);
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
        intelligence_score: z.number().min(0).max(1).optional().nullable(),
        wallet_classification: z
          .enum(["smart_money", "sniper", "bot", "whale", "retail", "unknown"])
          .optional()
          .nullable(),
      }),
    }),
  )
  .handler(async ({ data }): Promise<ServiceResult<WalletRow>> => {
    const patch: WalletUpdate = { ...data.patch, updated_at: new Date().toISOString() };
    const result = await supabaseAdmin
      .from("wallets")
      .update(patch)
      .eq("wallet_address", data.walletAddress)
      .select();
    return toSingleResult<WalletRow>(result);
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
      let q = supabaseAdmin
        .from("wallet_token_activity")
        .select("*")
        .eq("wallet_address", data.walletAddress)
        .order("timestamp", { ascending: false })
        .range(data.offset, data.offset + data.limit - 1);
      if (data.tokenAddress) q = q.eq("token_address", data.tokenAddress);
      if (data.actionType)   q = q.eq("action_type", data.actionType);
      return toResult<WalletTokenActivityRow[]>(await q);
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
      let q = supabaseAdmin
        .from("wallet_token_activity")
        .select("*")
        .eq("token_address", data.tokenAddress)
        .order("timestamp", { ascending: false })
        .range(data.offset, data.offset + data.limit - 1);
      if (data.actionType) q = q.eq("action_type", data.actionType);
      return toResult<WalletTokenActivityRow[]>(await q);
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
      // Explicit conflict target matches the UNIQUE constraint on transaction_signature.
      // ignoreDuplicates: true → INSERT ... ON CONFLICT DO NOTHING (idempotent).
      const result = await supabaseAdmin
        .from("wallet_token_activity")
        .upsert(payload, { onConflict: "transaction_signature", ignoreDuplicates: true })
        .select();
      return toSingleResult<WalletTokenActivityRow>(result);
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
      // Explicit conflict target matches the UNIQUE constraint on transaction_signature.
      const result = await supabaseAdmin
        .from("wallet_token_activity")
        .upsert(data.events, { onConflict: "transaction_signature", ignoreDuplicates: true })
        .select();
      return toResult<WalletTokenActivityRow[]>(result);
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
      const result = await supabaseAdmin
        .from("wallet_performance_history")
        .select("*")
        .eq("wallet_address", data.walletAddress)
        .order(data.sortBy, { ascending: false, nullsFirst: false })
        .range(data.offset, data.offset + data.limit - 1);
      return toResult<WalletPerformanceRow[]>(result);
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
      const result = await supabaseAdmin
        .from("wallet_performance_history")
        .select("*")
        .eq("wallet_address", data.walletAddress)
        .eq("token_address", data.tokenAddress)
        .limit(1);
      return toSingleResult<WalletPerformanceRow>(result);
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
      const result = await supabaseAdmin
        .from("wallet_performance_history")
        .upsert(payload, { onConflict: "wallet_address,token_address" })
        .select();
      return toSingleResult<WalletPerformanceRow>(result);
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
      const patch: Record<string, unknown> = {
        [data.milestone]: true,
        last_updated: new Date().toISOString(),
      };
      const result = await supabaseAdmin
        .from("wallet_performance_history")
        .update(patch)
        .eq("wallet_address", data.walletAddress)
        .eq("token_address", data.tokenAddress)
        .select();
      return toSingleResult<WalletPerformanceRow>(result);
    },
  );
