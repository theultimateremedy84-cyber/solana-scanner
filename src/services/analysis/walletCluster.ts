import type {
  Trade,
  DetectedPattern,
  ClusterRiskLevel,
} from "./types";

/**
 * Layer 1 — Wallet Cluster + Sybil Cluster Detection
 *
 * Original signals:
 *  1. Shared funding source (same `funderWallet`).
 *  2. Circular / back-and-forth trading inside a short window.
 *
 * Phase 2 — Sybil Cluster Detection:
 *  3. Group wallets that were funded by the same parent OR by the same
 *     mixer/bridge entity (using `walletEntity` tags emitted by the
 *     mapper). A group of ≥3 wallets sharing such a source is treated
 *     as a Sybil cluster.
 *  4. Synchronized activity: members of the same Sybil cluster trading
 *     the token inside overlapping time windows (`syncWindowMs`).
 *
 * The function returns a `clusterRiskLevel` so the frontend can render a
 * categorical badge (none / low / medium / high / critical).
 */
export interface ClusterResult {
  score: number;
  patterns: DetectedPattern[];
  /** Categorical Sybil risk for the UI */
  clusterRiskLevel: ClusterRiskLevel;
}

const SUSPICIOUS_FUNDER_ENTITIES = new Set([
  "mixer",
  "bridge",
  "contract_deployer",
]);

export function analyzeWalletCluster(
  trades: Trade[],
  opts: { topN?: number; windowMs?: number; syncWindowMs?: number } = {},
): ClusterResult {
  const topN = opts.topN ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const syncWindowMs = opts.syncWindowMs ?? 30_000;
  const patterns: DetectedPattern[] = [];
  if (trades.length < 10) {
    return { score: 0, patterns, clusterRiskLevel: "none" };
  }

  // --- pick top-N wallets by trade count ---
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(t.wallet, (counts.get(t.wallet) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
  const topSet = new Set(top);

  // Lookup: wallet -> latest known funder + entity tag
  const walletMeta = new Map<
    string,
    { funder?: string; funderEntity?: string }
  >();
  for (const t of trades) {
    if (!walletMeta.has(t.wallet)) {
      walletMeta.set(t.wallet, {
        funder: t.funderWallet,
        funderEntity: t.walletEntity,
      });
    }
  }

  // 1. shared funding source (legacy)
  const funders = new Map<string, string[]>();
  for (const w of top) {
    const f = walletMeta.get(w)?.funder;
    if (!f) continue;
    funders.set(f, [...(funders.get(f) ?? []), w]);
  }
  const clusters = [...funders.entries()].filter(([, ws]) => ws.length >= 2);
  if (clusters.length > 0) {
    const linked = clusters.reduce((n, [, ws]) => n + ws.length, 0);
    const ratio = linked / top.length;
    patterns.push({
      id: "shared_funding_source",
      label: "Shared funding source",
      description: `${linked}/${top.length} top wallets share ${clusters.length} common funder(s).`,
      weight: Math.min(35, Math.round(ratio * 40)),
      evidence: { clusters },
    });
  }

  // 2. circular trading within window (legacy)
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

  // ---- 3. Sybil clusters (Phase 2) ----
  // Group ALL wallets (not just top-N) by funder OR by suspicious funder-entity tag.
  const sybilGroups = new Map<string, Set<string>>();
  for (const t of trades) {
    const meta = walletMeta.get(t.wallet);
    if (!meta) continue;
    const keys: string[] = [];
    if (meta.funder) keys.push(`funder:${meta.funder}`);
    if (meta.funderEntity && SUSPICIOUS_FUNDER_ENTITIES.has(meta.funderEntity)) {
      keys.push(`entity:${meta.funderEntity}`);
    }
    for (const k of keys) {
      if (!sybilGroups.has(k)) sybilGroups.set(k, new Set());
      sybilGroups.get(k)!.add(t.wallet);
    }
  }
  const sybilClusters = [...sybilGroups.entries()]
    .filter(([, members]) => members.size >= 3)
    .map(([key, members]) => ({ key, members: [...members] }));

  let synchronizedHits = 0;
  if (sybilClusters.length > 0) {
    // 4. Synchronized activity within each cluster
    for (const c of sybilClusters) {
      const memberSet = new Set(c.members);
      const memberTrades = trades
        .filter((t) => memberSet.has(t.wallet))
        .sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < memberTrades.length; i++) {
        let distinct = new Set<string>();
        for (let j = i; j < memberTrades.length; j++) {
          if (memberTrades[j].timestamp - memberTrades[i].timestamp > syncWindowMs) break;
          distinct.add(memberTrades[j].wallet);
        }
        if (distinct.size >= 3) synchronizedHits++;
      }
    }

    const totalMembers = sybilClusters.reduce((n, c) => n + c.members.length, 0);
    patterns.push({
      id: "sybil_cluster",
      label: "Sybil cluster detected",
      description: `${sybilClusters.length} cluster(s) covering ${totalMembers} wallets share a common funder or suspicious upstream entity.`,
      weight: Math.min(40, 12 + sybilClusters.length * 6 + Math.min(15, totalMembers)),
      evidence: { clusters: sybilClusters },
    });

    if (synchronizedHits > 0) {
      patterns.push({
        id: "synchronized_sybil_activity",
        label: "Synchronized Sybil activity",
        description: `${synchronizedHits} time windows of ≤${Math.round(syncWindowMs / 1000)}s contained ≥3 wallets from the same Sybil cluster trading simultaneously.`,
        weight: Math.min(30, 8 + synchronizedHits * 2),
        evidence: { synchronizedHits, syncWindowMs },
      });
    }
  }

  const score = Math.min(100, patterns.reduce((s, p) => s + p.weight, 0));
  const clusterRiskLevel = scoreToRisk(score, sybilClusters.length, synchronizedHits);

  return { score, patterns, clusterRiskLevel };
}

function scoreToRisk(
  score: number,
  clusterCount: number,
  syncHits: number,
): ClusterRiskLevel {
  if (score >= 70 || (clusterCount >= 2 && syncHits >= 5)) return "critical";
  if (score >= 50 || syncHits >= 3) return "high";
  if (score >= 30 || clusterCount >= 1) return "medium";
  if (score > 0) return "low";
  return "none";
}
