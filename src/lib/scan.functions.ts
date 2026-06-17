import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildScanResult } from "./scan-core";
import type { Trade } from "@/services/analysis";
import { analyzeHoneyPot } from "./honeypot";
import type { ScanResult } from "./mockScan";
import { createClient } from "@supabase/supabase-js";
import { PostLaunchWatcher } from "./postLaunchWatcher";


const HELIUS_KEY = () => process.env.HELIUS_API_KEY ?? "";
const RPC_URL = () =>
  HELIUS_KEY()
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY()}`
    : "https://api.mainnet-beta.solana.com";

async function rpc<T = any>(method: string, params: any[]): Promise<T | null> {
  try {
    const r = await fetch(RPC_URL(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.result ?? null) as T;
  } catch {
    return null;
  }
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, init);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Build a server-side Supabase client using the service-role key so we can
 * read is_authority_transitioned without RLS restrictions.
 * Returns null when credentials are not configured (no hard crash).
 */
function getSupabaseServer() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Look up the is_authority_transitioned flag for a given mint in scan_history.
 * Returns false when the DB is unavailable or the mint has never been scanned.
 */
async function fetchAuthorityTransitionStatus(
  mintAddress: string,
): Promise<{ detected: boolean; authorityType?: string; signature?: string; detectedAt?: string }> {
  const sb = getSupabaseServer();
  if (!sb) return { detected: false };

  try {
    const { data } = await sb
      .from("scan_history")
      .select("is_authority_transitioned")
      .eq("token_address", mintAddress)
      .eq("is_authority_transitioned", true)
      .limit(1)
      .maybeSingle();

    return { detected: !!data };
  } catch {
    return { detected: false };
  }
}

/**
 * Sniper detection via Helius.
 *
 * Strategy:
 *  1. Paginate `getSignaturesForAddress` against the DEX pool address back to
 *     its oldest signatures (pool creation).
 *  2. Take the first ~25 signatures (chronologically) — these are the earliest
 *     interactions with the pool, i.e. the launch swaps.
 *  3. Parse them with Helius Enhanced Transactions to extract tokenTransfers.
 *  4. For each transfer of the target mint OUT of the pool to a user wallet,
 *     count the unique recipient wallets and sum the tokens received.
 *  5. Sniper supply % = sniper tokens / total supply * 100.
 */
async function fetchSniperStats(
  poolAddress: string,
  mint: string,
  supplyUi: number,
): Promise<{
  sniperWallets: number;
  sniperPct: number;
  analyzedSwaps: number;
  available: boolean;
}> {
  const empty = { sniperWallets: 0, sniperPct: 0, analyzedSwaps: 0, available: false };
  if (!HELIUS_KEY() || !poolAddress || !mint || supplyUi <= 0) return empty;

  // Walk back to the oldest signatures (capped to avoid runaway pagination).
  let before: string | undefined;
  let oldestBatch: any[] = [];
  for (let i = 0; i < 6; i++) {
    const batch = await rpc<any[]>("getSignaturesForAddress", [
      poolAddress,
      { limit: 1000, before },
    ]);
    if (!Array.isArray(batch) || batch.length === 0) break;
    oldestBatch = batch;
    if (batch.length < 1000) break;
    before = batch[batch.length - 1]?.signature;
    if (!before) break;
  }
  if (!oldestBatch.length) return empty;

  // getSignaturesForAddress returns newest-first; reverse last page → oldest-first.
  const earliest = oldestBatch
    .filter((s) => !s?.err)
    .slice(-25)
    .reverse();
  const sigs = earliest.map((s) => s.signature).filter(Boolean);
  if (!sigs.length) return empty;

  const parsed = await fetchJson<any[]>(
    `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: sigs }),
    },
  );
  if (!Array.isArray(parsed)) return empty;

  const buyers = new Map<string, number>();
  let analyzed = 0;
  for (const tx of parsed) {
    const transfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
    let counted = false;
    for (const t of transfers) {
      if (
        t?.mint === mint &&
        t?.toUserAccount &&
        t.toUserAccount !== poolAddress &&
        t.fromUserAccount !== t.toUserAccount
      ) {
        const amt = Number(t?.tokenAmount ?? 0);
        if (!isFinite(amt) || amt <= 0) continue;
        buyers.set(
          t.toUserAccount,
          (buyers.get(t.toUserAccount) ?? 0) + amt,
        );
        counted = true;
      }
    }
    if (counted) analyzed += 1;
  }

  const totalBought = Array.from(buyers.values()).reduce((a, b) => a + b, 0);
  const sniperPct = supplyUi > 0 ? (totalBought / supplyUi) * 100 : 0;
  return {
    sniperWallets: buyers.size,
    sniperPct,
    analyzedSwaps: analyzed,
    available: analyzed > 0,
  };
}


/**
 * Recent trade history for the advanced manipulation engine.
 *
 * Pulls the most recent signatures on the DEX pool, parses them via Helius
 * Enhanced Transactions, and converts each target-mint transfer into a Trade.
 * A transfer OUT of the pool to a wallet = buy; INTO the pool from a wallet = sell.
 */
async function fetchTradeHistory(
  poolAddress: string,
  mint: string,
): Promise<Trade[]> {
  if (!HELIUS_KEY() || !poolAddress || !mint) return [];

  const sigResp = await rpc<any[]>("getSignaturesForAddress", [
    poolAddress,
    { limit: 100 },
  ]);
  const sigs = Array.isArray(sigResp)
    ? sigResp.filter((x) => !x?.err).map((x) => x.signature).filter(Boolean).slice(0, 100)
    : [];
  if (!sigs.length) return [];

  const parsed = await fetchJson<any[]>(
    `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: sigs }),
    },
  );
  if (!Array.isArray(parsed)) return [];

  const trades: Trade[] = [];
  for (const tx of parsed) {
    const transfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
    for (const t of transfers) {
      if (t?.mint !== mint) continue;
      const amt = Number(t?.tokenAmount ?? 0);
      if (!isFinite(amt) || amt <= 0) continue;

      let side: "buy" | "sell" | null = null;
      let wallet: string | undefined;
      if (
        t.fromUserAccount === poolAddress &&
        t.toUserAccount &&
        t.toUserAccount !== poolAddress
      ) {
        side = "buy";
        wallet = t.toUserAccount;
      } else if (
        t.toUserAccount === poolAddress &&
        t.fromUserAccount &&
        t.fromUserAccount !== poolAddress
      ) {
        side = "sell";
        wallet = t.fromUserAccount;
      }
      if (!side || !wallet) continue;

      trades.push({
        signature: tx.signature,
        timestamp: (Number(tx.timestamp) || 0) * 1000,
        wallet,
        side,
        amount: amt,
        computeUnits:
          typeof tx?.meta?.computeUnitsConsumed === "number"
            ? tx.meta.computeUnitsConsumed
            : undefined,
      });
    }
  }
  return trades;
}


export const scanTokenLive = createServerFn({ method: "POST" })
  .inputValidator(z.object({ address: z.string().min(32).max(44) }))
  .handler(async ({ data }): Promise<ScanResult> => {
    const input = data.address.trim();

    // --- Resolve input to a token MINT address ---------------------------------
    async function resolveMint(addr: string): Promise<{
      mint: string;
      pairs: any[];
      resolvedFromPair: boolean;
    }> {
      const byToken = await fetchJson<any>(
        `https://api.dexscreener.com/latest/dex/tokens/${addr}`,
      );
      const tokenPairs: any[] = Array.isArray(byToken?.pairs) ? byToken.pairs : [];
      if (tokenPairs.length) {
        return { mint: addr, pairs: tokenPairs, resolvedFromPair: false };
      }

      const byPair = await fetchJson<any>(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${addr}`,
      );
      const pairList: any[] = Array.isArray(byPair?.pairs) ? byPair.pairs : [];
      let match = pairList.find(
        (p) => p?.baseToken?.address && p?.chainId === "solana",
      );

      if (!match) {
        const search = await fetchJson<any>(
          `https://api.dexscreener.com/latest/dex/search?q=${addr}`,
        );
        const sPairs: any[] = Array.isArray(search?.pairs) ? search.pairs : [];
        match = sPairs.find(
          (p) =>
            p?.chainId === "solana" &&
            (p?.pairAddress?.toLowerCase() === addr.toLowerCase() ||
              p?.baseToken?.address?.toLowerCase() === addr.toLowerCase()),
        );
      }

      if (match?.baseToken?.address) {
        const reTokens = await fetchJson<any>(
          `https://api.dexscreener.com/latest/dex/tokens/${match.baseToken.address}`,
        );
        const allPairs: any[] = Array.isArray(reTokens?.pairs)
          ? reTokens.pairs
          : [match];
        return {
          mint: match.baseToken.address,
          pairs: allPairs,
          resolvedFromPair: match.baseToken.address.toLowerCase() !== addr.toLowerCase(),
        };
      }

      return { mint: addr, pairs: [], resolvedFromPair: false };
    }

    const { mint: address, pairs, resolvedFromPair } = await resolveMint(input);

    // 1. Solana RPC — mint account (parsed) gives mint/freeze authority + supply + decimals
    const mintInfo = await rpc<any>("getAccountInfo", [
      address,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    const parsed = mintInfo?.value?.data?.parsed?.info ?? null;

    // 2. RPC — top 20 largest token accounts (used for holder concentration)
    const largest = await rpc<any>("getTokenLargestAccounts", [address]);
    const supplyResp = await rpc<any>("getTokenSupply", [address]);

    // 3. RugCheck — public risk report
    const rug = await fetchJson<any>(
      `https://api.rugcheck.xyz/v1/tokens/${address}/report`,
      { headers: { accept: "application/json" } },
    );

    // 4. Helius — DAS asset (token metadata: name/symbol/image)
    let asset: any = null;
    if (HELIUS_KEY()) {
      asset = await fetchJson<any>(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "asset",
          method: "getAsset",
          params: { id: address },
        }),
      }).then((j: any) => j?.result ?? null);
    }

    // pick highest-liquidity Solana pair
    const pair =
      pairs
        .filter((p) => p.chainId === "solana")
        .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0] ?? null;

    // 5. Helius — sniper detection on the pool's earliest swaps
    const supplyUi: number = Number(supplyResp?.value?.uiAmount ?? 0) || 0;
    const sniper = pair?.pairAddress
      ? await fetchSniperStats(pair.pairAddress, address, supplyUi)
      : null;

    // 5b. Helius — recent trade history for wash-trading / manipulation engine
    const trades = pair?.pairAddress
      ? await fetchTradeHistory(pair.pairAddress, address)
      : [];

    // 6. GoPlus — real honey-pot / sell-restriction analysis
    const honey = await analyzeHoneyPot(address, {
      freezeAuthorityActive: !!parsed?.freezeAuthority,
      mintAuthorityActive: !!parsed?.mintAuthority,
    });

    // 7. Post-launch authority transition check.
    //
    //    First, look up the DB to see if PostLaunchWatcher has already flagged
    //    this mint. This ensures that even if the watcher fired while the user
    //    was not looking, the re-scan still reflects the Critical Risk status.
    //
    //    Second, ensure the watcher is now tracking this mint so future
    //    SetAuthority instructions on it will be caught in real time.
    const authorityTransitioned = await fetchAuthorityTransitionStatus(address);

    // Register the mint with the watcher (idempotent — safe to call every scan).
    if (HELIUS_KEY()) {
      try {
        PostLaunchWatcher.getInstance().trackMint(address);
      } catch {
        // Watcher not started yet — tracking is best-effort here;
        // the periodic refresh will pick it up when the watcher starts.
      }
    }

    return buildScanResult({
      address,
      parsed,
      largest,
      supplyResp,
      rug,
      asset,
      pair,
      sniper,
      trades,
      honey,
      resolvedFromPair,
      originalInput: input,
      authorityTransitioned,
    });
  });
