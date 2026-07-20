// =============================================================================
// SOL Transfer Indexer  (Chapter 8 prerequisite — Discovery Clusters /
// Whale Fund-Distribution Tracing)
//
// WHY THIS EXISTS
//   wallet_token_activity only records token trades (buy/sell against a
//   bonding curve or AMM). It has no record of bare wallet-to-wallet SOL
//   transfers — which is exactly what a whale does when it books profit and
//   distributes funds across 10-15 fresh wallets to obscure the trail.
//
//   This module fetches each wallet's native SOL transfers via Helius
//   Enhanced Transactions, filters out known DEX/program/system accounts so
//   only real wallet↔wallet transfers remain, and persists them to
//   wallet_sol_transfers (see supabase/migrations/20260705000001_*.sql).
//
// WHAT THIS ENABLES
//   - detectCommonFundingSource(): wallets that received their first SOL
//     from the same address within a tight time window are very likely the
//     same entity. This is "Signal 1" — cheap, high-confidence, low
//     false-positive rate, unlike full behavioral-fingerprint clustering.
//   - The eventual Chapter 8 Discovery Clusters feature builds on top of
//     this same table.
//
// WHAT THIS CANNOT SEE
//   Transfers routed through a centralized exchange (CEX). Whale → CEX
//   deposit → [black box] → 10 withdrawal addresses is invisible on-chain.
//   This indexer only closes the gap for direct wallet-to-wallet transfers —
//   which is still the common case for less-disciplined actors.
//
// CREDIT USAGE
//   Reuses the same globalThis Helius CU budget guard as token-discovery.ts,
//   postLaunchWatcher.ts, and tx-reconstructor.ts, so this never blows past
//   your existing HELIUS_DAILY_BUDGET / HELIUS_HOURLY_BUDGET caps.
//
// INTEGRATION
//   Call indexWalletSolTransfers(walletAddress) after a wallet is enriched
//   (e.g. from wallet-enricher.ts, right after enrichWalletsForToken), or
//   run it as its own periodic scheduler over recently-active wallets.
//   Nothing in this file runs automatically — wire it in explicitly.
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getHeliusKey } from "./wallet-collection-worker";
import type { HeliusEnhancedTx } from "./wallet-collection.types";

const LOG = "[SolTransferIndexer]";
const LAMPORTS_PER_SOL = 1_000_000_000;

// Dust transfers below this are almost always fees/rent, not real funding
// events — skip them so the funding-source signal stays clean.
const MIN_SOL_THRESHOLD = 0.01;

// ---------------------------------------------------------------------------
// Ignore known program / AMM / system accounts — a transfer touching one of
// these is not a wallet-to-wallet funding event.
// (Kept in sync with the ignore list in tx-reconstructor.ts.)
// ---------------------------------------------------------------------------
const IGNORED_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // Jupiter aggregator
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM v4
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  // Raydium AMM v5
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",   // Pump.fun bonding curve
]);

// Known major CEX hot/deposit wallets worth flagging explicitly rather than
// silently dropping — if a whale's SOL lands here, the trail goes dark, and
// that's a signal worth surfacing rather than hiding.
const KNOWN_CEX_HOT_WALLETS = new Set<string>([
  // Populate with known Binance / Coinbase / OKX hot wallet addresses as you
  // identify them. Left empty by default — matching against this set is
  // best-effort and not required for the core funding-source detection.
]);

// ---------------------------------------------------------------------------
// Helius credit budget guard — identical pattern to token-discovery.ts /
// tx-reconstructor.ts. Shares the same globalThis counters so all modules
// draw from one combined daily/hourly budget.
// ---------------------------------------------------------------------------
function _consumeHC(cuAmount: number, label: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const now = Date.now();

  if (!g.__heliusBudget__ || now - g.__heliusBudget__.day >= 86_400_000) {
    g.__heliusBudget__ = {
      budget: parseInt(process.env.HELIUS_DAILY_BUDGET ?? "0", 10) || 0,
      used:   0,
      day:    now,
      warned: false,
    };
  }
  const b = g.__heliusBudget__ as { budget: number; used: number; day: number; warned: boolean };

  if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
    g.__heliusHourly__ = {
      budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "0", 10) || 0,
      used:   0,
      window: now,
      warned: false,
    };
  }
  const h = g.__heliusHourly__ as { budget: number; used: number; window: number; warned: boolean };

  if (h.budget > 0 && h.used + cuAmount > h.budget) {
    if (!h.warned) {
      h.warned = true;
      console.warn(`[HeliusBudget] ⚠️  Hourly cap reached. Skipping "${label}".`);
    }
    return false;
  }
  if (b.budget > 0 && b.used + cuAmount > b.budget) {
    if (!b.warned) {
      b.warned = true;
      console.warn(`[HeliusBudget] ⚠️  Daily budget exhausted. Skipping "${label}".`);
    }
    return false;
  }

  if (h.budget > 0) h.used += cuAmount;
  if (b.budget > 0) b.used += cuAmount;

  // ── Log to shared CU log batch (P2 fix: enricher calls missing from budget dashboard) ──
  // token-discovery.ts initialises g.__cuLogBatch__ and flushes it to helius_cu_log
  // every 60s. Pushing here makes SolTransferIndexer Helius calls visible in the
  // budget dashboard, matching the fix applied to tx-reconstructor.ts.
  if (Array.isArray(g.__cuLogBatch__)) {
    g.__cuLogBatch__.push({
      logged_at:     new Date().toISOString(),
      label,
      component:     label.split("/")[0] ?? label,
      cu_amount:     cuAmount,
      hourly_used:   h.used,
      hourly_budget: h.budget,
      daily_used:    b.used,
      daily_budget:  b.budget,
    });
  }

  return true;
}

async function fetchWithTimeout(url: string, timeoutMs = 15_000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`${LOG} fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch a wallet's native SOL transfer transactions from Helius.
// Uses type=TRANSFER so we only pay for transfer events, not swaps.
// ---------------------------------------------------------------------------
async function fetchWalletTransfers(
  walletAddress: string,
  heliusApiKey: string,
  limit = 100,
): Promise<HeliusEnhancedTx[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const h = g.__heliusHourly__ as { budget: number; used: number } | undefined;
  const b = g.__heliusBudget__  as { budget: number; used: number } | undefined;
  if ((h?.budget ?? 0) > 0 && (h?.used ?? 0) >= (h?.budget ?? 0)) return [];
  if ((b?.budget ?? 0) > 0 && (b?.used ?? 0) >= (b?.budget ?? 0)) return [];

  const url =
    `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions` +
    `?api-key=${heliusApiKey}` +
    `&limit=${limit}` +
    `&type=TRANSFER`;

  const res = await fetchWithTimeout(url);
  if (!res) {
    console.warn(`${LOG} fetchWalletTransfers timeout for ${walletAddress.slice(0, 8)}…`);
    return [];
  }
  if (!res.ok) {
    console.warn(`${LOG} fetchWalletTransfers HTTP ${res.status} for ${walletAddress.slice(0, 8)}…`);
    return [];
  }

  try {
    const data = await res.json();
    const txs = Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];
    if (txs.length > 0) {
      _consumeHC(txs.length, `SolTransferIndexer/fetchWalletTransfers(${walletAddress.slice(0, 8)})`);
    }
    return txs;
  } catch (err) {
    console.warn(`${LOG} JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Extract real wallet-to-wallet SOL transfers from a raw enhanced tx,
// excluding anything that touches a known program/AMM account.
// ---------------------------------------------------------------------------
export interface ExtractedTransfer {
  signature:  string;
  fromWallet: string;
  toWallet:   string;
  amountSol:  number;
  timestamp:  number; // unix seconds
}

function extractRealTransfers(tx: HeliusEnhancedTx): ExtractedTransfer[] {
  const out: ExtractedTransfer[] = [];
  const native = tx.nativeTransfers ?? [];

  for (const n of native) {
    const amountSol = n.amount / LAMPORTS_PER_SOL;
    if (amountSol < MIN_SOL_THRESHOLD) continue;
    if (n.fromUserAccount === n.toUserAccount) continue;
    if (IGNORED_PROGRAMS.has(n.fromUserAccount)) continue;
    if (IGNORED_PROGRAMS.has(n.toUserAccount)) continue;

    out.push({
      signature:  tx.signature,
      fromWallet: n.fromUserAccount,
      toWallet:   n.toUserAccount,
      amountSol,
      timestamp:  tx.timestamp,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public: index one wallet's SOL transfers into wallet_sol_transfers.
// Idempotent — relies on the (signature, from_wallet, to_wallet) unique
// constraint, so re-running this for the same wallet is always safe.
// ---------------------------------------------------------------------------
export interface IndexResult {
  walletAddress:   string;
  transfersFound:  number;
  transfersStored: number;
  cexHopsFlagged:  number;
  errors:          string[];
}

export async function indexWalletSolTransfers(
  walletAddress: string,
  limit = 100,
): Promise<IndexResult> {
  const result: IndexResult = {
    walletAddress, transfersFound: 0, transfersStored: 0, cexHopsFlagged: 0, errors: [],
  };

  const heliusKey = getHeliusKey();
  if (!heliusKey) {
    result.errors.push("HELIUS_API_KEY not set");
    return result;
  }

  const txs = await fetchWalletTransfers(walletAddress, heliusKey, limit);
  const rows: Array<{
    transaction_signature: string;
    from_wallet: string;
    to_wallet: string;
    amount_sol: number;
    transferred_at: string;
    discovered_via_wallet: string;
    data_source: string;
  }> = [];

  for (const tx of txs) {
    const transfers = extractRealTransfers(tx);
    for (const t of transfers) {
      result.transfersFound++;
      if (KNOWN_CEX_HOT_WALLETS.has(t.toWallet) || KNOWN_CEX_HOT_WALLETS.has(t.fromWallet)) {
        result.cexHopsFlagged++;
      }
      rows.push({
        transaction_signature: t.signature,
        from_wallet:           t.fromWallet,
        to_wallet:             t.toWallet,
        amount_sol:            t.amountSol,
        transferred_at:        new Date(t.timestamp * 1000).toISOString(),
        discovered_via_wallet: walletAddress,
        data_source:           "helius_enhanced_tx",
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from("wallet_sol_transfers")
      .upsert(rows, { onConflict: "transaction_signature,from_wallet,to_wallet", ignoreDuplicates: true });

    if (error) {
      result.errors.push(`Supabase upsert failed: ${error.message}`);
    } else {
      result.transfersStored = rows.length;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: common funding source detection ("Signal 1").
//
// Groups a set of wallets by who funded them first. Wallets sharing the same
// first_funder are very likely controlled by the same entity — especially
// when the funding events happened close together in time.
// ---------------------------------------------------------------------------
export interface FundingCluster {
  firstFunder:        string;
  wallets:             string[];
  fundedWithinWindow:  boolean; // true if all fundings happened within maxSpreadMs
  earliestFundedAt:    string;
  latestFundedAt:      string;
}

export async function detectCommonFundingSource(
  walletAddresses: string[],
  maxSpreadMs = 60 * 60 * 1000, // 1 hour — tune based on observed whale behavior
): Promise<FundingCluster[]> {
  if (walletAddresses.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("wallet_first_funder")
    .select("wallet_address, first_funder, first_funded_at")
    .in("wallet_address", walletAddresses);

  if (error || !data) {
    console.warn(`${LOG} detectCommonFundingSource query failed: ${error?.message}`);
    return [];
  }

  const byFunder = new Map<string, { wallet: string; fundedAt: string }[]>();
  for (const row of data) {
    if (!row.first_funder) continue;
    const list = byFunder.get(row.first_funder) ?? [];
    list.push({ wallet: row.wallet_address, fundedAt: row.first_funded_at });
    byFunder.set(row.first_funder, list);
  }

  const clusters: FundingCluster[] = [];
  for (const [funder, entries] of byFunder) {
    if (entries.length < 2) continue; // a cluster needs at least 2 wallets

    const times = entries.map((e) => new Date(e.fundedAt).getTime()).sort((a, b) => a - b);
    const spread = times[times.length - 1] - times[0];

    clusters.push({
      firstFunder:       funder,
      wallets:           entries.map((e) => e.wallet),
      fundedWithinWindow: spread <= maxSpreadMs,
      earliestFundedAt:  new Date(times[0]).toISOString(),
      latestFundedAt:    new Date(times[times.length - 1]).toISOString(),
    });
  }

  // Surface tightest, most-confident clusters first.
  clusters.sort((a, b) => b.wallets.length - a.wallets.length);
  return clusters;
}
