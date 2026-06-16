import type { Trade, DetectedPattern } from "./types";

/**
 * Layer 2 — Trade Cadence + Wash-Trading Engine
 *
 * Combines two detectors:
 *
 *  A) Cadence (original): metronomic timing, modal intervals, sub-second bursts.
 *  B) Wash-Trading (Phase 2):
 *      • Low variance in trade size (CV < 0.15) over a meaningful sample
 *        → "Artificial / Wash Trading".
 *      • Repeated non-variant volume bursts where the same wallets pair up
 *        on opposite sides (circular trading between top holders).
 *
 * The wash-trading score is also exported separately via
 * `analyzeWashTrading()` so callers (and the frontend) can surface
 * `washTradingScore` independently of the cadence score.
 */

export interface CadenceResult {
  score: number;
  patterns: DetectedPattern[];
  /** 0–100 wash-trading confidence */
  washTradingScore: number;
}

export function analyzeTradeCadence(trades: Trade[]): CadenceResult {
  const patterns: DetectedPattern[] = [];
  if (trades.length < 15) {
    return { score: 0, patterns, washTradingScore: 0 };
  }

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    deltas.push(sorted[i].timestamp - sorted[i - 1].timestamp);
  }

  // ---- A) Timing cadence ----
  const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const variance =
    deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;

  const buckets = new Map<number, number>();
  for (const d of deltas) {
    const k = Math.round(d / 1000);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  const [modeSec, modeCount] = [...buckets.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0] ?? [0, 0];
  const modeShare = modeCount / deltas.length;

  if (cv < 0.25 && deltas.length >= 20) {
    patterns.push({
      id: "robotic_cadence",
      label: "Robotic trade cadence",
      description: `Low timing variance (CV=${cv.toFixed(2)}), mean interval ${(mean / 1000).toFixed(1)}s.`,
      weight: Math.min(30, Math.round((0.25 - cv) * 120)),
      evidence: { cv, meanMs: mean, modeSec, modeShare },
    });
  } else if (modeShare > 0.4 && modeSec > 0) {
    patterns.push({
      id: "robotic_cadence",
      label: "Fixed-interval trading",
      description: `${Math.round(modeShare * 100)}% of trades occur every ~${modeSec}s.`,
      weight: Math.min(25, Math.round(modeShare * 30)),
      evidence: { modeSec, modeShare },
    });
  }

  const subSecond = deltas.filter((d) => d < 1000).length;
  if (subSecond / deltas.length > 0.3) {
    patterns.push({
      id: "burst_cadence",
      label: "Sub-second trade bursts",
      description: `${subSecond} trades fired <1s apart — infeasible for a human trader.`,
      weight: 15,
      evidence: { subSecond, total: deltas.length },
    });
  }

  // ---- B) Wash-trading layer ----
  const wash = analyzeWashTrading(sorted);
  patterns.push(...wash.patterns);

  const score = patterns.reduce((s, p) => s + p.weight, 0);
  return {
    score: Math.min(100, score),
    patterns,
    washTradingScore: wash.score,
  };
}

/**
 * Wash-Trading Engine — exported standalone so callers can surface
 * `washTradingScore` independently in the UI.
 *
 * Signals:
 *  1. Size variance: CV of `amount` (and `quoteAmount` if present).
 *     Real markets have heavy-tailed size distributions; wash trades
 *     are suspiciously uniform.
 *  2. Burst variance: split the trade stream into N-trade windows and
 *     check whether each window's volume is near-identical (low std).
 *  3. Circular top-holder trading: same wallet pair flipping opposite
 *     sides within `windowMs`.
 */
export function analyzeWashTrading(
  trades: Trade[],
  opts: { topN?: number; windowMs?: number; burstSize?: number } = {},
): { score: number; patterns: DetectedPattern[] } {
  const patterns: DetectedPattern[] = [];
  if (trades.length < 20) return { score: 0, patterns };

  const topN = opts.topN ?? 10;
  const windowMs = opts.windowMs ?? 120_000;
  const burstSize = opts.burstSize ?? 10;

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  // --- 1. Size variance (amount) ---
  const amounts = sorted.map((t) => t.amount).filter((a) => a > 0);
  const aMean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
  const aVar =
    amounts.reduce((s, a) => s + (a - aMean) ** 2, 0) / amounts.length;
  const aStd = Math.sqrt(aVar);
  const aCv = aMean > 0 ? aStd / aMean : 0;

  if (aCv < 0.15 && amounts.length >= 20) {
    patterns.push({
      id: "uniform_trade_size",
      label: "Uniform trade size",
      description: `Trade-size variance is near zero (CV=${aCv.toFixed(3)}) across ${amounts.length} trades.`,
      weight: Math.min(25, Math.round((0.15 - aCv) * 160)),
      evidence: { sizeCv: aCv, meanAmount: aMean, sample: amounts.length },
    });
  }

  // --- 2. Burst variance: per-window total volume ---
  const windows: number[] = [];
  for (let i = 0; i < sorted.length; i += burstSize) {
    const slice = sorted.slice(i, i + burstSize);
    if (slice.length < burstSize) break;
    windows.push(slice.reduce((s, t) => s + (t.quoteAmount ?? t.amount), 0));
  }
  let burstCv = 1;
  if (windows.length >= 4) {
    const wMean = windows.reduce((s, v) => s + v, 0) / windows.length;
    const wVar =
      windows.reduce((s, v) => s + (v - wMean) ** 2, 0) / windows.length;
    burstCv = wMean > 0 ? Math.sqrt(wVar) / wMean : 0;
    if (burstCv < 0.1) {
      patterns.push({
        id: "artificial_wash_trading",
        label: "Artificial / wash trading",
        description: `Volume buckets are abnormally uniform (CV=${burstCv.toFixed(3)} across ${windows.length} windows).`,
        weight: Math.min(35, Math.round((0.1 - burstCv) * 250)),
        evidence: { burstCv, windows: windows.length, burstSize },
      });
    }
  }

  // --- 3. Circular trading among top holders ---
  const counts = new Map<string, number>();
  for (const t of sorted) counts.set(t.wallet, (counts.get(t.wallet) ?? 0) + 1);
  const top = new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([w]) => w),
  );

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairFlips = new Map<string, number>();
  const topSorted = sorted.filter((t) => top.has(t.wallet));
  for (let i = 0; i < topSorted.length; i++) {
    const a = topSorted[i];
    for (let j = i + 1; j < topSorted.length; j++) {
      const b = topSorted[j];
      if (b.timestamp - a.timestamp > windowMs) break;
      if (a.wallet !== b.wallet && a.side !== b.side) {
        const k = pairKey(a.wallet, b.wallet);
        pairFlips.set(k, (pairFlips.get(k) ?? 0) + 1);
      }
    }
  }
  const circularPairs = [...pairFlips.entries()].filter(([, n]) => n >= 3);
  if (circularPairs.length > 0) {
    const total = circularPairs.reduce((s, [, n]) => s + n, 0);
    patterns.push({
      id: "circular_top_holder_trading",
      label: "Circular top-holder trading",
      description: `${circularPairs.length} top-holder pair(s) flipped sides ${total} times within ${Math.round(windowMs / 1000)}s windows.`,
      weight: Math.min(30, 10 + circularPairs.length * 4),
      evidence: { pairs: circularPairs, windowMs },
    });
  }

  const score = Math.min(100, patterns.reduce((s, p) => s + p.weight, 0));
  return { score, patterns };
}
