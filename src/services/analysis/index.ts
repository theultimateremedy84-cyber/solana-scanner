import type { Trade, DetectionResult, DetectedPattern } from "./types";
import { analyzeWalletCluster } from "./walletCluster";
import { analyzeTradeCadence } from "./tradeCadence";
import { analyzeNetZeroPositions } from "./netZeroPosition";
import { analyzeTxMetadata } from "./txMetadata";

export * from "./types";
export { analyzeWalletCluster, analyzeTradeCadence, analyzeNetZeroPositions, analyzeTxMetadata };

/**
 * Advanced Manipulation Detection — main entry point.
 *
 * Pass in the raw trade history for a token and get back a 0–100
 * anomaly score, a verdict, and the list of patterns that fired.
 *
 * The four layers are weighted and capped at 100. Replace the old
 * volume/liquidity-ratio wash-trade check with a call to this function.
 */
export function detectManipulation(trades: Trade[]): DetectionResult {
  const cluster = analyzeWalletCluster(trades);
  const cadence = analyzeTradeCadence(trades);
  const netZero = analyzeNetZeroPositions(trades);
  const meta = analyzeTxMetadata(trades);

  const patterns: DetectedPattern[] = [
    ...cluster.patterns,
    ...cadence.patterns,
    ...netZero.patterns,
    ...meta.patterns,
  ].sort((a, b) => b.weight - a.weight);

  // Weighted sum, capped. Net-zero is the strongest single signal.
  const raw =
    cluster.score * 0.9 +
    cadence.score * 0.8 +
    netZero.score * 1.1 +
    meta.score * 0.7;
  const anomalyScore = Math.max(0, Math.min(100, Math.round(raw)));

  const verdict: DetectionResult["verdict"] =
    anomalyScore >= 80 ? "manipulated"
    : anomalyScore >= 60 ? "likely_manipulated"
    : anomalyScore >= 35 ? "suspicious"
    : "clean";

  return {
    anomalyScore,
    verdict,
    patterns,
    breakdown: {
      walletCluster: cluster.score,
      tradeCadence: cadence.score,
      netZero: netZero.score,
      txMetadata: meta.score,
    },
  };
}
// Liquidity forensics (locker whitelist + post-launch SetAuthority watcher).
export {
  analyzeLiquidityLocker,
  analyzeAuthorityChanges,
  applyLiquidityForensics,
  VERIFIED_LOCKERS,
} from "./liquidityForensics";
export type {
  DetectedPattern,
  LockerType,
  LiquidityLockerInput,
  LiquidityLockerResult,
  ObservedTx,
  AuthorityChangeInput,
  AuthorityChangeEvent,
  AuthorityChangeResult,
} from "./liquidityForensics";
