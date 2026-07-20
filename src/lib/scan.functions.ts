import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildScanResult } from "./scan-core";
import type { Trade } from "@/services/analysis";
import { runDeveloperHistory } from "@/services/analysis/developerHistory";
import { analyzeHoneyPot } from "./honeypot";
import type { ScanResult } from "./mockScan";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PostLaunchWatcher } from "./postLaunchWatcher";
import { simulateAndAnalyze } from "@/services/analysis/transactionSimulator";
import { analyzeRentExemption, type AccountRentInfo, type RentMonitorResult } from "@/services/analysis/rentMonitor";
import { analyzeArithmeticSafety, type ArithmeticSafetyResult } from "@/services/analysis/overflowMonitor";


const HELIUS_KEY = () => process.env.HELIUS_API_KEY ?? "";
const RPC_URL = () =>
  HELIUS_KEY()
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY()}`
    : "https://api.mainnet-beta.solana.com";

async function rpc<T = any>(method: string, params: any[]): Promise<T | null> {
  // Inline Helius credit budget guard — shared via globalThis with PostLaunchWatcher
  // and wallet-collection-worker. User-triggered scans must not bypass the hourly cap.
  if (HELIUS_KEY()) {
    const g = globalThis as any;
    const now = Date.now();
    if (!g.__heliusHourly__ || now - g.__heliusHourly__.window >= 3_600_000) {
      g.__heliusHourly__ = {
        budget: parseInt(process.env.HELIUS_HOURLY_BUDGET ?? "0", 10) || 0,
        used:   0,
        window: now,
        warned: false,
      };
    }
    const h = g.__heliusHourly__;
    if (h.budget > 0 && h.used + 1 > h.budget) {
      if (!h.warned) {
        h.warned = true;
        const resetsIn = Math.ceil((h.window + 3_600_000 - now) / 60_000);
        console.warn(
          `[HeliusBudget] ⚠️  Hourly cap reached — blocking scan RPC "${method}". ` +
          `Resets in ~${resetsIn} min. Raise HELIUS_HOURLY_BUDGET in Railway Variables.`,
        );
      }
      return null;
    }
    if (h.budget > 0) h.used += 1;

    if (!g.__heliusBudget__ || now - g.__heliusBudget__.day >= 86_400_000) {
      g.__heliusBudget__ = {
        budget: parseInt(process.env.HELIUS_DAILY_BUDGET ?? "0", 10) || 0,
        used:   0,
        day:    now,
        warned: false,
      };
    }
    const b = g.__heliusBudget__;
    if (b.budget > 0 && b.used + 1 > b.budget) {
      if (!b.warned) {
        b.warned = true;
        console.warn(
          `[HeliusBudget] ⚠️  Daily budget exhausted — blocking scan RPC "${method}". ` +
          `Raise HELIUS_DAILY_BUDGET in Railway Variables.`,
        );
      }
      return null;
    }
    if (b.budget > 0) b.used += 1;
  }

  try {
    const r = await fetch(RPC_URL(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.result ?? null) as T;
  } catch {
    return null;
  }
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, init);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/**
 * SECURITY_SUPABASE_SERVICE_ROLE_MISSING — logged at most once per process so a
 * misconfigured deployment can't spam the logs on every scan request.
 */
let _loggedMissingServiceRoleKey = false;

/**
 * Build a server-side Supabase client using the service-role key so we can
 * read is_authority_transitioned without RLS restrictions.
 *
 * SECURITY: privileged DB access requires SUPABASE_SERVICE_ROLE_KEY. There is
 * no anon-key fallback — after the RLS hardening migration, anon-key writes
 * are rejected by Postgres anyway, so silently falling back to it only masked
 * the real misconfiguration. When the service-role key is unavailable, this
 * logs a single CRITICAL, tagged message and returns null so every existing
 * call site continues down its current "database unavailable" path — the
 * scan itself is never aborted or thrown from here.
 */
function getSupabaseServer() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!url || !key) {
    if (!_loggedMissingServiceRoleKey) {
      _loggedMissingServiceRoleKey = true;
      console.error(
        "[SECURITY_SUPABASE_SERVICE_ROLE_MISSING] [scanToken] CRITICAL: " +
        "SUPABASE_SERVICE_ROLE_KEY is not set (or SUPABASE_URL is missing). " +
        "Privileged scan_history reads/writes will be skipped for the remainder " +
        "of this process — scans continue without DB enrichment. " +
        `SUPABASE_URL=${url ? "SET" : "MISSING"} SUPABASE_SERVICE_ROLE_KEY=${key ? "SET" : "MISSING"}. ` +
        "Set SUPABASE_SERVICE_ROLE_KEY in Railway → Variables to restore full scan history persistence.",
      );
    }
    return null;
  }

  return supabaseAdmin;
}

/**
 * Look up the is_authority_transitioned flag for a given mint in scan_history.
 * Returns false when the DB is unavailable or the mint has never been scanned.
 */
async function fetchAuthorityTransitionStatus(
  mintAddress: string,
): Promise<{ detected: boolean; authorityType?: string; signature?: string; detectedAt?: string }> {
  const sb = getSupabaseServer();
  if (!sb) return { detected: false };

  try {
    const { data } = await sb
      .from("scan_history")
      .select("is_authority_transitioned")
      .eq("token_address", mintAddress)
      .eq("is_authority_transitioned", true)
      .limit(1)
      .maybeSingle();

    console.log(`[scanToken] is_authority_transitioned DB lookup for ${mintAddress}:`, data);
    return { detected: !!data };
  } catch {
    return { detected: false };
  }
}

/**
 * Look up the is_metadata_hijacked flag for a given mint in scan_history.
 *
 * Returns true when PostLaunchWatcher previously detected a post-launch
 * UpdateMetadataAccount / UpdateV1 / SetAndVerifyCollection instruction
 * on this mint and persisted the flag to the DB.
 */
async function fetchMetadataHijackedStatus(
  mintAddress: string,
): Promise<boolean> {
  const sb = getSupabaseServer();
  if (!sb) return false;
  try {
    const { data, error } = await sb
      .from("scan_history")
      .select("is_metadata_hijacked")
      .eq("token_address", mintAddress)
      .eq("is_metadata_hijacked", true)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`[scanToken] is_metadata_hijacked fetch error for ${mintAddress}:`, error.message);
      return false;
    }
    const detected = !!data;
    console.log(`[scanToken] is_metadata_hijacked RESULT for ${mintAddress}: detected=${detected}`);
    return detected;
  } catch (err) {
    console.error(`[scanToken] is_metadata_hijacked unexpected error for ${mintAddress}:`, err);
    return false;
  }
}

/**
 * Look up the is_account_resized flag for a given mint in scan_history.
 *
 * When TRUE, scan-core enforces globalRiskScore >= 95 (Critical Risk) and
 * renders an "Account Storage Tampered" Critical Red Alert in the UI.
 * This is the HIGHEST-priority scoring override — it overrides all other floors.
 *
 * Returns false when the DB is unavailable or the mint has never been scanned.
 * Cache is intentionally bypassed: every scan always re-queries so that a TRUE
 * set by PostLaunchWatcher is immediately reflected without a stale cache hit.
 */
async function fetchAccountResizedStatus(
  mintAddress: string,
): Promise<{ detected: boolean; account?: string; ownerProgram?: string; oldLength?: number | null; newLength?: number; source?: "system_allocate" | "system_allocate_with_seed" | "realloc_syscall"; signature?: string; detectedAt?: string }> {
  const sb = getSupabaseServer();
  if (!sb) {
    console.log(`[scanToken] is_account_resized: Supabase client unavailable — skipping DB lookup for ${mintAddress}`);
    return { detected: false };
  }

  try {
    const { data, error } = await sb
      .from("scan_history")
      .select("is_account_resized")
      .eq("token_address", mintAddress)
      .eq("is_account_resized", true)
      .limit(1)
      .maybeSingle();

    console.log(
      `[scanToken] is_account_resized DB lookup for ${mintAddress}:`,
      { data, error: error?.message ?? null },
    );

    if (error) {
      console.error(`[scanToken] is_account_resized fetch error for ${mintAddress}:`, error.message);
      return { detected: false };
    }

    const detected = !!data;
    console.log(`[scanToken] is_account_resized RESULT for ${mintAddress}: detected=${detected}`);
    return { detected };
  } catch (err) {
    console.error(`[scanToken] is_account_resized unexpected error for ${mintAddress}:`, err);
    return { detected: false };
  }
}

/**
 * Look up the latest is_path_obfuscated / cpi_depth pair for a mint in
 * scan_history. Used by the 'Transaction Bloat & Re-routing' Monitor.
 *
 * Returns { cpiDepth: 0, detected: false } when the DB is unavailable or
 * the mint has never been flagged by PostLaunchWatcher.
 */
async function fetchPathObfuscationStatus(
  mintAddress: string,
): Promise<{ detected: boolean; cpiDepth: number; signature?: string; detectedAt?: string }> {
  const sb = getSupabaseServer();
  if (!sb) return { detected: false, cpiDepth: 0 };
  try {
    const { data, error } = await sb
      .from("scan_history")
      .select("is_path_obfuscated, cpi_depth, scanned_at")
      .eq("token_address", mintAddress)
      .order("cpi_depth", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(
        `[scanToken] is_path_obfuscated fetch error for ${mintAddress}:`,
        error.message,
      );
      return { detected: false, cpiDepth: 0 };
    }
    const row = (data ?? {}) as { is_path_obfuscated?: boolean; cpi_depth?: number; scanned_at?: string };
    const cpiDepth = Number(row.cpi_depth ?? 0);
    const detected = !!row.is_path_obfuscated || cpiDepth >= 3;
    console.log(
      `[scanToken] is_path_obfuscated RESULT for ${mintAddress}: detected=${detected} cpiDepth=${cpiDepth}`,
    );
    return { detected, cpiDepth, detectedAt: row.scanned_at };
  } catch (err) {
    console.error(`[scanToken] is_path_obfuscated unexpected error for ${mintAddress}:`, err);
    return { detected: false, cpiDepth: 0 };
  }
}

/**
 * Look up the latest is_cpi_manipulated / cpi_risk_details pair for a mint
 * in scan_history. Powers the 'CPI Manipulation' Detector override.
 *
 * Returns { is_cpi_manipulated: false } when the DB is unavailable or
 * the column doesn't exist yet (pre-migration).
 */
async function fetchCpiManipulationStatus(mintAddress: string): Promise<{
  is_cpi_manipulated: boolean;
  suspiciousProgramIds: string[];
  trustedProgramIds: string[];
  cpi_risk_details: string;
}> {
  const empty = {
    is_cpi_manipulated: false,
    suspiciousProgramIds: [] as string[],
    trustedProgramIds: [] as string[],
    cpi_risk_details: "",
  };
  const sb = getSupabaseServer();
  if (!sb) return empty;
  try {
    const { data, error } = await sb
      .from("scan_history")
      .select("is_cpi_manipulated, cpi_risk_details, scanned_at")
      .eq("token_address", mintAddress)
      .order("scanned_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(
        `[scanToken] is_cpi_manipulated fetch error for ${mintAddress}:`,
        error.message,
      );
      return empty;
    }
    const row = (data ?? {}) as {
      is_cpi_manipulated?: boolean;
      cpi_risk_details?: string | null;
    };
    if (!row.is_cpi_manipulated) return empty;
    // Try to extract programIds from the details string (best effort).
    const text = row.cpi_risk_details ?? "";
    const ids = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
    console.log(
      `[scanToken] is_cpi_manipulated RESULT for ${mintAddress}: TRUE (${ids.length} suspicious)`,
    );
    return {
      is_cpi_manipulated: true,
      suspiciousProgramIds: ids,
      trustedProgramIds: [],
      cpi_risk_details: text,
    };
  } catch (err) {
    console.error(`[scanToken] is_cpi_manipulated unexpected error for ${mintAddress}:`, err);
    return empty;
  }
}

/**
 * Phase 14 — fetch the latest is_state_hijacked / state_hijack_details
 * for a mint from scan_history. Powers the 'State Hijacking' Detector
 * critical-risk override and the "PDA Integrity" UI panel.
 *
 * Returns { is_state_hijacked: false } when the DB is unavailable or
 * the column doesn't exist yet (pre-migration).
 */
async function fetchStateHijackStatus(mintAddress: string): Promise<{
  is_state_hijacked: boolean;
  state_hijack_details: string;
  findings: Array<{
    programId: string;
    programName: string;
    accountLabel: string;
    expectedAddress: string;
    providedAddress: string;
  }>;
}> {
  const empty = {
    is_state_hijacked: false,
    state_hijack_details: "",
    findings: [] as Array<{
      programId: string;
      programName: string;
      accountLabel: string;
      expectedAddress: string;
      providedAddress: string;
    }>,
  };
  const sb = getSupabaseServer();
  if (!sb) return empty;
  try {
    const { data, error } = await sb
      .from("scan_history")
      .select("is_state_hijacked, state_hijack_details, scanned_at")
      .eq("token_address", mintAddress)
      .order("scanned_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(
        `[scanToken] is_state_hijacked fetch error for ${mintAddress}:`,
        error.message,
      );
      return empty;
    }
    const row = (data ?? {}) as {
      is_state_hijacked?: boolean;
      state_hijack_details?: string | null;
    };
    if (!row.is_state_hijacked) return empty;
    const text = row.state_hijack_details ?? "";
    // Parse "<program> <slot>: expected <addr> but got <addr>" entries.
    const findings = text
      .split("|")
      .map((s) => s.trim())
      .map((entry) => {
        const m = entry.match(
          /^(.*?)\s+(\S+):\s+expected\s+(\S+)\s+but\s+got\s+(\S+)$/i,
        );
        if (!m) return null;
        return {
          programId: "",
          programName: m[1].trim(),
          accountLabel: m[2].trim(),
          expectedAddress: m[3].trim(),
          providedAddress: m[4].trim(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    console.log(
      `[scanToken] is_state_hijacked RESULT for ${mintAddress}: TRUE (${findings.length} hijacked PDA(s))`,
    );
    return {
      is_state_hijacked: true,
      state_hijack_details: text,
      findings,
    };
  } catch (err) {
    console.error(
      `[scanToken] is_state_hijacked unexpected error for ${mintAddress}:`,
      err,
    );
    return empty;
  }
}


/**
 * Phase 15 — 'Atomic Execution' Exploit Monitor.
 *
 * Looks up any cached atomic exploit result for this mint in scan_history,
 * returning it if found. Otherwise returns a stub so the live simulation
 * (simulateAndAnalyze) can run fresh during the scan.
 */
async function fetchAtomicExploitStatus(mintAddress: string): Promise<{
  is_atomic_exploit: boolean;
  atomic_exploit_details: string | null;
}> {
  const empty = { is_atomic_exploit: false, atomic_exploit_details: null };
  const sb = getSupabaseServer();
  if (!sb) return empty;
  try {
    const { data, error } = await sb
      .from("scan_history")
      .select("is_atomic_exploit, atomic_exploit_details, scanned_at")
      .eq("token_address", mintAddress)
      .order("scanned_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(
        `[scanToken] is_atomic_exploit fetch error for ${mintAddress}:`,
        error.message,
      );
      return empty;
    }
    const row = (data ?? {}) as {
      is_atomic_exploit?: boolean;
      atomic_exploit_details?: string | null;
    };
    return {
      is_atomic_exploit: row.is_atomic_exploit ?? false,
      atomic_exploit_details: row.atomic_exploit_details ?? null,
    };
  } catch (err) {
    console.error(
      `[scanToken] is_atomic_exploit unexpected error for ${mintAddress}:`,
      err,
    );
    return empty;
  }
}


/**
 * Phase 16 — 'Rent-Exemption & Account Eviction' Detector.
 *
 * Strategy:
 *   1. Fetch 3 recent confirmed signatures for the mint address.
 *   2. Take the most recent non-errored signature and call getTransaction
 *      with jsonParsed encoding to obtain the full account key list.
 *   3. For each unique account (capped at 20), call getAccountInfo
 *      (base64 encoding) to read the current lamport balance and data length.
 *   4. For each unique data length, call getMinimumBalanceForRentExemption
 *      to get the minimum required lamports.
 *   5. Pass the assembled list to analyzeRentExemption (pure computation).
 */
async function fetchRentExemptionStatus(mintAddress: string): Promise<RentMonitorResult> {
  const empty: RentMonitorResult = {
    has_non_rent_exempt_accounts: false,
    violations: [],
    checkedCount: 0,
    details: "Rent exemption check not performed.",
  };

  try {
    // Step 1: Get 3 recent signatures for the mint address.
    const sigResp = await rpc<any[]>("getSignaturesForAddress", [
      mintAddress,
      { limit: 3, commitment: "confirmed" },
    ]);
    const sigs: string[] = Array.isArray(sigResp)
      ? sigResp
          .filter((s: any) => !s?.err && typeof s?.signature === "string")
          .map((s: any) => s.signature as string)
      : [];
    if (!sigs.length) return empty;

    // Step 2: Get the full transaction for the most recent signature.
    const tx = await rpc<any>("getTransaction", [
      sigs[0],
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    const rawKeys: Array<string | { pubkey?: string }> =
      tx?.transaction?.message?.accountKeys ?? [];
    const accountKeys: string[] = rawKeys
      .map((k: any) =>
        typeof k === "string" ? k : typeof k?.pubkey === "string" ? k.pubkey : "",
      )
      .filter(Boolean)
      .slice(0, 20); // cap at 20 accounts per scan

    if (!accountKeys.length) return empty;

    // Step 3: Fetch account infos in parallel.
    const infos = await Promise.all(
      accountKeys.map((key) =>
        rpc<any>("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }]).then(
          (r) => ({ key, value: r?.value ?? null }),
        ),
      ),
    );

    // Build a map from address → { lamports, dataLength, owner }.
    // The owner field is used by analyzeRentExemption to skip System Program
    // accounts ("11111111111111111111111111111111"), which are runtime-managed
    // and are never subject to rent eviction.
    const accountDataMap = new Map<string, { lamports: number; dataLength: number; owner: string }>();
    const uniqueLengths = new Set<number>();

    for (const { key, value } of infos) {
      if (!value) continue;
      const lamports = Number(value.lamports ?? 0);
      // data is base64-encoded; estimate byte length from the base64 string length.
      const dataStr: string = Array.isArray(value.data) ? (value.data[0] ?? "") : (value.data ?? "");
      // base64 length → raw bytes: floor((len * 3) / 4) minus padding chars.
      const padding = dataStr.endsWith("==") ? 2 : dataStr.endsWith("=") ? 1 : 0;
      const dataLength = Math.max(0, Math.floor((dataStr.length * 3) / 4) - padding);
      // owner is the program that owns this account (base58 string).
      const owner: string = typeof value.owner === "string" ? value.owner : "";
      accountDataMap.set(key, { lamports, dataLength, owner });
      uniqueLengths.add(dataLength);
    }

    if (accountDataMap.size === 0) return empty;

    // Step 4: Fetch the rent-exempt minimum for each unique data length.
    const minBalanceMap = new Map<number, number>();
    await Promise.all(
      Array.from(uniqueLengths).map(async (len) => {
        const min = await rpc<number>("getMinimumBalanceForRentExemption", [len]);
        if (typeof min === "number" && min > 0) {
          minBalanceMap.set(len, min);
        }
      }),
    );

    // Step 5: Assemble the AccountRentInfo list and call the analyser.
    // The owner is forwarded so analyzeRentExemption can apply the
    // System Program guard before comparing lamports vs requiredMinimum.
    const accountRentInfos: AccountRentInfo[] = [];
    for (const [address, { lamports, dataLength, owner }] of accountDataMap) {
      const requiredMinimum = minBalanceMap.get(dataLength);
      if (!requiredMinimum) continue; // skip if we couldn't fetch minimum
      accountRentInfos.push({ address, lamports, dataLength, owner, requiredMinimum });
    }

    return analyzeRentExemption(accountRentInfos);
  } catch (err) {
    console.error("[fetchRentExemptionStatus] unexpected error:", err);
    return empty;
  }
}

/**
 * Phase 17 — Integer Overflow / Underflow Monitor (v2 — Context-Aware)
 *
 * Fetches the raw account data (base64-encoded) for the token mint address via
 * `getAccountInfo`, decodes it to a Buffer, and passes it to
 * `analyzeArithmeticSafety` for the 3-phase context-aware analysis:
 *   Phase A: BPF opcode scan + Rust/Anchor pattern matching (Preliminary Risk).
 *   Phase B: Behavioral edge-case simulation (u64::MAX+1, u64::MIN-1).
 *   Phase C: Developer reputation cross-reference.
 *
 * Returns a safe fallback result (is_vulnerable: false, Status: Under Review) if
 * the account data is unavailable or cannot be decoded.
 */
async function fetchProgramBytecodeAnalysis(
  mintAddress: string,
  context: import("@/services/analysis/overflowMonitor").OverflowContextInput = {},
): Promise<ArithmeticSafetyResult> {
  const fallback: ArithmeticSafetyResult = {
    is_preliminary_risk: false,
    is_confirmed_exploit: false,
    is_vulnerable: false,
    alert_tier: "Status: Under Review",
    verification_method: "Status: Under Review",
    simulation: {
      tested: false,
      edgeCasesTested: [],
      simulationPanicked: null,
      summary: "Program bytecode not available — analysis could not be performed.",
    },
    risk_level: "none",
    message: "Program bytecode not available for analysis.",
    details: [],
    unsafe_instruction_count: 0,
    safe_instruction_count: 0,
    confidence: "medium",
    has_verified_audit: context.hasVerifiedAudit ?? false,
  };
  try {
    const info = await rpc<any>("getAccountInfo", [
      mintAddress,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const dataField = info?.value?.data;
    const dataStr: string = Array.isArray(dataField)
      ? (dataField[0] ?? "")
      : typeof dataField === "string"
        ? dataField
        : "";
    if (!dataStr) return fallback;
    const bytes = Buffer.from(dataStr, "base64");
    if (bytes.length < 8) return fallback;
    return analyzeArithmeticSafety(bytes, context);
  } catch (err) {
    console.error("[fetchProgramBytecodeAnalysis] unexpected error:", err);
    return fallback;
  }
}


/**
 * Sniper detection via Helius.
 *
 * Strategy:
 *  1. Paginate `getSignaturesForAddress` against the DEX pool address back to
 *     its oldest signatures (pool creation).
 *  2. Take the first ~25 signatures (chronologically) — these are the earliest
 *     interactions with the pool, i.e. the launch swaps.
 *  3. Parse them with Helius Enhanced Transactions to extract tokenTransfers.
 *  4. For each transfer of the target mint OUT of the pool to a user wallet,
 *     count the unique recipient wallets and sum the tokens received.
 *  5. Sniper supply % = sniper tokens / total supply * 100.
 */
async function fetchSniperStats(
  poolAddress: string,
  mint: string,
  supplyUi: number,
): Promise<{
  sniperWallets: number;
  sniperPct: number;
  analyzedSwaps: number;
  available: boolean;
}> {
  const empty = { sniperWallets: 0, sniperPct: 0, analyzedSwaps: 0, available: false };
  if (!HELIUS_KEY() || !poolAddress || !mint || supplyUi <= 0) return empty;

  // Walk back to the oldest signatures (capped to avoid runaway pagination).
  let before: string | undefined;
  let oldestBatch: any[] = [];
  for (let i = 0; i < 6; i++) {
    const batch = await rpc<any[]>("getSignaturesForAddress", [
      poolAddress,
      { limit: 1000, before },
    ]);
    if (!Array.isArray(batch) || batch.length === 0) break;
    oldestBatch = batch;
    if (batch.length < 1000) break;
    before = batch[batch.length - 1]?.signature;
    if (!before) break;
  }
  if (!oldestBatch.length) return empty;

  // getSignaturesForAddress returns newest-first; reverse last page → oldest-first.
  const earliest = oldestBatch
    .filter((s) => !s?.err)
    .slice(-25)
    .reverse();
  const sigs = earliest.map((s) => s.signature).filter(Boolean);
  if (!sigs.length) return empty;

  const parsed = await fetchJson<any[]>(
    `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: sigs }),
    },
  );
  if (!Array.isArray(parsed)) return empty;

  const buyers = new Map<string, number>();
  let analyzed = 0;
  for (const tx of parsed) {
    const transfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
    let counted = false;
    for (const t of transfers) {
      if (
        t?.mint === mint &&
        t?.toUserAccount &&
        t.toUserAccount !== poolAddress &&
        t.fromUserAccount !== t.toUserAccount
      ) {
        const amt = Number(t?.tokenAmount ?? 0);
        if (!isFinite(amt) || amt <= 0) continue;
        buyers.set(
          t.toUserAccount,
          (buyers.get(t.toUserAccount) ?? 0) + amt,
        );
        counted = true;
      }
    }
    if (counted) analyzed += 1;
  }

  const totalBought = Array.from(buyers.values()).reduce((a, b) => a + b, 0);
  const sniperPct = supplyUi > 0 ? (totalBought / supplyUi) * 100 : 0;
  return {
    sniperWallets: buyers.size,
    sniperPct,
    analyzedSwaps: analyzed,
    available: analyzed > 0,
  };
}


/**
 * Recent trade history for the advanced manipulation engine.
 *
 * Pulls the most recent signatures on the DEX pool, parses them via Helius
 * Enhanced Transactions, and converts each target-mint transfer into a Trade.
 * A transfer OUT of the pool to a wallet = buy; INTO the pool from a wallet = sell.
 */
async function fetchTradeHistory(
  poolAddress: string,
  mint: string,
): Promise<Trade[]> {
  if (!HELIUS_KEY() || !poolAddress || !mint) return [];

  const sigResp = await rpc<any[]>("getSignaturesForAddress", [
    poolAddress,
    { limit: 100 },
  ]);
  const sigs = Array.isArray(sigResp)
    ? sigResp.filter((x) => !x?.err).map((x) => x.signature).filter(Boolean).slice(0, 100)
    : [];
  if (!sigs.length) return [];

  const parsed = await fetchJson<any[]>(
    `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY()}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: sigs }),
    },
  );
  if (!Array.isArray(parsed)) return [];

  const trades: Trade[] = [];
  for (const tx of parsed) {
    const transfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
    for (const t of transfers) {
      if (t?.mint !== mint) continue;
      const amt = Number(t?.tokenAmount ?? 0);
      if (!isFinite(amt) || amt <= 0) continue;

      let side: "buy" | "sell" | null = null;
      let wallet: string | undefined;
      if (
        t.fromUserAccount === poolAddress &&
        t.toUserAccount &&
        t.toUserAccount !== poolAddress
      ) {
        side = "buy";
        wallet = t.toUserAccount;
      } else if (
        t.toUserAccount === poolAddress &&
        t.fromUserAccount &&
        t.fromUserAccount !== poolAddress
      ) {
        side = "sell";
        wallet = t.fromUserAccount;
      }
      if (!side || !wallet) continue;

      trades.push({
        signature: tx.signature,
        timestamp: (Number(tx.timestamp) || 0) * 1000,
        wallet,
        side,
        amount: amt,
        computeUnits:
          typeof tx?.meta?.computeUnitsConsumed === "number"
            ? tx.meta.computeUnitsConsumed
            : undefined,
      });
    }
  }
  return trades;
}


export const scanTokenLive = createServerFn({ method: "POST" })
  .inputValidator(z.object({ address: z.string().min(32).max(44) }))
  .handler(async ({ data }): Promise<ScanResult> => {
    const input = data.address.trim();

    // --- Resolve input to a token MINT address ---------------------------------
    async function resolveMint(addr: string): Promise<{
      mint: string;
      pairs: any[];
      resolvedFromPair: boolean;
    }> {
      const byToken = await fetchJson<any>(
        `https://api.dexscreener.com/latest/dex/tokens/${addr}`,
      );
      const tokenPairs: any[] = Array.isArray(byToken?.pairs) ? byToken.pairs : [];
      if (tokenPairs.length) {
        return { mint: addr, pairs: tokenPairs, resolvedFromPair: false };
      }

      const byPair = await fetchJson<any>(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${addr}`,
      );
      const pairList: any[] = Array.isArray(byPair?.pairs) ? byPair.pairs : [];
      let match = pairList.find(
        (p) => p?.baseToken?.address && p?.chainId === "solana",
      );

      if (!match) {
        const search = await fetchJson<any>(
          `https://api.dexscreener.com/latest/dex/search?q=${addr}`,
        );
        const sPairs: any[] = Array.isArray(search?.pairs) ? search.pairs : [];
        match = sPairs.find(
          (p) =>
            p?.chainId === "solana" &&
            (p?.pairAddress?.toLowerCase() === addr.toLowerCase() ||
              p?.baseToken?.address?.toLowerCase() === addr.toLowerCase()),
        );
      }

      if (match?.baseToken?.address) {
        const reTokens = await fetchJson<any>(
          `https://api.dexscreener.com/latest/dex/tokens/${match.baseToken.address}`,
        );
        const allPairs: any[] = Array.isArray(reTokens?.pairs)
          ? reTokens.pairs
          : [match];
        return {
          mint: match.baseToken.address,
          pairs: allPairs,
          resolvedFromPair: match.baseToken.address.toLowerCase() !== addr.toLowerCase(),
        };
      }

      return { mint: addr, pairs: [], resolvedFromPair: false };
    }

    const { mint: address, pairs, resolvedFromPair } = await resolveMint(input);

    // 1. Solana RPC — mint account (parsed) gives mint/freeze authority + supply + decimals
    const mintInfo = await rpc<any>("getAccountInfo", [
      address,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    const parsed = mintInfo?.value?.data?.parsed?.info ?? null;

    // 2. RPC — top 20 largest token accounts (used for holder concentration)
    const largest = await rpc<any>("getTokenLargestAccounts", [address]);
    const supplyResp = await rpc<any>("getTokenSupply", [address]);

    // 3. RugCheck — public risk report
    const rug = await fetchJson<any>(
      `https://api.rugcheck.xyz/v1/tokens/${address}/report`,
      { headers: { accept: "application/json" } },
    );

    // 4. Helius — DAS asset (token metadata: name/symbol/image)
    let asset: any = null;
    if (HELIUS_KEY()) {
      asset = await fetchJson<any>(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "asset",
          method: "getAsset",
          params: { id: address },
        }),
      }).then((j: any) => j?.result ?? null);
    }

    // pick highest-liquidity Solana pair
    const pair =
      pairs
        .filter((p) => p.chainId === "solana")
        .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0] ?? null;

    // 5. Helius — sniper detection on the pool's earliest swaps
    const supplyUi: number = Number(supplyResp?.value?.uiAmount ?? 0) || 0;
    const sniper = pair?.pairAddress
      ? await fetchSniperStats(pair.pairAddress, address, supplyUi)
      : null;

    // 5b. Helius — recent trade history for wash-trading / manipulation engine
    const trades = pair?.pairAddress
      ? await fetchTradeHistory(pair.pairAddress, address)
      : [];

    // 6. GoPlus — real honey-pot / sell-restriction analysis
    const honey = await analyzeHoneyPot(address, {
      freezeAuthorityActive: !!parsed?.freezeAuthority,
      mintAuthorityActive: !!parsed?.mintAuthority,
    });

    // 7. Post-launch checks + Phase 10 developer history — all run in parallel.
    //    DB lookups are always live (no cache) so flags written by PostLaunchWatcher
    //    are immediately reflected.
    const developerWallet: string | null = rug?.creator?.address ?? null;
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
    // SECURITY: developer-history lookups are a privileged read against
    // scan_history — no anon-key fallback. runDeveloperHistory() already
    // treats a missing key as "unavailable" and degrades gracefully, so this
    // reuses the same single-per-process CRITICAL log as getSupabaseServer().
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!supabaseKey && !_loggedMissingServiceRoleKey) {
      _loggedMissingServiceRoleKey = true;
      console.error(
        "[SECURITY_SUPABASE_SERVICE_ROLE_MISSING] [scanToken] CRITICAL: " +
        "SUPABASE_SERVICE_ROLE_KEY is not set. Developer-history lookups and " +
        "other privileged scan_history access will be skipped for the remainder " +
        "of this process — scans continue without DB enrichment. " +
        "Set SUPABASE_SERVICE_ROLE_KEY in Railway → Variables to restore full scan history persistence.",
      );
    }

    const [authorityTransitioned, accountResized, metadataHijacked, pathObfuscated, cpiManipulation, stateHijack, developerHistory, atomicExploitCached, atomicExploitLive, rentExempt, overflowMonitor] = await Promise.all([
      fetchAuthorityTransitionStatus(address),
      fetchAccountResizedStatus(address),
      fetchMetadataHijackedStatus(address),
      // 'Transaction Bloat & Re-routing' Monitor — CPI depth lookup.
      fetchPathObfuscationStatus(address),
      // 'CPI Manipulation' Detector — untrusted-program CPI lookup.
      fetchCpiManipulationStatus(address),
      // Phase 14: 'State Hijacking' Detector — PDA derivation mismatch lookup.
      fetchStateHijackStatus(address),
      // Phase 10: look up this developer's history across all past scans.
      runDeveloperHistory({ developerWallet, currentMint: address, supabaseUrl, supabaseKey }),
      // Phase 15: check cached atomic exploit result from DB.
      fetchAtomicExploitStatus(address),
      // Phase 15: live transaction simulation via simulateTransaction RPC.
      simulateAndAnalyze(address, HELIUS_KEY()),
      // Phase 16: 'Rent-Exemption & Account Eviction' Detector.
      fetchRentExemptionStatus(address),
      // Phase 17: 'Integer Overflow / Underflow' Monitor — 3-phase context-aware analysis.
      // Phase C (developer reputation) is applied after this Promise.all resolves,
      // because developerHistory is also resolved in this same batch.
      fetchProgramBytecodeAnalysis(address),
    ]);

    // Merge cached + live atomic exploit results: if either source flags an
    // exploit, the scan is CRITICAL. The live simulation takes precedence for
    // the instruction list; the cached flag persists across re-scans.
    const atomicExploit = atomicExploitLive.available
      ? {
          ...atomicExploitLive,
          is_atomic_exploit: atomicExploitLive.is_atomic_exploit || atomicExploitCached.is_atomic_exploit,
        }
      : atomicExploitCached.is_atomic_exploit
        ? {
            available: true,
            is_atomic_exploit: true,
            instructions: [],
            simulationError: null,
            exploitDetails: atomicExploitCached.atomic_exploit_details ?? "Exploit flag loaded from scan history.",
          }
        : atomicExploitLive;

    // Phase 17 Phase C enrichment: now that developerHistory is resolved,
    // re-apply contextual reputation to the overflow result.
    // This upgrades a CONFIRMED EXPLOIT VECTOR to "DANGER: Intentional Backdoor Detected"
    // when the developer has a "Confirmed Scammer" or "Serial Offender" history.
    const overflowDevClass = developerHistory.classification ?? "Clean";
    const isOverflowSerialScammer =
      overflowDevClass === "Confirmed Scammer" || overflowDevClass === "Serial Offender";
    const enrichedOverflowMonitor: ArithmeticSafetyResult = (() => {
      if (!overflowMonitor.is_confirmed_exploit) return overflowMonitor;
      if (isOverflowSerialScammer) {
        return {
          ...overflowMonitor,
          alert_tier: "DANGER: Intentional Backdoor Detected" as const,
          verification_method: "Verified via Simulation" as const,
          message:
            "DANGER: Intentional Backdoor — Confirmed exploit vector combined with serial scammer " +
            `developer history (${overflowDevClass}). This overflow is almost certainly a deliberate attack mechanism.`,
        };
      }
      return overflowMonitor;
    })();

    console.log(
      `[scanToken] Phase 10 developerHistory for ${address}:`,
      {
        developerWallet,
        available: developerHistory.available,
        classification: developerHistory.classification,
        priorLaunchCount: developerHistory.priorLaunchCount,
        extremeRiskCount: developerHistory.extremeRiskCount,
      },
    );

    // 7b. Derive metadata mutability from the Helius DAS `getAsset` response.
    //     asset.mutable === true  → update_authority is still active (mutable)
    //     asset.mutable === false → metadata is frozen / immutable
    //     Burn address check: if the authority === SystemProgram, treat as burned.
    const SYSTEM_PROGRAM = "11111111111111111111111111111111";
    const updateAuthority: string | null =
      (asset?.authorities as Array<{ address: string; scopes: string[] }> | undefined)?.[0]?.address ?? null;
    const isMetadataMutable: boolean =
      typeof asset?.mutable === "boolean"
        ? asset.mutable && updateAuthority !== SYSTEM_PROGRAM
        : updateAuthority !== null && updateAuthority !== SYSTEM_PROGRAM;

    console.log(`[scanToken] Post-launch flags for ${address}:`, {
      is_authority_transitioned: authorityTransitioned.detected,
      is_account_resized: accountResized.detected,
      is_metadata_hijacked: metadataHijacked,
      metadata_update_authority: updateAuthority,
      is_metadata_mutable: isMetadataMutable,
    });

    // Register the mint with the watcher (idempotent — safe to call every scan).
    if (HELIUS_KEY()) {
      try {
        PostLaunchWatcher.getInstance().trackMint(address);
      } catch {
        // Watcher not started yet — tracking is best-effort here;
        // the periodic refresh will pick it up when the watcher starts.
      }
    }

    // When is_account_resized is TRUE, bypass any TanStack Router / query cache
    // by building a fresh result every time — the score MUST be forced to >= 95.
    const result = buildScanResult({
      address,
      parsed,
      largest,
      supplyResp,
      rug,
      asset,
      pair,
      sniper,
      trades,
      honey,
      resolvedFromPair,
      originalInput: input,
      authorityTransitioned,
      accountResized: accountResized.detected ? accountResized : null,
      metadataInfo: {
        updateAuthority,
        isMetadataMutable,
        isMetadataHijacked: metadataHijacked,
      },
      // Phase 10: pass developer history to score engine.
      developerHistory,
      // 'Transaction Bloat & Re-routing' Monitor.
      pathObfuscation: pathObfuscated.detected
        ? {
            cpiDepth: pathObfuscated.cpiDepth,
            signature: pathObfuscated.signature,
            detectedAt: pathObfuscated.detectedAt,
          }
        : { cpiDepth: pathObfuscated.cpiDepth },
      // 'CPI Manipulation' Detector — forces score=100 when TRUE.
      cpiManipulation: cpiManipulation.is_cpi_manipulated
        ? {
            is_cpi_manipulated: true,
            suspiciousProgramIds: cpiManipulation.suspiciousProgramIds,
            trustedProgramIds: cpiManipulation.trustedProgramIds,
            cpi_risk_details: cpiManipulation.cpi_risk_details,
          }
        : null,
      // 'State Hijacking' Detector — forces score=100 when TRUE.
      stateHijack: stateHijack.is_state_hijacked
        ? {
            is_state_hijacked: true,
            state_hijack_details: stateHijack.state_hijack_details,
            findings: stateHijack.findings,
          }
        : null,
      // Phase 15: 'Atomic Execution' Exploit Monitor — forces score=100 when TRUE.
      atomicExploit: atomicExploit.available ? atomicExploit : null,
      // Phase 16: 'Rent-Exemption & Account Eviction' Detector.
      rentExempt,
      // Phase 17: 'Integer Overflow / Underflow' Monitor (v2 — context-enriched).
      overflowMonitor: enrichedOverflowMonitor,
    });

    // FIX (Issue 4 — scan-time threat detectors never wrote to the alerts table):
    //   CPI manipulation, state hijacking, atomic exploit, rent-exemption, and
    //   integer-overflow detectors all affect globalRiskScore in scan-core but
    //   had NO path to the `alerts` table. Only PostLaunchWatcher wrote alerts
    //   (path_obfuscation, account_data_modification, metadata_hijack). This
    //   block wires each scan-time detector to the same alerts schema so every
    //   detected threat is persisted and queryable, not just logged to console.
    //
    //   Writes are best-effort (wrapped in try/catch + .catch) so a DB hiccup
    //   can never fail the user-facing scan response.
    if (supabaseUrl && supabaseKey) {
      try {
        const sbServer = getSupabaseServer();
        if (sbServer) {
          const alertRows: Array<{
            alert_type: string;
            severity: string;
            mint_address: string;
            signature: string | null;
            payload: Record<string, unknown>;
          }> = [];

          if (cpiManipulation.is_cpi_manipulated) {
            alertRows.push({
              alert_type:   "cpi_manipulation",
              severity:     "critical",
              mint_address: address,
              signature:    null,
              payload: {
                suspiciousProgramIds: cpiManipulation.suspiciousProgramIds ?? [],
                trustedProgramIds:    cpiManipulation.trustedProgramIds ?? [],
                cpi_risk_details:     cpiManipulation.cpi_risk_details ?? null,
                detectedAt:           new Date().toISOString(),
                source:               "scan",
              },
            });
          }

          if (stateHijack.is_state_hijacked) {
            alertRows.push({
              alert_type:   "state_hijacking",
              severity:     "critical",
              mint_address: address,
              signature:    null,
              payload: {
                state_hijack_details: stateHijack.state_hijack_details ?? null,
                findings:             stateHijack.findings ?? [],
                detectedAt:           new Date().toISOString(),
                source:               "scan",
              },
            });
          }

          if (atomicExploit.available && atomicExploit.is_atomic_exploit) {
            alertRows.push({
              alert_type:   "atomic_exploit",
              severity:     "critical",
              mint_address: address,
              signature:    null,
              payload: {
                instructions:    atomicExploit.instructions ?? [],
                exploitDetails:  atomicExploit.exploitDetails ?? null,
                simulationError: atomicExploit.simulationError ?? null,
                detectedAt:      new Date().toISOString(),
                source:          "scan",
              },
            });
          }

          if (rentExempt?.has_non_rent_exempt_accounts) {
            alertRows.push({
              alert_type:   "rent_exempt_violation",
              severity:     "high",
              mint_address: address,
              signature:    null,
              payload: {
                details:    rentExempt,
                detectedAt: new Date().toISOString(),
                source:     "scan",
              },
            });
          }

          if (enrichedOverflowMonitor.is_confirmed_exploit) {
            alertRows.push({
              alert_type:   "integer_overflow",
              severity:     enrichedOverflowMonitor.alert_tier?.startsWith("DANGER") ? "critical" : "high",
              mint_address: address,
              signature:    null,
              payload: {
                alert_tier:          enrichedOverflowMonitor.alert_tier ?? null,
                message:             enrichedOverflowMonitor.message ?? null,
                verification_method: enrichedOverflowMonitor.verification_method ?? null,
                developerClass:      overflowDevClass,
                detectedAt:          new Date().toISOString(),
                source:              "scan",
              },
            });
          }

          if (alertRows.length > 0) {
            await sbServer
              .from("alerts")
              .insert(alertRows)
              .catch((e: unknown) => {
                console.error(
                  `[scanToken] alerts insert failed for ${address}:`,
                  e instanceof Error ? e.message : String(e),
                );
              });
            console.log(
              `[scanToken] Wrote ${alertRows.length} alert(s) to alerts table for ${address}: ` +
              alertRows.map((a) => a.alert_type).join(", "),
            );
          }
        }
      } catch (alertErr) {
        // Best-effort: never fail the scan due to alert persistence errors.
        console.error(
          `[scanToken] alerts write exception for ${address}:`,
          alertErr instanceof Error ? alertErr.message : String(alertErr),
        );
      }
    }

    // Phase 10: persist developer_wallet and classification to scan_history
    // so future scans of other tokens by the same developer can look this up.
    if (developerWallet && supabaseUrl && supabaseKey) {
      try {
        const sbServer = getSupabaseServer();
        if (sbServer) {
          await sbServer
            .from("scan_history")
            .update({
              developer_wallet: developerWallet,
              developer_classification: developerHistory.classification,
            })
            .eq("token_address", address)
            .order("scanned_at", { ascending: false })
            .limit(1);
        }
      } catch {
        // Best-effort: do not fail the scan if the update fails.
      }
    }

    console.log(
      `[scanToken] Final globalRiskScore for ${address}: ${result.globalRiskScore}`,
      `(is_account_resized=${result.is_account_resized}, is_metadata_mutable=${result.isMetadataMutable}, is_metadata_hijacked=${result.isMetadataHijacked})`,
    );

    return result;
  });
