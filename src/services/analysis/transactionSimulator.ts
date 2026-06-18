/**
 * Phase 15 — 'Atomic Execution' Exploit Monitor
 * ---------------------------------------------------------------
 * Detects multi-instruction 'Atomic Exploits' where a legitimate
 * swap is bundled with malicious authority-modifying instructions
 * inside a single, atomically-executed Solana transaction.
 *
 * A single Solana transaction executes ALL instructions atomically —
 * either ALL succeed or ALL fail. This makes it the perfect vehicle
 * for a 'swap + backdoor' exploit: the user sees a swap succeed, but
 * hidden instructions simultaneously transfer mint authority, approve
 * a delegate, or mutate metadata.
 *
 * Strategy:
 *  1. Fetch the most recent transaction signatures for the mint address.
 *  2. For each signature, fetch the raw base64-encoded transaction bytes
 *     via `getTransaction` (encoding: "base64").
 *  3. Re-simulate via `simulateTransaction` RPC with `innerInstructions: true`
 *     to obtain the COMPLETE instruction tree including nested CPIs.
 *  4. Also parse the `getTransaction` (encoding: "jsonParsed") response for
 *     program IDs and instruction-level context not visible in simulation logs.
 *  5. Combine simulation logs + parsed instruction accounts to classify every
 *     instruction as: Swap, Authorization, Metadata, System, or Other.
 *  6. If any transaction contains BOTH a Swap instruction AND an
 *     Authorization/Metadata-modifying instruction, raise is_atomic_exploit.
 *
 * The service is used as a 'Pre-flight' check by the PostLaunchWatcher scan
 * pipeline: every token scan runs simulateAndAnalyze() against the mint's
 * most recent transactions before building the final ScanResult.
 *
 * Pure JSON-RPC implementation — no @solana/web3.js dependency.
 */

// ---------------------------------------------------------------------------
// Known Swap Program IDs
// ---------------------------------------------------------------------------

/**
 * Canonical programIds for the major Solana DEX / AMM programs.
 * Any instruction invoking one of these programs is classified as a "Swap".
 */
const SWAP_PROGRAM_IDS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "5quBtoiQqxF9Jv6KYKctB59NT3gtFD2XKcRv5qM7W57",  // Raydium AMM v3
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",  // Raydium Route
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", // Orca AMM
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter Aggregator v6
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // Jupiter v4
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // Serum DEX v3
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",  // Phoenix
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora Dynamic AMM
]);

// ---------------------------------------------------------------------------
// Known Authority-Modifying Program IDs
// ---------------------------------------------------------------------------

/** SPL Token Program — owns mint / freeze authority fields. */
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** SPL Token-2022 Program — same capabilities as SPL Token. */
const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Metaplex Token Metadata Program — controls token name / symbol / image. */
const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** Associated Token Account Program — used in authority delegation chains. */
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv";

/** System Program — Allocate/AllocateWithSeed can resize account data. */
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/**
 * Set of program IDs that CAN modify authority, metadata, or data account state.
 * An instruction from any of these programs alongside a swap is flagged.
 */
const AUTHORITY_PROGRAM_IDS = new Set([
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
]);

// ---------------------------------------------------------------------------
// SPL Token instruction discriminants (first byte of instruction data)
// ---------------------------------------------------------------------------

/**
 * SPL Token Program instruction indices that modify authority or delegation.
 * See: https://docs.rs/spl-token/latest/spl_token/instruction/enum.TokenInstruction.html
 *
 *  0 = InitializeMint         — sets initial mint/freeze authority
 *  4 = Approve                — delegates tokens to another wallet
 *  5 = Revoke                 — revokes a delegate
 *  6 = SetAuthority           — transfers mint or freeze authority
 *  7 = MintTo                 — inflates supply (requires mint authority)
 *  8 = Burn                   — can be used to drain supply
 *  9 = CloseAccount           — closes a token account
 * 25 = ApproveChecked         — checked form of Approve
 */
const AUTHORITY_DISCRIMINANTS: Record<number, string> = {
  0:  "InitializeMint",
  4:  "Approve",
  5:  "Revoke",
  6:  "SetAuthority",
  7:  "MintTo",
  9:  "CloseAccount",
  25: "ApproveChecked",
};

// ---------------------------------------------------------------------------
// Log-pattern matching for instruction name extraction
// ---------------------------------------------------------------------------

/**
 * Patterns matched against simulation log lines to extract instruction names.
 * Format: "Program log: Instruction: <Name>"
 */
const AUTHORIZATION_LOG_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /Instruction:\s*SetAuthority/i,              label: "SetAuthority" },
  { pattern: /Instruction:\s*Approve/i,                   label: "Approve" },
  { pattern: /Instruction:\s*ApproveChecked/i,            label: "ApproveChecked" },
  { pattern: /Instruction:\s*Revoke/i,                    label: "Revoke" },
  { pattern: /Instruction:\s*MintTo/i,                    label: "MintTo" },
  { pattern: /Instruction:\s*InitializeMint/i,            label: "InitializeMint" },
  { pattern: /Instruction:\s*CloseAccount/i,              label: "CloseAccount" },
  { pattern: /Instruction:\s*UpdateMetadataAccount/i,     label: "UpdateMetadataAccount" },
  { pattern: /Instruction:\s*UpdateV1/i,                  label: "UpdateMetadataV1" },
  { pattern: /Instruction:\s*SetAndVerifyCollection/i,    label: "SetAndVerifyCollection" },
  { pattern: /Instruction:\s*UpdateAsUpdateAuthorityV2/i, label: "UpdateAsUpdateAuthorityV2" },
  { pattern: /Instruction:\s*SetUpdateAuthority/i,        label: "SetUpdateAuthority" },
];

const SWAP_LOG_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /Instruction:\s*Swap/i,            label: "Swap" },
  { pattern: /Instruction:\s*SwapV2/i,          label: "SwapV2" },
  { pattern: /Instruction:\s*SwapExact/i,       label: "SwapExact" },
  { pattern: /Instruction:\s*Route/i,           label: "Route" },
  { pattern: /Instruction:\s*ExactIn/i,         label: "SwapExactIn" },
  { pattern: /Instruction:\s*ExactOut/i,        label: "SwapExactOut" },
  { pattern: /Instruction:\s*TwoHopSwap/i,      label: "TwoHopSwap" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single instruction extracted from the transaction simulation response.
 * May be a top-level instruction or an inner CPI instruction.
 */
export interface SimulatedInstruction {
  /** Invoking program's public key (base58). */
  programId: string;
  /** Human-readable program name derived from known program registry. */
  programName: string;
  /** Human-readable instruction type (e.g. "SetAuthority", "Swap", "Transfer"). */
  instructionType: string;
  /** Nesting depth: 0 = top-level, 1+ = inner CPI instruction. */
  depth: number;
  /** True if this instruction is a DEX/AMM swap. */
  isSwap: boolean;
  /**
   * True if this instruction modifies mint/freeze authority, token approval,
   * metadata update authority, or account data storage size.
   * Any instruction with this flag = TRUE co-existing with isSwap = TRUE
   * in the same transaction triggers the Atomic Exploit alert.
   */
  isAuthorizationRelated: boolean;
  /** True when both isSwap and isAuthorizationRelated are present in same tx. */
  isSuspicious: boolean;
}

/**
 * Full result returned by simulateAndAnalyze() for a single token mint.
 * The scanner pipeline stores this in the ScanResult and persists
 * is_atomic_exploit to scan_history.
 */
export interface AtomicExploitResult {
  /** True when simulateTransaction RPC was reachable and returned results. */
  available: boolean;
  /**
   * TRUE when any analyzed transaction contains BOTH a swap instruction AND
   * an authority-modifying instruction (SetAuthority, Approve, UpdateMetadata…).
   * Forces globalRiskScore = 100 (CRITICAL) in scan-core.
   */
  is_atomic_exploit: boolean;
  /** Full instruction list from the most suspicious transaction analyzed. */
  instructions: SimulatedInstruction[];
  /** Simulation error string if the RPC returned an error (null = clean run). */
  simulationError: string | null;
  /**
   * Human-readable summary of what was found, or "No exploit detected".
   * Persisted to scan_history.atomic_exploit_details.
   */
  exploitDetails: string;
  /** Transaction signature where the exploit was detected (if any). */
  signature?: string;
  /** ISO timestamp of detection. */
  detectedAt?: string;
}

// ---------------------------------------------------------------------------
// Program name registry
// ---------------------------------------------------------------------------

const PROGRAM_NAMES: Record<string, string> = {
  [SPL_TOKEN_PROGRAM_ID]:        "SPL Token",
  [SPL_TOKEN_2022_PROGRAM_ID]:   "SPL Token-2022",
  [TOKEN_METADATA_PROGRAM_ID]:   "Token Metadata",
  [ASSOCIATED_TOKEN_PROGRAM_ID]: "Associated Token",
  [SYSTEM_PROGRAM_ID]:           "System Program",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  "5quBtoiQqxF9Jv6KYKctB59NT3gtFD2XKcRv5qM7W57":  "Raydium AMM v3",
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS":  "Raydium Router",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc":  "Orca Whirlpool",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": "Orca AMM",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  "Jupiter v6",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":  "Jupiter v4",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin": "Serum DEX v3",
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY":  "Phoenix DEX",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo":  "Meteora DLMM",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "Meteora Dynamic AMM",
  "ComputeBudget111111111111111111111111111111":     "Compute Budget",
  "SysvarRent111111111111111111111111111111111":     "Sysvar: Rent",
  "SysvarC1ock11111111111111111111111111111111":     "Sysvar: Clock",
};

function programName(id: string): string {
  return PROGRAM_NAMES[id] ?? `${id.slice(0, 8)}…`;
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

function getRpcUrl(heliusKey: string): string {
  return heliusKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
    : "https://api.mainnet-beta.solana.com";
}

async function rpcCall<T = any>(
  heliusKey: string,
  method: string,
  params: any[],
): Promise<T | null> {
  try {
    const res = await fetch(getRpcUrl(heliusKey), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j?.result ?? null) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Instruction parsing helpers
// ---------------------------------------------------------------------------

/**
 * Resolve instruction type from a SPL Token program instruction data buffer.
 * The first byte is the instruction discriminant in the classic SPL Token ABI.
 */
function resolveSplTokenInstruction(dataBase64: string | undefined): string {
  if (!dataBase64) return "Unknown";
  try {
    const bytes = Buffer.from(dataBase64, "base64");
    const discriminant = bytes[0];
    return AUTHORITY_DISCRIMINANTS[discriminant] ?? `Instruction#${discriminant}`;
  } catch {
    return "Unknown";
  }
}

/**
 * Classify a single instruction by programId + optional data.
 * Returns a partial SimulatedInstruction (without depth / isSuspicious).
 */
function classifyInstruction(
  programId: string,
  dataBase64?: string,
  logDerivedType?: string,
): Pick<SimulatedInstruction, "programId" | "programName" | "instructionType" | "isSwap" | "isAuthorizationRelated"> {
  const name = programName(programId);
  const isSwap = SWAP_PROGRAM_IDS.has(programId);

  if (logDerivedType) {
    const isAuthLog = AUTHORIZATION_LOG_PATTERNS.some((p) =>
      p.pattern.test(`Instruction: ${logDerivedType}`),
    );
    return { programId, programName: name, instructionType: logDerivedType, isSwap, isAuthorizationRelated: isAuthLog };
  }

  if (programId === SPL_TOKEN_PROGRAM_ID || programId === SPL_TOKEN_2022_PROGRAM_ID) {
    const instrType = resolveSplTokenInstruction(dataBase64);
    const disc = dataBase64 ? Buffer.from(dataBase64, "base64")[0] : -1;
    const isAuth = disc in AUTHORITY_DISCRIMINANTS;
    return { programId, programName: name, instructionType: instrType, isSwap: false, isAuthorizationRelated: isAuth };
  }

  if (programId === TOKEN_METADATA_PROGRAM_ID) {
    return { programId, programName: name, instructionType: "MetadataInstruction", isSwap: false, isAuthorizationRelated: true };
  }

  if (programId === SYSTEM_PROGRAM_ID) {
    return { programId, programName: name, instructionType: "SystemInstruction", isSwap: false, isAuthorizationRelated: false };
  }

  if (isSwap) {
    return { programId, programName: name, instructionType: "Swap", isSwap: true, isAuthorizationRelated: false };
  }

  return { programId, programName: name, instructionType: "Instruction", isSwap: false, isAuthorizationRelated: false };
}

/**
 * Parse simulation logs to extract (programId → instructionType) mappings.
 * The Solana runtime emits "Program <id> invoke [<depth>]" and
 * "Program log: Instruction: <name>" lines in sequence.
 */
function parseSimulationLogs(logs: string[]): Map<string, string> {
  const result = new Map<string, string>();
  let currentProgram: string | null = null;

  for (const line of logs) {
    // "Program <id> invoke [N]"
    const invokeMatch = line.match(/^Program\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+invoke\s+\[(\d+)\]/);
    if (invokeMatch) {
      currentProgram = invokeMatch[1];
      continue;
    }

    // "Program log: Instruction: <name>"
    if (currentProgram && line.includes("Program log: Instruction:")) {
      const nameMatch = line.match(/Program log: Instruction:\s*(.+)/);
      if (nameMatch) {
        result.set(currentProgram, nameMatch[1].trim());
        currentProgram = null;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry — simulateAndAnalyze
// ---------------------------------------------------------------------------

/**
 * Runs the Atomic Execution Exploit Monitor for a given token mint address.
 *
 * 1. Fetches the 5 most recent confirmed transaction signatures for the mint.
 * 2. For each signature, fetches the full transaction twice:
 *    - "base64" encoding → raw bytes for simulateTransaction.
 *    - "jsonParsed" encoding → decoded accounts/data for instruction classification.
 * 3. Calls simulateTransaction with innerInstructions: true.
 * 4. Combines simulation logs + parsed instruction data to build the full
 *    instruction tree (top-level + inner CPIs at every nesting depth).
 * 5. Flags is_atomic_exploit if any tx contains Swap + Authorization together.
 *
 * @param mintAddress  The SPL token mint address to analyze.
 * @param heliusKey    Helius API key (empty → falls back to public RPC endpoint).
 * @returns            AtomicExploitResult with the full instruction tree.
 */
export async function simulateAndAnalyze(
  mintAddress: string,
  heliusKey: string,
): Promise<AtomicExploitResult> {
  const empty: AtomicExploitResult = {
    available: false,
    is_atomic_exploit: false,
    instructions: [],
    simulationError: null,
    exploitDetails: "",
  };

  if (!mintAddress) return empty;

  // ── Step 1: Fetch recent transaction signatures for the mint ──────────────
  const signaturesResp = await rpcCall<Array<{ signature: string; err: any }>>(
    heliusKey,
    "getSignaturesForAddress",
    [mintAddress, { limit: 10, commitment: "confirmed" }],
  );

  const signatures = (signaturesResp ?? [])
    .filter((s) => !s?.err && s?.signature)
    .map((s) => s.signature)
    .slice(0, 5);

  if (signatures.length === 0) return empty;

  // ── Step 2–4: Analyze each transaction ───────────────────────────────────
  let mostSuspiciousResult: AtomicExploitResult = { ...empty, available: true };
  let highestSuspicionScore = 0;

  for (const sig of signatures) {
    const txResult = await analyzeTransaction(sig, mintAddress, heliusKey);
    if (!txResult.available) continue;

    mostSuspiciousResult = { ...mostSuspiciousResult, available: true };

    const suspicionScore =
      (txResult.is_atomic_exploit ? 1000 : 0) +
      txResult.instructions.filter((i) => i.isAuthorizationRelated).length * 10 +
      txResult.instructions.filter((i) => i.isSwap).length;

    if (suspicionScore > highestSuspicionScore) {
      highestSuspicionScore = suspicionScore;
      mostSuspiciousResult = txResult;
    }

    // If we already found an exploit, stop looking.
    if (txResult.is_atomic_exploit) break;
  }

  return mostSuspiciousResult;
}

/**
 * Analyze a single transaction for atomic exploit patterns.
 */
async function analyzeTransaction(
  signature: string,
  mintAddress: string,
  heliusKey: string,
): Promise<AtomicExploitResult> {
  const empty: AtomicExploitResult = {
    available: false,
    is_atomic_exploit: false,
    instructions: [],
    simulationError: null,
    exploitDetails: "",
    signature,
  };

  // ── Fetch raw base64-encoded transaction for simulation ───────────────────
  const [rawTx, parsedTx] = await Promise.all([
    rpcCall<any>(heliusKey, "getTransaction", [
      signature,
      { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]),
    rpcCall<any>(heliusKey, "getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]),
  ]);

  const base64Tx = Array.isArray(rawTx?.transaction)
    ? (rawTx.transaction[0] as string)
    : null;

  if (!base64Tx) return empty;

  // ── Step 3: Simulate the transaction via RPC ──────────────────────────────
  const simResult = await rpcCall<any>(heliusKey, "simulateTransaction", [
    base64Tx,
    {
      encoding: "base64",
      commitment: "confirmed",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [] },
    },
  ]);

  const simValue = simResult?.value ?? simResult;
  const simulationError: string | null = simValue?.err
    ? (typeof simValue.err === "string" ? simValue.err : JSON.stringify(simValue.err))
    : null;

  // Extract simulation logs (even on simulated error, logs may contain instruction names)
  const simLogs: string[] = Array.isArray(simValue?.logs) ? simValue.logs : [];
  const logInstructionMap = parseSimulationLogs(simLogs);

  // Simulation inner instructions (contains programId + data at each CPI depth)
  const simInnerInstructions: Array<{
    index: number;
    instructions: Array<{ programIdIndex: number; data: string; accounts: number[] }>;
  }> = Array.isArray(simValue?.innerInstructions) ? simValue.innerInstructions : [];

  // ── Step 4: Build the instruction tree ────────────────────────────────────

  const instructions: SimulatedInstruction[] = [];

  // Account key lookup table from the parsed transaction
  const accountKeys: string[] =
    parsedTx?.transaction?.message?.accountKeys?.map((k: any) =>
      typeof k === "string" ? k : (k?.pubkey ?? ""),
    ) ?? [];

  // Top-level instructions from the parsed transaction
  const topLevelParsed: any[] =
    Array.isArray(parsedTx?.transaction?.message?.instructions)
      ? parsedTx.transaction.message.instructions
      : [];

  // Map from instruction index → inner instructions (parsed from parsedTx)
  const metaInnerInstructions: Map<number, any[]> = new Map();
  if (Array.isArray(parsedTx?.meta?.innerInstructions)) {
    for (const group of parsedTx.meta.innerInstructions) {
      if (Array.isArray(group?.instructions)) {
        metaInnerInstructions.set(Number(group.index), group.instructions);
      }
    }
  }

  // Process each top-level instruction
  topLevelParsed.forEach((ix: any, idx: number) => {
    const programId: string = ix?.programId ?? accountKeys[ix?.programIdIndex ?? -1] ?? "";
    if (!programId) return;

    const dataBase64: string | undefined = ix?.data;
    const logType = logInstructionMap.get(programId);

    const classified = classifyInstruction(programId, dataBase64, logType);
    instructions.push({ ...classified, depth: 0, isSuspicious: false });

    // Inner instructions (meta path — from parsed tx)
    const innerGroup = metaInnerInstructions.get(idx) ?? [];
    for (const innerIx of innerGroup) {
      const innerProgramId: string =
        innerIx?.programId ??
        accountKeys[innerIx?.programIdIndex ?? -1] ??
        "";
      if (!innerProgramId) continue;

      const innerData: string | undefined = innerIx?.data;
      const innerLogType = logInstructionMap.get(innerProgramId);
      const innerClassified = classifyInstruction(innerProgramId, innerData, innerLogType);
      instructions.push({ ...innerClassified, depth: 1, isSuspicious: false });
    }
  });

  // Also process simulation inner instructions (these capture CPIs at level 2+)
  const simAccountKeys: string[] =
    parsedTx?.transaction?.message?.accountKeys?.map((k: any) =>
      typeof k === "string" ? k : (k?.pubkey ?? ""),
    ) ?? [];

  for (const group of simInnerInstructions) {
    for (const innerIx of group.instructions) {
      const programId =
        simAccountKeys[innerIx?.programIdIndex ?? -1] ?? "";
      if (!programId) continue;

      // Only add if not already covered by the parsed meta path
      const alreadyCovered = instructions.some(
        (i) => i.programId === programId && i.depth >= 1,
      );
      if (alreadyCovered) continue;

      const classified = classifyInstruction(programId, innerIx?.data);
      instructions.push({ ...classified, depth: 2, isSuspicious: false });
    }
  }

  // Deduplicate entries with same programId + instructionType + depth
  const deduplicated = instructions.filter(
    (ix, idx, arr) =>
      arr.findIndex(
        (other) =>
          other.programId === ix.programId &&
          other.instructionType === ix.instructionType &&
          other.depth === ix.depth,
      ) === idx,
  );

  // ── Step 5: Detect Atomic Exploit ─────────────────────────────────────────

  const hasSwap = deduplicated.some((i) => i.isSwap);
  const authorizationInstructions = deduplicated.filter((i) => i.isAuthorizationRelated);
  const hasAuthorization = authorizationInstructions.length > 0;

  const is_atomic_exploit = hasSwap && hasAuthorization;

  // Mark suspicious instructions
  const finalInstructions: SimulatedInstruction[] = deduplicated.map((i) => ({
    ...i,
    isSuspicious: is_atomic_exploit && (i.isSwap || i.isAuthorizationRelated),
  }));

  // Build exploit details string
  let exploitDetails = "";
  if (is_atomic_exploit) {
    const authNames = authorizationInstructions.map((i) => i.instructionType).join(", ");
    exploitDetails =
      `🚨 CRITICAL: Non-Atomic/Multi-Instruction Execution detected. ` +
      `Transaction ${signature.slice(0, 8)}… bundles a Swap instruction with ` +
      `authorization-modifying instructions: [${authNames}]. ` +
      `This is a classic 'swap-and-backdoor' exploit pattern. ` +
      `Global risk score forced to 100 (Extreme Risk).`;
  } else if (hasAuthorization && !hasSwap) {
    exploitDetails =
      `Authority-modifying instructions detected (no swap): ` +
      authorizationInstructions.map((i) => i.instructionType).join(", ") + ".";
  } else if (deduplicated.length > 0) {
    const names = deduplicated
      .map((i) => `${i.programName}:${i.instructionType}`)
      .slice(0, 6)
      .join(" | ");
    exploitDetails = `Simulation clean. Instructions: ${names}.`;
  }

  return {
    available: true,
    is_atomic_exploit,
    instructions: finalInstructions,
    simulationError,
    exploitDetails,
    signature,
    detectedAt: is_atomic_exploit ? new Date().toISOString() : undefined,
  };
}
