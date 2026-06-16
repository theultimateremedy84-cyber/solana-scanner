import type { DetectedPattern } from "./types";

/**
 * Layer 5 — Liquidity Elasticity / Slippage Impact
 *
 * Given a pool's current reserves, simulate the price movement caused
 * by a sell of `sellUsd` USD worth of the token. We model the pool as
 * a Uniswap-v2 / constant-product AMM (`x * y = k`) which is the
 * dominant on-chain AMM shape on Solana (Raydium v4, Orca, Meteora
 * dynamic AMM, pump.fun's bonding curve at TGE, etc.).
 *
 *   Pre-trade price (USD per token)  = quoteReserveUsd / tokenReserve
 *   Tokens to sell                   = sellUsd / preTradePrice
 *   After applying CPMM:
 *     newTokenReserve  = tokenReserve + tokensIn
 *     newQuoteReserve  = k / newTokenReserve
 *     usdOut           = quoteReserveUsd - newQuoteReserve
 *     execPrice        = usdOut / tokensIn
 *     slippage         = 1 - execPrice / preTradePrice
 *
 * `slippageImpactRatio` is the fractional price move (0–1) and is
 * surfaced on `DetectionResult` so the frontend can render a
 * "shallow / robust" liquidity badge.
 */
export interface LiquiditySnapshot {
  /** Token reserve in the pool, in UI units (not raw lamports) */
  tokenReserve: number;
  /** USD value of the quote reserve (SOL/USDC × oracle price) */
  quoteReserveUsd: number;
  /** Pool / DEX label for evidence (optional) */
  poolLabel?: string;
  /** Swap fee in basis points (defaults to 25 bps = Raydium v4) */
  feeBps?: number;
}

export interface LiquidityImpactResult {
  /** Score 0–100 — higher = shallower / more dangerous liquidity */
  score: number;
  /** Patterns to feed back into the main DetectionResult */
  patterns: DetectedPattern[];
  /** Fractional price move (0..1) for `sellUsd` */
  slippageImpactRatio: number;
  /** Convenience: same value as percentage */
  slippagePct: number;
  /** Expected USD received from the simulated sell */
  expectedUsdOut: number;
  /** Pre / post mid-price in USD */
  preTradePriceUsd: number;
  postTradePriceUsd: number;
  /** Echo of the inputs for the UI */
  simulatedSellUsd: number;
  poolLabel?: string;
}

/**
 * Calculate slippage for a single sell.
 *
 * @param pool      Current pool reserves snapshot
 * @param sellUsd   Size of the simulated sell, default $5,000
 */
export function analyzeLiquidityImpact(
  pool: LiquiditySnapshot,
  sellUsd: number = 5_000,
): LiquidityImpactResult {
  const patterns: DetectedPattern[] = [];
  const feeBps = pool.feeBps ?? 25;

  if (
    !isFinite(pool.tokenReserve) ||
    !isFinite(pool.quoteReserveUsd) ||
    pool.tokenReserve <= 0 ||
    pool.quoteReserveUsd <= 0 ||
    sellUsd <= 0
  ) {
    return {
      score: 0,
      patterns,
      slippageImpactRatio: 0,
      slippagePct: 0,
      expectedUsdOut: 0,
      preTradePriceUsd: 0,
      postTradePriceUsd: 0,
      simulatedSellUsd: sellUsd,
      poolLabel: pool.poolLabel,
    };
  }

  const preTradePriceUsd = pool.quoteReserveUsd / pool.tokenReserve;
  const tokensIn = sellUsd / preTradePriceUsd;

  // CPMM with fee on the input side
  const feeMultiplier = 1 - feeBps / 10_000;
  const tokensInAfterFee = tokensIn * feeMultiplier;
  const k = pool.tokenReserve * pool.quoteReserveUsd;
  const newTokenReserve = pool.tokenReserve + tokensInAfterFee;
  const newQuoteReserve = k / newTokenReserve;
  const usdOut = pool.quoteReserveUsd - newQuoteReserve;

  const execPrice = usdOut / tokensIn;
  const slippageImpactRatio = Math.max(
    0,
    Math.min(1, 1 - execPrice / preTradePriceUsd),
  );
  const postTradePriceUsd = newQuoteReserve / newTokenReserve;

  // Scoring: linear up to 25% slip, then saturates.
  const score = Math.min(100, Math.round(slippageImpactRatio * 400));

  if (slippageImpactRatio >= 0.5) {
    patterns.push({
      id: "shallow_liquidity",
      label: "Shallow liquidity",
      description: `A $${sellUsd.toLocaleString()} sell would move the price by ${(slippageImpactRatio * 100).toFixed(1)}% — the pool is dangerously thin.`,
      weight: Math.min(35, Math.round(slippageImpactRatio * 50)),
      evidence: {
        sellUsd,
        preTradePriceUsd,
        postTradePriceUsd,
        slippagePct: slippageImpactRatio * 100,
        pool: pool.poolLabel,
      },
    });
  } else if (slippageImpactRatio >= 0.1) {
    patterns.push({
      id: "high_slippage_impact",
      label: "High slippage impact",
      description: `A $${sellUsd.toLocaleString()} sell would move the price by ${(slippageImpactRatio * 100).toFixed(1)}%.`,
      weight: Math.min(20, Math.round(slippageImpactRatio * 60)),
      evidence: {
        sellUsd,
        preTradePriceUsd,
        postTradePriceUsd,
        slippagePct: slippageImpactRatio * 100,
        pool: pool.poolLabel,
      },
    });
  }

  return {
    score,
    patterns,
    slippageImpactRatio,
    slippagePct: slippageImpactRatio * 100,
    expectedUsdOut: usdOut,
    preTradePriceUsd,
    postTradePriceUsd,
    simulatedSellUsd: sellUsd,
    poolLabel: pool.poolLabel,
  };
}

/**
 * Convenience: run the simulation at several sizes to build a
 * "liquidity depth curve" for the UI.
 */
export function buildLiquidityCurve(
  pool: LiquiditySnapshot,
  sizesUsd: number[] = [500, 1_000, 5_000, 10_000, 25_000, 50_000],
): Array<{ sellUsd: number; slippagePct: number; usdOut: number }> {
  return sizesUsd.map((s) => {
    const r = analyzeLiquidityImpact(pool, s);
    return {
      sellUsd: s,
      slippagePct: r.slippagePct,
      usdOut: r.expectedUsdOut,
    };
  });
}
