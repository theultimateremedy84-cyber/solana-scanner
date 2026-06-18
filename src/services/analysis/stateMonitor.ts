/**
 * Phase 14 — 'State Hijacking' Detector
 * ---------------------------------------------------------------
 * Detects "State Hijacking" vulnerabilities where a Solana program
 * instruction interacts with a PDA (Program Derived Address) that
 * does NOT match the canonical derivation seeds published in the
 * program's IDL / seed-mapping registry.
 *
 * A malicious actor can pass an attacker-controlled account in
 * place of the legitimate PDA. If the on-chain program forgets to
 * verify the PDA derivation, every read/write hits the wrong state
 * account — letting the attacker drain vaults, escalate roles, or
 * mutate authorities they shouldn't control.
 *
 * Strategy
 *   1. For every top-level + inner instruction, look up the invoked
 *      programId in KNOWN_SEED_MAPPINGS.
 *   2. For each declared PDA account-slot, derive the EXPECTED PDA
 *      from the canonical seeds (e.g. ["vault", mint, bump]).
 *   3. Compare against the ACTUAL account address used in the
 *      instruction at that slot.
 *   4. On mismatch, flag is_state_hijacked = TRUE and record
 *      expectedAddress vs providedAddress.
 *
 * Pure JS implementation — no @solana/web3.js dependency. PDA
 * derivation uses the Solana spec: sha256(seed1 || seed2 || ... ||
 * bump || programIdBytes || "ProgramDerivedAddress") with the
 * curve-rejection rule (we accept either a known bump or scan 255→0).
 */

import { createHash } from "crypto";

// -----------------------------------------------------------------------
// base58 codec (Bitcoin alphabet — same as Solana)
// -----------------------------------------------------------------------
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

export function base58Decode(s: string): Uint8Array {
  if (!s) return new Uint8Array();
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP[s[i]];
    if (v === undefined) throw new Error(`base58: invalid char "${s[i]}"`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function base58Encode(buf: Uint8Array): string {
  if (buf.length === 0) return "";
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

// -----------------------------------------------------------------------
// Ed25519 curve rejection — a PDA must NOT lie on the curve.
// We use a minimal point-decode check: a 32-byte string lies on the
// edwards25519 curve iff decoding the y-coordinate yields a valid x.
// For our threat-model the cheap recovery used by @solana/web3.js is
// adequate; we re-implement it inline below.
// -----------------------------------------------------------------------
const P = (1n << 255n) - 19n;
const D =
  37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r;
}
function modInv(a: bigint, mod: bigint): bigint {
  return modPow(a, mod - 2n, mod);
}
function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  // little-endian y with sign bit in MSB
  const last = bytes[31];
  const yBytes = new Uint8Array(bytes);
  yBytes[31] = last & 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(yBytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  // x^2 = u / v
  const x2 = (u * modInv(v, P)) % P;
  // Tonelli-shanks check: x = x2^((P+3)/8) candidate
  const x = modPow(x2, (P + 3n) / 8n, P);
  const x2check = (x * x) % P;
  if (x2check === x2) return true;
  // try x * 2^((P-1)/4)
  const I = modPow(2n, (P - 1n) / 4n, P);
  const x2check2 = ((x * I) % P * ((x * I) % P)) % P;
  return x2check2 === x2;
}

// -----------------------------------------------------------------------
// PDA derivation (Solana spec).
// -----------------------------------------------------------------------
const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");

export type SeedLike = string | Uint8Array;

function seedToBytes(seed: SeedLike): Uint8Array {
  if (typeof seed === "string") {
    // Allow either UTF8 strings or base58 pubkey-strings.
    // Heuristic: if length 32–44 chars and looks like base58, decode.
    if (
      seed.length >= 32 &&
      seed.length <= 44 &&
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(seed)
    ) {
      try {
        const b = base58Decode(seed);
        if (b.length === 32) return b;
      } catch {
        /* fall through */
      }
    }
    return new Uint8Array(Buffer.from(seed, "utf8"));
  }
  return seed;
}

/**
 * Derive a PDA + bump for the given seeds against `programIdBase58`.
 * Returns null when no off-curve bump can be found (extremely rare).
 */
export function findProgramAddress(
  seeds: SeedLike[],
  programIdBase58: string,
): { address: string; bump: number } | null {
  const programIdBytes = base58Decode(programIdBase58);
  if (programIdBytes.length !== 32) {
    throw new Error(`Invalid programId: ${programIdBase58}`);
  }
  const seedChunks = seeds.map(seedToBytes);
  for (const s of seedChunks) {
    if (s.length > 32) throw new Error("PDA seed exceeds 32 bytes");
  }
  for (let bump = 255; bump >= 0; bump--) {
    const hasher = createHash("sha256");
    for (const s of seedChunks) hasher.update(s);
    hasher.update(Buffer.from([bump]));
    hasher.update(programIdBytes);
    hasher.update(PDA_MARKER);
    const candidate = new Uint8Array(hasher.digest());
    if (!isOnCurve(candidate)) {
      return { address: base58Encode(candidate), bump };
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// Known seed mappings — equivalent to a minimal in-house IDL registry.
//
// Each entry describes one PDA-bearing account slot in a program's
// instruction. `seeds` is a list of token-substitutions resolved
// against the instruction's account list / parameters at scan-time
// (e.g. `{ kind: "literal", value: "vault" }`,
// `{ kind: "account", at: 1 }` references account-index 1).
// -----------------------------------------------------------------------
export type SeedToken =
  | { kind: "literal"; value: string }
  | { kind: "account"; at: number };

export interface PdaAccountRule {
  /** The PDA account slot inside the instruction's account list. */
  at: number;
  /** Human label for UI (e.g. "vault", "user_position"). */
  label: string;
  /** Canonical seed recipe. Bump is auto-scanned. */
  seeds: SeedToken[];
}

export interface ProgramSeedMapping {
  programId: string;
  programName: string;
  accounts: PdaAccountRule[];
}

/**
 * Built-in seed map for well-known programs. Extend as more IDLs are
 * imported. The shapes below match the canonical Anchor IDLs.
 */
export const KNOWN_SEED_MAPPINGS: Record<string, ProgramSeedMapping> = {
  // Associated Token Account Program — ATA = PDA(owner, tokenProgram, mint).
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: {
    programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    programName: "Associated Token Account",
    accounts: [
      {
        at: 1, // associated-token-account
        label: "associated_token_account",
        seeds: [
          { kind: "account", at: 2 }, // wallet owner
          { kind: "literal", value: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { kind: "account", at: 3 }, // mint
        ],
      },
    ],
  },
  // Metaplex Token Metadata — metadata PDA = ["metadata", programId, mint].
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: {
    programId: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    programName: "Metaplex Token Metadata",
    accounts: [
      {
        at: 0,
        label: "metadata_account",
        seeds: [
          { kind: "literal", value: "metadata" },
          { kind: "literal", value: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" },
          { kind: "account", at: 1 }, // mint
        ],
      },
    ],
  },
};

// -----------------------------------------------------------------------
// Transaction-shape adapters (same shape used by cpiValidator.ts).
// -----------------------------------------------------------------------
export interface IxLike {
  programId?: string;
  programIdIndex?: number;
  accounts?: number[];
  accountIndices?: number[]; // tolerated alias
  accountsAddresses?: string[]; // tolerated alias (decoded)
}

export interface TxLike {
  transaction?: {
    message?: {
      instructions?: IxLike[];
      accountKeys?: Array<string | { pubkey?: string }>;
    };
  };
  meta?: {
    innerInstructions?: Array<{
      index: number;
      instructions?: IxLike[];
    }>;
  };
}

function normalizeAccountKeys(
  keys: Array<string | { pubkey?: string }> | undefined,
): string[] {
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => (typeof k === "string" ? k : (k?.pubkey ?? ""))).filter(Boolean);
}
function resolveProgramId(ins: IxLike, accountKeys: string[]): string | null {
  if (typeof ins.programId === "string" && ins.programId) return ins.programId;
  if (typeof ins.programIdIndex === "number" && accountKeys[ins.programIdIndex])
    return accountKeys[ins.programIdIndex];
  return null;
}
function resolveAccounts(ins: IxLike, accountKeys: string[]): string[] {
  if (Array.isArray(ins.accountsAddresses)) return ins.accountsAddresses;
  const idx = Array.isArray(ins.accounts)
    ? ins.accounts
    : Array.isArray(ins.accountIndices)
      ? ins.accountIndices
      : null;
  if (!idx) return [];
  return idx.map((i) => accountKeys[i]).filter(Boolean);
}

// -----------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------
export interface HijackedAccountFinding {
  programId: string;
  programName: string;
  /** Slot label e.g. "vault". */
  accountLabel: string;
  /** PDA derived from the canonical seeds — what SHOULD have been used. */
  expectedAddress: string;
  /** Address actually passed in the instruction — the hijacked account. */
  providedAddress: string;
  /** Source of the instruction. */
  source: "top" | "inner";
  outerIndex: number;
}

export interface StateMonitorResult {
  /** TRUE when at least one PDA slot did not match its canonical derivation. */
  is_state_hijacked: boolean;
  findings: HijackedAccountFinding[];
  /** Count of (programId, account-slot) pairs that WERE successfully verified. */
  verifiedPdas: number;
  /** Human-readable summary stored in state_hijack_details TEXT. */
  state_hijack_details: string;
}

function resolveSeeds(
  tokens: SeedToken[],
  ixAccounts: string[],
): SeedLike[] | null {
  const out: SeedLike[] = [];
  for (const t of tokens) {
    if (t.kind === "literal") out.push(t.value);
    else {
      const a = ixAccounts[t.at];
      if (!a) return null;
      out.push(a);
    }
  }
  return out;
}

export function analyzeStateIntegrity(
  tx: TxLike,
  mappings: Record<string, ProgramSeedMapping> = KNOWN_SEED_MAPPINGS,
): StateMonitorResult {
  const accountKeys = normalizeAccountKeys(tx.transaction?.message?.accountKeys);
  const findings: HijackedAccountFinding[] = [];
  let verifiedPdas = 0;

  const walk = (ins: IxLike, source: "top" | "inner", outerIndex: number) => {
    const programId = resolveProgramId(ins, accountKeys);
    if (!programId) return;
    const mapping = mappings[programId];
    if (!mapping) return;
    const ixAccounts = resolveAccounts(ins, accountKeys);
    if (ixAccounts.length === 0) return;
    for (const rule of mapping.accounts) {
      const provided = ixAccounts[rule.at];
      if (!provided) continue;
      const seeds = resolveSeeds(rule.seeds, ixAccounts);
      if (!seeds) continue;
      let derived: { address: string; bump: number } | null = null;
      try {
        derived = findProgramAddress(seeds, programId);
      } catch {
        continue;
      }
      if (!derived) continue;
      if (derived.address === provided) {
        verifiedPdas++;
      } else {
        findings.push({
          programId,
          programName: mapping.programName,
          accountLabel: rule.label,
          expectedAddress: derived.address,
          providedAddress: provided,
          source,
          outerIndex,
        });
      }
    }
  };

  for (const [i, ins] of (tx.transaction?.message?.instructions ?? []).entries()) {
    walk(ins, "top", i);
  }
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ins of group.instructions ?? []) {
      walk(ins, "inner", group.index ?? 0);
    }
  }

  const is_state_hijacked = findings.length > 0;
  const state_hijack_details = is_state_hijacked
    ? findings
        .map(
          (f) =>
            `${f.programName} ${f.accountLabel}: expected ${f.expectedAddress} but got ${f.providedAddress}`,
        )
        .join(" | ")
    : verifiedPdas > 0
      ? `All ${verifiedPdas} PDA derivation(s) verified against canonical seeds.`
      : "No mappable PDA-bearing instructions observed.";

  return { is_state_hijacked, findings, verifiedPdas, state_hijack_details };
}

/**
 * Batch helper — ANY hijacked transaction flips the flag.
 */
export function analyzeStateIntegrityBatch(
  txs: TxLike[],
  mappings: Record<string, ProgramSeedMapping> = KNOWN_SEED_MAPPINGS,
): StateMonitorResult {
  const merged: StateMonitorResult = {
    is_state_hijacked: false,
    findings: [],
    verifiedPdas: 0,
    state_hijack_details: "",
  };
  for (const tx of txs) {
    const r = analyzeStateIntegrity(tx, mappings);
    merged.findings.push(...r.findings);
    merged.verifiedPdas += r.verifiedPdas;
    if (r.is_state_hijacked) merged.is_state_hijacked = true;
  }
  merged.state_hijack_details = merged.is_state_hijacked
    ? merged.findings
        .map(
          (f) =>
            `${f.programName} ${f.accountLabel}: expected ${f.expectedAddress} but got ${f.providedAddress}`,
        )
        .join(" | ")
    : merged.verifiedPdas > 0
      ? `All ${merged.verifiedPdas} PDA derivation(s) verified across ${txs.length} tx.`
      : "No mappable PDA-bearing instructions observed.";
  return merged;
}
