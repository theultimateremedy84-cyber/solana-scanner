/**
 * postLaunchWatcher.ts
 *
 * Real-time post-launch authority transition monitor for Solana SPL tokens.
 *
 * Connects to the Helius WebSocket endpoint and subscribes to logs mentioning
 * the SPL Token Program. When a SetAuthority instruction is detected for a
 * tracked mint — specifically authority types MintTokens (0) or FreezeAccount (1)
 * — it fires an Immediate Red Alert and updates the Supabase scan_history table
 * to set is_authority_transitioned = true.
 *
 * Usage (server-side singleton, e.g. called from your server entry point):
 *
 *   import { PostLaunchWatcher } from "@/lib/postLaunchWatcher";
 *   const watcher = PostLaunchWatcher.getInstance();
 *   watcher.start();
 *
 * IMPORTANT — Supabase schema prerequisite:
 *   ALTER TABLE scan_history ADD COLUMN IF NOT EXISTS
 *     is_authority_transitioned BOOLEAN NOT NULL DEFAULT FALSE;
 *
 *   Run this once against your Supabase project before deploying.
 *
 * Environment variables required:
 *   HELIUS_API_KEY   — your Helius API key (server-only, never VITE_ prefixed)
 *   SUPABASE_URL     — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (bypasses RLS for server writes)
 */

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SPL Token Program (classic) — owns mint / freeze authority fields. */
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** SPL Token-2022 program — also tracked when checking account ownership. */
const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Native System Program — owner of all account allocation / reallocation. */
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/**
 * SetAuthority instruction discriminant in the SPL Token program.
 * Layout: [6, authority_type (u8), option<new_authority> (1 + 32 bytes)]
 */
const SET_AUTHORITY_DISCRIMINANT = 6;

/**
 * SystemProgram instruction discriminants that change an account's data
 * length (i.e. its on-chain storage size). Detecting any of these on an
 * account owned by a tracked token program is treated as a Critical Red
 * Alert (Unauthorized Account Data Modification).
 *
 *   8  = Allocate              — sets data length for an existing account
 *   9  = AllocateWithSeed      — same, for a PDA-derived account
 *
 * NOTE: Solana also exposes account resizing via the in-program
 * `AccountInfo::realloc` syscall (often invoked through CPI). That path
 * does not surface a SystemInstruction in the parsed instructions list —
 * instead it shows up as a data-length delta between pre/post account
 * states. We capture both paths in extractAccountResizes() below.
 */
const SYSTEM_INSTRUCTION_ALLOCATE = 8;
const SYSTEM_INSTRUCTION_ALLOCATE_WITH_SEED = 9;

/**
 * Authority type bytes inside the SetAuthority instruction.
 *   0 = MintTokens   — controls unlimited supply inflation
 *   1 = FreezeAccount — controls per-account freeze ability
 */
const AUTHORITY_TYPE_MINT_TOKENS = 0;
const AUTHORITY_TYPE_FREEZE_ACCOUNT = 1;

/** Token Metadata Program — owns on-chain metadata accounts for SPL tokens. */
const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/**
 * When update_authority equals this address (SystemProgram) the metadata is
 * permanently revoked — treat the token as "Immutable / Burned".
 */
const METADATA_BURN_ADDRESS = "11111111111111111111111111111111";

/**
 * Log fragment strings that indicate a Token Metadata Program instruction
 * that modifies on-chain metadata (name, symbol, URI, or update authority).
 * Used as a fast pre-filter before fetching the full transaction.
 */
const METADATA_UPDATE_LOG_FRAGMENTS = [
  "UpdateMetadataAccount",
  "UpdateV1",
  "SetAndVerifyCollection",
  "UpdateAsUpdateAuthorityV2",
] as const;

/** How long (ms) to wait before reconnecting after a WebSocket close. */
const RECONNECT_DELAY_MS = 5_000;

/**
 * Maximum reconnect attempts before giving up.
 * FIX: raised from 20 to effectively unlimited (Number.MAX_SAFE_INTEGER).
 * A Railway service with intermittent Helius connectivity was hitting this cap
 * after ~20 disconnects (100 seconds of cumulative downtime at 5s base delay)
 * and permanently stopping the watcher for the lifetime of the process.
 * The watcher should retry forever — Railway's restart policy handles true
 * unrecoverable failures at the process level.
 */
const MAX_RECONNECT_ATTEMPTS = Number.MAX_SAFE_INTEGER;

/** How often to send a keepalive ping (ms). */
const HEARTBEAT_INTERVAL_MS  = 30_000;
/** How long to wait for a pong before force-recycling the socket (ms). */
const HEARTBEAT_TIMEOUT_MS   = 20_000;
/** Hard cap on simultaneous per-mint logsSubscribe slots. */
const MAX_MINT_SUBSCRIPTIONS = 500;

/** Solana RPC polling interval (ms) when fetching full transaction after alert. */
const TX_FETCH_TIMEOUT_MS = 10_000;


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthorityType = "MintTokens" | "FreezeAccount";

export interface AuthorityTransitionAlert {
  /** Mint address of the affected token. */
  mintAddress: string;
  /** Transaction signature where the SetAuthority was detected. */
  signature: string;
  /** Which authority was transferred. */
  authorityType: AuthorityType;
  /** The new authority address (null = authority was revoked). */
  newAuthority: string | null;
  /** Unix epoch ms when the alert was generated. */
  detectedAt: number;
}

/** Callback invoked whenever an authority transition is detected. */
export type AlertCallback = (alert: AuthorityTransitionAlert) => void;

// ---------------------------------------------------------------------------
// Account-Data-Modification (Reallocate) alert
// ---------------------------------------------------------------------------

export interface AccountResizeAlert {
  /** Account whose data length was modified. */
  account: string;
  /** Program that owns the resized account (usually an SPL Token program). */
  ownerProgram: string;
  /** Mint address (when the account is an SPL token account / mint). */
  mintAddress: string | null;
  /** Old data length (bytes) — null when not derivable from RPC response. */
  oldLength: number | null;
  /** New data length (bytes). */
  newLength: number;
  /** Detection source: a SystemProgram Allocate ix, or a pre/post length delta. */
  source: "system_allocate" | "system_allocate_with_seed" | "realloc_syscall";
  /** Transaction signature where the modification happened. */
  signature: string;
  /** Unix epoch ms when the alert was generated. */
  detectedAt: number;
}

export type ResizeAlertCallback = (alert: AccountResizeAlert) => void;

// ---------------------------------------------------------------------------
// Metadata Hijack alert
// ---------------------------------------------------------------------------

/**
 * Fired when PostLaunchWatcher detects a Token Metadata Program instruction
 * (UpdateMetadataAccount, UpdateV1, SetAndVerifyCollection, etc.) on a tracked
 * mint after its initial launch. This signals a potential name / symbol / image
 * hijack or rug-pull via metadata spoofing.
 */
export interface MetadataHijackAlert {
  /** Mint address of the affected token. */
  mintAddress: string;
  /** Transaction signature where the UpdateMetadata instruction was detected. */
  signature: string;
  /**
   * Instruction type string derived from the transaction logs
   * (e.g. "UpdateMetadataAccount", "UpdateV1", "SetAndVerifyCollection").
   */
  instructionType: string;
  /** Unix epoch ms when the alert was generated. */
  detectedAt: number;
}

export type MetadataHijackAlertCallback = (alert: MetadataHijackAlert) => void;

// ---------------------------------------------------------------------------
// CPI Depth / Transaction Bloat & Re-routing alert
// ---------------------------------------------------------------------------

/**
 * Fired when the PostLaunchWatcher / transaction processor finds a tx whose
 * Cross-Program-Invocation (CPI) nesting depth is >= 3. Deep CPI nesting is
 * a strong signal that a transaction is being deliberately bloated to hide
 * malicious logic ("Programmable Rugs") — standard scanners often time out
 * or return Unknown on such transactions.
 *
 *   depth >= 3 → is_path_obfuscated = TRUE, "warn" severity.
 *   depth >= 4 → 'Extreme Obfuscation', 'Critical Risk' alert.
 */
export interface PathObfuscationAlert {
  mintAddress: string;
  signature: string;
  /** Max CPI nesting depth observed in the transaction. */
  cpiDepth: number;
  /** True when depth >= 4 (Solana protocol maximum). */
  extreme: boolean;
  detectedAt: number;
}

export type PathObfuscationAlertCallback = (alert: PathObfuscationAlert) => void;

/**
 * Calculate the maximum Cross-Program-Invocation (CPI) nesting depth of a
 * Solana transaction from its `meta.innerInstructions` array.
 *
 * The Solana JSON RPC populates `stackHeight` on each inner instruction
 * (stackHeight = 1 for top-level ix, 2 for the first CPI, etc.). We treat
 * the maximum observed stackHeight as the depth. When `stackHeight` is
 * absent (older RPC responses), we fall back to counting nested groups.
 *
 * Returns 1 for a tx with no CPIs, 0 for a malformed / missing meta.
 *
 * Usage:
 *   const depth = calculateCPIDepth(tx.meta);
 *   if (depth >= 3) { ... flag is_path_obfuscated = true ... }
 *   if (depth >= 4) { ... 'Extreme Obfuscation' Critical Risk alert ... }
 */
export function calculateCPIDepth(transactionMetadata: any): number {
  if (!transactionMetadata) return 0;
  const innerGroups: any[] = Array.isArray(transactionMetadata.innerInstructions)
    ? transactionMetadata.innerInstructions
    : [];
  if (innerGroups.length === 0) return 1; // no CPIs at all

  let maxStackHeight = 1;
  let sawStackHeight = false;
  for (const group of innerGroups) {
    const ixs: any[] = Array.isArray(group?.instructions) ? group.instructions : [];
    for (const ix of ixs) {
      const sh = Number(ix?.stackHeight);
      if (Number.isFinite(sh) && sh > 0) {
        sawStackHeight = true;
        if (sh > maxStackHeight) maxStackHeight = sh;
      }
    }
  }
  if (sawStackHeight) return maxStackHeight;

  // Fallback: no stackHeight reported — approximate depth from the number of
  // distinct inner-instruction groups + 1 top-level layer. Cap at protocol max 4.
  return Math.min(4, 1 + innerGroups.length);
}

/**
 * Given a fetched transaction, return a PathObfuscationAlert when its CPI
 * nesting depth is >= 3 and it touches one of the trackedMints. Returns null
 * otherwise.
 */
function extractPathObfuscation(
  tx: any,
  signature: string,
  trackedMints: Set<string>,
): PathObfuscationAlert | null {
  if (!tx?.meta) return null;
  const depth = calculateCPIDepth(tx.meta);
  if (depth < 3) return null;

  const accountKeys: any[] = Array.isArray(tx?.transaction?.message?.accountKeys)
    ? tx.transaction.message.accountKeys
    : [];
  let touchedMint: string | null = null;
  for (const a of accountKeys) {
    const pubkey: string | undefined = typeof a === "string" ? a : a?.pubkey;
    if (pubkey && trackedMints.has(pubkey)) {
      touchedMint = pubkey;
      break;
    }
  }
  if (!touchedMint) return null;

  return {
    mintAddress: touchedMint,
    signature,
    cpiDepth: depth,
    extreme: depth >= 4,
    detectedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Supabase server client (service-role — bypasses RLS for server writes)
// ---------------------------------------------------------------------------



function buildSupabaseServerClient() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_ANON_KEY ??
    "";

  if (!url || !key) {
    console.warn(
      "[PostLaunchWatcher] Supabase credentials not found — DB updates will be skipped.",
    );
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Helius RPC helpers (server-side fetch)
// ---------------------------------------------------------------------------

async function heliusRpc<T = unknown>(
  apiKey: string,
  method: string,
  params: unknown[],
): Promise<T | null> {
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(TX_FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: T };
    return json?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch and parse a transaction to extract any SetAuthority instructions
 * that target the SPL Token Program on a tracked mint.
 *
 * Returns an array of alert objects (one per qualifying instruction found).
 */
async function extractAuthorityTransitions(
  signature: string,
  trackedMints: Set<string>,
  apiKey: string,
): Promise<AuthorityTransitionAlert[]> {
  const tx = await heliusRpc<any>(apiKey, "getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);

  if (!tx) return [];

  const alerts: AuthorityTransitionAlert[] = [];
  const instructions: any[] = [
    ...(tx?.transaction?.message?.instructions ?? []),
    ...(tx?.meta?.innerInstructions?.flatMap((ii: any) => ii.instructions ?? []) ?? []),
  ];

  for (const ix of instructions) {
    // jsonParsed form — Solana RPC fully parsed the instruction
    if (
      ix?.program === "spl-token" &&
      ix?.parsed?.type === "setAuthority"
    ) {
      const info = ix.parsed?.info ?? {};
      const mintAddress: string = info.mint ?? info.account ?? "";
      if (!mintAddress || !trackedMints.has(mintAddress)) continue;

      const authorityTypeStr: string = info.authorityType ?? "";
      let authorityType: AuthorityType | null = null;
      if (authorityTypeStr === "mintTokens") authorityType = "MintTokens";
      else if (authorityTypeStr === "freezeAccount") authorityType = "FreezeAccount";
      if (!authorityType) continue;

      alerts.push({
        mintAddress,
        signature,
        authorityType,
        newAuthority: info.newAuthority ?? null,
        detectedAt: Date.now(),
      });
      continue;
    }

    // Raw / base58-encoded form — parse instruction data manually
    if (
      ix?.programId === SPL_TOKEN_PROGRAM_ID &&
      typeof ix?.data === "string"
    ) {
      const rawBytes = base58Decode(ix.data);
      if (!rawBytes || rawBytes.length < 2) continue;
      if (rawBytes[0] !== SET_AUTHORITY_DISCRIMINANT) continue;

      const authorityTypeByte = rawBytes[1];
      if (
        authorityTypeByte !== AUTHORITY_TYPE_MINT_TOKENS &&
        authorityTypeByte !== AUTHORITY_TYPE_FREEZE_ACCOUNT
      )
        continue;

      // Account at index 0 of the instruction's accounts is the mint/account
      const accounts: string[] = Array.isArray(ix.accounts) ? ix.accounts : [];
      const mintAddress = accounts[0] ?? "";
      if (!mintAddress || !trackedMints.has(mintAddress)) continue;

      // New authority: option flag at byte 2; if 1, next 32 bytes are the pubkey
      let newAuthority: string | null = null;
      if (rawBytes.length >= 35 && rawBytes[2] === 1) {
        newAuthority = base58Encode(rawBytes.slice(3, 35));
      }

      const authorityType: AuthorityType =
        authorityTypeByte === AUTHORITY_TYPE_MINT_TOKENS
          ? "MintTokens"
          : "FreezeAccount";

      alerts.push({
        mintAddress,
        signature,
        authorityType,
        newAuthority,
        detectedAt: Date.now(),
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Account-Data-Modification (Reallocate) extraction
// ---------------------------------------------------------------------------

/**
 * Returns true when `programId` is one of the SPL Token programs we track.
 * Any account whose `owner` matches this set is considered a tracked-token
 * account, and a resize of it triggers a Critical Red Alert.
 */
function isTrackedTokenProgram(programId: string | undefined | null): boolean {
  return (
    programId === SPL_TOKEN_PROGRAM_ID ||
    programId === SPL_TOKEN_2022_PROGRAM_ID
  );
}

/**
 * Best-effort mint resolver for a token account / mint account.
 * Uses jsonParsed accountKeys metadata when present.
 */
function resolveMintFromAccount(
  account: string,
  trackedMints: Set<string>,
  parsedAccounts: any[],
): string | null {
  if (trackedMints.has(account)) return account; // the account IS a tracked mint
  for (const a of parsedAccounts) {
    if (a?.pubkey === account && a?.parsed?.info?.mint) {
      const m = a.parsed.info.mint as string;
      if (trackedMints.has(m)) return m;
    }
  }
  return null;
}

/**
 * Scan a transaction for ANY instruction that mutates an account's data
 * length, where that account is owned by a tracked-token program.
 *
 * Two detection paths:
 *   1. SystemProgram `Allocate` / `AllocateWithSeed` instructions
 *      (parsed.type === "allocate" / "allocateWithSeed"), found in both
 *      the top-level `message.instructions` and every `innerInstructions`
 *      group (where CPI-issued resizes appear).
 *   2. Direct pre/post account-data-length deltas: when the parsed account
 *      list reports `data.parsed.info.dataLength` (or raw `data` length)
 *      differing between pre and post snapshots, that is a `realloc`
 *      syscall path used by upgradeable programs to inject new logic
 *      into already-deployed contracts.
 */
async function extractAccountResizes(
  signature: string,
  trackedMints: Set<string>,
  apiKey: string,
): Promise<AccountResizeAlert[]> {
  const tx = await heliusRpc<any>(apiKey, "getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (!tx) return [];

  const alerts: AccountResizeAlert[] = [];
  const accountKeys: any[] = Array.isArray(tx?.transaction?.message?.accountKeys)
    ? tx.transaction.message.accountKeys
    : [];

  // Build a quick lookup of account -> owner program from jsonParsed metadata.
  const accountOwners = new Map<string, string>();
  for (const a of accountKeys) {
    const pubkey: string | undefined = a?.pubkey;
    const owner: string | undefined = a?.parsed?.info?.owner ?? a?.owner;
    if (pubkey && owner) accountOwners.set(pubkey, owner);
  }

  const allInstructions: any[] = [
    ...(tx?.transaction?.message?.instructions ?? []),
    ...(tx?.meta?.innerInstructions?.flatMap(
      (ii: any) => ii.instructions ?? [],
    ) ?? []),
  ];

  for (const ix of allInstructions) {
    // -------- jsonParsed SystemProgram allocate / allocateWithSeed --------
    if (
      ix?.program === "system" &&
      (ix?.parsed?.type === "allocate" ||
        ix?.parsed?.type === "allocateWithSeed")
    ) {
      const info = ix.parsed?.info ?? {};
      const account: string = info.account ?? info.newAccount ?? "";
      const newLength: number = Number(info.space ?? 0);
      if (!account || !newLength) continue;

      const owner = accountOwners.get(account) ?? "";
      if (!isTrackedTokenProgram(owner)) continue;

      alerts.push({
        account,
        ownerProgram: owner,
        mintAddress: resolveMintFromAccount(account, trackedMints, accountKeys),
        oldLength: null, // SystemProgram allocate has no "old" value exposed
        newLength,
        source:
          ix.parsed.type === "allocateWithSeed"
            ? "system_allocate_with_seed"
            : "system_allocate",
        signature,
        detectedAt: Date.now(),
      });
      continue;
    }

    // -------- Raw SystemProgram instruction (base58 data) --------
    if (
      ix?.programId === SYSTEM_PROGRAM_ID &&
      typeof ix?.data === "string"
    ) {
      const rawBytes = base58Decode(ix.data);
      if (!rawBytes || rawBytes.length < 4) continue;
      // First 4 bytes = little-endian u32 instruction discriminant.
      const disc =
        rawBytes[0] |
        (rawBytes[1] << 8) |
        (rawBytes[2] << 16) |
        (rawBytes[3] << 24);
      if (
        disc !== SYSTEM_INSTRUCTION_ALLOCATE &&
        disc !== SYSTEM_INSTRUCTION_ALLOCATE_WITH_SEED
      )
        continue;

      const accounts: string[] = Array.isArray(ix.accounts) ? ix.accounts : [];
      const account = accounts[0] ?? "";
      if (!account) continue;
      const owner = accountOwners.get(account) ?? "";
      if (!isTrackedTokenProgram(owner)) continue;

      // For Allocate: bytes[4..12] = u64 LE space.
      let newLength = 0;
      if (rawBytes.length >= 12) {
        const lo =
          rawBytes[4] |
          (rawBytes[5] << 8) |
          (rawBytes[6] << 16) |
          (rawBytes[7] << 24);
        const hi =
          rawBytes[8] |
          (rawBytes[9] << 8) |
          (rawBytes[10] << 16) |
          (rawBytes[11] << 24);
        newLength = lo + hi * 0x1_0000_0000;
      }

      alerts.push({
        account,
        ownerProgram: owner,
        mintAddress: resolveMintFromAccount(account, trackedMints, accountKeys),
        oldLength: null,
        newLength,
        source:
          disc === SYSTEM_INSTRUCTION_ALLOCATE_WITH_SEED
            ? "system_allocate_with_seed"
            : "system_allocate",
        signature,
        detectedAt: Date.now(),
      });
    }
  }

  // -------- pre/post realloc syscall detection ----------------------------
  // Helius/Solana RPC exposes per-account pre/post state when available.
  // When data length changed and the account is owned by a tracked token
  // program, treat as a realloc-syscall resize even if no SystemInstruction
  // appears (this is the CPI / in-program realloc() path).
  const preAccounts: any[] = Array.isArray(tx?.meta?.preAccountInfos)
    ? tx.meta.preAccountInfos
    : [];
  const postAccounts: any[] = Array.isArray(tx?.meta?.postAccountInfos)
    ? tx.meta.postAccountInfos
    : [];
  for (let i = 0; i < postAccounts.length; i++) {
    const post = postAccounts[i];
    const pre = preAccounts[i];
    if (!post || !pre) continue;
    const owner: string = post.owner ?? "";
    if (!isTrackedTokenProgram(owner)) continue;
    const oldLen: number = Array.isArray(pre.data)
      ? Number(pre.data[2] ?? 0)
      : Number(pre.dataLength ?? 0);
    const newLen: number = Array.isArray(post.data)
      ? Number(post.data[2] ?? 0)
      : Number(post.dataLength ?? 0);
    if (!oldLen && !newLen) continue;
    if (oldLen === newLen) continue;
    const account: string = post.pubkey ?? accountKeys[i]?.pubkey ?? "";
    if (!account) continue;
    alerts.push({
      account,
      ownerProgram: owner,
      mintAddress: resolveMintFromAccount(account, trackedMints, accountKeys),
      oldLength: oldLen,
      newLength: newLen,
      source: "realloc_syscall",
      signature,
      detectedAt: Date.now(),
    });
  }

  return alerts;
}



// ---------------------------------------------------------------------------
// Metadata Hijack extraction
// ---------------------------------------------------------------------------

/**
 * Scan a transaction for Token Metadata Program instructions that modify
 * on-chain metadata on a tracked mint (UpdateMetadataAccount, UpdateV1,
 * SetAndVerifyCollection, or UpdateAsUpdateAuthorityV2).
 *
 * Strategy:
 *   1. Fetch the full transaction (jsonParsed).
 *   2. Walk every top-level and inner instruction.
 *   3. For any instruction whose programId === TOKEN_METADATA_PROGRAM_ID,
 *      check if any of its accounts matches a tracked mint directly.
 *      (UpdateV1 always places the mint at accounts[1]; older variants may
 *      not include it explicitly — in that case all accounts are checked.)
 *   4. Return one MetadataHijackAlert per qualifying instruction.
 */
async function extractMetadataHijacks(
  signature: string,
  trackedMints: Set<string>,
  apiKey: string,
): Promise<MetadataHijackAlert[]> {
  const tx = await heliusRpc<any>(apiKey, "getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (!tx) return [];

  const alerts: MetadataHijackAlert[] = [];

  const logMessages: string[] = Array.isArray(tx?.meta?.logMessages)
    ? tx.meta.logMessages
    : [];

  // Identify instruction type from logs (use first matching fragment).
  let instructionType = "UpdateMetadataAccount";
  for (const frag of METADATA_UPDATE_LOG_FRAGMENTS) {
    if (logMessages.some((l: string) => l.includes(frag))) {
      instructionType = frag;
      break;
    }
  }

  const allInstructions: any[] = [
    ...(tx?.transaction?.message?.instructions ?? []),
    ...(tx?.meta?.innerInstructions?.flatMap(
      (ii: any) => ii.instructions ?? [],
    ) ?? []),
  ];

  for (const ix of allInstructions) {
    // programId may come from raw encoding; jsonParsed uses ix.program
    const programId: string =
      (ix?.programId as string | undefined) ??
      (ix?.program === "token-metadata" ? TOKEN_METADATA_PROGRAM_ID : "");

    if (programId !== TOKEN_METADATA_PROGRAM_ID) continue;

    const accounts: string[] = Array.isArray(ix.accounts) ? ix.accounts : [];

    // Check all accounts against tracked mints — at most one alert per ix.
    for (const account of accounts) {
      if (trackedMints.has(account)) {
        alerts.push({
          mintAddress: account,
          signature,
          instructionType,
          detectedAt: Date.now(),
        });
        break;
      }
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Minimal base58 helpers (no external dependency)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Uint8Array(256).fill(255);
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET.charCodeAt(i)] = i;
}

function base58Decode(str: string): Uint8Array | null {
  try {
    const bytes: number[] = [];
    for (const char of str) {
      const val = BASE58_MAP[char.charCodeAt(0)];
      if (val === 255) return null;
      let carry = val;
      for (let i = 0; i < bytes.length; i++) {
        carry += bytes[i] * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (const char of str) {
      if (char !== "1") break;
      bytes.push(0);
    }
    return new Uint8Array(bytes.reverse());
  } catch {
    return null;
  }
}

function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += "1";
  for (let i = digits.length - 1; i >= 0; i--)
    result += BASE58_ALPHABET[digits[i]];
  return result;
}

// ---------------------------------------------------------------------------
// PostLaunchWatcher — singleton WebSocket monitor
// ---------------------------------------------------------------------------

export class PostLaunchWatcher {
  private static instance: PostLaunchWatcher | null = null;

  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private alertCallbacks: AlertCallback[] = [];
  private resizeAlertCallbacks: ResizeAlertCallback[] = [];
  private metadataHijackCallbacks: MetadataHijackAlertCallback[] = [];
  private pathObfuscationCallbacks: PathObfuscationAlertCallback[] = [];

  // ── Per-mint subscription state ─────────────────────────────────────────────
  /**
   * One entry per tracked mint.
   * subId === null means the logsSubscribe request is in-flight or not yet sent.
   */
  private mintSubscriptions: Map<string, { subId: number | null; subscribedAt: number }> = new Map();

  /** Reverse lookup: confirmed subscription ID → mint address. */
  private subIdToMint: Map<number, string> = new Map();

  /** Correlates in-flight subscribe responses to their mint address. */
  private pendingSubRequests: Map<number, string> = new Map();

  /** Correlates in-flight unsubscribe responses to the subId being cancelled. */
  private pendingUnsubRequests: Map<number, number> = new Map();

  /** Monotonically-increasing JSON-RPC request ID counter (starts above legacy IDs). */
  private idCounter = 100;

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  /** setInterval handle for the 30-second keepalive ping. */
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  /** setTimeout handle for the 20-second pong timeout. */
  private heartbeatPending: ReturnType<typeof setTimeout> | null = null;

  /** Interval handle for periodic mint-list refresh. */
  private refreshIntervalHandle: ReturnType<typeof setInterval> | null = null;

  private readonly apiKey: string;
  private readonly supabase: ReturnType<typeof buildSupabaseServerClient>;

  private constructor() {
    this.apiKey = process.env.HELIUS_API_KEY ?? "";
    this.supabase = buildSupabaseServerClient();
  }

  /** Return (or lazily create) the singleton watcher. */
  static getInstance(): PostLaunchWatcher {
    if (!PostLaunchWatcher.instance) {
      PostLaunchWatcher.instance = new PostLaunchWatcher();
    }
    return PostLaunchWatcher.instance;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Register a callback that fires on every Immediate Red Alert. */
  onAlert(cb: AlertCallback): void {
    this.alertCallbacks.push(cb);
  }

  /** Register a callback that fires on every Account-Resize Critical Alert. */
  onResizeAlert(cb: ResizeAlertCallback): void {
    this.resizeAlertCallbacks.push(cb);
  }

  /** Register a callback that fires on every Metadata Hijack High-Risk Alert. */
  onMetadataHijackAlert(cb: MetadataHijackAlertCallback): void {
    this.metadataHijackCallbacks.push(cb);
  }

  /**
   * Register a callback that fires on every CPI-Depth / Path-Obfuscation alert
   * (depth >= 3). The `extreme` flag on the alert is set when depth >= 4.
   */
  onPathObfuscationAlert(cb: PathObfuscationAlertCallback): void {
    this.pathObfuscationCallbacks.push(cb);
  }



  /**
   * Start the WebSocket watcher. Safe to call multiple times — subsequent
   * calls are no-ops if the watcher is already running.
   */
  async start(): Promise<void> {
    if (this.running) return;

    if (!this.apiKey) {
      console.error(
        "[PostLaunchWatcher] HELIUS_API_KEY is not set — watcher cannot start.",
      );
      return;
    }

    this.running = true;
    await this.loadTrackedMints();
    this.connect();

    // Refresh the tracked-mint list every 5 minutes so newly scanned tokens
    // are picked up without restarting the service.
    this.refreshIntervalHandle = setInterval(
      () => void this.loadTrackedMints(),
      5 * 60 * 1_000,
    );

    console.log(
      `[PostLaunchWatcher] Started — ${this.mintSubscriptions.size} mints loaded. ` +
      `Subscriptions will confirm once the WebSocket opens.`,
    );
  }

  /** Gracefully stop the watcher and close the WebSocket. */
  stop(): void {
    this.running = false;
    this.stopHeartbeat();
    if (this.refreshIntervalHandle !== null) {
      clearInterval(this.refreshIntervalHandle);
      this.refreshIntervalHandle = null;
    }
    this.mintSubscriptions.clear();
    this.subIdToMint.clear();
    this.pendingSubRequests.clear();
    this.pendingUnsubRequests.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log("[PostLaunchWatcher] Stopped.");
  }

  /**
   * Manually add a mint to the watch list (e.g. immediately after a scan).
   * This is a real-time shortcut — the periodic refresh also picks it up.
   */
  trackMint(mintAddress: string): void {
    if (!mintAddress) return;
    if (this.mintSubscriptions.has(mintAddress)) return;
    this.subscribeMint(mintAddress);
    console.log(
      `[PostLaunchWatcher] trackMint(${mintAddress}) — now watching ${this.mintSubscriptions.size} mints.`,
    );
  }

  /** Return a snapshot of currently tracked mints. */
  getTrackedMints(): ReadonlySet<string> {
    return new Set(this.mintSubscriptions.keys());
  }

  // -------------------------------------------------------------------------
  // Internal — Supabase
  // -------------------------------------------------------------------------

  /**
   * Load all token addresses from scan_history into the tracked-mints set.
   * Called on start and every 5 minutes thereafter.
   */
  private async loadTrackedMints(): Promise<void> {
    if (!this.supabase) return;
    try {
      const { data, error } = await this.supabase
        .from("scan_history")
        .select("token_address");

      if (error) {
        console.error("[PostLaunchWatcher] loadTrackedMints error:", error.message);
        return;
      }

      const dbMints = new Set(
        (data ?? [])
          .map((r: { token_address: string }) => r.token_address)
          .filter(Boolean),
      );

      // Subscribe to mints now in the DB but not yet tracked.
      let added = 0;
      for (const mint of dbMints) {
        if (!this.mintSubscriptions.has(mint)) {
          this.subscribeMint(mint);
          added++;
        }
      }

      // Unsubscribe from mints no longer in the DB
      // (keep mints added via trackMint() that aren't in DB yet — they'll appear on next refresh).
      let removed = 0;
      for (const mint of this.mintSubscriptions.keys()) {
        if (!dbMints.has(mint)) {
          this.unsubscribeMint(mint);
          removed++;
        }
      }

      this.logSubscriptionStats(added, removed);
    } catch (err) {
      console.error("[PostLaunchWatcher] loadTrackedMints exception:", err);
    }
  }

  private logSubscriptionStats(added: number, removed: number): void {
    const total     = this.mintSubscriptions.size;
    const confirmed = [...this.mintSubscriptions.values()].filter(v => v.subId !== null).length;
    const pending   = total - confirmed;
    const mints     = [...this.mintSubscriptions.keys()];
    const preview   = mints.slice(0, 3).map(m => m.slice(0, 8) + "…").join(", ");
    const estPerDay = total * 120;
    console.log(
      `[PostLaunchWatcher] Subscriptions — total: ${total}, confirmed: ${confirmed}, pending: ${pending}` +
      (added || removed ? ` (+${added}/-${removed})` : "") +
      ` | mints: [${preview}${mints.length > 3 ? ` +${mints.length - 3} more` : ""}]` +
      ` | est notifications/day: ~${estPerDay.toLocaleString()}`,
    );
  }

  /**
   * Persist the alert to Supabase — sets is_authority_transitioned = true
   * on all rows for the affected mint.
   *
   * NOTE: Requires the column to exist:
   *   ALTER TABLE scan_history ADD COLUMN IF NOT EXISTS
   *     is_authority_transitioned BOOLEAN NOT NULL DEFAULT FALSE;
   */
  private async persistAlert(alert: AuthorityTransitionAlert): Promise<void> {
    if (!this.supabase) return;
    try {
      const { error } = await this.supabase
        .from("scan_history")
        .update({ is_authority_transitioned: true })
        .eq("token_address", alert.mintAddress);

      if (error) {
        console.error(
          "[PostLaunchWatcher] persistAlert DB error:",
          error.message,
        );
      } else {
        console.log(
          `[PostLaunchWatcher] DB updated: is_authority_transitioned=true for ${alert.mintAddress}`,
        );
      }
    } catch (err) {
      console.error("[PostLaunchWatcher] persistAlert exception:", err);
    }
  }

  /**
   * Persist an Account-Resize alert to Supabase:
   *   1. Sets scan_history.is_account_resized = TRUE on rows for the affected mint.
   *   2. Inserts a row into the `alerts` table for dashboard/notification surfaces.
   *
   * Schema prerequisites (run once as migrations):
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_account_resized BOOLEAN NOT NULL DEFAULT FALSE;
   *
   *   CREATE TABLE IF NOT EXISTS public.alerts (
   *     id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   *     created_at    timestamptz NOT NULL DEFAULT now(),
   *     alert_type    text NOT NULL,
   *     severity      text NOT NULL,
   *     mint_address  text,
   *     account       text,
   *     signature     text,
   *     payload       jsonb NOT NULL DEFAULT '{}'::jsonb
   *   );
   */
  private async persistResizeAlert(alert: AccountResizeAlert): Promise<void> {
    if (!this.supabase) return;
    try {
      if (alert.mintAddress) {
        const { error: histErr } = await this.supabase
          .from("scan_history")
          .update({ is_account_resized: true })
          .eq("token_address", alert.mintAddress);
        if (histErr) {
          console.error(
            "[PostLaunchWatcher] persistResizeAlert scan_history error:",
            histErr.message,
          );
        }
      }

      const { error: alertErr } = await this.supabase.from("alerts").insert({
        alert_type: "account_data_modification",
        severity: "critical",
        mint_address: alert.mintAddress,
        account: alert.account,
        signature: alert.signature,
        payload: {
          ownerProgram: alert.ownerProgram,
          oldLength: alert.oldLength,
          newLength: alert.newLength,
          source: alert.source,
          detectedAt: new Date(alert.detectedAt).toISOString(),
        },
      });
      if (alertErr) {
        console.error(
          "[PostLaunchWatcher] persistResizeAlert alerts insert error:",
          alertErr.message,
        );
      }
    } catch (err) {
      console.error("[PostLaunchWatcher] persistResizeAlert exception:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Internal — alert dispatch
  // -------------------------------------------------------------------------

  private async dispatchAlert(alert: AuthorityTransitionAlert): Promise<void> {
    // Log the Immediate Red Alert to console (visible in server logs).
    console.error(
      [
        "🚨 [IMMEDIATE RED ALERT] Authority Transition Detected!",
        `   Mint:           ${alert.mintAddress}`,
        `   Authority Type: ${alert.authorityType}`,
        `   New Authority:  ${alert.newAuthority ?? "REVOKED"}`,
        `   Signature:      ${alert.signature}`,
        `   Detected At:    ${new Date(alert.detectedAt).toISOString()}`,
        "   ⚠️  This is a primary indicator of a rug pull attempt.",
      ].join("\n"),
    );

    // Persist to DB.
    await this.persistAlert(alert);

    // Invoke registered callbacks.
    for (const cb of this.alertCallbacks) {
      try {
        cb(alert);
      } catch (err) {
        console.error("[PostLaunchWatcher] alertCallback error:", err);
      }
    }
  }

  /**
   * Persist a Metadata Hijack alert to Supabase:
   *   1. Sets scan_history.is_metadata_hijacked = TRUE on all rows for the mint.
   *   2. Inserts a row into the `alerts` table for dashboard surfaces.
   *
   * Schema prerequisites (run once):
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_metadata_hijacked BOOLEAN NOT NULL DEFAULT FALSE;
   */
  private async persistMetadataHijackAlert(alert: MetadataHijackAlert): Promise<void> {
    if (!this.supabase) return;
    try {
      const { error: histErr } = await this.supabase
        .from("scan_history")
        .update({ is_metadata_hijacked: true })
        .eq("token_address", alert.mintAddress);
      if (histErr) {
        console.error(
          "[PostLaunchWatcher] persistMetadataHijackAlert scan_history error:",
          histErr.message,
        );
      } else {
        console.log(
          `[PostLaunchWatcher] DB updated: is_metadata_hijacked=true for ${alert.mintAddress}`,
        );
      }

      const { error: alertErr } = await this.supabase.from("alerts").insert({
        alert_type: "metadata_hijack",
        severity: "critical",
        mint_address: alert.mintAddress,
        signature: alert.signature,
        payload: {
          instructionType: alert.instructionType,
          detectedAt: new Date(alert.detectedAt).toISOString(),
        },
      });
      if (alertErr) {
        console.error(
          "[PostLaunchWatcher] persistMetadataHijackAlert alerts insert error:",
          alertErr.message,
        );
      }
    } catch (err) {
      console.error("[PostLaunchWatcher] persistMetadataHijackAlert exception:", err);
    }
  }

  private async dispatchMetadataHijackAlert(alert: MetadataHijackAlert): Promise<void> {
    console.error(
      [
        "🚨 [HIGH RISK ALERT] Metadata Hijacking Attempt Detected!",
        `   Mint:              ${alert.mintAddress}`,
        `   Instruction Type:  ${alert.instructionType}`,
        `   Signature:         ${alert.signature}`,
        `   Detected At:       ${new Date(alert.detectedAt).toISOString()}`,
        "   ⚠️  Token name/symbol/image may have been changed post-launch.",
      ].join("\n"),
    );

    await this.persistMetadataHijackAlert(alert);

    for (const cb of this.metadataHijackCallbacks) {
      try {
        cb(alert);
      } catch (err) {
        console.error("[PostLaunchWatcher] metadataHijackCallback error:", err);
      }
    }
  }

  private async dispatchResizeAlert(alert: AccountResizeAlert): Promise<void> {
    console.error(
      [
        "🚨 [CRITICAL RED ALERT] Unauthorized Account Data Modification!",
        `   Account:        ${alert.account}`,
        `   Owner Program:  ${alert.ownerProgram}`,
        `   Mint:           ${alert.mintAddress ?? "(unresolved)"}`,
        `   Length:         ${alert.oldLength ?? "?"} → ${alert.newLength} bytes`,
        `   Source:         ${alert.source}`,
        `   Signature:      ${alert.signature}`,
        `   Detected At:    ${new Date(alert.detectedAt).toISOString()}`,
        "   ⚠️  Account storage was resized — possible logic injection into a live contract.",
      ].join("\n"),
    );

    await this.persistResizeAlert(alert);

    for (const cb of this.resizeAlertCallbacks) {
      try {
        cb(alert);
      } catch (err) {
        console.error("[PostLaunchWatcher] resizeAlertCallback error:", err);
      }
    }
  }


  // -------------------------------------------------------------------------
  // Internal — WebSocket lifecycle
  // -------------------------------------------------------------------------

  private getWsUrl(): string {
    return `wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(this.getWsUrl());
    } catch (err) {
      console.error("[PostLaunchWatcher] WebSocket constructor error:", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      console.log("[PostLaunchWatcher] WebSocket connected.");
      this.reconnectAttempts = 0;
      this.syncSubscriptions();   // per-mint re-subscribe (replaces global subscribe())
      this.startHeartbeat();      // detect silent Railway load-balancer drops
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      void this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      console.warn(
        `[PostLaunchWatcher] WebSocket closed (code ${event.code}). Reconnecting…`,
      );
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", (event: Event) => {
      console.error("[PostLaunchWatcher] WebSocket error:", event);
    });
  }

  // -------------------------------------------------------------------------
  // Internal — per-mint subscription management
  // -------------------------------------------------------------------------

  /** Monotonically-increasing request ID. Skips legacy IDs (1, 2) and heartbeat ID (999). */
  private nextId(): number {
    this.idCounter++;
    if (this.idCounter === 999) this.idCounter++;
    if (this.idCounter >= 90_000) this.idCounter = 100;
    return this.idCounter;
  }

  /**
   * Send a logsSubscribe { mentions: [mint] } request for a single mint.
   * Adds the mint to mintSubscriptions with subId=null (pending confirmation).
   * No-op if the mint is already tracked or if the cap is reached.
   */
  private subscribeMint(mint: string): void {
    if (this.mintSubscriptions.has(mint)) return;

    if (this.mintSubscriptions.size >= MAX_MINT_SUBSCRIPTIONS) {
      console.warn(
        `[PostLaunchWatcher] Cap reached (${MAX_MINT_SUBSCRIPTIONS}). Skipping ${mint}.`,
      );
      return;
    }

    this.mintSubscriptions.set(mint, { subId: null, subscribedAt: Date.now() });

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const reqId = this.nextId();
    this.pendingSubRequests.set(reqId, mint);
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id:     reqId,
        method: "logsSubscribe",
        params: [{ mentions: [mint] }, { commitment: "confirmed" }],
      }),
    );
    console.log(
      `[PostLaunchWatcher] + subscribing ${mint} (reqId=${reqId}) | active: ${this.mintSubscriptions.size}`,
    );
  }

  /**
   * Send a logsUnsubscribe for a mint and remove it from all tracking maps.
   */
  private unsubscribeMint(mint: string): void {
    const entry = this.mintSubscriptions.get(mint);
    if (!entry) return;

    this.mintSubscriptions.delete(mint);

    if (entry.subId !== null) {
      this.subIdToMint.delete(entry.subId);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const reqId = this.nextId();
        this.pendingUnsubRequests.set(reqId, entry.subId);
        this.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id:     reqId,
            method: "logsUnsubscribe",
            params: [entry.subId],
          }),
        );
      }
    }

    console.log(
      `[PostLaunchWatcher] - unsubscribed ${mint} | active: ${this.mintSubscriptions.size}`,
    );
  }

  /**
   * Re-subscribe to every mint in mintSubscriptions after a reconnect.
   *
   * Called from the WebSocket "open" handler. Resets all confirmed subIds
   * (they belong to the old session) and sends a fresh logsSubscribe for
   * every mint so monitoring resumes immediately without losing any token.
   * This replaces the old subscribe() which sent two hard-coded global
   * program subscriptions.
   */
  private syncSubscriptions(): void {
    // Old WebSocket session is gone — clear its subscription IDs.
    this.subIdToMint.clear();
    this.pendingSubRequests.clear();
    this.pendingUnsubRequests.clear();
    for (const entry of this.mintSubscriptions.values()) {
      entry.subId = null;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let sent = 0;
    for (const mint of this.mintSubscriptions.keys()) {
      const reqId = this.nextId();
      this.pendingSubRequests.set(reqId, mint);
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id:     reqId,
          method: "logsSubscribe",
          params: [{ mentions: [mint] }, { commitment: "confirmed" }],
        }),
      );
      sent++;
    }

    console.log(
      sent > 0
        ? `[PostLaunchWatcher] Reconnected — re-subscribing to ${sent} tracked mints.`
        : `[PostLaunchWatcher] Reconnected — no mints yet (list loads on next refresh).`,
    );
  }

  // -------------------------------------------------------------------------
  // Internal — heartbeat (prevents silent Railway load-balancer drops)
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatHandle = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: 999, method: "getHealth", params: [] }),
        );
      } catch { return; }

      this.heartbeatPending = setTimeout(() => {
        console.warn(
          `[PostLaunchWatcher] Heartbeat timeout — no response in ${HEARTBEAT_TIMEOUT_MS / 1000}s. ` +
          "Force-recycling WebSocket…",
        );
        try { this.ws?.close(); } catch { /* ignore */ }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    if (this.heartbeatPending !== null) {
      clearTimeout(this.heartbeatPending);
      this.heartbeatPending = null;
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Any inbound message clears the heartbeat timeout (server is alive).
    if (this.heartbeatPending !== null) {
      clearTimeout(this.heartbeatPending);
      this.heartbeatPending = null;
    }

    // ── Subscription confirmation ────────────────────────────────────────────
    if (typeof msg?.result === "number" && msg?.id !== undefined) {
      const reqId: number = msg.id as number;

      // logsSubscribe confirmation
      const mintForReq = this.pendingSubRequests.get(reqId);
      if (mintForReq !== undefined) {
        this.pendingSubRequests.delete(reqId);
        const subId: number = msg.result;
        const entry = this.mintSubscriptions.get(mintForReq);
        if (entry) {
          entry.subId = subId;
          this.subIdToMint.set(subId, mintForReq);
          console.log(
            `[PostLaunchWatcher] ✓ confirmed ${mintForReq.slice(0, 8)}… (subId=${subId})`,
          );
        }
        return;
      }

      // logsUnsubscribe confirmation
      if (this.pendingUnsubRequests.has(reqId)) {
        this.pendingUnsubRequests.delete(reqId);
        return;
      }

      return;
    }

    // ── Notification ─────────────────────────────────────────────────────────
    if (msg?.method !== "logsNotification") return;

    // Identify which mint this notification belongs to via subscription ID.
    const subId: number | undefined = msg?.params?.subscription as number | undefined;
    if (subId === undefined) return;

    const mintAddress = this.subIdToMint.get(subId);
    if (!mintAddress) return;   // notification for an untracked / stale sub

    const value = msg?.params?.result?.value;
    const signature: string = value?.signature ?? "";
    const logs: string[] = Array.isArray(value?.logs) ? value.logs : [];

    if (!signature) return;

    // Fast pre-filter: detect candidate log fragments.
    const mentionsSetAuthority = logs.some((l: string) => l.includes("SetAuthority"));
    const mentionsResize = logs.some(
      (l: string) =>
        l.includes("Allocate") ||
        l.includes("AllocateWithSeed") ||
        l.includes("realloc") ||
        l.includes("Reallocate"),
    );
    const mentionsMetadataUpdate = METADATA_UPDATE_LOG_FRAGMENTS.some((frag) =>
      logs.some((l: string) => l.includes(frag)),
    );

    if (!mentionsSetAuthority && !mentionsResize && !mentionsMetadataUpdate) return;

    // Build a single-element set for the extraction helpers (they expect a Set).
    const mintSet = new Set([mintAddress]);

    if (mentionsSetAuthority) {
      const alerts = await extractAuthorityTransitions(signature, mintSet, this.apiKey);
      for (const alert of alerts) await this.dispatchAlert(alert);
    }

    if (mentionsResize) {
      const resizeAlerts = await extractAccountResizes(signature, mintSet, this.apiKey);
      for (const alert of resizeAlerts) await this.dispatchResizeAlert(alert);
    }

    if (mentionsMetadataUpdate) {
      const metaAlerts = await extractMetadataHijacks(signature, mintSet, this.apiKey);
      for (const alert of metaAlerts) await this.dispatchMetadataHijackAlert(alert);
    }

    // ── CPI-Depth / Path-Obfuscation Monitor ─────────────────────────────────
    // Only fetch the full transaction when at least one pre-filter matched —
    // avoids a getTransaction RPC call for every log notification.
    try {
      const tx = await heliusRpc<any>(this.apiKey, "getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      const obfAlert = extractPathObfuscation(tx, signature, mintSet);
      if (obfAlert) await this.dispatchPathObfuscationAlert(obfAlert);
    } catch (err) {
      console.error("[PostLaunchWatcher] CPI-depth probe error:", err);
    }
  }




  // -------------------------------------------------------------------------
  // Path-Obfuscation persistence + dispatch
  // -------------------------------------------------------------------------

  private async persistPathObfuscationAlert(
    alert: PathObfuscationAlert,
  ): Promise<void> {
    if (!this.supabase) return;
    try {
      const { error: histErr } = await this.supabase
        .from("scan_history")
        .update({
          is_path_obfuscated: true,
          cpi_depth: alert.cpiDepth,
        })
        .eq("token_address", alert.mintAddress);
      if (histErr) {
        console.error(
          "[PostLaunchWatcher] persistPathObfuscationAlert scan_history error:",
          histErr.message,
        );
      } else {
        console.log(
          `[PostLaunchWatcher] DB updated: is_path_obfuscated=true cpi_depth=${alert.cpiDepth} for ${alert.mintAddress}`,
        );
      }

      const { error: alertErr } = await this.supabase.from("alerts").insert({
        alert_type: alert.extreme
          ? "path_obfuscation_extreme"
          : "path_obfuscation",
        severity: alert.extreme ? "critical" : "warn",
        mint_address: alert.mintAddress,
        signature: alert.signature,
        payload: {
          cpiDepth: alert.cpiDepth,
          extreme: alert.extreme,
          detectedAt: new Date(alert.detectedAt).toISOString(),
        },
      });
      if (alertErr) {
        console.error(
          "[PostLaunchWatcher] persistPathObfuscationAlert alerts insert error:",
          alertErr.message,
        );
      }
    } catch (err) {
      console.error("[PostLaunchWatcher] persistPathObfuscationAlert exception:", err);
    }
  }

  private async dispatchPathObfuscationAlert(
    alert: PathObfuscationAlert,
  ): Promise<void> {
    console.error(
      [
        alert.extreme
          ? "🚨 [CRITICAL RISK] Extreme Obfuscation — Deep CPI Nesting Detected!"
          : "⚠️  [WARNING] Obfuscated Transaction Path Detected (CPI nesting)",
        `   Mint:        ${alert.mintAddress}`,
        `   CPI Depth:   ${alert.cpiDepth}${alert.extreme ? "  (protocol maximum)" : ""}`,
        `   Signature:   ${alert.signature}`,
        `   Detected At: ${new Date(alert.detectedAt).toISOString()}`,
        "   ⚠️  Malicious logic may be hidden in nested program calls.",
      ].join("\n"),
    );

    await this.persistPathObfuscationAlert(alert);

    for (const cb of this.pathObfuscationCallbacks) {
      try {
        cb(alert);
      } catch (err) {
        console.error("[PostLaunchWatcher] pathObfuscationCallback error:", err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(
        "[PostLaunchWatcher] Maximum reconnect attempts reached. Watcher stopped.",
      );
      this.running = false;
      return;
    }

    const delay = RECONNECT_DELAY_MS * Math.min(this.reconnectAttempts, 6);
    console.log(
      `[PostLaunchWatcher] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`,
    );
    setTimeout(() => this.connect(), delay);
  }
}

// ---------------------------------------------------------------------------
// Convenience factory — start the singleton and register an alert callback
// ---------------------------------------------------------------------------

/**
 * Start the PostLaunchWatcher singleton and optionally register an alert handler.
 *
 * Example (in your server entry point, e.g. src/server.ts or src/start.ts):
 *
 *   import { startPostLaunchWatcher } from "@/lib/postLaunchWatcher";
 *   startPostLaunchWatcher((alert) => {
 *     // e.g. push alert to a WebSocket room, send an email, etc.
 *   });
 */
export async function startPostLaunchWatcher(
  onAlert?: AlertCallback,
  onMetadataHijack?: MetadataHijackAlertCallback,
  onPathObfuscation?: PathObfuscationAlertCallback,
): Promise<PostLaunchWatcher> {
  const watcher = PostLaunchWatcher.getInstance();
  if (onAlert) watcher.onAlert(onAlert);
  if (onMetadataHijack) watcher.onMetadataHijackAlert(onMetadataHijack);
  if (onPathObfuscation) watcher.onPathObfuscationAlert(onPathObfuscation);
  await watcher.start();
  return watcher;
}

export { METADATA_BURN_ADDRESS };
