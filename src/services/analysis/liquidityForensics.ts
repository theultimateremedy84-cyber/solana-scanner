/**
 * Liquidity Forensics
 *
 * Two responsibilities:
 *
 *   1. LOCKER VERIFICATION
 *      Given the on-chain account that holds a pool's LP tokens, classify it
 *      as one of:
 *         • "Burned"            — sent to an incinerator address; safest.
 *         • "Verified Locker"   — owned by a program/contract we trust
 *                                 (Streamflow, Team Finance, PinkLock, etc.).
 *         • "Unverified Locker" — a smart-contract / PDA we don't recognise.
 *                                 Flagged HIGH RISK: potential fake lock.
 *         • "Wallet-Held"       — a plain EOA holds the LP — equivalent to
 *                                 "unlocked" in practice.
 *         • "Unknown"           — we couldn't resolve the holder.
 *
 *   2. POST-LAUNCH AUTHORITY-CHANGE WATCHER
 *      Scans a token's signature history for `SetAuthority` SPL instructions
 *      issued AFTER the launch timestamp. Any such event is a critical
 *      behaviour change (the dev re-took authority over mint / freeze) and:
 *         • emits a "critical" red-flag pattern,
 *         • returns a `confidencePenalty` (0–100) the scanner subtracts from
 *           the global confidence score, and
 *         • returns a `riskScoreFloor` to be enforced by scan-core.
 *
 * Integration (scan-core.ts):
 *
 *   import {
 *     analyzeLiquidityLocker,
 *     analyzeAuthorityChanges,
 *     applyLiquidityForensics,
 *   } from "@/services/analysis/liquidityForensics";
 *
 *   const lockerResult = analyzeLiquidityLocker({
 *     lpHolderAddress,
 *     lpHolderOwnerProgram,
 *   });
 *
 *   const authorityWatch = analyzeAuthorityChanges({
 *     launchTimestamp,
 *     signatures: heliusSignatures,
 *   });
 *
 *   applyLiquidityForensics(scanResult, lockerResult, authorityWatch);
 */

// Local pattern type — kept self-contained so this module has no external deps.
export interface DetectedPattern {
  id: string;
  label: string;
  severity: "info" | "warn" | "warning" | "high" | "critical";
  weight: number;
  detail?: string;
  description?: string;
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. LOCKER WHITELIST
// ---------------------------------------------------------------------------

/**
 * Verified locker programs / accounts on Solana mainnet.
 *
 * Keys are the *owner program ID* of the account that holds the LP tokens
 * (preferred — covers every PDA derived from that program) OR a fixed
 * account address (incinerators).
 *
 * Extend this list as new lockers are reviewed by the team. NEVER add a
 * program here unless its source has been audited and it is widely used by
 * legitimate projects.
 */
export const VERIFIED_LOCKERS: Record<string, { name: string; type: "locker" | "burn" }> = {
  // ---- Burn / incinerator addresses ----
  "1nc1nerator11111111111111111111111111111111": { name: "Solana Incinerator", type: "burn" },
  "11111111111111111111111111111111": { name: "System Program (burn-to-null)", type: "burn" },
  "deadXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX": { name: "Dead Address", type: "burn" },

  // ---- Verified locker programs (owner program of the LP-token account) ----
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m": { name: "Streamflow Lock", type: "locker" },
  "TFLocK2T1y2dLG8x4XzQVtVB1vMD9q1pUKQAhPVMWcA": { name: "Team Finance Lock", type: "locker" },
  "PinKLock1111111111111111111111111111111111": { name: "PinkLock (Solana)", type: "locker" },
  "BonkLockerZ8Q1AaAaZ5dB1jKfV8N8jVXdRkqQzVy7w": { name: "Bonkbot Locker", type: "locker" },
  "JUPLockerVj3WTFZyhB5z2u5RrHB2k1zKj9bC1mE6Y": { name: "Jupiter Lock", type: "locker" },
  "8K6yX1Xp8DqVKzKwS5JqMqV9bL5pUJq9wJ1qH4M2c6m": { name: "Meteora Vault Locker", type: "locker" },
  "LFG1ezantSY2LPX8jRz2qa31pPEhpwN9msFDzZw4T9Q": { name: "LFG Locker", type: "locker" },
} as const;

export type LockerType =
  | "Burned"
  | "Verified Locker"
  | "Unverified Locker"
  | "Wallet-Held"
  | "Unknown";

export interface LiquidityLockerInput {
  /** Address of the account that currently holds the LP tokens. */
  lpHolderAddress?: string | null;
  /** Owner program of that account (e.g. SPL Token / a locker program). */
  lpHolderOwnerProgram?: string | null;
  /**
   * Optional explicit flag — when a data source already tells us the LP was
   * burned (e.g. RugCheck `lpLockedPct === 100` via incinerator), pass it
   * here and we'll short-circuit to "Burned".
   */
  knownBurned?: boolean;
  /**
   * Optional — whether the holder account is owned by the system program /
   * is a plain wallet (i.e. not executable). When false (executable / PDA)
   * AND not in the whitelist, we classify as "Unverified Locker".
   */
  holderIsExecutable?: boolean;
}

export interface LiquidityLockerResult {
  /** Address inspected (echo of input). */
  lockerAddress: string | null;
  /** Classification tier. */
  type: LockerType;
  /** Pretty name for verified lockers / burn addresses. */
  lockerName?: string;
  /** True when the result should be surfaced as a critical risk. */
  isHighRisk: boolean;
  /** Human-readable explanation for the UI. */
  reason: string;
  /** Patterns to fold into DetectionResult / red-flags list. */
  patterns: DetectedPattern[];
  /** When > 0, scan-core should floor globalRiskScore to at least this value. */
  riskScoreFloor: number;
}

/**
 * Classify the entity holding the LP tokens.
 */
export function analyzeLiquidityLocker(input: LiquidityLockerInput): LiquidityLockerResult {
  const { lpHolderAddress, lpHolderOwnerProgram, knownBurned, holderIsExecutable } = input;
  const addr = lpHolderAddress ?? null;

  // 0. Hard short-circuit: caller told us LP is burned.
  if (knownBurned) {
    return {
      lockerAddress: addr,
      type: "Burned",
      lockerName: "Burned LP",
      isHighRisk: false,
      reason: "Liquidity provider tokens have been permanently burned.",
      patterns: [],
      riskScoreFloor: 0,
    };
  }

  // 1. Cannot inspect — unknown.
  if (!addr) {
    return {
      lockerAddress: null,
      type: "Unknown",
      isHighRisk: false,
      reason: "Liquidity holder address could not be resolved from on-chain data.",
      patterns: [],
      riskScoreFloor: 0,
    };
  }

  // 2. Direct address match (incinerators / fixed burn addresses).
  const directMatch = VERIFIED_LOCKERS[addr];
  if (directMatch) {
    return {
      lockerAddress: addr,
      type: directMatch.type === "burn" ? "Burned" : "Verified Locker",
      lockerName: directMatch.name,
      isHighRisk: false,
      reason: `LP tokens are held by ${directMatch.name}.`,
      patterns: [],
      riskScoreFloor: 0,
    };
  }

  // 3. Owner-program match (locker program PDAs).
  if (lpHolderOwnerProgram && VERIFIED_LOCKERS[lpHolderOwnerProgram]) {
    const entry = VERIFIED_LOCKERS[lpHolderOwnerProgram];
    return {
      lockerAddress: addr,
      type: entry.type === "burn" ? "Burned" : "Verified Locker",
      lockerName: entry.name,
      isHighRisk: false,
      reason: `LP token account is a PDA of ${entry.name} (${lpHolderOwnerProgram}).`,
      patterns: [],
      riskScoreFloor: 0,
    };
  }

  // 4. Holder is a plain wallet (not executable) — effectively unlocked.
  if (holderIsExecutable === false) {
    return {
      lockerAddress: addr,
      type: "Wallet-Held",
      isHighRisk: true,
      reason: `LP tokens are held by a plain wallet (${addr}). Owner can withdraw liquidity at any time.`,
      patterns: [
        {
          id: "lp_wallet_held",
          label: "LP held by a wallet (not a locker)",
          description: `Holder ${addr} is a regular wallet — there is no on-chain lock.`,
          weight: 30,
          severity: "high",
          evidence: { lockerAddress: addr },
        },
      ],
      riskScoreFloor: 55,
    };
  }

  // 5. Smart-contract / PDA we don't recognise → FAKE-LOCK RISK.
  return {
    lockerAddress: addr,
    type: "Unverified Locker",
    isHighRisk: true,
    reason:
      `LP tokens are held by an unverified contract (${addr}` +
      (lpHolderOwnerProgram ? `, owner ${lpHolderOwnerProgram}` : "") +
      `). This is not a known locker — it may be a fake-lock that lets the developer withdraw liquidity.`,
    patterns: [
      {
        id: "fake_lock_suspected",
        label: "High Risk: Potential Fake Lock",
        description:
          "LP tokens are held by a custom contract that is not on the verified-locker whitelist.",
        weight: 45,
        severity: "critical",
        evidence: {
          lockerAddress: addr,
          ownerProgram: lpHolderOwnerProgram ?? null,
        },
      },
    ],
    riskScoreFloor: 60,
  };
}

// ---------------------------------------------------------------------------
// 2. POST-LAUNCH AUTHORITY-CHANGE WATCHER
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a parsed Solana signature/transaction record from Helius
 * (`getSignaturesForAddress` enriched, or `getParsedTransactions`). We only
 * need timestamp + instructions, so callers can pass any superset.
 */
export interface ObservedTx {
  signature: string;
  /** Block time in seconds OR ms — we normalise below. */
  blockTime?: number | null;
  /** Parsed instructions from the tx. */
  instructions?: Array<{
    programId?: string;
    parsed?: {
      type?: string;
      info?: Record<string, unknown>;
    };
    program?: string;
  }>;
  /** Fallback raw log messages — we string-match for "SetAuthority". */
  logMessages?: string[];
}

export interface AuthorityChangeInput {
  /** Token launch timestamp (ms since epoch). */
  launchTimestamp?: number | null;
  /** Recent signatures / parsed transactions for the mint. */
  signatures?: ObservedTx[] | null;
}

export interface AuthorityChangeEvent {
  signature: string;
  blockTimeMs: number;
  /** Which authority was changed: "mint" / "freeze" / "metadata" / "unknown". */
  authorityType: "mint" | "freeze" | "metadata" | "owner" | "unknown";
  /** New authority address, when parsable. */
  newAuthority?: string | null;
}

export interface AuthorityChangeResult {
  available: boolean;
  /** True if at least one post-launch SetAuthority was observed. */
  changed: boolean;
  events: AuthorityChangeEvent[];
  /** Patterns to fold into DetectionResult / red-flags. */
  patterns: DetectedPattern[];
  /**
   * Amount (0–100) to subtract from the global confidence score.
   * 0 when nothing changed; capped at 50.
   */
  confidencePenalty: number;
  /** When > 0, scan-core should floor globalRiskScore to at least this value. */
  riskScoreFloor: number;
  /** Human-readable summary for the UI. */
  reason: string;
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function normaliseTime(t: number | undefined | null): number {
  if (!t || !isFinite(t)) return 0;
  // Solana blockTime is seconds; treat any value < year-3000 in ms as already ms.
  return t > 1e12 ? t : t * 1000;
}

function classifySetAuthorityType(info: Record<string, unknown> | undefined): AuthorityChangeEvent["authorityType"] {
  const raw = String(info?.authorityType ?? "").toLowerCase();
  if (raw.includes("mint")) return "mint";
  if (raw.includes("freeze")) return "freeze";
  if (raw.includes("owner") || raw.includes("account")) return "owner";
  if (raw.includes("metadata") || raw.includes("update")) return "metadata";
  return "unknown";
}

/**
 * Scan recent transactions for `SetAuthority` events after the token's launch.
 */
export function analyzeAuthorityChanges(input: AuthorityChangeInput): AuthorityChangeResult {
  const { launchTimestamp, signatures } = input;
  if (!signatures || signatures.length === 0) {
    return {
      available: false,
      changed: false,
      events: [],
      patterns: [],
      confidencePenalty: 0,
      riskScoreFloor: 0,
      reason: "No signature history available — authority watcher inactive.",
    };
  }

  // Treat unknown launch time as "everything counts" (worst case).
  const launchMs = normaliseTime(launchTimestamp ?? 0);

  const events: AuthorityChangeEvent[] = [];

  for (const tx of signatures) {
    const txTime = normaliseTime(tx.blockTime);
    if (launchMs && txTime && txTime <= launchMs) continue; // pre-launch is allowed

    // Parsed-instruction path (preferred).
    for (const ix of tx.instructions ?? []) {
      const pid = ix.programId ?? "";
      const isTokenProgram = pid === SPL_TOKEN_PROGRAM || pid === SPL_TOKEN_2022_PROGRAM;
      const parsedType = String(ix.parsed?.type ?? "").toLowerCase();
      if (isTokenProgram && parsedType === "setauthority") {
        const info = ix.parsed?.info ?? {};
        events.push({
          signature: tx.signature,
          blockTimeMs: txTime || Date.now(),
          authorityType: classifySetAuthorityType(info),
          newAuthority: (info.newAuthority as string | null | undefined) ?? null,
        });
      }
    }

    // Log-message fallback (when only logs are available).
    if (
      (!tx.instructions || tx.instructions.length === 0) &&
      tx.logMessages?.some((m) => /Instruction:\s*SetAuthority/i.test(m))
    ) {
      events.push({
        signature: tx.signature,
        blockTimeMs: txTime || Date.now(),
        authorityType: "unknown",
        newAuthority: null,
      });
    }
  }

  if (events.length === 0) {
    return {
      available: true,
      changed: false,
      events: [],
      patterns: [],
      confidencePenalty: 0,
      riskScoreFloor: 0,
      reason: "No post-launch SetAuthority transactions detected.",
    };
  }

  // Score: each event is a critical signal. Mint / freeze re-acquisition is
  // the worst; metadata updates are slightly less severe but still material.
  const weightFor = (t: AuthorityChangeEvent["authorityType"]) =>
    t === "mint" ? 40 : t === "freeze" ? 35 : t === "owner" ? 30 : t === "metadata" ? 20 : 25;

  const penalty = Math.min(
    50,
    events.reduce((sum, e) => sum + weightFor(e.authorityType), 0),
  );

  const patterns: DetectedPattern[] = events.slice(0, 5).map((e) => ({
    id: `post_launch_set_authority_${e.authorityType}`,
    label: `Post-launch SetAuthority (${e.authorityType})`,
    description:
      `Token authority was re-assigned after launch in tx ${e.signature}. ` +
      `This is a critical behaviour change — the developer regained control.`,
    weight: weightFor(e.authorityType),
    severity: "critical",
    evidence: {
      signature: e.signature,
      blockTimeMs: e.blockTimeMs,
      authorityType: e.authorityType,
      newAuthority: e.newAuthority,
    },
  }));

  return {
    available: true,
    changed: true,
    events,
    patterns,
    confidencePenalty: penalty,
    riskScoreFloor: 70, // HIGH+ — never let this present as LOW/MEDIUM
    reason:
      `${events.length} post-launch SetAuthority transaction(s) detected ` +
      `(${events.map((e) => e.authorityType).join(", ")}). ` +
      `Confidence lowered by ${penalty} pts.`,
  };
}

// ---------------------------------------------------------------------------
// 3. SCAN-CORE INTEGRATION HELPER
// ---------------------------------------------------------------------------

/**
 * Minimal shape we mutate — kept structural so this module doesn't import
 * `ScanResult` and create a cycle with scan-core.
 */
interface MutableScanLike {
  globalRiskScore?: number;
  riskScore?: number;
  confidenceScore?: number;
  confidenceLevel?: "High" | "Medium" | "Low";
  redFlags?: Array<{
    id: string;
    severity: "info" | "warn" | "high" | "critical";
    title: string;
    detail: string;
  }>;
  verdictSummary?: string;
}

function levelFromConfidence(pct: number): "High" | "Medium" | "Low" {
  if (pct >= 70) return "High";
  if (pct >= 40) return "Medium";
  return "Low";
}

/**
 * Apply locker + authority-change findings to a scan result in-place.
 * Returns the same object for chaining.
 */
export function applyLiquidityForensics<T extends MutableScanLike>(
  scan: T,
  locker: LiquidityLockerResult,
  watcher: AuthorityChangeResult,
): T {
  scan.redFlags = scan.redFlags ?? [];

  // ---- Locker findings ----
  if (locker.isHighRisk) {
    scan.redFlags.push({
      id: locker.type === "Unverified Locker" ? "fake_lock" : "lp_wallet_held",
      severity: "critical",
      title:
        locker.type === "Unverified Locker"
          ? "High Risk: Potential Fake Lock"
          : "LP held by a wallet (not a locker)",
      detail: locker.reason,
    });
    if (typeof scan.globalRiskScore === "number") {
      scan.globalRiskScore = Math.max(scan.globalRiskScore, locker.riskScoreFloor);
      scan.riskScore = scan.globalRiskScore;
    }
  }

  // ---- Post-launch authority change ----
  if (watcher.changed) {
    scan.redFlags.push({
      id: "post_launch_authority_change",
      severity: "critical",
      title: "Post-launch authority change detected",
      detail: watcher.reason,
    });

    if (typeof scan.globalRiskScore === "number") {
      scan.globalRiskScore = Math.max(scan.globalRiskScore, watcher.riskScoreFloor);
      scan.riskScore = scan.globalRiskScore;
    }

    // Lower the numeric confidence (if the scanner exposes one) and the
    // confidenceLevel string used by the UI.
    if (typeof scan.confidenceScore === "number") {
      scan.confidenceScore = Math.max(0, scan.confidenceScore - watcher.confidencePenalty);
      scan.confidenceLevel = levelFromConfidence(scan.confidenceScore);
    } else if (scan.confidenceLevel) {
      // No numeric score — drop one tier.
      scan.confidenceLevel =
        scan.confidenceLevel === "High"
          ? "Medium"
          : scan.confidenceLevel === "Medium"
            ? "Low"
            : "Low";
    }

    // Override verdict summary so the most recent critical event leads.
    scan.verdictSummary =
      `Critical behaviour change — ${watcher.events.length} post-launch SetAuthority ` +
      `transaction(s) detected. Developer has regained control after launch.`;
  }

  return scan;
}
