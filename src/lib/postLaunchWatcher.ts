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

/**
 * SetAuthority instruction discriminant in the SPL Token program.
 * Layout: [6, authority_type (u8), option<new_authority> (1 + 32 bytes)]
 */
const SET_AUTHORITY_DISCRIMINANT = 6;

/**
 * Authority type bytes inside the SetAuthority instruction.
 *   0 = MintTokens   — controls unlimited supply inflation
 *   1 = FreezeAccount — controls per-account freeze ability
 */
const AUTHORITY_TYPE_MINT_TOKENS = 0;
const AUTHORITY_TYPE_FREEZE_ACCOUNT = 1;

/** How long (ms) to wait before reconnecting after a WebSocket close. */
const RECONNECT_DELAY_MS = 5_000;

/** Maximum reconnect attempts before giving up and logging a fatal error. */
const MAX_RECONNECT_ATTEMPTS = 20;

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
  private subscriptionId: number | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private alertCallbacks: AlertCallback[] = [];

  /**
   * Set of mint addresses currently being monitored.
   * Populated by loadTrackedMints() from Supabase on start and on refresh.
   */
  private trackedMints: Set<string> = new Set();

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
      `[PostLaunchWatcher] Started — watching ${this.trackedMints.size} mints.`,
    );
  }

  /** Gracefully stop the watcher and close the WebSocket. */
  stop(): void {
    this.running = false;
    if (this.refreshIntervalHandle !== null) {
      clearInterval(this.refreshIntervalHandle);
      this.refreshIntervalHandle = null;
    }
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
    if (mintAddress) this.trackedMints.add(mintAddress);
  }

  /** Return a snapshot of currently tracked mints. */
  getTrackedMints(): ReadonlySet<string> {
    return this.trackedMints;
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

      const previous = this.trackedMints.size;
      this.trackedMints = new Set(
        (data ?? []).map((r: { token_address: string }) => r.token_address).filter(Boolean),
      );
      const delta = this.trackedMints.size - previous;
      if (delta !== 0) {
        console.log(
          `[PostLaunchWatcher] Tracked mints refreshed: ${this.trackedMints.size} (${delta >= 0 ? "+" : ""}${delta}).`,
        );
      }
    } catch (err) {
      console.error("[PostLaunchWatcher] loadTrackedMints exception:", err);
    }
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
      this.subscribe();
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      void this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      console.warn(
        `[PostLaunchWatcher] WebSocket closed (code ${event.code}). Reconnecting…`,
      );
      this.subscriptionId = null;
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", (event: Event) => {
      console.error("[PostLaunchWatcher] WebSocket error:", event);
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    /**
     * logsSubscribe with a `mentions` filter for the SPL Token Program.
     * Every transaction that invokes the Token Program will be reported,
     * regardless of which specific instruction it contains.
     */
    const subscribeMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [SPL_TOKEN_PROGRAM_ID] },
        { commitment: "confirmed" },
      ],
    });

    this.ws.send(subscribeMsg);
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Subscription confirmation — save the subscription ID.
    if (typeof msg?.result === "number" && msg?.id === 1) {
      this.subscriptionId = msg.result;
      console.log(
        `[PostLaunchWatcher] Subscribed to SPL Token Program logs (sub ID: ${this.subscriptionId}).`,
      );
      return;
    }

    // Notification — check if the log mentions SetAuthority.
    if (msg?.method !== "logsNotification") return;

    const value = msg?.params?.result?.value;
    const signature: string = value?.signature ?? "";
    const logs: string[] = Array.isArray(value?.logs) ? value.logs : [];

    if (!signature) return;

    // Fast pre-filter: only fetch the full transaction when the logs
    // contain "SetAuthority" — avoids the expensive RPC call on most txs.
    const mentionsSetAuthority = logs.some((line: string) =>
      line.includes("SetAuthority"),
    );
    if (!mentionsSetAuthority) return;

    // If the tracked-mint set is empty, nothing can match — skip.
    if (this.trackedMints.size === 0) return;

    // Fetch full transaction and extract qualifying authority transitions.
    const alerts = await extractAuthorityTransitions(
      signature,
      this.trackedMints,
      this.apiKey,
    );

    for (const alert of alerts) {
      await this.dispatchAlert(alert);
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
): Promise<PostLaunchWatcher> {
  const watcher = PostLaunchWatcher.getInstance();
  if (onAlert) watcher.onAlert(onAlert);
  await watcher.start();
  return watcher;
}
