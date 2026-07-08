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

// ── Helius daily credit budget ───────────────────────────────────────────────
// Shared with TokenDiscovery via globalThis so no extra import is needed.
// getTransaction = 10 CUs, getAccountInfo = 1 CU (Helius standard pricing).
// Configure with HELIUS_DAILY_BUDGET env var (default 20 000 CUs/day).
// Set HELIUS_DAILY_BUDGET=0 to disable enforcement.
function _consumeHC(cuAmount: number, label: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const now = Date.now();

  // ── Daily bucket ────────────────────────────────────────────────────────────
  if (!g.__heliusBudget__ || now - g.__heliusBudget__.day >= 86_400_000) {
    g.__heliusBudget__ = {
      budget: parseInt(process.env.HELIUS_DAILY_BUDGET ?? "20000", 10) || 0,
      used:   0,
      day:    now,
      warned: false,
    };
  }
  const b = g.__heliusBudget__ as { budget: number; used: number; day: number; warned: boolean };

  // ── Hourly bucket ───────────────────────────────────────────────────────────
  // Shared with TokenDiscovery via globalThis. HELIUS_HOURLY_BUDGET env var
  // (set in Railway Variables) controls the per-hour cap. Default: 1000 CUs/hr.
  if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
    g.__heliusHourly__ = {
      budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "1000", 10) || 0,
      used:   0,
      window: now,
      warned: false,
    };
  }
  const h = g.__heliusHourly__ as { budget: number; used: number; window: number; warned: boolean };

  // ── Hourly cap check ─────────────────────────────────────────────────────────
  if (h.budget > 0 && h.used + cuAmount > h.budget) {
    if (!h.warned) {
      h.warned = true;
      const resetsIn = Math.ceil((h.window + 3_600_000 - now) / 60_000);
      console.warn(
        `[HeliusBudget] ⚠️  Hourly cap reached (${h.used}/${h.budget} CUs used this hour). ` +
        `Skipping PLW\u0022${label}\u0022 — resets in ~${resetsIn} min. ` +
        `Raise HELIUS_HOURLY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Daily cap check ──────────────────────────────────────────────────────────
  if (b.budget > 0 && b.used + cuAmount > b.budget) {
    if (!b.warned) {
      b.warned = true;
      console.warn(
        `[HeliusBudget] ⚠️  Daily budget exhausted (${b.used}/${b.budget} CUs used). ` +
        `Skipping "${label}" until tomorrow. ` +
        `Raise HELIUS_DAILY_BUDGET in Railway Variables to increase the limit.`,
      );
    }
    return false;
  }

  // ── Consume from both buckets ────────────────────────────────────────────────
  if (h.budget > 0) h.used += cuAmount;
  if (b.budget > 0) b.used += cuAmount;
  return true;
}
// ─────────────────────────────────────────────────────────────────────────────

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
/**
 * FIX (connect-hang bug): how long to wait for the WebSocket to leave
 * CONNECTING before giving up and forcing a reconnect. See connect() below.
 */
const CONNECT_TIMEOUT_MS = 15_000;

const HEARTBEAT_INTERVAL_MS  = 30_000;
/** How long to wait for a pong before force-recycling the socket (ms). */
const HEARTBEAT_TIMEOUT_MS   = 20_000;
/**
 * Maximum number of tokens tracked simultaneously.
 * Each tracked token uses 2 WebSocket subscriptions (mint + metadata PDA),
 * so total subscription slots = MAX_TRACKED_TOKENS × 2.
 *
 * FREE-TIER NOTE: Reduced from 200 to 50 to stay within Helius free-tier limits.
 * Each tracked token generates Helius credits on every on-chain transaction that
 * mentions it (trades, etc.). 200 tokens × 2 subs was the primary driver of
 * ~80k credits/hour. 50 tokens × 2 subs brings this to a manageable level.
 *
 * Set PLW_ENABLED=false in Railway → Variables to disable the watcher
 * entirely without redeploying.
 * Raise MAX_TRACKED_TOKENS via the HELIUS_PLW_MAX_TOKENS env var on paid plans.
 */
const MAX_TRACKED_TOKENS = (() => {
  const env = parseInt(process.env.HELIUS_PLW_MAX_TOKENS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 5;
})();
/** Total LaserStream subscription slots consumed (2 per tracked token). */
const MAX_TOTAL_SUBSCRIPTIONS = MAX_TRACKED_TOKENS * 2;

  /**
   * Per-token notification count threshold before automatic eviction.
   *
   * FIX — root cause of unbounded Helius credit drain:
   *   Helius charges ~1 credit per logsNotification delivered over the WebSocket.
   *   HELIUS_HOURLY_BUDGET only gated HTTP RPC calls via _consumeHC(), so the
   *   WebSocket kept delivering (and charging) notifications even after the
   *   internal budget was "exhausted". Two symptoms:
   *     (a) Thousands of credits consumed per hour on Helius's end.
   *     (b) High-volume tokens (JUP, established DEXes in scan_history) generate
   *         100s of notifications/min with zero rug-pull signals.
   *
   * HOW THE FIX WORKS:
   *   1. Every incoming logsNotification now calls _consumeHC(1, "PLW/notification")
   *      so the internal budget reflects Helius's actual charge.
   *   2. When a single token exceeds HOT_TOKEN_EVICTION_THRESHOLD notifications
   *      in the current session, the watcher sends logsUnsubscribe immediately.
   *      This stops Helius from delivering (and billing) further notifications.
   *
   * Tunable via HELIUS_HOT_TOKEN_THRESHOLD in Railway → Variables (default 300).
   * Set to 0 to disable hot-token eviction.
   */
  const HOT_TOKEN_EVICTION_THRESHOLD = (() => {
    const env = parseInt(process.env.HELIUS_HOT_TOKEN_THRESHOLD ?? "", 10);
    return Number.isFinite(env) && env >= 0 ? env : 300;
  })();
  
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
  preFetchedTx?: unknown,
): Promise<AuthorityTransitionAlert[]> {
  let tx: any = preFetchedTx ?? null;
  if (!tx) {
    if (!_consumeHC(10, "PLW/extractAuthorityTransitions")) return [];
    tx = await heliusRpc<any>(apiKey, "getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
  }
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
  preFetchedTx?: unknown,
): Promise<AccountResizeAlert[]> {
  let tx: any = preFetchedTx ?? null;
  if (!tx) {
    if (!_consumeHC(10, "PLW/extractAccountResizes")) return [];
    tx = await heliusRpc<any>(apiKey, "getTransaction", [
      signature,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
  }
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
  preFetchedTx?: unknown,
): Promise<MetadataHijackAlert[]> {
  let tx: any = preFetchedTx ?? null;
  if (!tx) {
    if (!_consumeHC(10, "PLW/extractMetadataHijacks")) return [];
    tx = await heliusRpc<any>(apiKey, "getTransaction", [
      signature,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
  }
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
// Solana PDA derivation — used to compute Token Metadata PDAs
// ---------------------------------------------------------------------------

/** p = 2^255 − 19 (the prime for Curve25519 / ed25519).
 *  Precomputed literal — avoids BigInt exponentiation at module init time,
 *  which crashes Bun during SSR bundle loading ("BigInt too big"). */
const _P25519 = 57896044618658097711785492504343953926634992332820282019728792003956564819949n;

/** d constant for ed25519: −121665/121666 mod p.
 *  Precomputed literal — replaces the top-level IIFE that triggered the SSR crash.
 *  Verified against RFC 8032 and the standard @noble/ed25519 implementation. */
const _D25519 = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function _modpow25519(base: bigint, exp: bigint): bigint {
  let result = 1n;
  base = ((base % _P25519) + _P25519) % _P25519;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % _P25519;
    exp >>= 1n;
    base = base * base % _P25519;
  }
  return result;
}

/**
 * Returns true when the 32-byte array represents a valid compressed ed25519
 * point (i.e. the point IS on the curve). Solana PDAs are required to be
 * OFF the curve — so a hash is a valid PDA candidate when this returns false.
 */
function _isOnEd25519Curve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const yBytes = Buffer.from(bytes);
  yBytes[31] &= 0x7f;                          // clear sign bit
  let y = 0n;
  for (let i = 0; i < 32; i++) y |= BigInt(yBytes[i]) << BigInt(8 * i);
  y = ((y % _P25519) + _P25519) % _P25519;
  const y2 = y * y % _P25519;
  const u  = (y2 - 1n + _P25519) % _P25519;
  const v  = (_D25519 * y2 + 1n) % _P25519;
  const vInv = _modpow25519(v, _P25519 - 2n);  // Fermat's little theorem
  const x2 = u * vInv % _P25519;
  if (x2 === 0n) return true;                   // x = 0 ⟹ on curve
  // Euler's criterion: x² is a QR iff x²^((p−1)/2) ≡ 1 (mod p)
  return _modpow25519(x2, (_P25519 - 1n) / 2n) === 1n;
}

/**
 * Derive the canonical Token Metadata PDA for a given mint address.
 *
 * Seeds (Metaplex convention):
 *   [ "metadata", TOKEN_METADATA_PROGRAM_ID bytes, mint bytes, bump_byte, program_id_bytes,
 *     "ProgramDerivedAddress" ]
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle`) which is available
 * globally in Bun and in all modern browsers — no Node.js import needed.
 * Tries bump seeds 255 → 0 and returns the first off-curve result (base58).
 * Returns null only when no valid PDA can be found or the mint is invalid.
 */
async function deriveMetadataPDA(mintAddress: string): Promise<string | null> {
  try {
    const programIdBytes = base58Decode(TOKEN_METADATA_PROGRAM_ID);
    const mintBytes      = base58Decode(mintAddress);
    if (!programIdBytes || !mintBytes || programIdBytes.length !== 32 || mintBytes.length !== 32) {
      return null;
    }

    const enc    = new TextEncoder();
    const seed1  = enc.encode("metadata");
    const suffix = enc.encode("ProgramDerivedAddress");

    for (let bump = 255; bump >= 0; bump--) {
      // Concatenate all seed parts into one Uint8Array for subtle.digest
      const data = new Uint8Array(
        seed1.length + programIdBytes.length + mintBytes.length + 1 + programIdBytes.length + suffix.length,
      );
      let off = 0;
      data.set(seed1,        off); off += seed1.length;
      data.set(programIdBytes, off); off += programIdBytes.length;
      data.set(mintBytes,    off); off += mintBytes.length;
      data[off++] = bump;
      data.set(programIdBytes, off); off += programIdBytes.length;  // program_id appended by runtime
      data.set(suffix,       off);

      const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", data);
      const hash    = new Uint8Array(hashBuf);

      if (!_isOnEd25519Curve(hash)) {
        return base58Encode(hash);
      }
    }
    return null;
  } catch {
    return null;
  }
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

  /**
   * Metadata PDA subscriptions — one per tracked mint (paired with mintSubscriptions).
   * Key = the metadata PDA address (base58), value = subscription state.
   */
  private metadataPDASubscriptions: Map<string, { subId: number | null; subscribedAt: number }> = new Map();

  /** mint → metadata PDA address (cached deriveMetadataPDA result). */
  private mintToMetadataPDA: Map<string, string> = new Map();

  /** metadata PDA address → mint address (reverse lookup for routing notifications). */
  private metadataPDAToMint: Map<string, string> = new Map();

  /**
   * Reverse lookup: confirmed subscription ID → mint address.
   * For metadata PDA subscriptions the value is the ASSOCIATED MINT, not the PDA itself.
   */
  private subIdToMint: Map<number, string> = new Map();

  /**
   * Tracks which confirmed subscription IDs belong to metadata PDA subscriptions
   * (rather than direct mint subscriptions). Used in handleMessage to decide which
   * event types to check for a given notification.
   */
  private subIdIsMetadata: Set<number> = new Set();

  /** Correlates in-flight subscribe responses to their address (mint or metadata PDA). */
  private pendingSubRequests: Map<number, string> = new Map();

  /**
   * Tracks which pending subscribe request IDs are for metadata PDA subscriptions.
   * Entries are removed once the confirmation arrives.
   */
  private pendingSubIsMeta: Set<number> = new Set();

  /** Correlates in-flight unsubscribe responses to the subId being cancelled. */
  private pendingUnsubRequests: Map<number, number> = new Map();

  /** Monotonically-increasing JSON-RPC request ID counter (starts above legacy IDs). */
  private idCounter = 100;

  // ── Notification metrics ────────────────────────────────────────────────────
  /** Timestamp (ms) when the current session started — used to compute notification rates. */
  // Credit-burn deduplication: seen-signature cache prevents the same tx from
  // being fetched twice (mint sub + metadata PDA sub can both fire for one tx).
  // Per-mint cooldown prevents runaway credit burn from a single hot token.
  private readonly seenSignatures: Set<string> = new Set();
  private seenSignaturesList: string[] = [];
  private readonly mintLastAlerted: Map<string, number> = new Map();
  private static readonly MINT_ALERT_COOLDOWN_MS = 300_000;

  private sessionStartMs = Date.now();
  /** Total logsNotification messages received since session start. */
  private totalNotifications = 0;
  /** Per-mint notification counter (key = mint address). */
  private notificationsPerMint: Map<string, number> = new Map();
  /** Total hot-token evictions this session (surfaced in getStats()). */
  private hotTokenEvictions = 0;

  // ── Heartbeat ───────────────────────────────────────────────────────────────
  /** setInterval handle for the 30-second keepalive ping. */
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  /** setTimeout handle for the 20-second pong timeout. */
  private heartbeatPending: ReturnType<typeof setTimeout> | null = null;

  // FIX (connect-hang bug): guards against a WebSocket that never leaves
  // CONNECTING (e.g. a Railway restart leaves Helius's load balancer holding
  // a half-open socket from the previous process). Without this, neither
  // 'open' nor 'close'/'error' ever fires, the heartbeat never starts, and
  // scheduleReconnect() is never called — the watcher is frozen forever.
  private connectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /** Interval handle for periodic mint-list refresh. */
  private refreshIntervalHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * When > Date.now(), the watcher is paused because the hourly Helius budget
   * was exhausted. scheduleReconnect() returns early while paused so the
   * WebSocket is NOT automatically re-opened (which would resume billing).
   * _pauseForBudget() sets this and arranges a delayed self-restart.
   */
  private budgetPausedUntilMs = 0;

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

    // ── Feature flag ─────────────────────────────────────────────────────────
    // Set PLW_ENABLED=false in Railway → Variables to disable without redeploy.
    const plwEnabled = (process.env.PLW_ENABLED ?? "true").toLowerCase();
    if (plwEnabled === "false" || plwEnabled === "0") {
      console.log(
        "[PostLaunchWatcher] Disabled via PLW_ENABLED env var — skipping start.",
      );
      return;
    }

    if (!this.apiKey) {
      console.error(
        "[PostLaunchWatcher] HELIUS_API_KEY is not set — watcher cannot start.",
      );
      return;
    }

    this.sessionStartMs = Date.now();
    this.totalNotifications = 0;
    this.notificationsPerMint.clear();

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
      `[PostLaunchWatcher] Started — tracking ${this.mintSubscriptions.size} mints ` +
      `(cap: ${MAX_TRACKED_TOKENS} tokens × 2 subs = ${MAX_TOTAL_SUBSCRIPTIONS} total slots). ` +
      `Subscriptions will confirm once the WebSocket opens.`,
    );
  }

  /** Gracefully stop the watcher and close the WebSocket. */
  stop(): void {
    this.running = false;
    this.stopHeartbeat();
    this.clearConnectTimeout();
    if (this.refreshIntervalHandle !== null) {
      clearInterval(this.refreshIntervalHandle);
      this.refreshIntervalHandle = null;
    }

    // ── Clean unsubscribe: send logsUnsubscribe for every active subscription
    // before closing so Helius credits stop accruing immediately.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const toUnsub: number[] = [];
      for (const entry of this.mintSubscriptions.values()) {
        if (entry.subId !== null) toUnsub.push(entry.subId);
      }
      for (const entry of this.metadataPDASubscriptions.values()) {
        if (entry.subId !== null) toUnsub.push(entry.subId);
      }
      for (const subId of toUnsub) {
        try {
          this.ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id:     this.nextId(),
              method: "logsUnsubscribe",
              params: [subId],
            }),
          );
        } catch { /* ignore — we're closing anyway */ }
      }
      if (toUnsub.length > 0) {
        console.log(
          `[PostLaunchWatcher] Sent logsUnsubscribe for ${toUnsub.length} active subscriptions.`,
        );
      }
    }

    this.mintSubscriptions.clear();
    this.metadataPDASubscriptions.clear();
    this.mintToMetadataPDA.clear();
    this.metadataPDAToMint.clear();
    this.subIdToMint.clear();
    this.subIdIsMetadata.clear();
    this.pendingSubRequests.clear();
    this.pendingSubIsMeta.clear();
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
   *
   * FILTERS applied to prevent Helius credit drain:
   *   1. token_address LIKE '%pump'  — pump.fun tokens only. Established tokens
   *      (JUP, POPCAT, ZINC, etc.) scanned via the UI have arbitrary addresses
   *      and generate hundreds of logsNotifications/min with zero rug-pull signal.
   *      This single filter is the primary protection; pump.fun mint addresses
   *      always end in the literal string "pump".
   *   2. ORDER BY scanned_at DESC    — most recently scanned tokens fill slots first.
   */
  private async loadTrackedMints(): Promise<void> {
    if (!this.supabase) return;
    try {
      const { data, error } = await this.supabase
        .from("scan_history")
        .select("token_address")
        .like("token_address", "%pump")   // pump.fun tokens only — primary guard
        .order("scanned_at", { ascending: false })
        .limit(MAX_TRACKED_TOKENS);

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
    const mintTotal       = this.mintSubscriptions.size;
    const mintConfirmed   = [...this.mintSubscriptions.values()].filter(v => v.subId !== null).length;
    const metaTotal       = this.metadataPDASubscriptions.size;
    const metaConfirmed   = [...this.metadataPDASubscriptions.values()].filter(v => v.subId !== null).length;
    const totalSubs       = mintTotal + metaTotal;
    const totalConfirmed  = mintConfirmed + metaConfirmed;
    const totalPending    = totalSubs - totalConfirmed;
    const mints           = [...this.mintSubscriptions.keys()];
    const preview         = mints.slice(0, 3).map(m => m.slice(0, 8) + "…").join(", ");
    // 2 subs per token × 120 notifications/day estimate
    const estPerDay       = mintTotal * 2 * 120;
    console.log(
      `[PostLaunchWatcher] Subscriptions — tokens: ${mintTotal}/${MAX_TRACKED_TOKENS}` +
      ` | subs: ${totalSubs}/${MAX_TOTAL_SUBSCRIPTIONS} (${totalConfirmed} confirmed, ${totalPending} pending)` +
      (added || removed ? ` (+${added}/-${removed} tokens)` : "") +
      ` | mints: [${preview}${mints.length > 3 ? ` +${mints.length - 3} more` : ""}]` +
      ` | est notifications/day: ~${estPerDay.toLocaleString()}` +
      ` | credits burned so far: ${this.totalNotifications.toLocaleString()}`,
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
    // Standard Helius WebSocket endpoint — supported on all plan tiers including free.
    // atlas-mainnet.helius-rpc.com is a Geyser/Atlas premium endpoint (paid plans only)
    // and returns HTTP 1002 on the free tier. mainnet.helius-rpc.com supports
    // logsSubscribe / accountSubscribe on the free tier with 1M credits/month.
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

    // FIX (connect-hang bug): if the handshake never completes (no 'open',
    // no 'close', no 'error' — e.g. Helius's load balancer still holds a
    // half-open socket from the previous process after a Railway restart),
    // this timer force-closes the zombie socket and schedules a reconnect so
    // the watcher can never get permanently stuck in CONNECTING.
    this.clearConnectTimeout();
    this.connectTimeoutHandle = setTimeout(() => {
      this.connectTimeoutHandle = null;
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        console.warn(
          `[PostLaunchWatcher] WebSocket connect timeout — still CONNECTING after ` +
          `${CONNECT_TIMEOUT_MS / 1000}s. Forcing reconnect…`,
        );
        try { this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
        this.scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    this.ws.addEventListener("open", () => {
      this.clearConnectTimeout();
      console.log("[PostLaunchWatcher] WebSocket connected.");
      this.reconnectAttempts = 0;
      this.syncSubscriptions();   // per-mint re-subscribe (replaces global subscribe())
      this.startHeartbeat();      // detect silent Railway load-balancer drops
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      void this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      this.clearConnectTimeout();
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
   * Send a logsSubscribe { mentions: [mint] } request for a single mint,
   * and also subscribe to that mint's Token Metadata PDA (hybrid model).
   * Adds the mint to mintSubscriptions with subId=null (pending confirmation).
   * No-op if the mint is already tracked or if the token cap is reached.
   */
  private subscribeMint(mint: string): void {
    if (this.mintSubscriptions.has(mint)) return;

    if (this.mintSubscriptions.size >= MAX_TRACKED_TOKENS) {
      console.warn(
        `[PostLaunchWatcher] Token cap reached (${MAX_TRACKED_TOKENS} tokens / ` +
        `${MAX_TOTAL_SUBSCRIPTIONS} total subs). Skipping ${mint.slice(0, 8)}….`,
      );
      return;
    }

    this.mintSubscriptions.set(mint, { subId: null, subscribedAt: Date.now() });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
    }

    // Also subscribe to the Token Metadata PDA for this mint so metadata
    // update transactions are caught even when the mint address isn't
    // explicitly listed in the transaction's account keys.
    this.subscribeMetadataPDA(mint);

    console.log(
      `[PostLaunchWatcher] + tracking ${mint.slice(0, 8)}… ` +
      `(mint sub + metadata PDA sub) | tokens: ${this.mintSubscriptions.size}/${MAX_TRACKED_TOKENS}`,
    );
  }

  /**
   * Kick off async derivation of the Token Metadata PDA for a mint and
   * subscribe once resolved. Fire-and-forget — safe to call without awaiting.
   * Called automatically from subscribeMint — do not call directly.
   */
  private subscribeMetadataPDA(mint: string): void {
    this._deriveAndSubscribeMetadataPDA(mint).catch((err: unknown) => {
      console.warn(
        `[PostLaunchWatcher] subscribeMetadataPDA(${mint.slice(0, 8)}…) unexpected error:`,
        err,
      );
    });
  }

  /**
   * Internal async implementation of metadata PDA subscription.
   * Uses the globally-available Web Crypto API (no Node.js import required).
   */
  private async _deriveAndSubscribeMetadataPDA(mint: string): Promise<void> {
    // Resolve or compute the metadata PDA for this mint (cached after first call).
    let pdaAddress = this.mintToMetadataPDA.get(mint);
    if (!pdaAddress) {
      pdaAddress = (await deriveMetadataPDA(mint)) ?? undefined;
      if (!pdaAddress) {
        console.warn(
          `[PostLaunchWatcher] deriveMetadataPDA failed for ${mint.slice(0, 8)}… ` +
          "— metadata PDA subscription skipped.",
        );
        return;
      }
      // Guard: mint may have been removed while we were awaiting
      if (!this.mintSubscriptions.has(mint)) return;
      if (this.metadataPDAToMint.has(pdaAddress)) return;
      this.mintToMetadataPDA.set(mint, pdaAddress);
      this.metadataPDAToMint.set(pdaAddress, mint);
    }

    if (this.metadataPDASubscriptions.has(pdaAddress)) return;
    this.metadataPDASubscriptions.set(pdaAddress, { subId: null, subscribedAt: Date.now() });

    // If the WebSocket is open, send the subscribe immediately.
    // If not open yet, syncSubscriptions() will pick it up when the WS reconnects.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const reqId = this.nextId();
    this.pendingSubRequests.set(reqId, pdaAddress);
    this.pendingSubIsMeta.add(reqId);
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id:     reqId,
        method: "logsSubscribe",
        params: [{ mentions: [pdaAddress] }, { commitment: "confirmed" }],
      }),
    );
  }

  /**
   * Send logsUnsubscribe for a mint and its metadata PDA, remove from all maps.
   */
  private unsubscribeMint(mint: string): void {
    const entry = this.mintSubscriptions.get(mint);
    if (!entry) return;
    this.mintSubscriptions.delete(mint);

    const sendUnsub = (subId: number) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const reqId = this.nextId();
        this.pendingUnsubRequests.set(reqId, subId);
        this.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id:     reqId,
            method: "logsUnsubscribe",
            params: [subId],
          }),
        );
      }
    };

    if (entry.subId !== null) {
      this.subIdToMint.delete(entry.subId);
      sendUnsub(entry.subId);
    }

    // Also clean up the paired metadata PDA subscription.
    const pdaAddress = this.mintToMetadataPDA.get(mint);
    if (pdaAddress) {
      const pdaEntry = this.metadataPDASubscriptions.get(pdaAddress);
      if (pdaEntry) {
        this.metadataPDASubscriptions.delete(pdaAddress);
        if (pdaEntry.subId !== null) {
          this.subIdToMint.delete(pdaEntry.subId);
          this.subIdIsMetadata.delete(pdaEntry.subId);
          sendUnsub(pdaEntry.subId);
        }
      }
      this.metadataPDAToMint.delete(pdaAddress);
      this.mintToMetadataPDA.delete(mint);
    }

    console.log(
      `[PostLaunchWatcher] - untracked ${mint.slice(0, 8)}… (mint + metadata PDA) ` +
      `| tokens: ${this.mintSubscriptions.size}/${MAX_TRACKED_TOKENS}`,
    );
  }

  /**
   * Re-subscribe to every tracked mint AND its metadata PDA after a reconnect.
   *
   * Called from the WebSocket "open" handler. Resets all confirmed subIds
   * (they belong to the old session) and sends fresh logsSubscribe requests
   * for both mint and metadata PDA subscriptions.
   */
  private syncSubscriptions(): void {
    // Old WebSocket session is gone — clear its subscription IDs.
    this.subIdToMint.clear();
    this.subIdIsMetadata.clear();
    this.pendingSubRequests.clear();
    this.pendingSubIsMeta.clear();
    this.pendingUnsubRequests.clear();
    for (const entry of this.mintSubscriptions.values()) {
      entry.subId = null;
    }
    for (const entry of this.metadataPDASubscriptions.values()) {
      entry.subId = null;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let mintSent = 0;
    let metaSent = 0;

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
      mintSent++;
    }

    for (const [pdaAddress] of this.metadataPDASubscriptions) {
      const reqId = this.nextId();
      this.pendingSubRequests.set(reqId, pdaAddress);
      this.pendingSubIsMeta.add(reqId);
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id:     reqId,
          method: "logsSubscribe",
          params: [{ mentions: [pdaAddress] }, { commitment: "confirmed" }],
        }),
      );
      metaSent++;
    }

    console.log(
      mintSent > 0
        ? `[PostLaunchWatcher] Reconnected — re-subscribing: ${mintSent} mint subs + ${metaSent} metadata PDA subs.`
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

  /** Clears the connect-hang guard timer, if one is pending. */
  private clearConnectTimeout(): void {
    if (this.connectTimeoutHandle !== null) {
      clearTimeout(this.connectTimeoutHandle);
      this.connectTimeoutHandle = null;
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

      // logsSubscribe confirmation — mint or metadata PDA
      const addressForReq = this.pendingSubRequests.get(reqId);
      if (addressForReq !== undefined) {
        this.pendingSubRequests.delete(reqId);
        const subId: number = msg.result;
        const isMeta = this.pendingSubIsMeta.has(reqId);
        this.pendingSubIsMeta.delete(reqId);

        if (isMeta) {
          // Metadata PDA subscription confirmed
          const pdaEntry = this.metadataPDASubscriptions.get(addressForReq);
          if (pdaEntry) {
            pdaEntry.subId = subId;
            const mintAddress = this.metadataPDAToMint.get(addressForReq) ?? addressForReq;
            this.subIdToMint.set(subId, mintAddress);
            this.subIdIsMetadata.add(subId);
            console.log(
              `[PostLaunchWatcher] ✓ confirmed metadata PDA ${addressForReq.slice(0, 8)}… ` +
              `→ mint ${mintAddress.slice(0, 8)}… (subId=${subId})`,
            );
          }
        } else {
          // Direct mint subscription confirmed
          const entry = this.mintSubscriptions.get(addressForReq);
          if (entry) {
            entry.subId = subId;
            this.subIdToMint.set(subId, addressForReq);
            console.log(
              `[PostLaunchWatcher] ✓ confirmed mint ${addressForReq.slice(0, 8)}… (subId=${subId})`,
            );
          }
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

    // ── Notification metrics ──────────────────────────────────────────────────
    this.totalNotifications++;

      // FIX: Count each WebSocket notification against the Helius credit budget.
      // Helius charges ~1 CU per logsNotification delivered, whether or not we
      // make a downstream HTTP RPC call. Without this, HELIUS_HOURLY_BUDGET only
      // gated HTTP calls while the WebSocket kept delivering (and billing) msgs.
      //
      // CRITICAL: when the budget is exhausted we MUST close the WebSocket.
      // Simply returning here stops our downstream RPC calls but Helius continues
      // to DELIVER (and BILL) every subsequent notification over the open socket.
      // _pauseForBudget() unsubscribes all mints and closes the connection so
      // Helius stops billing until the hourly window resets.
      if (!_consumeHC(1, "PLW/notification")) {
        this._pauseForBudget();
        return;
      }

      const mintCount = (this.notificationsPerMint.get(mintAddress) ?? 0) + 1;
      this.notificationsPerMint.set(mintAddress, mintCount);

      // ── Hot-token eviction ────────────────────────────────────────────────────
      // Unsubscribe tokens that exceed HOT_TOKEN_EVICTION_THRESHOLD notifications.
      // High-volume established tokens (JUP, active DEX tokens stored in
      // scan_history) generate hundreds of notifications/min with zero rug-pull
      // signals — evicting them stops Helius billing immediately.
      // Configurable via HELIUS_HOT_TOKEN_THRESHOLD in Railway Variables (default 300).
      if (HOT_TOKEN_EVICTION_THRESHOLD > 0 && mintCount >= HOT_TOKEN_EVICTION_THRESHOLD) {
        const sessionMinutes = Math.max(1, Math.round((Date.now() - this.sessionStartMs) / 60_000));
        console.warn(
          "[PostLaunchWatcher] HOT-TOKEN EVICTION: " + mintAddress.slice(0, 8) + "... generated " +
          mintCount + " notifications in " + sessionMinutes + " min (" + Math.round(mintCount / sessionMinutes) + "/min). " +
          "Sending logsUnsubscribe to stop credit drain. " +
          "Raise HELIUS_HOT_TOKEN_THRESHOLD (current: " + HOT_TOKEN_EVICTION_THRESHOLD + ") in Railway Variables to keep tracking.",
        );
        this.unsubscribeMint(mintAddress);
        return;
      }

    const value = msg?.params?.result?.value;
    const signature: string = value?.signature ?? "";
    const logs: string[] = Array.isArray(value?.logs) ? value.logs : [];

    if (!signature) return;

    // Whether this notification came through a metadata PDA subscription or a
    // direct mint subscription determines which event types we check.
    // Metadata PDA subscriptions ONLY process metadata update events to avoid
    // duplicate processing when both subscriptions fire on the same transaction.
    const isMetadataSub = this.subIdIsMetadata.has(subId);

    // Fast pre-filter: detect candidate log fragments.
    const mentionsSetAuthority = !isMetadataSub &&
      logs.some((l: string) => l.includes("SetAuthority"));
    const mentionsResize = !isMetadataSub && logs.some(
      (l: string) =>
        l.includes("Allocate") ||
        l.includes("AllocateWithSeed") ||
        l.includes("realloc") ||
        l.includes("Reallocate"),
    );
    const mentionsMetadataUpdate = METADATA_UPDATE_LOG_FRAGMENTS.some((frag) =>
      logs.some((l: string) => l.includes(frag)),
    );

    // ── CPI-depth log pre-filter ──────────────────────────────────────────────
    // Solana always logs "Program X invoke [N]" where N is the stack depth.
    // invoke[4]+ means true CPI nesting beyond normal DEX routing (depth[3]).
    // Checking here means we NEVER call getTransaction on a routine trade just to
    // confirm depth < 3 — the logs already tell us. This eliminates the single
    // largest driver of Helius credit consumption on the free tier.
    // invoke[3] is normal DEX routing depth for Pump.fun trades — only flag
    // invoke[4]+ which indicates true obfuscation nesting beyond standard depth.
    const hasDeepCpi = !isMetadataSub && logs.some(
      (l: string) => l.includes(" invoke [4]") || l.includes(" invoke [5]") || l.includes(" invoke [6]"),
    );

    const needsRpc = mentionsSetAuthority || mentionsResize || mentionsMetadataUpdate || hasDeepCpi;
    if (!needsRpc) return;

    // ── Signature dedup ───────────────────────────────────────────────────────
    // Both the mint subscription and its metadata PDA subscription can fire for
    // the same transaction. Without dedup we would fetch (and pay for) the same
    // tx twice. Keep a rolling cache of the last 2000 processed signatures.
    if (this.seenSignatures.has(signature)) return;
    this.seenSignatures.add(signature);
    this.seenSignaturesList.push(signature);
    if (this.seenSignaturesList.length > 2000) {
      const evicted = this.seenSignaturesList.shift()!;
      this.seenSignatures.delete(evicted);
    }

    // ── Per-mint cooldown ─────────────────────────────────────────────────────
    // A hot token being actively traded can trigger many suspicious-looking
    // notifications per minute. Cap getTransaction fetches to once per mint
    // per MINT_ALERT_COOLDOWN_MS to prevent runaway credit burn.
    const nowMs = Date.now();
    const lastAlerted = this.mintLastAlerted.get(mintAddress) ?? 0;
    if (nowMs - lastAlerted < PostLaunchWatcher.MINT_ALERT_COOLDOWN_MS) {
      console.log(
        `[PostLaunchWatcher] cooldown: skipping RPC for ${mintAddress.slice(0, 8)}… ` +
        `(next allowed in ${Math.ceil((PostLaunchWatcher.MINT_ALERT_COOLDOWN_MS - (nowMs - lastAlerted)) / 1000)}s)`,
      );
      return;
    }
    this.mintLastAlerted.set(mintAddress, nowMs);

    // ── Single getTransaction fetch shared across ALL extractors ──────────────
    // OLD behaviour: each extractor (authority, resize, metadata, CPI) fetched
    // the transaction independently — up to 4 × 10 = 40 CUs per notification.
    // NEW behaviour: fetch ONCE here (10 CUs), pass the pre-fetched object to
    // every extractor so none of them makes a redundant RPC call.
    if (!_consumeHC(10, "PLW/handleMessage/getTransaction")) return;
    let sharedTx: unknown;
    try {
      sharedTx = await heliusRpc<unknown>(this.apiKey, "getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ]);
    } catch (err) {
      console.error("[PostLaunchWatcher] getTransaction error:", err);
      return;
    }
    if (!sharedTx) return;

    // Build a single-element set for the extraction helpers (they expect a Set).
    const mintSet = new Set([mintAddress]);

    if (mentionsSetAuthority) {
      const alerts = await extractAuthorityTransitions(signature, mintSet, this.apiKey, sharedTx);
      for (const alert of alerts) await this.dispatchAlert(alert);
    }

    if (mentionsResize) {
      const resizeAlerts = await extractAccountResizes(signature, mintSet, this.apiKey, sharedTx);
      for (const alert of resizeAlerts) await this.dispatchResizeAlert(alert);
    }

    if (mentionsMetadataUpdate) {
      const metaAlerts = await extractMetadataHijacks(signature, mintSet, this.apiKey, sharedTx);
      for (const alert of metaAlerts) await this.dispatchMetadataHijackAlert(alert);
    }

    // ── CPI-Depth / Path-Obfuscation Monitor ─────────────────────────────────
    if (hasDeepCpi) {
      try {
        const obfAlert = extractPathObfuscation(sharedTx, signature, mintSet);
        if (obfAlert) await this.dispatchPathObfuscationAlert(obfAlert);
      } catch (err) {
        console.error("[PostLaunchWatcher] CPI-depth probe error:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public — status metrics
  // -------------------------------------------------------------------------

  /**
   * Return a point-in-time snapshot of PostLaunchWatcher operational metrics.
   * Safe to call at any time (does not mutate state).
   */
  getStats(): {
    enabled:            boolean;
    running:            boolean;
    wsAlive:            boolean;
    tokens:             number;
    tokenCap:           number;
    mintSubsConfirmed:  number;
    mintSubsPending:    number;
    metaSubsConfirmed:  number;
    metaSubsPending:    number;
    totalSubs:          number;
    totalSubsCap:       number;
    totalNotifications: number;
    hotTokenEvictions:  number;
    sessionAgeSeconds:  number;
    estimatedCreditsPerDay: number;
    topMintsByNotifications: Array<{ mint: string; notifications: number }>;
  } {
    const enabled = (process.env.PLW_ENABLED ?? "true").toLowerCase() !== "false" &&
                    (process.env.PLW_ENABLED ?? "true").toLowerCase() !== "0";
    const mintTotal      = this.mintSubscriptions.size;
    const mintConfirmed  = [...this.mintSubscriptions.values()].filter(v => v.subId !== null).length;
    const metaTotal      = this.metadataPDASubscriptions.size;
    const metaConfirmed  = [...this.metadataPDASubscriptions.values()].filter(v => v.subId !== null).length;
    const sessionAge     = Math.max(1, (Date.now() - this.sessionStartMs) / 1000);

    // Estimated daily credits = (notifications received / session age) × 86400
    const estimatedCreditsPerDay = this.totalNotifications > 0
      ? Math.round((this.totalNotifications / sessionAge) * 86400)
      : mintTotal * 2 * 120;  // fallback: 120 notifications/day per sub (empirical)

    // Top 5 noisiest mints (most notifications received)
    const topMintsByNotifications = [...this.notificationsPerMint.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([mint, notifications]) => ({ mint, notifications }));

    return {
      enabled,
      running:            this.running,
      wsAlive:            !!(this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)),
      tokens:             mintTotal,
      tokenCap:           MAX_TRACKED_TOKENS,
      mintSubsConfirmed:  mintConfirmed,
      mintSubsPending:    mintTotal - mintConfirmed,
      metaSubsConfirmed:  metaConfirmed,
      metaSubsPending:    metaTotal - metaConfirmed,
      totalSubs:          mintTotal + metaTotal,
      totalSubsCap:       MAX_TOTAL_SUBSCRIPTIONS,
      totalNotifications: this.totalNotifications,
      sessionAgeSeconds:  Math.floor(sessionAge),
      estimatedCreditsPerDay,
      topMintsByNotifications,
    };
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

  /**
   * Close the WebSocket and pause all subscriptions until the hourly Helius
   * credit window resets. Called when _consumeHC returns false for a
   * logsNotification — at that point the in-process budget is exhausted, but
   * the WebSocket stays OPEN and Helius keeps DELIVERING (and BILLING) every
   * subsequent notification. The only way to stop the billing is to send
   * logsUnsubscribe for every active subscription and close the connection.
   *
   * After the hourly window resets this method schedules a self-restart via
   * this.connect() so monitoring resumes automatically.
   */
  private _pauseForBudget(): void {
    // Already paused — don't double-schedule
    if (Date.now() < this.budgetPausedUntilMs) return;

    const g = globalThis as any;
    const h = g.__heliusHourly__;
    const resetsIn = h
      ? Math.max(0, (h.window + 3_600_000) - Date.now())
      : 3_600_000;
    const resumeAt = Date.now() + resetsIn + 10_000;
    this.budgetPausedUntilMs = resumeAt;

    const resetsInMin = Math.ceil(resetsIn / 60_000);
    console.warn(
      `[PostLaunchWatcher] ⛔ Hourly budget exhausted — closing WebSocket to stop Helius billing. ` +
      `Active subscriptions will be restored at ${new Date(resumeAt).toISOString()} ` +
      `(~${resetsInMin} min). Set HELIUS_HOURLY_BUDGET in Railway Variables to raise the cap.`,
    );

    this.stopHeartbeat();
    try { this.ws?.close(); } catch { /* ignore */ }
    // ws.close() fires the 'close' event → scheduleReconnect() → sees
    // budgetPausedUntilMs in the future → returns early (no reconnect loop).

    setTimeout(() => {
      this.budgetPausedUntilMs = 0;
      if (!this.running) return; // externally stopped while paused
      this.reconnectAttempts = 0;
      console.log(
        "[PostLaunchWatcher] Hourly budget window reset — resuming WebSocket subscriptions.",
      );
      this.connect();
    }, resetsIn + 10_000);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    // Budget pause in effect — _pauseForBudget() has already scheduled a
    // delayed restart. Do NOT reconnect now; that would reopen the WebSocket
    // and resume Helius billing before the window resets.
    if (Date.now() < this.budgetPausedUntilMs) return;

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
