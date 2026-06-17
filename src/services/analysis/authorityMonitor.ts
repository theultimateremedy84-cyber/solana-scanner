/**
 * Authority Monitor
 *
 * Fetches and classifies the three key authorities for a Solana SPL token:
 *   • Upgrade Authority   — Metaplex metadata update authority (controls name / symbol / URI)
 *   • Mint Authority      — controls supply inflation
 *   • Freeze Authority    — controls whether individual accounts can be frozen
 *
 * Each authority is classified as one of three tiers:
 *   "Immutable/Safe"     — null / burned; the field can never be changed
 *   "Medium Risk"        — address is a recognised multisig (SPL multisig, Squads, Realms)
 *   "Unsafe/Upgradeable" — address is a plain wallet; a single key-holder can act unilaterally
 *
 * The overall classification is the worst tier across all three authorities.
 *
 * Integration note (scan-core.ts):
 *   When overallClassification === "Unsafe/Upgradeable", scan-core enforces a minimum
 *   globalRiskScore of 20 (MEDIUM risk level), preventing a LOW rating for upgradeable tokens.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthorityClassification =
  | "Immutable/Safe"
  | "Medium Risk"
  | "Unsafe/Upgradeable";

export interface AuthorityDetail {
  /** The on-chain authority address, or null when burned / revoked. */
  address: string | null;
  /** Risk tier assigned to this authority. */
  classification: AuthorityClassification;
  /** True when the address was positively identified as a multisig account. */
  isMultisig: boolean;
  /** Human-readable explanation surfaced in the UI. */
  reason: string;
}

export interface AuthorityMonitorResult {
  /** False when all RPC calls failed; individual fields default to Unsafe/Upgradeable in that case. */
  available: boolean;
  /** Metaplex metadata update authority — controls token name, symbol, image URI. */
  upgradeAuthority: AuthorityDetail;
  /** SPL mint authority — can inflate total supply at will. */
  mintAuthority: AuthorityDetail;
  /** SPL freeze authority — can freeze any token account, blocking sells. */
  freezeAuthority: AuthorityDetail;
  /** Worst classification across all three authorities. */
  overallClassification: AuthorityClassification;
  /**
   * Set to true by scan-core after computing globalRiskScore when the
   * upgradeable floor (≥ 20) was triggered.
   */
  upgradeableRiskFloorApplied: boolean;
}

// ---------------------------------------------------------------------------
// On-chain program constants
// ---------------------------------------------------------------------------

/** SPL Token Program (classic) — owns standard mint / multisig accounts. */
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * SPL Multisig account data length (bytes).
 * Layout: 1 (m) + 1 (n) + 1 (is_initialized) + 11 × 32 (signers) = 355
 */
const SPL_MULTISIG_SIZE = 355;

/** Squads Protocol v3 program — common on-chain multisig for teams. */
const SQUADS_V3_PROGRAM = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu5";

/** Squads Protocol v4 (Multisig) program. */
const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/** SPL Governance (Realms) program — DAO / council-gated authorities. */
const REALMS_GOVERNANCE = "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw";

/** Set of program IDs whose owned accounts we treat as multisig by definition. */
const KNOWN_MULTISIG_OWNERS = new Set([
  SQUADS_V3_PROGRAM,
  SQUADS_V4_PROGRAM,
  REALMS_GOVERNANCE,
]);

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

async function fetchAccountInfo(
  address: string,
  rpcUrl: string,
): Promise<{ owner: string; dataSize: number } | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64" }],
      }),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const value = json?.result?.value;
    if (!value) return null;

    const owner: string = value.owner ?? "";
    const dataB64: string = Array.isArray(value.data)
      ? (value.data[0] ?? "")
      : typeof value.data === "string"
        ? value.data
        : "";
    const dataSize = Buffer.from(dataB64, "base64").length;
    return { owner, dataSize };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

async function classifyAddress(
  address: string | null,
  role: string,
  rpcUrl: string,
): Promise<AuthorityDetail> {
  // Null / empty → burned / revoked
  if (!address) {
    return {
      address: null,
      classification: "Immutable/Safe",
      isMultisig: false,
      reason: `${role} is burned / revoked — this field is permanently locked.`,
    };
  }

  const info = await fetchAccountInfo(address, rpcUrl);

  if (!info) {
    // RPC unavailable — conservatively treat as wallet to avoid false positives
    return {
      address,
      classification: "Unsafe/Upgradeable",
      isMultisig: false,
      reason:
        `${role} is set (${address.slice(0, 8)}…) but account info was unreachable — ` +
        "treating as single-wallet authority.",
    };
  }

  const { owner, dataSize } = info;

  // SPL Token multisig: owned by Token Program AND exactly 355 bytes
  const isSplMultisig =
    owner === SPL_TOKEN_PROGRAM && dataSize === SPL_MULTISIG_SIZE;

  // Squads / Realms: any account owned by a known governance program
  const isGovernanceMultisig = KNOWN_MULTISIG_OWNERS.has(owner);

  const isMultisig = isSplMultisig || isGovernanceMultisig;

  if (isMultisig) {
    const label = isSplMultisig
      ? "SPL multisig"
      : SQUADS_V3_PROGRAM === owner || SQUADS_V4_PROGRAM === owner
        ? "Squads multisig"
        : "Realms / governance multisig";
    return {
      address,
      classification: "Medium Risk",
      isMultisig: true,
      reason:
        `${role} is controlled by a ${label} (${address.slice(0, 8)}…) — ` +
        "any change requires M-of-N signers.",
    };
  }

  // Everything else is a plain wallet or an unrecognised program
  return {
    address,
    classification: "Unsafe/Upgradeable",
    isMultisig: false,
    reason:
      `${role} is held by a single wallet (${address.slice(0, 8)}…) — ` +
      "the holder can modify this field unilaterally.",
  };
}

function worstOf(
  a: AuthorityClassification,
  b: AuthorityClassification,
): AuthorityClassification {
  const rank: Record<AuthorityClassification, number> = {
    "Immutable/Safe": 0,
    "Medium Risk": 1,
    "Unsafe/Upgradeable": 2,
  };
  return rank[a] >= rank[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run authority monitor checks for a Solana SPL token.
 *
 * All three getAccountInfo calls are issued in parallel; the function
 * degrades gracefully when RPC is unavailable (each field defaults to
 * "Unsafe/Upgradeable" to ensure conservative risk scoring).
 *
 * @param mintAuthorityAddress    Raw mintAuthority field (null = revoked)
 * @param freezeAuthorityAddress  Raw freezeAuthority field (null = revoked)
 * @param upgradeAuthorityAddress Metaplex metadata update authority (null = immutable)
 * @param rpcUrl                  Solana JSON-RPC endpoint for getAccountInfo
 */
export async function runAuthorityMonitor(params: {
  mintAuthorityAddress: string | null;
  freezeAuthorityAddress: string | null;
  upgradeAuthorityAddress: string | null;
  rpcUrl: string;
}): Promise<AuthorityMonitorResult> {
  const {
    mintAuthorityAddress,
    freezeAuthorityAddress,
    upgradeAuthorityAddress,
    rpcUrl,
  } = params;

  const [upgradeAuthority, mintAuthority, freezeAuthority] = await Promise.all([
    classifyAddress(upgradeAuthorityAddress, "Upgrade / metadata authority", rpcUrl),
    classifyAddress(mintAuthorityAddress, "Mint authority", rpcUrl),
    classifyAddress(freezeAuthorityAddress, "Freeze authority", rpcUrl),
  ]);

  const overallClassification = [
    upgradeAuthority,
    mintAuthority,
    freezeAuthority,
  ].reduce(
    (worst, auth) => worstOf(worst, auth.classification),
    "Immutable/Safe" as AuthorityClassification,
  );

  return {
    available: true,
    upgradeAuthority,
    mintAuthority,
    freezeAuthority,
    overallClassification,
    // upgradeableRiskFloorApplied is set by scan-core after score synthesis
    upgradeableRiskFloorApplied: false,
  };
}
