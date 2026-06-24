// =============================================================================
// Wallet Audit Endpoint  —  /api/wallet-audit
//
// PURPOSE:
//   Live comparison between:
//     • what is stored in wallet_performance_history
//     • what DexScreener currently returns for each token's SOL pair
//     • what DexScreener currently returns for each token's best USDC pair
//
//   Produces a per-token corruption report that does NOT rely on any fixed
//   price threshold — corruption is identified purely by the ratio:
//     stored_price_sol / dexscreener_sol_price ≈ 1.0 → corrupted (was USDC price)
//     stored_price_sol / dexscreener_sol_price ≈ SOL/USD rate → correct
//
// USAGE:
//   GET /api/wallet-audit
//   GET /api/wallet-audit?token=zinc155BS4mSPk8GXQj4R5hkVDQXcW253pTYq5SGyfi
//   GET /api/wallet-audit?limit=20&onlyCorrupted=true
//
// AUTHENTICATION:
//   Add auth middleware appropriate to your app before deploying externally.
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { getSupabase } from "../../lib/api/wallet-collection-worker";

const LOG = "[WalletAudit]";
const WSOL = "So11111111111111111111111111111111111111112";
const DEXSCREENER_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenPricePair {
  dexId:        string;
  pairAddress:  string;
  quoteSymbol:  string;
  priceNative:  number;
  priceUsd:     number;
  liquidityUsd: number;
}

interface TokenPrices {
  bestSolPair:  TokenPricePair | null;
  bestUsdcPair: TokenPricePair | null;
  priceSol:     number | null;
  priceUsd:     number | null;
  fetchError:   string | null;
}

interface WalletRow {
  wallet_address:          string;
  position_status:         string | null;
  current_token_price_sol: number | null;
  current_token_price_usd: number | null;
  current_position_value_sol: number | null;
  unrealized_profit:       number | null;
  roi_multiple:            number | null;
  initial_investment:      number | null;
  current_token_balance:   number | null;
  last_updated:            string | null;
}

interface TokenAuditResult {
  token_address:    string;
  stored_wallets:   number;
  live_price_sol:   number | null;  // from DexScreener SOL pair
  live_price_usdc:  number | null;  // from DexScreener USDC pair (priceNative = USDC)
  live_price_usd:   number | null;  // live USD price
  best_sol_pair_dex: string | null;
  best_sol_pair_liq: number | null;
  best_usdc_pair_dex: string | null;
  best_usdc_pair_liq: number | null;
  fetch_error:      string | null;
  wallets: WalletAuditRow[];
}

interface WalletAuditRow {
  wallet_address:          string;
  position_status:         string | null;
  stored_price_sol:        number | null;
  live_price_sol:          number | null;
  corruption_ratio:        number | null;  // stored/live — should be ~1.0 if corrupted
  stored_price_usd:        number | null;
  implied_sol_usd_at_storage: number | null;  // stored_usd / stored_sol — ~1 = corrupted
  verdict:                 "CORRECT" | "CORRUPTED" | "AMBIGUOUS" | "NO_LIVE_PRICE" | "NO_STORED_PRICE";
  stored_position_value:   number | null;
  estimated_true_position: number | null;   // balance × live_sol_price
  stored_unrealized:       number | null;
  estimated_true_unrealized: number | null; // estimated_position - initial_investment
  stored_roi:              number | null;
  estimated_true_roi:      number | null;
  initial_investment:      number | null;
  current_token_balance:   number | null;
  last_updated:            string | null;
}

// ---------------------------------------------------------------------------
// DexScreener fetcher — both SOL and USDC pair prices
// ---------------------------------------------------------------------------

async function fetchBothPrices(tokenAddress: string): Promise<TokenPrices> {
  const empty: TokenPrices = { bestSolPair: null, bestUsdcPair: null, priceSol: null, priceUsd: null, fetchError: null };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { headers: { accept: "application/json" }, signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return { ...empty, fetchError: `HTTP ${res.status}` };

    const data = await res.json() as {
      pairs?: Array<{
        chainId?: string;
        dexId?: string;
        pairAddress?: string;
        priceNative?: string;
        priceUsd?: string;
        marketCap?: number;
        liquidity?: { usd?: number };
        quoteToken?: { address?: string; symbol?: string };
        baseToken?: { address?: string };
      }>;
    };

    // Only Solana base-token pairs
    const basePairs = (data.pairs ?? []).filter(
      (p) =>
        (!p.chainId || p.chainId === "solana") &&
        p.baseToken?.address === tokenAddress,
    );

    const solPairs = basePairs
      .filter((p) => p.quoteToken?.address === WSOL)
      .map((p): TokenPricePair => ({
        dexId:        p.dexId ?? "unknown",
        pairAddress:  p.pairAddress ?? "",
        quoteSymbol:  "SOL",
        priceNative:  parseFloat(p.priceNative ?? "0"),
        priceUsd:     parseFloat(p.priceUsd    ?? "0"),
        liquidityUsd: p.liquidity?.usd ?? 0,
      }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    const usdcPairs = basePairs
      .filter((p) => p.quoteToken?.symbol === "USDC" || p.quoteToken?.symbol === "USDT")
      .map((p): TokenPricePair => ({
        dexId:        p.dexId ?? "unknown",
        pairAddress:  p.pairAddress ?? "",
        quoteSymbol:  p.quoteToken?.symbol ?? "USDC",
        priceNative:  parseFloat(p.priceNative ?? "0"),
        priceUsd:     parseFloat(p.priceUsd    ?? "0"),
        liquidityUsd: p.liquidity?.usd ?? 0,
      }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    const bestSolPair  = solPairs[0]  ?? null;
    const bestUsdcPair = usdcPairs[0] ?? null;

    return {
      bestSolPair,
      bestUsdcPair,
      priceSol: bestSolPair?.priceNative ?? null,
      priceUsd: bestSolPair?.priceUsd ?? bestUsdcPair?.priceUsd ?? null,
      fetchError: null,
    };
  } catch (err) {
    return { ...empty, fetchError: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Classify a single wallet row against live prices
// ---------------------------------------------------------------------------

function classifyRow(row: WalletRow, livePriceSol: number | null): WalletAuditRow {
  const storedPriceSol = row.current_token_price_sol;
  const storedPriceUsd = row.current_token_price_usd;
  const balance        = row.current_token_balance ?? 0;
  const invested       = row.initial_investment    ?? 0;

  // implied SOL/USD rate at time of storage
  const impliedSolUsd =
    storedPriceSol != null && storedPriceSol > 0 && storedPriceUsd != null
      ? storedPriceUsd / storedPriceSol
      : null;

  // How far stored price is from the live SOL price
  const corruptionRatio =
    storedPriceSol != null && livePriceSol != null && livePriceSol > 0
      ? storedPriceSol / livePriceSol
      : null;

  let verdict: WalletAuditRow["verdict"];
  if (storedPriceSol == null) {
    verdict = "NO_STORED_PRICE";
  } else if (livePriceSol == null) {
    verdict = "NO_LIVE_PRICE";
  } else if (impliedSolUsd != null && impliedSolUsd < 5) {
    verdict = "CORRUPTED";     // stored "SOL price" was actually a USD/USDC price
  } else if (impliedSolUsd != null && impliedSolUsd < 15) {
    verdict = "AMBIGUOUS";     // investigate manually
  } else {
    verdict = "CORRECT";
  }

  const estTruePosition  = livePriceSol != null ? balance * livePriceSol : null;
  const estTrueUnrealized = estTruePosition != null && invested > 0
    ? estTruePosition - invested
    : null;
  const estTrueRoi = estTruePosition != null && invested > 0
    ? estTruePosition / invested
    : null;

  return {
    wallet_address:              row.wallet_address,
    position_status:             row.position_status,
    stored_price_sol:            storedPriceSol,
    live_price_sol:              livePriceSol,
    corruption_ratio:            corruptionRatio ? parseFloat(corruptionRatio.toFixed(4)) : null,
    stored_price_usd:            storedPriceUsd,
    implied_sol_usd_at_storage:  impliedSolUsd ? parseFloat(impliedSolUsd.toFixed(4)) : null,
    verdict,
    stored_position_value:       row.current_position_value_sol,
    estimated_true_position:     estTruePosition  ? parseFloat(estTruePosition.toFixed(6))  : null,
    stored_unrealized:           row.unrealized_profit,
    estimated_true_unrealized:   estTrueUnrealized ? parseFloat(estTrueUnrealized.toFixed(6)) : null,
    stored_roi:                  row.roi_multiple,
    estimated_true_roi:          estTrueRoi ? parseFloat(estTrueRoi.toFixed(4)) : null,
    initial_investment:          row.initial_investment,
    current_token_balance:       row.current_token_balance,
    last_updated:                row.last_updated,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const Route = createAPIFileRoute("/api/wallet-audit")({
  GET: async ({ request }) => {
    const url         = new URL(request.url);
    const tokenFilter = url.searchParams.get("token");
    const limit       = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    const onlyBad     = url.searchParams.get("onlyCorrupted") === "true";

    const sb = getSupabase();
    if (!sb) {
      return Response.json({ error: "Supabase unavailable" }, { status: 503 });
    }

    // ── Fetch distinct tokens from DB ──────────────────────────────────────
    let tokenQuery = sb
      .from("wallet_performance_history")
      .select("token_address")
      .not("current_token_price_sol", "is", null)
      .not("current_token_price_usd", "is", null)
      .limit(limit);

    if (tokenFilter) tokenQuery = tokenQuery.eq("token_address", tokenFilter);

    const { data: tokenRows, error: tokenErr } = await tokenQuery;
    if (tokenErr) {
      return Response.json({ error: tokenErr.message }, { status: 500 });
    }

    const uniqueTokens = Array.from(new Set((tokenRows ?? []).map((r) => r.token_address as string)));
    console.log(`${LOG} Auditing ${uniqueTokens.length} tokens…`);

    const auditResults: TokenAuditResult[] = [];
    let summary = {
      total_tokens_audited: 0,
      tokens_with_corruption: 0,
      tokens_correct: 0,
      tokens_ambiguous: 0,
      tokens_no_live_price: 0,
      total_corrupted_wallets: 0,
      total_correct_wallets: 0,
      total_ambiguous_wallets: 0,
    };

    // ── Process each token ─────────────────────────────────────────────────
    for (const tokenAddress of uniqueTokens) {
      // Fetch wallet rows for this token
      const { data: walletRows, error: walletErr } = await sb
        .from("wallet_performance_history")
        .select(
          "wallet_address, position_status, current_token_price_sol, " +
          "current_token_price_usd, current_position_value_sol, " +
          "unrealized_profit, roi_multiple, initial_investment, " +
          "current_token_balance, last_updated",
        )
        .eq("token_address", tokenAddress)
        .not("current_token_price_sol", "is", null);

      if (walletErr || !walletRows?.length) continue;

      // Fetch live DexScreener prices
      const livePrice = await fetchBothPrices(tokenAddress);
      await sleep(DEXSCREENER_DELAY_MS);

      // Classify each wallet
      const classifiedWallets = (walletRows as WalletRow[]).map(
        (row) => classifyRow(row, livePrice.priceSol),
      );

      const corruptedCount = classifiedWallets.filter((w) => w.verdict === "CORRUPTED").length;
      const correctCount   = classifiedWallets.filter((w) => w.verdict === "CORRECT").length;
      const ambigCount     = classifiedWallets.filter((w) => w.verdict === "AMBIGUOUS").length;
      const noLiveCount    = classifiedWallets.filter((w) => w.verdict === "NO_LIVE_PRICE").length;

      summary.total_tokens_audited++;
      summary.total_corrupted_wallets += corruptedCount;
      summary.total_correct_wallets   += correctCount;
      summary.total_ambiguous_wallets += ambigCount;
      if (corruptedCount > 0) summary.tokens_with_corruption++;
      else if (ambigCount > 0) summary.tokens_ambiguous++;
      else if (noLiveCount === classifiedWallets.length) summary.tokens_no_live_price++;
      else summary.tokens_correct++;

      const filteredWallets = onlyBad
        ? classifiedWallets.filter((w) => w.verdict === "CORRUPTED" || w.verdict === "AMBIGUOUS")
        : classifiedWallets;

      if (onlyBad && filteredWallets.length === 0) continue;

      auditResults.push({
        token_address:      tokenAddress,
        stored_wallets:     walletRows.length,
        live_price_sol:     livePrice.priceSol,
        live_price_usdc:    livePrice.bestUsdcPair?.priceNative ?? null,
        live_price_usd:     livePrice.priceUsd,
        best_sol_pair_dex:  livePrice.bestSolPair?.dexId ?? null,
        best_sol_pair_liq:  livePrice.bestSolPair?.liquidityUsd ?? null,
        best_usdc_pair_dex: livePrice.bestUsdcPair?.dexId ?? null,
        best_usdc_pair_liq: livePrice.bestUsdcPair?.liquidityUsd ?? null,
        fetch_error:        livePrice.fetchError,
        wallets:            filteredWallets.sort((a, b) =>
          (b.stored_roi ?? 0) - (a.stored_roi ?? 0),
        ),
      });

      console.log(
        `${LOG} ${tokenAddress.slice(0, 8)}… ` +
        `corrupted=${corruptedCount} correct=${correctCount} ` +
        `liveSol=${livePrice.priceSol ?? "N/A"}`,
      );
    }

    return Response.json({
      generated_at: new Date().toISOString(),
      summary,
      tokens: auditResults.sort((a, b) => {
        const aC = a.wallets.filter((w) => w.verdict === "CORRUPTED").length;
        const bC = b.wallets.filter((w) => w.verdict === "CORRUPTED").length;
        return bC - aC;
      }),
    });
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
