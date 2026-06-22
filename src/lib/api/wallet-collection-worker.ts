// =============================================================================
// Wallet Collection Worker
//
// Core collection logic. Completely independent of the token scanner.
// Call collect() after a token is detected. Never throws — always returns
// a CollectionResult so callers stay alive even when Helius is unreachable.
//
// No imports from scan.functions.ts, scan-core.ts, or any scanner module.
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

/** Minimum SOL spent to count as a real buy (filters dust + spam). */
const MIN_SOL_THRESHOLD = 0.001; // ~0.001 SOL ≈ fractions of a cent

/** Minimum token amount to count as a real trade (not a zero-value spam). */
const MIN_TOKEN_AMOUNT = 1;

/** Max Helius Enhanced Transactions per batch call. */
const HELIUS_BATCH_SIZE = 100;

/** Max unique buyer wallets to collect per token. */
const MAX_BUYERS = 50;

/** Max total traders to collect (buyers + sellers) per token. */
const MAX_TRADERS = 200;

/** Solana System Program — ignore transfers to/from this address. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Well-known airdrop / fee programs to ignore as trade counterparties. */
const IGNORED_PROGRAMS = new Set([
  SYSTEM_PROGRAM,
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS", // Associated Token
]);

const LAMPORTS_PER_SOL = 1_000_000_000;

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
    if (!res.ok) return null;
    const j = await res.json();
    return (j?.result ?? null) as T;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function heliusParseTxs(
  signatures: string[],
): Promise<HeliusEnhancedTx[]> {
  const key = getHeliusKey();
  if (!key || signatures.length === 0) return [];
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
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as HeliusEnhancedTx[]) : [];
  } catch {
    return [];
  }
}

/** Returns null when Supabase credentials are not configured. */
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

// ---------------------------------------------------------------------------
// Filtering — determines if a transaction contains a real, paid trade
// ---------------------------------------------------------------------------

/**
 * Extract genuine paid buyers from a Helius Enhanced Transaction.
 *
 * A real buy:
 *  1. Has a tokenTransfer for the target mint FROM the pool TO the wallet.
 *  2. Has a corresponding nativeTransfer where the wallet sends SOL TO the pool,
 *     OR the feePayer is the wallet and the pool received native SOL.
 *  3. amount_sol >= MIN_SOL_THRESHOLD (filters dust, airdrop-only txs).
 *  4. tokenAmount >= MIN_TOKEN_AMOUNT (filters zero-value spam).
 *  5. Buyer wallet is not in IGNORED_PROGRAMS.
 */
function extractBuyers(
  tx: HeliusEnhancedTx,
  mint: string,
  poolAddress: string,
): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  // Index native SOL paid per wallet (sum all SOL flowing from wallet to pool)
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
    // Must be our target mint flowing OUT of pool TO a user wallet
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

    // Determine how much SOL this wallet paid.
    // Check the wallet as the payer OR the feePayer as a fallback.
    let amountSol =
      solPaidByWallet.get(t.toUserAccount) ??
      solPaidByWallet.get(tx.feePayer) ??
      0;

    // If there are zero native transfers to the pool but this is a USDC/WSOL
    // swap, the nativeTransfer might not go directly to the pool. Use feePayer
    // SOL as fallback only when feePayer === toUserAccount.
    if (amountSol === 0 && tx.feePayer === t.toUserAccount) {
      // Sum all outgoing SOL from feePayer
      amountSol = nativeTransfers
        .filter((n) => n.fromUserAccount === tx.feePayer)
        .reduce((s, n) => s + n.amount / LAMPORTS_PER_SOL, 0);
    }

    // Strict filter: must have paid at least MIN_SOL_THRESHOLD
    // This rejects airdrop transactions and zero-cost token transfers
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

/**
 * Extract genuine paid sellers from a Helius Enhanced Transaction.
 *
 * A real sell:
 *  1. Has a tokenTransfer for the target mint FROM the wallet TO the pool.
 *  2. Has a corresponding nativeTransfer where the pool sends SOL TO the wallet.
 *  3. tokenAmount >= MIN_TOKEN_AMOUNT.
 */
function extractSellers(
  tx: HeliusEnhancedTx,
  mint: string,
  poolAddress: string,
): ParsedTrader[] {
  const traders: ParsedTrader[] = [];
  const transfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  // SOL received per wallet from pool
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
// Supabase write — batch upsert into wallet_token_activity
// ---------------------------------------------------------------------------

async function persistTraders(
  traders: ParsedTrader[],
  job: WalletCollectionJob,
): Promise<string[]> {
  const errors: string[] = [];
  if (traders.length === 0) return errors;

  const sb = getSupabase();
  if (!sb) {
    errors.push("Supabase credentials not configured — skipping persist.");
    return errors;
  }

  const tokenAgeAtEntry =
    job.tokenCreatedAt != null
      ? null // will be computed per-row below
      : null;
  void tokenAgeAtEntry;

  const rows = traders.map((t) => ({
    wallet_address: t.walletAddress,
    token_address: job.tokenAddress,
    transaction_signature: t.transactionSignature,
    action_type: t.actionType,
    amount_sol: t.amountSol,
    amount_usd: null, // enriched later by analytics layer
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

  // Batch in chunks of 200 to stay inside Supabase's row limit per request
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from("wallet_token_activity")
      .upsert(chunk, { onConflict: "transaction_signature", ignoreDuplicates: true });
    if (error) {
      errors.push(`Supabase upsert error (chunk ${i / CHUNK}): ${error.message}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Top holders collection
// ---------------------------------------------------------------------------

async function collectSignificantHolders(
  job: WalletCollectionJob,
  existingWallets: Set<string>,
  errors: string[],
): Promise<ParsedTrader[]> {
  const traders: ParsedTrader[] = [];
  try {
    const result = await rpc<{
      value: Array<{ address: string; amount: string; uiAmount: number }>;
    }>("getTokenLargestAccounts", [job.tokenAddress, "confirmed"]);

    if (!result?.value) return traders;

    // Resolve each token account → owner wallet
    for (const acct of result.value.slice(0, 20)) {
      if (IGNORED_PROGRAMS.has(acct.address)) continue;
      if (acct.address === job.poolAddress) continue;

      const uiAmount = acct.uiAmount ?? 0;
      if (uiAmount <= 0) continue;

      // Resolve token account → owner
      const info = await rpc<{ value: { data: unknown; owner: string } }>(
        "getAccountInfo",
        [acct.address, { encoding: "jsonParsed" }],
      );

      const parsed = (info?.value?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed;
      const owner = parsed?.info?.owner;
      if (!owner || IGNORED_PROGRAMS.has(owner) || owner === job.poolAddress) {
        continue;
      }
      if (existingWallets.has(owner)) continue;
      existingWallets.add(owner);

      // We don't have a specific transaction for this holder, so we create
      // a synthetic "holder" record with a placeholder signature.
      // Only add if we can get a real transaction for this holder.
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
        amountSol: 0, // unknown — holder may have bought via multiple txs
        tokenAmount: uiAmount,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }
  } catch (err) {
    errors.push(
      `Holder collection error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return traders;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect wallet activity for a token and persist it to wallet_token_activity.
 *
 * Never throws. Returns a CollectionResult describing what was collected.
 * The scanner continues operating normally whether this succeeds or fails.
 *
 * Strategy:
 *  1. Paginate getSignaturesForAddress backwards to pool creation.
 *  2. Chronologically take the first N signatures (earliest = launch buyers).
 *  3. Parse via Helius Enhanced Transactions.
 *  4. Filter out dust/spam/airdrop transactions.
 *  5. Collect up to MAX_BUYERS unique buyers.
 *  6. Also collect sellers from the same transaction set.
 *  7. Collect significant holders via getTokenLargestAccounts.
 *  8. Upsert all into wallet_token_activity (idempotent on tx signature).
 */
export async function collect(
  job: WalletCollectionJob,
): Promise<CollectionResult> {
  const result: CollectionResult = {
    tokenAddress: job.tokenAddress,
    poolAddress: job.poolAddress,
    tradersCollected: 0,
    buyersCollected: 0,
    sellersCollected: 0,
    skippedDust: 0,
    skippedAirdrop: 0,
    errors: [],
  };

  try {
    if (!getHeliusKey()) {
      result.errors.push(
        "HELIUS_API_KEY not set — wallet collection skipped.",
      );
      return result;
    }

    // -------------------------------------------------------------------------
    // Step 1: Paginate back to the pool's oldest signatures
    // -------------------------------------------------------------------------
    let before: string | undefined;
    let oldestBatch: Array<{ signature: string; err: unknown }> = [];

    for (let page = 0; page < 8; page++) {
      const batch = await rpc<Array<{ signature: string; err: unknown }>>(
        "getSignaturesForAddress",
        [
          job.poolAddress,
          { limit: 1000, before, commitment: "confirmed" },
        ],
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      oldestBatch = batch;
      if (batch.length < 1000) break; // reached pool creation
      before = batch[batch.length - 1]?.signature;
      if (!before) break;
    }

    if (oldestBatch.length === 0) {
      result.errors.push("No signatures found for pool address.");
      return result;
    }

    // Take the OLDEST signatures (launch = bottom of last page) and reverse
    // to get chronological order (first trade first).
    const earliest = oldestBatch
      .filter((s) => !s.err)
      .slice(-Math.min(100, oldestBatch.length))
      .reverse()
      .map((s) => s.signature)
      .filter(Boolean);

    if (earliest.length === 0) {
      result.errors.push("No valid signatures after filtering errored txs.");
      return result;
    }

    // -------------------------------------------------------------------------
    // Step 2: Also grab the 100 most recent signatures for sell + recent data
    // -------------------------------------------------------------------------
    const recentResp = await rpc<Array<{ signature: string; err: unknown }>>(
      "getSignaturesForAddress",
      [job.poolAddress, { limit: 100, commitment: "confirmed" }],
    );
    const recentSigs: string[] = Array.isArray(recentResp)
      ? recentResp.filter((s) => !s.err).map((s) => s.signature).filter(Boolean)
      : [];

    // Deduplicate, preserve chronological order (earliest first)
    const allSigs = Array.from(new Set([...earliest, ...recentSigs]));

    // -------------------------------------------------------------------------
    // Step 3: Parse in batches via Helius Enhanced Transactions
    // -------------------------------------------------------------------------
    const allTraders: ParsedTrader[] = [];
    const seenSignatures = new Set<string>();
    const seenBuyers = new Set<string>();
    let skippedDust = 0;
    let skippedAirdrop = 0;

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

        // --- Buyers ---
        if (seenBuyers.size < MAX_BUYERS) {
          const buyers = extractBuyers(tx, job.tokenAddress, job.poolAddress);
          for (const b of buyers) {
            if (seenBuyers.has(b.walletAddress)) {
              // De-duplicate: update to most recent tx for this buyer
              continue;
            }
            if (b.amountSol < MIN_SOL_THRESHOLD) {
              skippedDust++;
              continue;
            }
            seenBuyers.add(b.walletAddress);
            allTraders.push(b);
          }
        }

        // --- Sellers ---
        const sellers = extractSellers(tx, job.tokenAddress, job.poolAddress);
        for (const s of sellers) {
          allTraders.push(s);
        }
      }
    }

    result.skippedDust = skippedDust;
    result.skippedAirdrop = skippedAirdrop;

    // -------------------------------------------------------------------------
    // Step 4: Significant holders (top token account holders via RPC)
    // -------------------------------------------------------------------------
    const holderTraders = await collectSignificantHolders(
      job,
      new Set([...allTraders.map((t) => t.walletAddress)]),
      result.errors,
    );
    allTraders.push(...holderTraders);

    // -------------------------------------------------------------------------
    // Step 5: Persist to wallet_token_activity
    // -------------------------------------------------------------------------
    const persistErrors = await persistTraders(allTraders, job);
    result.errors.push(...persistErrors);

    result.buyersCollected = allTraders.filter((t) => t.actionType === "buy").length;
    result.sellersCollected = allTraders.filter((t) => t.actionType === "sell").length;
    result.tradersCollected = allTraders.length;
  } catch (err) {
    // Top-level catch — worker NEVER crashes the caller
    result.errors.push(
      `Unhandled worker error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}
