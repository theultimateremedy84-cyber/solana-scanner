import type { Trade, DetectedPattern } from "./types";

/**
 * Layer 4 (Pro Tip) — Transaction Metadata Analysis
 *
 * Wash bots almost always emit the *exact* same instruction layout and
 * burn the *exact* same number of compute units per trade. Real users
 * coming from different wallets/UIs produce a much wider distribution.
 *
 * Provide `instructionFingerprint` as a stable hash of the program ID
 * + instruction discriminator + serialised account layout (NOT the raw
 * amounts). A simple working version: `sha256(programId + base64(ixData.slice(0, 8)))`.
 */
export function analyzeTxMetadata(
  trades: Trade[],
): { score: number; patterns: DetectedPattern[] } {
  const patterns: DetectedPattern[] = [];

  const fps = trades.map((t) => t.instructionFingerprint).filter(Boolean) as string[];
  if (fps.length >= 20) {
    const counts = new Map<string, number>();
    for (const f of fps) counts.set(f, (counts.get(f) ?? 0) + 1);
    const [topFp, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = topCount / fps.length;
    if (share > 0.8) {
      patterns.push({
        id: "identical_instruction_fingerprint",
        label: "Identical instruction structure",
        description: `${Math.round(share * 100)}% of trades share the exact same instruction fingerprint.`,
        weight: Math.min(25, Math.round((share - 0.8) * 100) + 10),
        evidence: { fingerprint: topFp, share },
      });
    }
  }

  const cus = trades.map((t) => t.computeUnits).filter((n): n is number => typeof n === "number");
  if (cus.length >= 20) {
    const mean = cus.reduce((s, n) => s + n, 0) / cus.length;
    const variance = cus.reduce((s, n) => s + (n - mean) ** 2, 0) / cus.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    if (cv < 0.05) {
      patterns.push({
        id: "uniform_compute_units",
        label: "Uniform compute-unit usage",
        description: `Compute units almost identical across trades (CV=${cv.toFixed(3)}, mean=${Math.round(mean)}).`,
        weight: 15,
        evidence: { cv, mean },
      });
    }
  }

  const score = patterns.reduce((s, p) => s + p.weight, 0);
  return { score: Math.min(100, score), patterns };
}
