/**
 * Shared deterministic helper for the wallet-cluster "related tokens"
 * estimate. Both the scanner (Developer Reputation) and the cluster page
 * (/cluster/:tokenAddress/tokens) call this so the rugged-token count is
 * IDENTICAL across the two views.
 *
 * The math intentionally mirrors the legacy generator in
 * `routes/cluster.$tokenAddress.tokens.tsx` (same FNV-1a hash + LCG RNG +
 * same per-token r() consumption order) so existing seeded outputs remain
 * stable.
 */

export type RelatedTokenStatus = "Active" | "Rugged" | "Dormant";

const STATUSES: RelatedTokenStatus[] = ["Active", "Rugged", "Dormant"];

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function range(r: () => number, min: number, max: number) {
  return min + r() * (max - min);
}

export interface ClusterTokenStats {
  /** Total related tokens for this cluster (3–12). */
  relatedTokens: number;
  /** How many of those related tokens have status "Rugged". */
  ruggedTokens: number;
  /** Active count. */
  activeTokens: number;
  /** Dormant count. */
  dormantTokens: number;
  /** Per-index status list (so the cluster UI can adopt the same source). */
  statuses: RelatedTokenStatus[];
}

/**
 * Compute deterministic cluster stats from a token mint address.
 * Replicates the r() consumption order of the legacy generator so the
 * cluster page can keep generating addresses / market caps independently
 * while sharing the same status sequence.
 */
export function computeClusterStats(tokenAddress: string): ClusterTokenStats {
  const seed = hash(tokenAddress);
  const r = rng(seed);
  const count = Math.min(12, Math.max(3, Math.floor(range(r, 3, 12))));
  const statuses: RelatedTokenStatus[] = [];
  for (let i = 0; i < count; i++) {
    // mirror legacy r() consumption: symIdx, status, marketCap, ageDays
    Math.floor(r() * 12);                          // symIdx
    const status = STATUSES[Math.floor(r() * STATUSES.length)];
    Math.round(range(r, 5_000, 5_000_000));        // marketCap
    Math.floor(range(r, 1, 240));                  // ageDays
    statuses.push(status);
  }
  const ruggedTokens  = statuses.filter((s) => s === "Rugged").length;
  const activeTokens  = statuses.filter((s) => s === "Active").length;
  const dormantTokens = statuses.filter((s) => s === "Dormant").length;
  return { relatedTokens: count, ruggedTokens, activeTokens, dormantTokens, statuses };
}
