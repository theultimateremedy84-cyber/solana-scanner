// =============================================================================
// Wallet Collection Worker  (v7)
//
// Supabase key priority — matches scan.functions.ts exactly:
//   SUPABASE_SERVICE_ROLE_KEY  (service role — bypasses RLS, preferred)
//   SUPABASE_ANON_KEY          (anon — what scan.functions.ts falls back to)
//   SUPABASE_PUBLISHABLE_KEY   (publishable alias)
//   VITE_SUPABASE_ANON_KEY     (last resort)
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
const MIN_TOKEN_AMOUNT  = 1;
const HELIUS_BATCH_SIZE = 100;
const MAX_BUYERS        = 50;
const MAX_TRADERS       = 200;
const LAMPORTS_PER_SOL  = 1_000_000_000;
const LOG = "[WalletWorker]";

const IGNORED_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS",
]);

// ---------------------------------------------------------------------------
// Env helpers
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

export function getSupabase() {
  // import.meta.env.VITE_SUPABASE_URL is baked in at Vite build time and is
  // guaranteed to resolve correctly in Railway Vite builds. process.env.*
  // variants are kept as runtime fallbacks.
  const url =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";

  if (!url || !key) {
    console.error(
      `${LOG} ✗ Supabase credentials not found.\n` +
      `  Checked: VITE_SUPABASE_URL (import.meta.env), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,\n` +
      `           SUPABASE_PUBLISHABLE_KEY, VITE_SUPABASE_ANON_KEY\n` +
      `  VITE_SUPABASE_URL (baked) = ${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ? "SET" : "MISSING"}\n` +
      `  SUPABASE_URL              = ${process.env.SUPABASE_URL ? "SET" : "MISSING"}\n` +
      `  SUPABASE_SERVICE_ROLE_KEY = ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "MISSING"}\n` +
      `  SUPABASE_ANON_KEY         = ${process.env.SUPABASE_ANON_KEY ? "SET" : "MISSING"}\n` +
      `  SUPABASE_PUBLISHABLE_KEY  = ${process.env.SUPABASE_PUBLISHABLE_KEY ? "SET" : "MISSING"}`,
    );
    return null;
  }

  const keyLabel =
    process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" :
    process.env.SUPABASE_ANON_KEY         ? "anon"         : "publishable";

  console.log(`${LOG} Supabase connected (${keyLabel}) url=${url.slice(0, 40)}…`);

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

async function rpc<T = unknown>(method: string, params: unknown[], timeoutMs = 12_000): Promise<T | null> {
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
    if (!res.ok) { console.warn(`${LOG} RPC ${method} HTTP ${res.status}`); return null; }
    const j = await res.json();
    return (j?.result ?? null) as T;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`${LOG} RPC ${method} error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helius
// ---------------------------------------------------------------------------

async function heliusParseTxs(signatures: string[]): Promise<HeliusEnhancedTx[]> {
  const key = getHeliusKey();
  if (!key || signatures.length === 0) return [];
  console.log(`${LOG}   Helius parse ${signatures.length} txs`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: signatures }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`${LOG}   Helius HTTP ${res.status}`); return []; }
    const data = await res.json();
    const txs = Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];
    console.log(`${LOG}   Helius returned ${txs.length} parsed txs`);
    return txs;
  } catch (err) {
    console.warn(`${LOG}   Helius error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trade extraction
// ---------------------------------------------------------------------------

function extractBuyers(tx: HeliusEnhancedTx, mint: string, poolAddress: string): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const native    = tx.nativeTransfers ?? [];

  const solPaid = new Map<string, number>();
  for (const n of native) {
    if (n.toUserAccount === poolAddress && n.fromUserAccount && n.fromUserAccount !== poolAddress && !IGNORED_PROGRAMS.has(n.fromUserAccount)) {
      solPaid.set(n.fromUserAccount, (solPaid.get(n.fromUserAccount) ?? 0) + n.amount / LAMPORTS_PER_SOL);
    }
  }

  for (const t of transfers) {
    if (t.mint !== mint || t.fromUserAccount !== poolAddress || !t.toUserAccount || t.toUserAccount === poolAddress || IGNORED_PROGRAMS.has(t.toUserAccount)) continue;
    const tokenAmount = Number(t.tokenAmount ?? 0);
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;
    let amountSol = solPaid.get(t.toUserAccount) ?? solPaid.get(tx.feePayer) ?? 0;
    if (amountSol === 0 && tx.feePayer === t.toUserAccount) {
      amountSol = native.filter((n) => n.fromUserAccount === tx.feePayer).reduce((s, n) => s + n.amount / LAMPORTS_PER_SOL, 0);
    }
    if (amountSol < MIN_SOL_THRESHOLD) continue;
    traders.push({ walletAddress: t.toUserAccount, transactionSignature: tx.signature, actionType: "buy", amountSol, tokenAmount, timestamp: tx.timestamp });
  }
  return traders;
}

function extractSellers(tx: HeliusEnhancedTx, mint: string, poolAddress: string): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const native    = tx.nativeTransfers ?? [];

  const solReceived = new Map<string, number>();
  for (const n of native) {
    if (n.fromUserAccount === poolAddress && n.toUserAccount && n.toUserAccount !== poolAddress && !IGNORED_PROGRAMS.has(n.toUserAccount)) {
      solReceived.set(n.toUserAccount, (solReceived.get(n.toUserAccount) ?? 0) + n.amount / LAMPORTS_PER_SOL);
    }
  }

  for (const t of transfers) {
    if (t.mint !== mint || t.toUserAccount !== poolAddress || !t.fromUserAccount || t.fromUserAccount === poolAddress || IGNORED_PROGRAMS.has(t.fromUserAccount)) continue;
    const tokenAmount = Number(t.tokenAmount ?? 0);
    if (!isFinite(tokenAmount) || tokenAmount < MIN_TOKEN_AMOUNT) continue;
    const amountSol = solReceived.get(t.fromUserAccount) ?? 0;
    if (amountSol < MIN_SOL_THRESHOLD) continue;
    traders.push({ walletAddress: t.fromUserAccount, transactionSignature: tx.signature, actionType: "sell", amountSol, tokenAmount, timestamp: tx.timestamp });
  }
  return traders;
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function persistActivity(traders: ParsedTrader[], job: WalletCollectionJob, errors: string[]): Promise<void> {
  if (traders.length === 0) { console.log(`${LOG}   Step 4 SKIP — 0 traders`); return; }
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallet_token_activity skipped."); return; }

  const rows = traders.map((t) => ({
    wallet_address:        t.walletAddress,
    token_address:         job.tokenAddress,
    transaction_signature: t.transactionSignature,
    action_type:           t.actionType,
    amount_sol:            t.amountSol,
    amount_usd:            null,
    token_amount:          t.tokenAmount,
    timestamp:             new Date(t.timestamp * 1000).toISOString(),
    entry_market_cap:      job.marketCapUsd ?? null,
    liquidity_at_entry:    job.liquidityUsd ?? null,
    holder_count_at_entry: job.holderCount  ?? null,
    token_age_at_entry:    job.tokenCreatedAt != null ? Math.max(0, Math.round(t.timestamp - job.tokenCreatedAt)) : null,
  }));

  console.log(`${LOG}   Step 4 — upserting ${rows.length} rows → wallet_token_activity`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from("wallet_token_activity").upsert(chunk, { onConflict: "transaction_signature", ignoreDuplicates: true });
    if (error) { const m = `wallet_token_activity: ${error.message}`; console.error(`${LOG}   ✗ ${m}`); errors.push(m); }
    else         { console.log(`${LOG}   ✓ wallet_token_activity chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows)`); }
  }
}

async function persistWallets(traders: ParsedTrader[], errors: string[]): Promise<void> {
  if (traders.length === 0) return;
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallets skipped."); return; }

  const walletMap = new Map<string, { firstTs: number; lastTs: number; buys: number; sells: number }>();
  for (const t of traders) {
    const w = walletMap.get(t.walletAddress) ?? { firstTs: t.timestamp, lastTs: t.timestamp, buys: 0, sells: 0 };
    w.firstTs = Math.min(w.firstTs, t.timestamp);
    w.lastTs  = Math.max(w.lastTs,  t.timestamp);
    if (t.actionType === "buy") w.buys++; else w.sells++;
    walletMap.set(t.walletAddress, w);
  }

  const rows = Array.from(walletMap.entries()).map(([addr, w]) => ({
    wallet_address:        addr,
    first_seen_timestamp:  new Date(w.firstTs * 1000).toISOString(),
    last_seen_timestamp:   new Date(w.lastTs  * 1000).toISOString(),
    total_buys:            w.buys,
    total_sells:           w.sells,
    total_tokens_traded:   1,
    wallet_classification: "unknown",
  }));

  console.log(`${LOG}   Step 5 — upserting ${rows.length} rows → wallets`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from("wallets").upsert(chunk, { onConflict: "wallet_address", ignoreDuplicates: false });
    if (error) { const m = `wallets: ${error.message}`; console.error(`${LOG}   ✗ ${m}`); errors.push(m); }
    else         { console.log(`${LOG}   ✓ wallets chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows)`); }
  }
}

async function persistPerformanceHistory(traders: ParsedTrader[], tokenAddress: string, marketCapUsd: number | null | undefined, errors: string[]): Promise<void> {
  if (traders.length === 0) return;
  const sb = getSupabase();
  if (!sb) { errors.push("Supabase unavailable — wallet_performance_history skipped."); return; }

  const perfMap = new Map<string, { invested: number; received: number; lastTs: number }>();
  for (const t of traders) {
    const p = perfMap.get(t.walletAddress) ?? { invested: 0, received: 0, lastTs: t.timestamp };
    if (t.actionType === "buy") p.invested += t.amountSol; else p.received += t.amountSol;
    p.lastTs = Math.max(p.lastTs, t.timestamp);
    perfMap.set(t.walletAddress, p);
  }

  const mcap = marketCapUsd ?? null;
  const rows = Array.from(perfMap.entries()).map(([addr, p]) => {
    const realized = p.received - p.invested;
    const roi      = p.invested > 0 ? (p.invested + realized) / p.invested : null;
    return {
      wallet_address:    addr,
      token_address:     tokenAddress,
      initial_investment: p.invested,
      current_value:     p.received,
      realized_profit:   realized,
      unrealized_profit: 0,
      roi_multiple:      roi,
      peak_roi:          roi,
      reached_100k_mc:   mcap != null && mcap >= 100_000,
      reached_500k_mc:   mcap != null && mcap >= 500_000,
      reached_1m_mc:     mcap != null && mcap >= 1_000_000,
      reached_5m_mc:     mcap != null && mcap >= 5_000_000,
      reached_10m_mc:    mcap != null && mcap >= 10_000_000,
      reached_50m_mc:    mcap != null && mcap >= 50_000_000,
      last_updated:      new Date().toISOString(),
    };
  });

  console.log(`${LOG}   Step 6 — upserting ${rows.length} rows → wallet_performance_history`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from("wallet_performance_history").upsert(chunk, { onConflict: "wallet_address,token_address", ignoreDuplicates: false });
    if (error) { const m = `wallet_performance_history: ${error.message}`; console.error(`${LOG}   ✗ ${m}`); errors.push(m); }
    else         { console.log(`${LOG}   ✓ wallet_performance_history chunk ${Math.floor(i / CHUNK)} (${chunk.length} rows)`); }
  }
}

// ---------------------------------------------------------------------------
// Significant holders (Step 3 — always runs)
// ---------------------------------------------------------------------------

async function collectSignificantHolders(job: WalletCollectionJob, existingWallets: Set<string>, errors: string[]): Promise<ParsedTrader[]> {
  const traders: ParsedTrader[] = [];
  console.log(`${LOG} Step 3 — getTokenLargestAccounts for ${job.tokenAddress}`);

  try {
    const result = await rpc<{ value: Array<{ address: string; uiAmount: number }> }>(
      "getTokenLargestAccounts", [job.tokenAddress, { commitment: "confirmed" }],
    );
    if (!result?.value) { console.log(`${LOG}   No value returned from RPC`); return traders; }
    console.log(`${LOG}   ${result.value.length} token accounts found`);

    for (const acct of result.value.slice(0, 20)) {
      if (IGNORED_PROGRAMS.has(acct.address)) continue;
      if (job.poolAddress && acct.address === job.poolAddress) continue;
      const uiAmount = acct.uiAmount ?? 0;
      if (uiAmount <= 0) continue;

      const info = await rpc<{ value: { data: unknown; owner: string } }>(
        "getAccountInfo", [acct.address, { encoding: "jsonParsed" }],
      );
      const parsed = (info?.value?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed;
      const owner  = parsed?.info?.owner;
      if (!owner || IGNORED_PROGRAMS.has(owner)) continue;
      if (job.poolAddress && owner === job.poolAddress) continue;
      if (existingWallets.has(owner)) continue;
      existingWallets.add(owner);

      const sigs = await rpc<Array<{ signature: string; err: unknown }>>(
        "getSignaturesForAddress", [acct.address, { limit: 5, commitment: "confirmed" }],
      );
      if (!Array.isArray(sigs) || sigs.length === 0) continue;
      const firstSig = sigs.filter((s) => !s.err).map((s) => s.signature).find(Boolean);
      if (!firstSig) continue;

      traders.push({ walletAddress: owner, transactionSignature: firstSig, actionType: "buy", amountSol: 0, tokenAmount: uiAmount, timestamp: Math.floor(Date.now() / 1000) });
      console.log(`${LOG}   holder: ${owner.slice(0, 8)}… (${uiAmount.toLocaleString()} tokens)`);
    }
    console.log(`${LOG}   collectSignificantHolders done: ${traders.length} holders`);
  } catch (err) {
    const msg = `collectSignificantHolders: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG}   ${msg}`);
    errors.push(msg);
  }
  return traders;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function collect(job: WalletCollectionJob): Promise<CollectionResult> {
  const result: CollectionResult = {
    tokenAddress: job.tokenAddress, poolAddress: job.poolAddress ?? null,
    tradersCollected: 0, buyersCollected: 0, sellersCollected: 0,
    skippedDust: 0, skippedAirdrop: 0, errors: [],
  };

  const heliusOk = !!getHeliusKey();
  const sbOk     = !!getSupabase();

  console.log(
    `${LOG} ═══ collect() START\n` +
    `${LOG}   token  : ${job.tokenAddress}\n` +
    `${LOG}   pool   : ${job.poolAddress ?? "NONE (holder-only mode)"}\n` +
    `${LOG}   helius : ${heliusOk ? "✓" : "✗ MISSING (Steps 1-2 skipped)"}\n` +
    `${LOG}   sb     : ${sbOk ? "✓" : "✗ MISSING CREDENTIALS"}`,
  );

  try {
    const allTraders: ParsedTrader[] = [];
    let skippedDust = 0;

    // Steps 1-2: trade history (requires poolAddress + Helius)
    if (job.poolAddress && heliusOk) {
      console.log(`${LOG} Step 1 — paginating pool sigs: ${job.poolAddress}`);
      let before: string | undefined;
      let pageSigs: string[] = [];

      for (let page = 0; page < 8; page++) {
        const batch = await rpc<Array<{ signature: string; err: unknown }>>(
          "getSignaturesForAddress", [job.poolAddress, { limit: 1000, before, commitment: "confirmed" }],
        );
        if (!Array.isArray(batch) || batch.length === 0) { console.log(`${LOG}   page ${page}: empty`); break; }
        console.log(`${LOG}   page ${page}: ${batch.length} sigs`);
        pageSigs = batch.filter((s) => !s.err).map((s) => s.signature).filter(Boolean);
        if (batch.length < 1000) break;
        before = batch[batch.length - 1]?.signature;
        if (!before) break;
      }

      const recentResp = await rpc<Array<{ signature: string; err: unknown }>>(
        "getSignaturesForAddress", [job.poolAddress, { limit: 100, commitment: "confirmed" }],
      );
      const recentSigs = Array.isArray(recentResp)
        ? recentResp.filter((s) => !s.err).map((s) => s.signature).filter(Boolean)
        : [];

      const allSigs = Array.from(new Set([...pageSigs.slice(0, 100), ...recentSigs]));
      console.log(`${LOG} Step 2 — parsing ${allSigs.length} sigs via Helius`);

      const seenSigs   = new Set<string>();
      const seenBuyers = new Set<string>();

      for (let i = 0; i < allSigs.length && allTraders.length < MAX_TRADERS; i += HELIUS_BATCH_SIZE) {
        const txs = await heliusParseTxs(allSigs.slice(i, i + HELIUS_BATCH_SIZE));
        for (const tx of txs) {
          if (!tx.signature || seenSigs.has(tx.signature)) continue;
          seenSigs.add(tx.signature);
          if (seenBuyers.size < MAX_BUYERS) {
            for (const b of extractBuyers(tx, job.tokenAddress, job.poolAddress!)) {
              if (seenBuyers.has(b.walletAddress)) continue;
              if (b.amountSol < MIN_SOL_THRESHOLD) { skippedDust++; continue; }
              seenBuyers.add(b.walletAddress);
              allTraders.push(b);
            }
          }
          for (const s of extractSellers(tx, job.tokenAddress, job.poolAddress!)) allTraders.push(s);
        }
      }
      result.skippedDust = skippedDust;
      console.log(`${LOG} Step 2 done — buys=${allTraders.filter((t) => t.actionType === "buy").length} sells=${allTraders.filter((t) => t.actionType === "sell").length}`);
    } else {
      console.log(`${LOG} Steps 1-2 SKIPPED — ${job.poolAddress ? "no Helius key" : "no poolAddress"}`);
    }

    // Step 3: holders
    const holderTraders = await collectSignificantHolders(job, new Set(allTraders.map((t) => t.walletAddress)), result.errors);
    allTraders.push(...holderTraders);

    console.log(`${LOG} Total traders: ${allTraders.length}`);
    if (allTraders.length === 0) {
      console.warn(`${LOG} ⚠ 0 traders — no rows to write. Token may have no on-chain holder accounts yet.`);
    }

    // Steps 4-6: writes
    await persistActivity(allTraders, job, result.errors);
    await persistWallets(allTraders, result.errors);
    await persistPerformanceHistory(allTraders, job.tokenAddress, job.marketCapUsd, result.errors);

    result.buyersCollected  = allTraders.filter((t) => t.actionType === "buy").length;
    result.sellersCollected = allTraders.filter((t) => t.actionType === "sell").length;
    result.tradersCollected = allTraders.length;

    console.log(`${LOG} ═══ collect() DONE — traders=${result.tradersCollected} errors=${result.errors.length}`);
  } catch (err) {
    const msg = `Unhandled error in collect(): ${err instanceof Error ? err.message : String(err)}`;
    console.error(`${LOG} ✗ ${msg}`, err);
    result.errors.push(msg);
  }

  return result;
}
