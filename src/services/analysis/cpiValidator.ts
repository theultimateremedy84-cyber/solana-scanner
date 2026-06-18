/**
 * 'CPI Manipulation' Detector
 * ---------------------------------------------------------------
 * Detects "Arbitrary CPI" vulnerabilities where a Solana transaction
 * invokes an UNVERIFIED or UNAUTHORIZED program via Cross-Program
 * Invocation.
 *
 * Strategy:
 *   1. Maintain a TRUSTED_PROGRAM_LIST of well-known, audited programs
 *      (SPL Token, Token-2022, System, Jupiter, Raydium, Orca, ...).
 *   2. Walk the transaction's `meta.innerInstructions` tree (NOT only
 *      top-level instructions) and collect the `programId` of every
 *      invocation.
 *   3. Any programId that is not in the trusted list and is not a
 *      well-known system / runtime program flags the transaction as
 *      `is_cpi_manipulated: TRUE`, recording the suspicious programId
 *      in `suspiciousProgramIds`.
 *
 * Used by scan-core to enforce a CRITICAL globalRiskScore floor of 100
 * and by the UI "CPI Analysis" panel to label unverified addresses RED.
 */

// -----------------------------------------------------------------------
// Trusted program registry
// -----------------------------------------------------------------------

/**
 * Known/standard Solana runtime + native programs.
 * These can appear as CPI targets in completely legitimate transactions.
 */
export const SYSTEM_PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  ComputeBudget111111111111111111111111111111: "Compute Budget Program",
  Sysvar1nstructions1111111111111111111111111: "Sysvar: Instructions",
  SysvarRent111111111111111111111111111111111: "Sysvar: Rent",
  SysvarC1ock11111111111111111111111111111111: "Sysvar: Clock",
  Vote111111111111111111111111111111111111111: "Vote Program",
  Stake11111111111111111111111111111111111111: "Stake Program",
  BPFLoader1111111111111111111111111111111111: "BPF Loader",
  BPFLoader2111111111111111111111111111111111: "BPF Loader 2",
  BPFLoaderUpgradeab1e11111111111111111111111: "BPF Upgradeable Loader",
  Ed25519SigVerify111111111111111111111111111: "Ed25519 SigVerify",
  KeccakSecp256k11111111111111111111111111111: "Secp256k1 Program",
};

/**
 * Trusted, audited programs (DEX aggregators, AMMs, SPL tokens, ...).
 * Add new programs here once they have been reviewed.
 */
export const TRUSTED_PROGRAM_LIST: Record<string, string> = {
  // --- SPL ---
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "SPL Token-2022 Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account Program",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  // --- DEX aggregators ---
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: "Jupiter Aggregator v4",
  // --- Raydium ---
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: "Raydium Routing",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  // --- Orca ---
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": "Orca v1",
  // --- Pump.fun / Moonshot ---
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: "Moonshot",
  // --- Marinade / staking ---
  MarBmsSgKXdrN1egZf5sqe1TMThczhMLJhrL4mLN3y9: "Marinade Finance",
};

/**
 * Combined lookup — true when a programId is trusted OR a known
 * system / runtime program.
 */
export function isTrustedProgram(programId: string): boolean {
  if (!programId) return false;
  return programId in TRUSTED_PROGRAM_LIST || programId in SYSTEM_PROGRAMS;
}

/**
 * Human-readable label for a trusted programId, or null.
 */
export function getTrustedProgramLabel(programId: string): string | null {
  return TRUSTED_PROGRAM_LIST[programId] ?? SYSTEM_PROGRAMS[programId] ?? null;
}

// -----------------------------------------------------------------------
// validateCPI()
// -----------------------------------------------------------------------

/**
 * One detected CPI invocation.
 */
export interface CPIInvocation {
  /** The invoked program. */
  programId: string;
  /** Source: "top" = transaction.message.instructions, "inner" = meta.innerInstructions. */
  source: "top" | "inner";
  /** Nesting depth — 0 = top-level, >=1 = inner (CPI). */
  depth: number;
  /** Top-level instruction index this invocation belongs to. */
  outerIndex: number;
  /** True when the programId is in TRUSTED_PROGRAM_LIST or SYSTEM_PROGRAMS. */
  trusted: boolean;
  /** Friendly label when trusted, else null. */
  label: string | null;
}

/**
 * Result of validating CPIs in a single transaction.
 */
export interface CPIValidationResult {
  /** TRUE when at least one CPI targets an untrusted programId. */
  is_cpi_manipulated: boolean;
  /** Every program invoked, in walk order, with trust verdict. */
  invocations: CPIInvocation[];
  /** Distinct programIds that were untrusted (suspicious). */
  suspiciousProgramIds: string[];
  /** Distinct trusted programIds (for display). */
  trustedProgramIds: string[];
  /** Maximum CPI nesting depth observed (matches Bloat monitor units). */
  maxDepth: number;
  /** Human-readable summary for `cpi_risk_details` (TEXT column). */
  cpi_risk_details: string;
}

/**
 * Loosely-typed Solana tx metadata — we only depend on the shape
 * Helius / @solana/web3.js return.
 */
export interface TxMetadataLike {
  transaction?: {
    message?: {
      instructions?: Array<{
        programId?: string;
        programIdIndex?: number;
      }>;
      accountKeys?: Array<string | { pubkey?: string }>;
    };
  };
  meta?: {
    innerInstructions?: Array<{
      index: number;
      instructions?: Array<{
        programId?: string;
        programIdIndex?: number;
        stackHeight?: number | null;
      }>;
    }>;
    logMessages?: string[] | null;
  };
}

/**
 * Resolve an instruction's programId, supporting both decoded objects
 * (Helius-style: `programId` is a string) and raw message format
 * (`programIdIndex` into the accountKeys array).
 */
function resolveProgramId(
  ins: { programId?: string; programIdIndex?: number },
  accountKeys: string[],
): string | null {
  if (typeof ins.programId === "string" && ins.programId.length > 0) {
    return ins.programId;
  }
  if (typeof ins.programIdIndex === "number" && accountKeys[ins.programIdIndex]) {
    return accountKeys[ins.programIdIndex];
  }
  return null;
}

function normalizeAccountKeys(
  keys: Array<string | { pubkey?: string }> | undefined,
): string[] {
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => (typeof k === "string" ? k : (k?.pubkey ?? ""))).filter(Boolean);
}

/**
 * Walk the transaction's instruction tree (top-level + innerInstructions)
 * and classify every invoked programId as trusted or suspicious.
 *
 * IMPORTANT: do NOT rely solely on top-level instructions — Arbitrary CPI
 * attacks intentionally hide the malicious invocation inside an inner
 * instruction tree. We always traverse `meta.innerInstructions`.
 */
export function validateCPI(transactionMetadata: TxMetadataLike): CPIValidationResult {
  const tx = transactionMetadata ?? {};
  const accountKeys = normalizeAccountKeys(tx.transaction?.message?.accountKeys);
  const invocations: CPIInvocation[] = [];

  // --- Top-level instructions (depth 0) ----------------------------------
  const topIns = tx.transaction?.message?.instructions ?? [];
  topIns.forEach((ins, outerIndex) => {
    const programId = resolveProgramId(ins, accountKeys);
    if (!programId) return;
    invocations.push({
      programId,
      source: "top",
      depth: 0,
      outerIndex,
      trusted: isTrustedProgram(programId),
      label: getTrustedProgramLabel(programId),
    });
  });

  // --- meta.innerInstructions (CPI calls — depth >= 1) -------------------
  const innerGroups = tx.meta?.innerInstructions ?? [];
  let maxDepth = invocations.length > 0 ? 1 : 0;
  for (const group of innerGroups) {
    const outerIndex = group.index ?? 0;
    const list = group.instructions ?? [];
    for (const ins of list) {
      const programId = resolveProgramId(ins, accountKeys);
      if (!programId) continue;
      // Solana exposes `stackHeight` for inner instructions: 2 = first CPI,
      // 3 = nested CPI, etc. Fall back to depth=1 when unavailable.
      const stackHeight =
        typeof ins.stackHeight === "number" && ins.stackHeight > 0
          ? ins.stackHeight
          : 2;
      const depth = Math.max(1, stackHeight - 1);
      if (depth > maxDepth) maxDepth = depth;
      invocations.push({
        programId,
        source: "inner",
        depth,
        outerIndex,
        trusted: isTrustedProgram(programId),
        label: getTrustedProgramLabel(programId),
      });
    }
  }

  // --- Roll-up ----------------------------------------------------------
  const suspicious = new Set<string>();
  const trusted = new Set<string>();
  for (const inv of invocations) {
    if (inv.trusted) trusted.add(inv.programId);
    else suspicious.add(inv.programId);
  }

  const suspiciousProgramIds = Array.from(suspicious);
  const trustedProgramIds = Array.from(trusted);
  const is_cpi_manipulated = suspiciousProgramIds.length > 0;

  const cpi_risk_details = is_cpi_manipulated
    ? `Untrusted CPI target(s) detected: ${suspiciousProgramIds.join(", ")}`
    : trustedProgramIds.length > 0
      ? `All ${invocations.length} invocation(s) target trusted programs.`
      : "No CPI invocations observed in the analysed transaction.";

  return {
    is_cpi_manipulated,
    invocations,
    suspiciousProgramIds,
    trustedProgramIds,
    maxDepth,
    cpi_risk_details,
  };
}

/**
 * Convenience helper: validate an array of transaction metadata objects
 * (e.g. the last N tracked transactions for a mint) and return a single
 * combined verdict. ANY manipulated tx flips the flag.
 */
export function validateCPIBatch(txs: TxMetadataLike[]): CPIValidationResult {
  const combined: CPIValidationResult = {
    is_cpi_manipulated: false,
    invocations: [],
    suspiciousProgramIds: [],
    trustedProgramIds: [],
    maxDepth: 0,
    cpi_risk_details: "",
  };
  const suspicious = new Set<string>();
  const trusted = new Set<string>();
  for (const tx of txs) {
    const r = validateCPI(tx);
    combined.invocations.push(...r.invocations);
    r.suspiciousProgramIds.forEach((p) => suspicious.add(p));
    r.trustedProgramIds.forEach((p) => trusted.add(p));
    if (r.maxDepth > combined.maxDepth) combined.maxDepth = r.maxDepth;
    if (r.is_cpi_manipulated) combined.is_cpi_manipulated = true;
  }
  combined.suspiciousProgramIds = Array.from(suspicious);
  combined.trustedProgramIds = Array.from(trusted);
  combined.cpi_risk_details = combined.is_cpi_manipulated
    ? `Untrusted CPI target(s) detected: ${combined.suspiciousProgramIds.join(", ")}`
    : combined.invocations.length > 0
      ? `All ${combined.invocations.length} invocation(s) across ${txs.length} tx target trusted programs.`
      : "No CPI invocations observed.";
  return combined;
}
