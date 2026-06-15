import type { Trade, DetectedPattern } from "./types";

/**
 * Layer 3 — Net-Zero Position Monitoring
 *
 * For each wallet, scan a sliding 3-minute window and look for
 * round-trip trades: a buy and a sell of (approximately) the same size
 * that cancel out. Many of these per wallet across the dataset is a
 * very strong wash-trading signal.
 */
export function analyzeNetZeroPositions(
  trades: Trade[],
  opts: { windowMs?: number; tolerance?: number } = {},
): { score: number; patterns: DetectedPattern[] } {
  const windowMs = opts.windowMs ?? 3 * 60_000;
  const tol = opts.tolerance ?? 0.02; // 2%
  const patterns: DetectedPattern[] = [];
  if (trades.length < 4) return { score: 0, patterns };

  const byWallet = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = byWallet.get(t.wallet) ?? [];
    arr.push(t);
    byWallet.set(t.wallet, arr);
  }

  let totalRoundTrips = 0;
  const offenders: { wallet: string; roundTrips: number }[] = [];

  for (const [wallet, ws] of byWallet) {
    ws.sort((a, b) => a.timestamp - b.timestamp);
    let rt = 0;
    const used = new Set<number>();
    for (let i = 0; i < ws.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < ws.length; j++) {
        if (used.has(j)) continue;
        if (ws[j].timestamp - ws[i].timestamp > windowMs) break;
        if (ws[i].side === ws[j].side) continue;
        const diff = Math.abs(ws[i].amount - ws[j].amount);
        const base = Math.max(ws[i].amount, ws[j].amount) || 1;
        if (diff / base <= tol) {
          rt++;
          used.add(i);
          used.add(j);
          break;
        }
      }
    }
    if (rt >= 2) {
      offenders.push({ wallet, roundTrips: rt });
      totalRoundTrips += rt;
    }
  }

  if (totalRoundTrips >= 3) {
    const share = totalRoundTrips / (trades.length / 2);
    patterns.push({
      id: "round_trip_net_zero",
      label: "Net-zero round-trip trading",
      description: `${totalRoundTrips} round-trip trades across ${offenders.length} wallet(s) within ${windowMs / 60000}m.`,
      weight: Math.min(40, Math.round(share * 80) + 10),
      evidence: { offenders: offenders.slice(0, 10), windowMs },
    });
  }

  const score = patterns.reduce((s, p) => s + p.weight, 0);
  return { score: Math.min(100, score), patterns };
}
