// =============================================================================
// Wallet Audit Endpoint  —  /api/wallet-audit
//
// Provides live per-token corruption analysis by cross-referencing:
//   1. Stored wallet_performance_history prices
//   2. Live DexScreener SOL-pair price (v10 correct value)
//   3. Live DexScreener USDC-pair priceNative (the wrong value v9 would store)
//   4. Five-layer confidence scoring identical to 20260623000009_confidence_audit.sql
//
// CONFIDENCE TIERS:
//   CERTAIN        — abs_diff_pct < 5% between price_sol and price_usd
//                    (prices are numerically identical — only possible from USDC pair)
//   HIGH_CONFIDENCE— implied SOL/USD ratio < 5 (never happened historically)
//   AMBIGUOUS      — ratio 5–15 (excluded from repair candidates)
//   CORRECT        — ratio > 15 (not flagged)
//
// USAGE:
//   GET /api/wallet-audit
//   GET /api/wallet-audit?token=zinc155...
//   GET /api/wallet-audit?onlyCorrupted=true&limit=50
//   GET /api/wallet-audit?confidence=CERTAIN           (filter by tier)
// =============================================================================

import { createAPIFileRoute } from "@tanstack/react-start/api";
import { getSupabase } from "../../lib/api/wallet-collection-worker";

const WSOL        = "So11111111111111111111111111111111111111112";
const DELAY_MS    = 250;   // between DexScreener calls — stays well within 300 req/min free tier

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConfidenceTier = "CERTAIN" | "HIGH_CONFIDENCE" | "AMBIGUOUS" | "CORRECT" | "NO_DATA";

interface LivePairInfo {
  dexId:        string;
  pairAddress:  string;
  quoteSymbol:  string;
  priceNative:  number;
  priceUsd:     number;
  liquidityUsd: number;
}

interface LivePriceResult {
  bestSolPair:        LivePairInfo | null;
  bestUsdcPair:       LivePairInfo | null;
  allSolPairCount:    number;
  allUsdcPairCount:   number;
  livePriceSol:       number | null;    // from priceNative of best SOL pair
  livePriceUsdcPair:  number | null;    // priceNative of best USDC pair (was the wrong value)
  livePriceUsd:       number | null;    // USD price from best available pair
  fetchError:         string | null;
  // Key question: did v9 have a higher-liquidity USDC pair than the best SOL pair?
  // If yes, v9 would have picked the USDC pair → corruption would have fired
  usdcPairWouldHaveWon: boolean;
}

interface StoredRow {
  wallet_address:            string;
  position_status:           string | null;
  current_token_price_sol:   number | null;
  current_token_price_usd:   number | null;
  current_position_value_sol: number | null;
  unrealized_profit:         number | null;
  roi_multiple:              number | null;
  initial_investment:        number | null;
  current_token_balance:     number | null;
  last_updated:              string | null;
}

interface WalletAuditRow {
  wallet_address:              string;
  position_status:             string | null;
  // Stored (possibly wrong)
  stored_price_sol:            number | null;
  stored_price_usd:            number | null;
  stored_position_value_sol:   number | null;
  stored_unrealized:           number | null;
  stored_roi:                  number | null;
  // Derived corruption signals
  implied_sol_usd_ratio:       number | null;  // stored_usd / stored_sol — ≈1 = corrupted
  abs_diff_pct:                number | null;  // |usd-sol|/sol*100 — <5% = corrupted
  // Live DexScreener comparison
  live_price_sol:              number | null;  // what v10 would store
  live_price_usdc_native:      number | null;  // what v9 wrongly stored
  stored_vs_live_sol_ratio:    number | null;  // stored_sol / live_sol — ≈70 = corrupted row
  stored_vs_usdc_native_ratio: number | null;  // stored_sol / usdc_native — ≈1 = corrupted row
  // Estimated true values (using live SOL pair price)
  estimated_true_position_sol: number | null;
  estimated_true_unrealized:   number | null;
  estimated_true_roi:          number | null;
  // Inflation magnitude
  position_value_inflation_factor: number | null;
  // Confidence
  confidence:                  ConfidenceTier;
  evidence_layers:             string[];
  last_updated:                string | null;
}

interface TokenAuditResult {
  token_address:         string;
  total_wallets:         number;
  certain_count:         number;
  high_confidence_count: number;
  ambiguous_count:       number;
  correct_count:         number;
  // Live pair situation
  live_sol_pairs_count:  number;
  live_usdc_pairs_count: number;
  best_sol_pair_dex:     string | null;
  best_sol_pair_liq:     number | null;
  best_usdc_pair_dex:    string | null;
  best_usdc_pair_liq:    number | null;
  usdc_pair_would_have_won_in_v9: boolean;
  live_price_sol:        number | null;
  live_price_usdc_native: number | null;
  fetch_error:           string | null;
  wallets:               WalletAuditRow[];
}

// ---------------------------------------------------------------------------
// DexScreener — fetch both SOL pair and USDC pair simultaneously
// ---------------------------------------------------------------------------

async function fetchBothPairs(tokenAddress: string): Promise<LivePriceResult> {
  const empty: LivePriceResult = {
    bestSolPair: null, bestUsdcPair: null,
    allSolPairCount: 0, allUsdcPairCount: 0,
    livePriceSol: null, livePriceUsdcPair: null, livePriceUsd: null,
    fetchError: null, usdcPairWouldHaveWon: false,
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { headers: { accept: "application/json" }, signal: ctrl.signal },
    );
    clearTimeout(t);

    if (!res.ok) return { ...empty, fetchError: `HTTP ${res.status}` };

    const data = await res.json() as {
      pairs?: Array<{
        chainId?: string; dexId?: string; pairAddress?: string;
        priceNative?: string; priceUsd?: string;
        liquidity?: { usd?: number };
        quoteToken?: { address?: string; symbol?: string };
        baseToken?:  { address?: string };
      }>;
    };

    const basePairs = (data.pairs ?? []).filter(
      (p) => (!p.chainId || p.chainId === "solana") && p.baseToken?.address === tokenAddress,
    );

    const toInfo = (p: typeof basePairs[0]): LivePairInfo => ({
      dexId:        p.dexId ?? "unknown",
      pairAddress:  p.pairAddress ?? "",
      quoteSymbol:  p.quoteToken?.symbol ?? "?",
      priceNative:  parseFloat(p.priceNative ?? "0"),
      priceUsd:     parseFloat(p.priceUsd    ?? "0"),
      liquidityUsd: p.liquidity?.usd ?? 0,
    });

    const solPairs  = basePairs.filter((p) => p.quoteToken?.address === WSOL).map(toInfo)
                               .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    const usdcPairs = basePairs.filter((p) =>
      p.quoteToken?.symbol === "USDC" || p.quoteToken?.symbol === "USDT",
    ).map(toInfo).sort((a, b) => b.liquidityUsd - a.liquidityUsd);

    const bestSol  = solPairs[0]  ?? null;
    const bestUsdc = usdcPairs[0] ?? null;

    // Would v9 have picked the USDC pair? (highest liquidity overall)
    const usdcPairWouldHaveWon =
      bestUsdc != null && bestSol != null
        ? bestUsdc.liquidityUsd > bestSol.liquidityUsd
        : false;

    return {
      bestSolPair:        bestSol,
      bestUsdcPair:       bestUsdc,
      allSolPairCount:    solPairs.length,
      allUsdcPairCount:   usdcPairs.length,
      livePriceSol:       bestSol?.priceNative  ?? null,
      livePriceUsdcPair:  bestUsdc?.priceNative ?? null,
      livePriceUsd:       bestSol?.priceUsd ?? bestUsdc?.priceUsd ?? null,
      fetchError:         null,
      usdcPairWouldHaveWon,
    };
  } catch (err) {
    return { ...empty, fetchError: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Classify one stored row against live pair data
// ---------------------------------------------------------------------------

function classifyRow(row: StoredRow, live: LivePriceResult): WalletAuditRow {
  const sol = row.current_token_price_sol;
  const usd = row.current_token_price_usd;
  const bal = row.current_token_balance ?? 0;
  const inv = row.initial_investment ?? 0;

  // Layer 1: ratio and abs_diff
  const impliedRatio   = sol != null && sol > 0 && usd != null ? usd / sol : null;
  const absDiffPct     = sol != null && sol > 0 && usd != null
    ? Math.abs(usd - sol) / sol * 100 : null;

  // Layer 2: comparison to live SOL pair price
  // If the stored "SOL price" is actually the USDC priceNative, then:
  //   stored_sol / live_sol_price ≈ USDC_price / SOL_price ≈ 70
  //   stored_sol / live_usdc_native ≈ 1.0   ← matches the wrong pair exactly
  const storedVsLiveSol  = sol != null && live.livePriceSol != null && live.livePriceSol > 0
    ? sol / live.livePriceSol : null;
  const storedVsUsdcNative = sol != null && live.livePriceUsdcPair != null && live.livePriceUsdcPair > 0
    ? sol / live.livePriceUsdcPair : null;

  // Estimated true values using live SOL price
  const estPosition  = live.livePriceSol != null ? bal * live.livePriceSol : null;
  const estUnrealized = estPosition != null ? estPosition - inv : null;
  const estRoi       = estPosition != null && inv > 0 ? estPosition / inv : null;

  // Inflation factor: stored / estimated true
  const inflationFactor = estPosition != null && estPosition > 0 && row.current_position_value_sol != null
    ? row.current_position_value_sol / estPosition : null;

  // ── Confidence ────────────────────────────────────────────────────────────
  const evidence: string[] = [];
  let confidence: ConfidenceTier = "CORRECT";

  if (sol == null || usd == null) {
    confidence = "NO_DATA";
  } else if (impliedRatio == null || impliedRatio > 15) {
    confidence = "CORRECT";
  } else {
    // Layer 1: abs diff
    if (absDiffPct != null && absDiffPct < 5) {
      evidence.push(`L1:price_diff=${absDiffPct.toFixed(3)}% (prices identical)`);
    }
    // Layer 2: impossible implied SOL/USD
    if (impliedRatio < 2) {
      evidence.push(`L2:ratio=${impliedRatio.toFixed(4)} (SOL/USD<$2 impossible)`);
    } else if (impliedRatio < 5) {
      evidence.push(`L2:ratio=${impliedRatio.toFixed(4)} (SOL/USD<$5 historically impossible)`);
    }
    // Layer 3: stored price matches USDC priceNative within 2%
    if (storedVsUsdcNative != null && Math.abs(storedVsUsdcNative - 1) < 0.02) {
      evidence.push(`L3:stored≈live_USDC_native (ratio=${storedVsUsdcNative.toFixed(4)})`);
    }
    // Layer 4: stored price is ≈70× the live SOL price
    if (storedVsLiveSol != null && storedVsLiveSol > 30 && storedVsLiveSol < 200) {
      evidence.push(`L4:stored=${storedVsLiveSol.toFixed(1)}× live_sol_price`);
    }
    // Layer 5: USDC pair would have won in v9 (liquidity check)
    if (live.usdcPairWouldHaveWon) {
      evidence.push(`L5:USDC_pair_liq($${live.bestUsdcPair?.liquidityUsd.toFixed(0)}) > SOL_pair_liq($${live.bestSolPair?.liquidityUsd.toFixed(0)})`);
    }

    // Assign tier
    if (absDiffPct != null && absDiffPct < 5) {
      confidence = "CERTAIN";
    } else if (impliedRatio < 2) {
      confidence = "CERTAIN";
    } else if (impliedRatio < 5) {
      confidence = "HIGH_CONFIDENCE";
    } else {
      confidence = "AMBIGUOUS";
    }
  }

  return {
    wallet_address:              row.wallet_address,
    position_status:             row.position_status,
    stored_price_sol:            sol,
    stored_price_usd:            usd,
    stored_position_value_sol:   row.current_position_value_sol,
    stored_unrealized:           row.unrealized_profit,
    stored_roi:                  row.roi_multiple,
    implied_sol_usd_ratio:       impliedRatio != null ? +impliedRatio.toFixed(6) : null,
    abs_diff_pct:                absDiffPct   != null ? +absDiffPct.toFixed(4)   : null,
    live_price_sol:              live.livePriceSol,
    live_price_usdc_native:      live.livePriceUsdcPair,
    stored_vs_live_sol_ratio:    storedVsLiveSol   != null ? +storedVsLiveSol.toFixed(4)   : null,
    stored_vs_usdc_native_ratio: storedVsUsdcNative != null ? +storedVsUsdcNative.toFixed(4) : null,
    estimated_true_position_sol: estPosition  != null ? +estPosition.toFixed(6)  : null,
    estimated_true_unrealized:   estUnrealized != null ? +estUnrealized.toFixed(6) : null,
    estimated_true_roi:          estRoi        != null ? +estRoi.toFixed(4)        : null,
    position_value_inflation_factor: inflationFactor != null ? +inflationFactor.toFixed(2) : null,
    confidence,
    evidence_layers: evidence,
    last_updated: row.last_updated,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const Route = createAPIFileRoute("/api/wallet-audit")({
  GET: async ({ request }) => {
    const url            = new URL(request.url);
    const tokenFilter    = url.searchParams.get("token");
    const limit          = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);
    const onlyCorrupted  = url.searchParams.get("onlyCorrupted") === "true";
    const confFilter     = url.searchParams.get("confidence") as ConfidenceTier | null;

    const sb = getSupabase();
    if (!sb) return Response.json({ error: "Supabase unavailable" }, { status: 503 });

    // Fetch distinct tokens that have price data stored
    let tokenQuery = sb
      .from("wallet_performance_history")
      .select("token_address")
      .not("current_token_price_sol", "is", null)
      .not("current_token_price_usd", "is", null)
      .gt("current_token_price_sol", 0)
      .gt("current_token_price_usd", 0)
      .limit(limit);

    if (tokenFilter) tokenQuery = tokenQuery.eq("token_address", tokenFilter);

    const { data: tokenRows, error: tokenErr } = await tokenQuery;
    if (tokenErr) return Response.json({ error: tokenErr.message }, { status: 500 });

    const uniqueTokens = Array.from(
      new Set((tokenRows ?? []).map((r) => r.token_address as string))
    );

    const summary = {
      tokens_audited: 0,
      tokens_certain: 0, tokens_high_confidence: 0,
      tokens_ambiguous: 0, tokens_correct: 0, tokens_no_live_price: 0,
      wallets_certain: 0, wallets_high_confidence: 0,
      wallets_ambiguous: 0, wallets_correct: 0,
    };

    const results: TokenAuditResult[] = [];

    for (const tokenAddress of uniqueTokens) {
      // Fetch stored rows for this token
      const { data: walletRows, error: wErr } = await sb
        .from("wallet_performance_history")
        .select(
          "wallet_address, position_status, current_token_price_sol, " +
          "current_token_price_usd, current_position_value_sol, " +
          "unrealized_profit, roi_multiple, initial_investment, " +
          "current_token_balance, last_updated",
        )
        .eq("token_address", tokenAddress)
        .not("current_token_price_sol", "is", null)
        .not("current_token_price_usd", "is", null);

      if (wErr || !walletRows?.length) continue;

      // Live DexScreener for this token
      const live = await fetchBothPairs(tokenAddress);
      await sleep(DELAY_MS);

      // Classify each wallet row
      const classified = (walletRows as StoredRow[]).map((r) => classifyRow(r, live));

      const certain   = classified.filter((w) => w.confidence === "CERTAIN");
      const highConf  = classified.filter((w) => w.confidence === "HIGH_CONFIDENCE");
      const ambiguous = classified.filter((w) => w.confidence === "AMBIGUOUS");
      const correct   = classified.filter((w) => w.confidence === "CORRECT");

      summary.tokens_audited++;
      summary.wallets_certain           += certain.length;
      summary.wallets_high_confidence   += highConf.length;
      summary.wallets_ambiguous         += ambiguous.length;
      summary.wallets_correct           += correct.length;

      if (certain.length + highConf.length > 0) {
        if (certain.length > 0) summary.tokens_certain++;
        else summary.tokens_high_confidence++;
      } else if (ambiguous.length > 0) {
        summary.tokens_ambiguous++;
      } else if (!live.livePriceSol) {
        summary.tokens_no_live_price++;
      } else {
        summary.tokens_correct++;
      }

      // Filter output
      let outputWallets = classified;
      if (onlyCorrupted) {
        outputWallets = classified.filter(
          (w) => w.confidence === "CERTAIN" || w.confidence === "HIGH_CONFIDENCE",
        );
      }
      if (confFilter) {
        outputWallets = classified.filter((w) => w.confidence === confFilter);
      }

      if (onlyCorrupted && outputWallets.length === 0) continue;

      results.push({
        token_address:         tokenAddress,
        total_wallets:         walletRows.length,
        certain_count:         certain.length,
        high_confidence_count: highConf.length,
        ambiguous_count:       ambiguous.length,
        correct_count:         correct.length,
        live_sol_pairs_count:  live.allSolPairCount,
        live_usdc_pairs_count: live.allUsdcPairCount,
        best_sol_pair_dex:     live.bestSolPair?.dexId     ?? null,
        best_sol_pair_liq:     live.bestSolPair?.liquidityUsd ?? null,
        best_usdc_pair_dex:    live.bestUsdcPair?.dexId    ?? null,
        best_usdc_pair_liq:    live.bestUsdcPair?.liquidityUsd ?? null,
        usdc_pair_would_have_won_in_v9: live.usdcPairWouldHaveWon,
        live_price_sol:        live.livePriceSol,
        live_price_usdc_native: live.livePriceUsdcPair,
        fetch_error:           live.fetchError,
        wallets:               outputWallets.sort((a, b) => (b.stored_roi ?? 0) - (a.stored_roi ?? 0)),
      });
    }

    // Sort: tokens with most CERTAIN rows first
    results.sort((a, b) => (b.certain_count + b.high_confidence_count)
                          - (a.certain_count + a.high_confidence_count));

    return Response.json({
      generated_at:        new Date().toISOString(),
      summary,
      repair_candidates: {
        description: "Tokens where at least one wallet has CERTAIN or HIGH_CONFIDENCE corruption",
        tokens: results
          .filter((r) => r.certain_count + r.high_confidence_count > 0)
          .map((r) => ({
            token_address:   r.token_address,
            wallets_to_repair: r.certain_count + r.high_confidence_count,
            certain:         r.certain_count,
            high_confidence: r.high_confidence_count,
          })),
      },
      ambiguous_tokens: results
        .filter((r) => r.ambiguous_count > 0 && r.certain_count + r.high_confidence_count === 0)
        .map((r) => ({ token_address: r.token_address, wallets: r.ambiguous_count })),
      tokens: results,
    });
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
