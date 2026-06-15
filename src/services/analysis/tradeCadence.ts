import type { Trade, DetectedPattern } from "./types";

/**
 * Layer 2 — Trade Cadence Analysis
 *
 * Bots tend to fire trades on a fixed schedule. We compute the
 * inter-trade interval distribution and look for:
 *   • Very low coefficient of variation (CV) → metronomic timing.
 *   • A single modal interval covering a large share of trades.
 *   • Sub-second bursts that are infeasible for humans.
 */
export function analyzeTradeCadence(
  trades: Trade[],
): { score: number; patterns: DetectedPattern[] } {
  const patterns: DetectedPattern[] = [];
  if (trades.length < 15) return { score: 0, patterns };

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    deltas.push(sorted[i].timestamp - sorted[i - 1].timestamp);
  }

  const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const variance =
    deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;

  // bucket to nearest second and find the mode
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

  const score = patterns.reduce((s, p) => s + p.weight, 0);
  return { score: Math.min(100, score), patterns };
}
