import type { Trade, DetectedPattern } from "./types";
import { tagEntity, type EntityLabel, type EntityTag } from "./mapper";

/**
 * ---------------------------------------------------------------------------
 * Layer 4 — Transaction Metadata Analysis (upgraded)
 * ---------------------------------------------------------------------------
 *
 * Original behaviour (still here):
 *   - Flags trade sets where >80% share an identical instruction fingerprint.
 *   - Flags trade sets where compute-unit usage has near-zero variance.
 *
 * New behaviour (data-enrichment driven):
 *   - Aggregates `origin` classifications produced by the mapper and flags
 *     wallets dominated by `programmatic` activity.
 *   - Honours `walletEntity` tags so trades originating from a known mixer
 *     or unlabeled contract deployer add weight to the score.
 *   - Exposes `traceCreatorFundingSource()` which walks a wallet's funding
 *     graph backwards to determine where its initial liquidity seed came
 *     from (CEX, bridge, mixer, contract deployer, unknown).
 *
 * The graph walker is provider-agnostic: pass in a `getFunder()` callback
 * (e.g. backed by Helius `getSignaturesForAddress` + the first inbound
 * transfer) and the function does the rest.
 * ---------------------------------------------------------------------------
 */

export function analyzeTxMetadata(
  trades: Trade[],
): { score: number; patterns: DetectedPattern[] } {
  const patterns: DetectedPattern[] = [];

  // --- 1. Identical instruction fingerprint (existing) ---
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

  // --- 2. Uniform compute units (existing) ---
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

  // --- 3. Programmatic dominance (NEW) ---
  const originLabeled = trades.filter((t) => t.origin && t.origin !== "unknown");
  if (originLabeled.length >= 20) {
    const programmatic = originLabeled.filter((t) => t.origin === "programmatic").length;
    const share = programmatic / originLabeled.length;
    if (share > 0.75) {
      patterns.push({
        id: "programmatic_dominance",
        label: "Bot / programmatic activity dominates",
        description: `${Math.round(share * 100)}% of classified trades were programmatic (bot / aggregator / relayer).`,
        weight: Math.min(20, Math.round((share - 0.75) * 80) + 8),
        evidence: { share, sample: originLabeled.length },
      });
    }
  }

  // --- 4. Suspicious counterparty entities (NEW) ---
  const entityHits = new Map<EntityTag, number>();
  for (const t of trades) {
    const tag = t.walletEntity?.tag;
    if (!tag || tag === "unknown") continue;
    entityHits.set(tag, (entityHits.get(tag) ?? 0) + 1);
  }
  const mixerHits = entityHits.get("mixer") ?? 0;
  if (mixerHits > 0) {
    patterns.push({
      id: "mixer_counterparty",
      label: "Mixer-tagged counterparty involved",
      description: `${mixerHits} trade(s) involve a wallet tagged as a privacy mixer.`,
      weight: Math.min(30, 10 + mixerHits * 4),
      evidence: { mixerHits },
    });
  }

  const score = patterns.reduce((s, p) => s + p.weight, 0);
  return { score: Math.min(100, score), patterns };
}

// ---------------------------------------------------------------------------
// Creator funding-source tracer (NEW)
// ---------------------------------------------------------------------------

export type FundingSourceCategory =
  | "cex"
  | "bridge"
  | "mixer"
  | "contract_deployer"
  | "self_funded"
  | "unknown";

export interface FundingHop {
  address: string;
  entity: EntityLabel;
  /** Funding tx signature, if available */
  signature?: string;
  /** Quote / SOL amount transferred at this hop */
  amount?: number;
  /** Unix epoch (ms) of the funding tx */
  timestamp?: number;
}

export interface FundingTrace {
  /** The wallet we started from (token creator). */
  creator: string;
  /** Ordered chain of funders, most recent first → origin last. */
  path: FundingHop[];
  /** Final classification of the originating source. */
  originCategory: FundingSourceCategory;
  /** 0–100 risk score derived from the origin category + path length. */
  riskScore: number;
  /** Free-form notes for UI display. */
  notes: string[];
}

/**
 * Callback signature for fetching the immediate funder of an address.
 * Implementations typically:
 *   - call `getSignaturesForAddress(address, { before })`,
 *   - find the earliest inbound native-SOL or SPL transfer,
 *   - return the source wallet + amount + signature + timestamp.
 *
 * Return `null` when no funder can be identified (e.g. genesis / airdrop).
 */
export type GetFunderFn = (address: string) => Promise<{
  address: string;
  signature?: string;
  amount?: number;
  timestamp?: number;
} | null>;

interface TraceOptions {
  /** Maximum hops to follow back. Default 6. */
  maxDepth?: number;
  /**
   * Optional hint resolver — given an address, return registry hints
   * (deployedPrograms, txCount …) used to refine `tagEntity()`.
   */
  getEntityHints?: (address: string) => Promise<Parameters<typeof tagEntity>[1] | undefined>;
}

/**
 * Walk backwards through the funding graph of `creatorWallet` and report
 * where the seed liquidity ultimately came from. Stops early if it hits a
 * labelled CEX / bridge / mixer / known deployer, or when `maxDepth` is
 * reached.
 *
 * Notes:
 *  - Cycle-safe: visited addresses are tracked.
 *  - Privacy-focused / suspicious origins return a high `riskScore`.
 *  - This is the single function the rest of the engine should call to
 *    answer "did this token's creator wallet originate from somewhere
 *    suspicious?".
 */
export async function traceCreatorFundingSource(
  creatorWallet: string,
  getFunder: GetFunderFn,
  opts: TraceOptions = {},
): Promise<FundingTrace> {
  const maxDepth = opts.maxDepth ?? 6;
  const visited = new Set<string>([creatorWallet]);
  const path: FundingHop[] = [];
  const notes: string[] = [];

  let cursor = creatorWallet;

  for (let depth = 0; depth < maxDepth; depth++) {
    const funder = await getFunder(cursor);
    if (!funder || !funder.address) {
      notes.push(`no funder found at depth ${depth} (likely genesis/airdrop)`);
      break;
    }
    if (visited.has(funder.address)) {
      notes.push(`cycle detected at ${funder.address.slice(0, 6)}…`);
      break;
    }
    visited.add(funder.address);

    const hints = opts.getEntityHints ? await opts.getEntityHints(funder.address) : undefined;
    const entity = tagEntity(funder.address, hints);

    path.push({
      address: funder.address,
      entity,
      signature: funder.signature,
      amount: funder.amount,
      timestamp: funder.timestamp,
    });

    // Terminal categories — stop as soon as we hit one.
    if (
      entity.tag === "cex_hot_wallet"   ||
      entity.tag === "cex_deposit_wallet" ||
      entity.tag === "bridge"           ||
      entity.tag === "mixer"            ||
      entity.tag === "contract_deployer"
    ) {
      notes.push(`hit terminal entity (${entity.tag}) after ${depth + 1} hop(s)`);
      break;
    }

    cursor = funder.address;
  }

  // Derive originCategory from the deepest labelled hop, else "unknown".
  let originCategory: FundingSourceCategory = "unknown";
  for (let i = path.length - 1; i >= 0; i--) {
    const tag = path[i].entity.tag;
    if (tag === "cex_hot_wallet" || tag === "cex_deposit_wallet") { originCategory = "cex"; break; }
    if (tag === "bridge")            { originCategory = "bridge"; break; }
    if (tag === "mixer")             { originCategory = "mixer"; break; }
    if (tag === "contract_deployer") { originCategory = "contract_deployer"; break; }
  }
  if (originCategory === "unknown" && path.length === 0) {
    originCategory = "self_funded";
  }

  // Risk scoring: mixer >> contract_deployer >> bridge > cex.
  const baseRisk: Record<FundingSourceCategory, number> = {
    mixer: 90,
    contract_deployer: 55,
    bridge: 35,
    unknown: 25,
    cex: 10,
    self_funded: 5,
  };
  // Longer obfuscation chains add risk.
  const depthPenalty = Math.min(15, path.length * 2);
  const riskScore = Math.max(0, Math.min(100, baseRisk[originCategory] + depthPenalty));

  if (originCategory === "mixer") {
    notes.push("⚠ creator wallet was seeded through a privacy-focused protocol");
  } else if (originCategory === "contract_deployer") {
    notes.push("creator funded by a wallet that also deploys contracts — possible insider cluster");
  }

  return { creator: creatorWallet, path, originCategory, riskScore, notes };
}
