// =============================================================================
// Wallet Collection Worker
//
// Core collection logic. Completely independent of the token scanner.
// Call collect() after a token is detected. Never throws — always returns
// a CollectionResult so callers stay alive even when Helius is unreachable.
//
// No imports from scan.functions.ts, scan-core.ts, or any scanner module.
//
// Pipeline:
//   Step 1 — getSignaturesForAddress on pool (requires poolAddress)
//   Step 2 — Helius Enhanced Transactions parse (buyers + sellers)
//   Step 3 — collectSignificantHolders via getTokenLargestAccounts (always)
//   Step 4 — Upsert wallet_token_activity
//   Step 5 — Upsert wallets (one row per unique wallet address)
//   Step 6 — Upsert wallet_performance_history (per wallet × token)
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import type {
  WalletCollectionJob,
  CollectionResult,
  HeliusEnhancedTx,
  ParsedTrader,
} from "./wallet-collection.types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SOL_THRESHOLD = 0.001;
const MIN_TOKEN_AMOUNT = 1;
const HELIUS_BATCH_SIZE = 100;
const MAX_BUYERS = 50;
const MAX_TRADERS = 200;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const LAMPORTS_PER_SOL = 1_000_000_000;
const LOG = "[WalletWorker]";

const IGNORED_PROGRAMS = new Set([
  SYSTEM_PROGRAM,
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeliusKey(): string {
  return process.env.HELIUS_API_KEY ?? "";
}

function getRpcUrl(): string {
  const key = getHeliusKey();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : "https://api.mainnet-beta.solana.com";
}

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function rpc<T = unknown>(
  method: string,
  params: unknown[],
  timeoutMs = 12_000,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(getRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`${LOG} RPC ${method} HTTP ${res.status}`);
      return null;
    }
    const j = await res.json();
    return (j?.result ?? null) as T;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`${LOG} RPC ${method} error:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function heliusParseTxs(
  signatures: string[],
): Promise<HeliusEnhancedTx[]> {
  const key = getHeliusKey();
  if (!key || signatures.length === 0) return [];
  console.log(`${LOG}   heliusParseTxs — requesting ${signatures.length} txs`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(
      `https://api.helius.xyz/v0/transactions?api-key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactions: signatures }),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`${LOG}   Helius parse HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const data = await res.json();
    const txs = Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];
    console.log(`${LOG}   heliusParseTxs — received ${txs.length} parsed txs`);
    return txs;
  } catch (err) {
    console.warn(`${LOG}   heliusParseTxs error:`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function extractBuyers(
  tx: HeliusEnhancedTx,
  mint: string,
  poolAddress: string,
): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  const solPaidByWallet = new Map<string, number>();
  for (const n of nativeTransfers) {
    if (
      n.toUserAccount === poolAddress &&
      n.fromUserAccount &&
      n.fromUserAccount !== poolAddress &&
      !IGNORED_PROGRAMS.has(n.fromUserAccount)
    ) {
      const current = solPaidByWallet.get(n.fromUserAccount) ?? 0;
      solPaidByWallet.set(
        n.fromUserAccount,
        current + n.amount / LAMPORTS_PER_SOL,
      );
    }
  }

  for (const t of transfers) {
    if (
      t.mint !== mint ||
      t.fromUserAccount !== poolAddress ||
      !t.toUserAccount ||
      t.toUserAccount === poolAddress ||
      IGNORED_PROGRAMS.has(t.toUserAccount)
    ) {
      continue;
    }

    const tokenAmount = Number(t.tokenAmount ?? 0);
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;

    let amountSol =
      solPaidByWallet.get(t.toUserAccount) ??
      solPaidByWallet.get(tx.feePayer) ??
      0;

    if (amountSol === 0 && tx.feePayer === t.toUserAccount) {
      amountSol = nativeTransfers
        .filter((n) => n.fromUserAccount === tx.feePayer)
        .reduce((s, n) => s + n.amount / LAMPORTS_PER_SOL, 0);
    }

    if (amountSol < MIN_SOL_THRESHOLD) continue;

    traders.push({
      walletAddress: t.toUserAccount,
      transactionSignature: tx.signature,
      actionType: "buy",
      amountSol,
      tokenAmount,
      timestamp: tx.timestamp,
    });
  }

  return traders;
}

function extractSellers(
  tx: HeliusEnhancedTx,
  mint: string,
  poolAddress: string,
): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  const solReceivedByWallet = new Map<string, number>();
  for (const n of nativeTransfers) {
    if (
      n.fromUserAccount === poolAddress &&
      n.toUserAccount &&
      n.toUserAccount !== poolAddress &&
      !IGNORED_PROGRAMS.has(n.toUserAccount)
    ) {
      const current = solReceivedByWallet.get(n.toUserAccount) ?? 0;
      solReceivedByWallet.set(
        n.toUserAccount,
        current + n.amount / LAMPORTS_PER_SOL,
      );
    }
  }

  for (const t of transfers) {
    if (
      t.mint !== mint ||
      t.toUserAccount !== poolAddress ||
      !t.fromUserAccount ||
      t.fromUserAccount === poolAddress ||
      IGNORED_PROGRAMS.has(t.fromUserAccount)
    ) {
      continue;
    }

    const tokenAmount = Number(t.tokenAmount ?? 0);
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;

    const amountSol = solReceivedByWallet.get(t.fromUserAccount) ?? 0;
    if (amountSol < MIN_SOL_THRESHOLD) continue;

    traders.push({
      walletAddress: t.fromUserAccount,
      transactionSignature: tx.signature,
      actionType: "sell",
      amountSol,
      tokenAmount,
      timestamp: tx.timestamp,
    });
  }

  return traders;
}

// ---------------------------------------------------------------------------
// Supabase writes — wallet_token_activity
// ---------------------------------------------------------------------------

async function persistActivity(
  traders: ParsedTrader[],
  job: WalletCollectionJob,
): Promise<string[]> {
  const errors: string[] = [];
  if (traders.length === 0) {
    console.log(`${LOG}   persistActivity — 0 traders, skipping.`);
    return errors;
  }

  const sb = getSupabase();
  if (!sb) {
    const msg = "Supabase credentials not configured — skipping persist.";
    console.error(`${LOG}   ${msg}`);
    errors.push(msg);
    return errors;
  }

  const rows = traders.map((t) => ({
    wallet_address: t.walletAddress,
    token_address: job.tokenAddress,
    transaction_signature: t.transactionSignature,
    action_type: t.actionType,
    amount_sol: t.amountSol,
    amount_usd: null,
    token_amount: t.tokenAmount,
    timestamp: new Date(t.timestamp * 1000).toISOString(),
    entry_market_cap: job.marketCapUsd ?? null,
    liquidity_at_entry: job.liquidityUsd ?? null,
    holder_count_at_entry: job.holderCount ?? null,
    token_age_at_entry:
      job.tokenCreatedAt != null
        ? Math.max(0, Math.round(t.timestamp - job.tokenCreatedAt))
        : null,
  }));

  console.log(
    `${LOG}   persistActivity — upserting ${rows.length} rows into wallet_token_activity`,
  );

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("wallet_token_activity")
      .upsert(chunk, { onConflict: "transaction_signature", ignoreDuplicates: true });
    if (error) {
      const msg = `wallet_token_activity upsert error (chunk ${Math.floor(i / CHUNK)}): ${error.message}`;
      console.error(`${LOG}   ${msg}`);
      errors.push(msg);
    } else {
      console.log(`${LOG}   wallet_token_activity chunk ${Math.floor(i / CHUNK)} — OK (${chunk.length} rows)`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Supabase writes — wallets
// ---------------------------------------------------------------------------

async function persistWallets(
  traders: ParsedTrader[],
  errors: string[],
): Promise<void> {
  if (traders.length === 0) return;

  const sb = getSupabase();
  if (!sb) {
    errors.push("Supabase credentials not configured — skipping wallets upsert.");
    return;
  }

  // Aggregate per unique wallet
  const walletMap = new Map<
    string,
    { firstTs: number; lastTs: number; buys: number; sells: number }
  >();

  for (const t of traders) {
    const existing = walletMap.get(t.walletAddress);
    if (!existing) {
      walletMap.set(t.walletAddress, {
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        buys: t.actionType === "buy" ? 1 : 0,
        sells: t.actionType === "sell" ? 1 : 0,
      });
    } else {
      existing.firstTs = Math.min(existing.firstTs, t.timestamp);
      existing.lastTs = Math.max(existing.lastTs, t.timestamp);
      if (t.actionType === "buy") existing.buys++;
      else existing.sells++;
    }
  }

  const rows = Array.from(walletMap.entries()).map(([addr, stats]) => ({
    wallet_address: addr,
    first_seen_timestamp: new Date(stats.firstTs * 1000).toISOString(),
    last_seen_timestamp: new Date(stats.lastTs * 1000).toISOString(),
    total_buys: stats.buys,
    total_sells: stats.sells,
    total_tokens_traded: 1,
    wallet_classification: "unknown",
  }));

  console.log(
    `${LOG}   persistWallets — upserting ${rows.length} rows into wallets`,
  );

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("wallets")
      .upsert(chunk, {
        onConflict: "wallet_address",
        ignoreDuplicates: false,
      });
    if (error) {
      const msg = `wallets upsert error (chunk ${Math.floor(i / CHUNK)}): ${error.message}`;
      console.error(`${LOG}   ${msg}`);
      errors.push(msg);
    } else {
      console.log(`${LOG}   wallets chunk ${Math.floor(i / CHUNK)} — OK (${chunk.length} rows)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Supabase writes — wallet_performance_history
// ---------------------------------------------------------------------------

async function persistPerformanceHistory(
  traders: ParsedTrader[],
  tokenAddress: string,
  marketCapUsd: number | null | undefined,
  errors: string[],
): Promise<void> {
  if (traders.length === 0) return;

  const sb = getSupabase();
  if (!sb) {
    errors.push("Supabase credentials not configured — skipping performance history.");
    return;
  }

  // Aggregate per (wallet, token)
  const perfMap = new Map<
    string,
    { investedSol: number; receivedSol: number; lastTs: number }
  >();

  for (const t of traders) {
    const existing = perfMap.get(t.walletAddress) ?? {
      investedSol: 0,
      receivedSol: 0,
      lastTs: t.timestamp,
    };
    if (t.actionType === "buy") existing.investedSol += t.amountSol;
    else existing.receivedSol += t.amountSol;
    existing.lastTs = Math.max(existing.lastTs, t.timestamp);
    perfMap.set(t.walletAddress, existing);
  }

  const mcap = marketCapUsd ?? null;

  const rows = Array.from(perfMap.entries()).map(([addr, stats]) => {
    const realized = stats.receivedSol - stats.investedSol;
    const roi =
      stats.investedSol > 0
        ? (stats.investedSol + realized) / stats.investedSol
        : null;
    return {
      wallet_address: addr,
      token_address: tokenAddress,
      initial_investment: stats.investedSol,
      current_value: stats.receivedSol,
      realized_profit: realized,
      unrealized_profit: 0,
      roi_multiple: roi,
      peak_roi: roi,
      reached_100k_mc:  mcap != null && mcap >= 100_000,
      reached_500k_mc:  mcap != null && mcap >= 500_000,
      reached_1m_mc:    mcap != null && mcap >= 1_000_000,
      reached_5m_mc:    mcap != null && mcap >= 5_000_000,
      reached_10m_mc:   mcap != null && mcap >= 10_000_000,
      reached_50m_mc:   mcap != null && mcap >= 50_000_000,
      last_updated: new Date().toISOString(),
    };
  });

  console.log(
    `${LOG}   persistPerformanceHistory — upserting ${rows.length} rows into wallet_performance_history`,
  );

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("wallet_performance_history")
      .upsert(chunk, {
        onConflict: "wallet_address,token_address",
        ignoreDuplicates: false,
      });
    if (error) {
      const msg = `wallet_performance_history upsert error (chunk ${Math.floor(i / CHUNK)}): ${error.message}`;
      console.error(`${LOG}   ${msg}`);
      errors.push(msg);
    } else {
      console.log(
        `${LOG}   wallet_performance_history chunk ${Math.floor(i / CHUNK)} — OK (${chunk.length} rows)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Significant holders (always runs, even without a pool address)
// ---------------------------------------------------------------------------

async function collectSignificantHolders(
  job: WalletCollectionJob,
  existingWallets: Set<string>,
  errors: string[],
): Promise<ParsedTrader[]> {
  const traders: ParsedTrader[] = [];
  console.log(`${LOG} Step 3 — collectSignificantHolders for mint=${job.tokenAddress}`);

  try {
    const result = await rpc<{
      value: Array<{ address: string; amount: string; uiAmount: number }>;
    }>("getTokenLargestAccounts", [job.tokenAddress, "confirmed"]);

    if (!result?.value) {
      console.log(`${LOG}   getTokenLargestAccounts returned no value`);
      return traders;
    }

    console.log(`${LOG}   getTokenLargestAccounts returned ${result.value.length} accounts`);

    for (const acct of result.value.slice(0, 20)) {
      if (IGNORED_PROGRAMS.has(acct.address)) continue;
      if (job.poolAddress && acct.address === job.poolAddress) continue;

      const uiAmount = acct.uiAmount ?? 0;
      if (uiAmount <= 0) continue;

      const info = await rpc<{ value: { data: unknown; owner: string } }>(
        "getAccountInfo",
        [acct.address, { encoding: "jsonParsed" }],
      );

      const parsed = (
        info?.value?.data as { parsed?: { info?: { owner?: string } } } | undefined
      )?.parsed;
      const owner = parsed?.info?.owner;
      if (!owner || IGNORED_PROGRAMS.has(owner)) continue;
      if (job.poolAddress && owner === job.poolAddress) continue;
      if (existingWallets.has(owner)) continue;
      existingWallets.add(owner);

      const sigs = await rpc<Array<{ signature: string; err: unknown }>>(
        "getSignaturesForAddress",
        [acct.address, { limit: 5, commitment: "confirmed" }],
      );
      if (!Array.isArray(sigs) || sigs.length === 0) continue;

      const firstSig = sigs
        .filter((s) => !s.err)
        .map((s) => s.signature)
        .find(Boolean);
      if (!firstSig) continue;

      traders.push({
        walletAddress: owner,
        transactionSignature: firstSig,
        actionType: "buy",
        amountSol: 0,
        tokenAmount: uiAmount,
        timestamp: Math.floor(Date.now() / 1000),
      });

      console.log(`${LOG}   holder collected: ${owner} (${uiAmount.toLocaleString()} tokens)`);
    }

    console.log(`${LOG}   collectSignificantHolders — found ${traders.length} holders`);
  } catch (err) {
    const msg = `Holder collection error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG}   ${msg}`);
    errors.push(msg);
  }
  return traders;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect wallet activity for a token and persist to all three tables:
 *   wallet_token_activity, wallets, wallet_performance_history
 *
 * Never throws. Returns a CollectionResult with full diagnostic info.
 *
 * When poolAddress is absent: Steps 1–2 are skipped; only significant-holder
 * collection runs (Step 3). All DB writes still occur.
 */
export async function collect(
  job: WalletCollectionJob,
): Promise<CollectionResult> {
  const result: CollectionResult = {
    tokenAddress: job.tokenAddress,
    poolAddress: job.poolAddress ?? null,
    tradersCollected: 0,
    buyersCollected: 0,
    sellersCollected: 0,
    skippedDust: 0,
    skippedAirdrop: 0,
    errors: [],
  };

  console.log(
    `${LOG} ═══ collect() START token=${job.tokenAddress} ` +
    `pool=${job.poolAddress ?? "NONE — holder-only mode"} ` +
    `heliusKey=${getHeliusKey() ? "SET" : "MISSING"} ` +
    `supabase=${getSupabase() ? "OK" : "MISSING CREDENTIALS"}`,
  );

  try {
    if (!getHeliusKey()) {
      const msg = "HELIUS_API_KEY not set — trade history collection skipped. Holder collection still runs.";
      console.warn(`${LOG} ⚠ ${msg}`);
      result.errors.push(msg);
      // Don't return — holder collection doesn't need Helius key
    }

    const allTraders: ParsedTrader[] = [];
    let skippedDust = 0;

    // -------------------------------------------------------------------------
    // Steps 1–2: Trade history via pool address (skipped when poolAddress absent)
    // -------------------------------------------------------------------------
    if (job.poolAddress && getHeliusKey()) {
      console.log(`${LOG} Step 1 — paginating signatures for pool ${job.poolAddress}`);

      let before: string | undefined;
      let oldestBatch: Array<{ signature: string; err: unknown }> = [];

      for (let page = 0; page < 8; page++) {
        const batch = await rpc<Array<{ signature: string; err: unknown }>>(
          "getSignaturesForAddress",
          [job.poolAddress, { limit: 1000, before, commitment: "confirmed" }],
        );
        if (!Array.isArray(batch) || batch.length === 0) {
          console.log(`${LOG}   Page ${page}: empty — stopping pagination`);
          break;
        }
        console.log(`${LOG}   Page ${page}: ${batch.length} signatures`);
        oldestBatch = batch;
        if (batch.length < 1000) break;
        before = batch[batch.length - 1]?.signature;
        if (!before) break;
      }

      if (oldestBatch.length === 0) {
        const msg = "No signatures found for pool address.";
        console.warn(`${LOG} ⚠ ${msg}`);
        result.errors.push(msg);
      } else {
        // Step 2: most-recent 100 sigs
        const recentResp = await rpc<Array<{ signature: string; err: unknown }>>(
          "getSignaturesForAddress",
          [job.poolAddress, { limit: 100, commitment: "confirmed" }],
        );
        const recentSigs: string[] = Array.isArray(recentResp)
          ? recentResp.filter((s) => !s.err).map((s) => s.signature).filter(Boolean)
          : [];

        const earliest = oldestBatch
          .filter((s) => !s.err)
          .slice(-Math.min(100, oldestBatch.length))
          .reverse()
          .map((s) => s.signature)
          .filter(Boolean);

        const allSigs = Array.from(new Set([...earliest, ...recentSigs]));
        console.log(`${LOG} Step 2 — parsing ${allSigs.length} unique signatures via Helius`);

        const seenSignatures = new Set<string>();
        const seenBuyers = new Set<string>();

        for (
          let i = 0;
          i < allSigs.length && allTraders.length < MAX_TRADERS;
          i += HELIUS_BATCH_SIZE
        ) {
          const batch = allSigs.slice(i, i + HELIUS_BATCH_SIZE);
          const txs = await heliusParseTxs(batch);

          for (const tx of txs) {
            if (!tx.signature || seenSignatures.has(tx.signature)) continue;
            seenSignatures.add(tx.signature);

            if (seenBuyers.size < MAX_BUYERS) {
              const buyers = extractBuyers(tx, job.tokenAddress, job.poolAddress!);
              for (const b of buyers) {
                if (seenBuyers.has(b.walletAddress)) continue;
                if (b.amountSol < MIN_SOL_THRESHOLD) { skippedDust++; continue; }
                seenBuyers.add(b.walletAddress);
                allTraders.push(b);
              }
            }

            const sellers = extractSellers(tx, job.tokenAddress, job.poolAddress!);
            for (const s of sellers) {
              allTraders.push(s);
            }
          }
        }

        console.log(
          `${LOG} Step 2 done — buyers=${allTraders.filter((t) => t.actionType === "buy").length} ` +
          `sellers=${allTraders.filter((t) => t.actionType === "sell").length} skippedDust=${skippedDust}`,
        );
      }
    } else {
      console.log(
        `${LOG} Steps 1–2 SKIPPED — ` +
        (job.poolAddress ? "HELIUS_API_KEY not set" : "no poolAddress provided"),
      );
    }

    result.skippedDust = skippedDust;

    // -------------------------------------------------------------------------
    // Step 3: Significant holders (always runs)
    // -------------------------------------------------------------------------
    const holderTraders = await collectSignificantHolders(
      job,
      new Set([...allTraders.map((t) => t.walletAddress)]),
      result.errors,
    );
    allTraders.push(...holderTraders);

    console.log(
      `${LOG} Total traders before persist: ${allTraders.length} ` +
      `(buyers=${allTraders.filter((t) => t.actionType === "buy").length} ` +
      `sellers=${allTraders.filter((t) => t.actionType === "sell").length})`,
    );

    if (allTraders.length === 0) {
      console.warn(`${LOG} ⚠ No traders collected — all tables will remain unchanged for this token.`);
    }

    // -------------------------------------------------------------------------
    // Step 4: Persist wallet_token_activity
    // -------------------------------------------------------------------------
    console.log(`${LOG} Step 4 — persist wallet_token_activity`);
    const actErrors = await persistActivity(allTraders, job);
    result.errors.push(...actErrors);

    // -------------------------------------------------------------------------
    // Step 5: Persist wallets
    // -------------------------------------------------------------------------
    console.log(`${LOG} Step 5 — persist wallets`);
    await persistWallets(allTraders, result.errors);

    // -------------------------------------------------------------------------
    // Step 6: Persist wallet_performance_history
    // -------------------------------------------------------------------------
    console.log(`${LOG} Step 6 — persist wallet_performance_history`);
    await persistPerformanceHistory(
      allTraders,
      job.tokenAddress,
      job.marketCapUsd,
      result.errors,
    );

    result.buyersCollected = allTraders.filter((t) => t.actionType === "buy").length;
    result.sellersCollected = allTraders.filter((t) => t.actionType === "sell").length;
    result.tradersCollected = allTraders.length;

    console.log(
      `${LOG} ═══ collect() DONE token=${job.tokenAddress} ` +
      `traders=${result.tradersCollected} buyers=${result.buyersCollected} ` +
      `sellers=${result.sellersCollected} errors=${result.errors.length}`,
    );
  } catch (err) {
    const msg = `Unhandled worker error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG} ✗ ${msg}`, err);
    result.errors.push(msg);
  }

  return result;
}
