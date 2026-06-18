import { supabase } from "@/integrations/supabase/client";
import type { ScanResult } from "./mockScan";

/**
 * scan_history table row shape.
 *
 * IMPORTANT — Supabase schema prerequisite for is_authority_transitioned:
 *   Run once against your Supabase project before deploying:
 *
 *   ALTER TABLE scan_history
 *     ADD COLUMN IF NOT EXISTS is_authority_transitioned BOOLEAN NOT NULL DEFAULT FALSE;
 */
export interface ScanHistoryRow {
  id: string;
  token_address: string;
  token_name: string | null;
  token_symbol: string | null;
  scanned_at: string;
  risk_score: number;
  risk_level: string;
  honey_pot_status: string;
  mint_authority: string | null;
  freeze_authority: string | null;
  liquidity: number | null;
  lp_status: string | null;
  lp_lock_days: number | null;
  market_cap: number | null;
  fdv: number | null;
  volume_24h: number | null;
  holder_count: number | null;
  top_holder_pct: number | null;
  sniper_wallets: number | null;
  sniper_pct: number | null;
  image_url: string | null;
  /**
   * True when PostLaunchWatcher has detected a SetAuthority instruction
   * (MintTokens or FreezeAccount) on this mint after its initial launch.
   * Defaults to FALSE in the DB; set to TRUE by the watcher or on re-scan.
   *
   * DB column: BOOLEAN NOT NULL DEFAULT FALSE
   */
  is_authority_transitioned: boolean;
  /**
   * True when PostLaunchWatcher has detected an account-data-length
   * modification (SystemProgram Allocate / AllocateWithSeed, or a
   * realloc-syscall pre/post delta) on an account owned by this token's
   * program after its initial launch.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_account_resized BOOLEAN NOT NULL DEFAULT FALSE;
   */
  is_account_resized: boolean;
  /**
   * The current update_authority of the token's Metaplex metadata account.
   * null  = authority not available / metadata account doesn't exist.
   * "111…" = burned (SystemProgram) — metadata is permanently immutable.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS metadata_update_authority TEXT;
   */
  metadata_update_authority: string | null;
  /**
   * True when the metadata update_authority is live (not null, not the
   * SystemProgram burn address). A +15 risk-score penalty is applied.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_metadata_mutable BOOLEAN NOT NULL DEFAULT TRUE;
   */
  is_metadata_mutable: boolean;
  /**
   * True when PostLaunchWatcher detected a post-launch UpdateMetadataAccount /
   * UpdateV1 instruction on this mint and set the flag. Triggers a Critical
   * alert in the scan result.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_metadata_hijacked BOOLEAN NOT NULL DEFAULT FALSE;
   */
  is_metadata_hijacked: boolean;

  /**
   * Phase 10: Solana base58 address of the token creator / deployer wallet.
   * Source: rug.creator.address from RugCheck API.
   * Used by the Developer History Tracker to build cross-token reputation.
   *
   * DB column (added by Phase 10 migration):
   *   ALTER TABLE scan_history ADD COLUMN IF NOT EXISTS developer_wallet TEXT;
   */
  developer_wallet: string | null;

  /**
   * Phase 10: Classification tier for this scan's developer.
   * "Clean" | "Suspicious" | "Serial Offender" | "Confirmed Scammer"
   *
   * DB column (added by Phase 10 migration):
   *   ALTER TABLE scan_history ADD COLUMN IF NOT EXISTS developer_classification TEXT;
   */
  developer_classification: string | null;

  /**
   * 'Transaction Bloat & Re-routing' Monitor flag — set TRUE when the
   * transaction processor / PostLaunchWatcher observes a tx whose
   * Cross-Program-Invocation nesting depth is >= 3.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_path_obfuscated BOOLEAN NOT NULL DEFAULT FALSE;
   */
  is_path_obfuscated: boolean;

  /**
   * Maximum CPI nesting depth observed for this mint's transactions.
   * 0 = unknown, 1 = no CPIs, ≥3 = obfuscated, 4 = Extreme Obfuscation.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS cpi_depth INTEGER NOT NULL DEFAULT 0;
   */
  cpi_depth: number;

  /**
   * 'CPI Manipulation' Detector flag — TRUE when validateCPI() found
   * a CPI invocation targeting a programId outside TRUSTED_PROGRAM_LIST.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_cpi_manipulated BOOLEAN NOT NULL DEFAULT FALSE;
   */
  is_cpi_manipulated: boolean;

  /**
   * Human-readable summary + suspicious programIds.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS cpi_risk_details TEXT;
   */
  cpi_risk_details: string | null;

  /**
   * Phase 14 — 'State Hijacking' Detector flag. TRUE when an instruction
   * referenced a PDA whose address did NOT match the canonical seed
   * derivation in KNOWN_SEED_MAPPINGS.
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS is_state_hijacked BOOLEAN NOT NULL DEFAULT FALSE;
   */
  is_state_hijacked: boolean;

  /**
   * Pipe-delimited summary of hijacked PDA findings (expected vs provided).
   *
   * DB column:
   *   ALTER TABLE scan_history
   *     ADD COLUMN IF NOT EXISTS state_hijack_details TEXT;
   */
  state_hijack_details: string | null;

  /**
   * Phase 15 — 'Atomic Execution' Exploit Monitor flag. TRUE when
   * simulateTransaction detected a Swap + authorization-modifying
   * instruction bundle in a single atomic transaction.
   *
   * DB column: BOOLEAN NOT NULL DEFAULT FALSE
   *   (see supabase/migrations/20260621000000_atomic_exploit_monitor.sql)
   */
  is_atomic_exploit: boolean;

  /**
   * Human-readable summary of the atomic exploit finding.
   * Null when no exploit was detected or the simulator did not run.
   *
   * DB column: TEXT
   */
  atomic_exploit_details: string | null;
}






export async function recordScan(result: ScanResult): Promise<void> {
  const row = {
    token_address: result.address,
    token_name: result.name,
    token_symbol: result.symbol,
    risk_score: result.riskScore,
    risk_level: result.riskLevel,
    honey_pot_status: result.honeyPotStatus,
    mint_authority: result.mintAuthority,
    freeze_authority: result.freezeAuthority,
    liquidity: result.liquidity,
    lp_status: result.lpStatus,
    lp_lock_days: result.lpLockDays,
    market_cap: result.marketCap,
    fdv: result.fdv,
    volume_24h: result.volume24h,
    holder_count: result.holders,
    top_holder_pct: result.top10Pct,
    sniper_wallets: result.sniperWallets,
    sniper_pct: result.sniperPct,
    image_url: result.imageUrl ?? null,
    is_authority_transitioned: result.is_authority_transitioned,
    is_account_resized: result.is_account_resized,
    metadata_update_authority: result.metadataUpdateAuthority ?? null,
    is_metadata_mutable: result.isMetadataMutable,
    is_metadata_hijacked: result.isMetadataHijacked,
    // Phase 10: persist developer wallet and classification for future history lookups.
    developer_wallet: result.developerHistory?.developerWallet ?? null,
    developer_classification: result.developerHistory?.classification ?? null,
    // 'Transaction Bloat & Re-routing' Monitor fields.
    is_path_obfuscated: result.is_path_obfuscated,
    cpi_depth: result.cpiDepth,
    // 'CPI Manipulation' Detector fields.
    is_cpi_manipulated: result.is_cpi_manipulated,
    cpi_risk_details: result.cpi_risk_details,
    // 'State Hijacking' Detector fields (Phase 14).
    is_state_hijacked: result.is_state_hijacked,
    state_hijack_details: result.state_hijack_details,
    // 'Atomic Execution' Exploit Monitor fields (Phase 15).
    is_atomic_exploit: result.is_atomic_exploit,
    atomic_exploit_details: result.atomic_exploit_details,
  };
  const { error } = await supabase.from("scan_history").insert(row);
  if (error) console.error("[recordScan]", error.message);
}

export async function fetchRecentScans(limit = 100): Promise<ScanHistoryRow[]> {
  const { data, error } = await supabase
    .from("scan_history")
    .select("*")
    .order("scanned_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[fetchRecentScans]", error.message);
    return [];
  }
  return (data ?? []) as ScanHistoryRow[];
}

export async function fetchTokenHistory(address: string): Promise<ScanHistoryRow[]> {
  const { data, error } = await supabase
    .from("scan_history")
    .select("*")
    .eq("token_address", address)
    .order("scanned_at", { ascending: true });
  if (error) {
    console.error("[fetchTokenHistory]", error.message);
    return [];
  }
  return (data ?? []) as ScanHistoryRow[];
}

/**
 * Fetch all scan_history rows where is_atomic_exploit is true.
 * Used by the /atomic-exploits dashboard to display historical detections.
 * Results are ordered newest-first; caller can slice or filter further.
 */
export async function fetchAtomicExploitDetections(limit = 500): Promise<ScanHistoryRow[]> {
  const { data, error } = await supabase
    .from("scan_history")
    .select("*")
    .eq("is_atomic_exploit", true)
    .order("scanned_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[fetchAtomicExploitDetections]", error.message);
    return [];
  }
  return (data ?? []) as ScanHistoryRow[];
}

/**
 * Fetch all scan_history rows where is_authority_transitioned is true.
 * Used by dashboards to display an alert list of flagged tokens.
 */
export async function fetchTransitionedTokens(): Promise<ScanHistoryRow[]> {
  const { data, error } = await supabase
    .from("scan_history")
    .select("*")
    .eq("is_authority_transitioned", true)
    .order("scanned_at", { ascending: false });
  if (error) {
    console.error("[fetchTransitionedTokens]", error.message);
    return [];
  }
  return (data ?? []) as ScanHistoryRow[];
}

/**
 * Fetch all scan_history rows where is_account_resized is true.
 * Used by dashboards to display tokens flagged for Unauthorized Account
 * Data Modification (Account Storage Tampered).
 */
export async function fetchResizedTokens(): Promise<ScanHistoryRow[]> {
  const { data, error } = await supabase
    .from("scan_history")
    .select("*")
    .eq("is_account_resized", true)
    .order("scanned_at", { ascending: false });
  if (error) {
    console.error("[fetchResizedTokens]", error.message);
    return [];
  }
  return (data ?? []) as ScanHistoryRow[];
}


export interface TokenHistorySummary {
  first: ScanHistoryRow | null;
  latest: ScanHistoryRow | null;
  highest: ScanHistoryRow | null;
  lowest: ScanHistoryRow | null;
  total: number;
}

export function summarizeHistory(rows: ScanHistoryRow[]): TokenHistorySummary {
  if (rows.length === 0)
    return { first: null, latest: null, highest: null, lowest: null, total: 0 };
  const sorted = [...rows].sort(
    (a, b) => new Date(a.scanned_at).getTime() - new Date(b.scanned_at).getTime(),
  );
  const highest = [...rows].sort((a, b) => b.risk_score - a.risk_score)[0];
  const lowest = [...rows].sort((a, b) => a.risk_score - b.risk_score)[0];
  return {
    first: sorted[0],
    latest: sorted[sorted.length - 1],
    highest,
    lowest,
    total: rows.length,
  };
}

export function riskLevelColor(level: string): string {
  switch (level) {
    case "LOW":
      return "var(--risk-low, #10b981)";
    case "MEDIUM":
      return "var(--risk-medium, #f59e0b)";
    case "HIGH":
      return "var(--risk-high, #f97316)";
    case "EXTREME":
      return "var(--risk-extreme, #ef4444)";
    default:
      return "var(--muted-foreground)";
  }
}
