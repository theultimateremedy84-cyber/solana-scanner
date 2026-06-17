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
