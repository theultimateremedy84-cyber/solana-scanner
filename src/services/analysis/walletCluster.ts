import type { Trade, DetectedPattern } from "./types";

/**
 * Layer 1 — Wallet Cluster Analysis
 *
 * Looks at the top-N most active wallets and flags two things:
 *  1. Shared funding source (same `funderWallet`) — classic Sybil pattern.
 *  2. Circular / back-and-forth trading inside a short window — wallets
 *     repeatedly hitting opposite sides of the book within `windowMs`.
 */
export function analyzeWalletCluster(
  trades: Trade[],
  opts: { topN?: number; windowMs?: number } = {},
): { score: number; patterns: DetectedPattern[] } {
  const topN = opts.topN ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const patterns: DetectedPattern[] = [];
  if (trades.length < 10) return { score: 0, patterns };

  // --- pick top-N wallets by trade count ---
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(t.wallet, (counts.get(t.wallet) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
  const topSet = new Set(top);

  // 1. shared funding source
  const funders = new Map<string, string[]>();
  for (const w of top) {
    const f = trades.find((t) => t.wallet === w)?.funderWallet;
    if (!f) continue;
    funders.set(f, [...(funders.get(f) ?? []), w]);
  }
  const clusters = [...funders.entries()].filter(([, ws]) => ws.length >= 2);
  if (clusters.length > 0) {
    const linked = clusters.reduce((n, [, ws]) => n + ws.length, 0);
    const ratio = linked / top.length; // 0..1
    patterns.push({
      id: "shared_funding_source",
      label: "Shared funding source",
      description: `${linked}/${top.length} top wallets share ${clusters.length} common funder(s).`,
      weight: Math.min(35, Math.round(ratio * 40)),
      evidence: { clusters },
    });
  }

  // 2. circular trading within window
  const topTrades = trades
    .filter((t) => topSet.has(t.wallet))
    .sort((a, b) => a.timestamp - b.timestamp);
  let circular = 0;
  for (let i = 0; i < topTrades.length; i++) {
    const a = topTrades[i];
    for (let j = i + 1; j < topTrades.length; j++) {
      const b = topTrades[j];
      if (b.timestamp - a.timestamp > windowMs) break;
      if (a.wallet !== b.wallet && a.side !== b.side) circular++;
    }
  }
  const pairs = (top.length * (top.length - 1)) / 2 || 1;
  const density = circular / pairs;
  if (density > 1.5) {
    patterns.push({
      id: "internal_circular_trading",
      label: "Internal circular trading",
      description: `Top wallets traded against each other ${circular} times within ${windowMs / 1000}s windows.`,
      weight: Math.min(30, Math.round(density * 6)),
      evidence: { circularEvents: circular, windowMs },
    });
  }

  const score = patterns.reduce((s, p) => s + p.weight, 0);
  return { score: Math.min(100, score), patterns };
}
