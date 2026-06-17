/**
 * Developer History Tracker — Phase 10
 *
 * Queries the scan_history database for all previous token launches by the
 * same developer/creator wallet address. Builds a persistent reputation
 * profile based on the developer's track record across all tokens.
 *
 * How it works:
 *   1. The developer wallet is extracted from the RugCheck creator field
 *      during every scan and stored in scan_history.developer_wallet.
 *   2. On each new scan, this module queries scan_history for all OTHER
 *      tokens by the same wallet to build a cross-token risk profile.
 *   3. Each past token is classified as: safe / suspicious / high_risk / rugged.
 *   4. The developer is given a classification tier:
 *      "Clean"             — 0 high-risk or rugged tokens
 *      "Suspicious"        — 1 high-risk (MEDIUM/HIGH) prior token
 *      "Serial Offender"   — 2+ high-risk OR 1+ EXTREME-risk prior tokens
 *      "Confirmed Scammer" — 3+ EXTREME-risk prior tokens, or 1+ verified
 *                            honeypot confirmed in a prior scan
 *
 * Risk integration (scan-core.ts):
 *   "Confirmed Scammer" → globalRiskScore floored to ≥ 80
 *   "Serial Offender"   → globalRiskScore floored to ≥ 60
 *   "Suspicious"        → globalRiskScore + 15
 *
 * DB prerequisite:
 *   Run supabase/migrations/[phase10].sql to add the developer_wallet column
 *   and index to scan_history before deploying this feature.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeveloperClassification =
  | "Clean"
  | "Suspicious"
  | "Serial Offender"
  | "Confirmed Scammer";

export interface PriorTokenRecord {
  /** Token mint address. */
  tokenAddress: string;
  /** Token name, if stored. */
  tokenName: string | null;
  /** Token symbol, if stored. */
  tokenSymbol: string | null;
  /** Risk level at time of last scan. */
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "EXTREME" | string;
  /** Risk score 0–100. */
  riskScore: number;
  /** Honeypot status. */
  honeyPotStatus: string | null;
  /** LP status (Burned / Locked / Unlocked). */
  lpStatus: string | null;
  /** When this token was scanned. */
  scannedAt: string;
  /** Derived classification of this past token. */
  tokenRisk: "safe" | "suspicious" | "high_risk" | "rugged";
}

export interface DeveloperHistoryResult {
  /** False when Supabase is unavailable or developer wallet is unknown. */
  available: boolean;

  /** Developer wallet address that was queried. */
  developerWallet: string | null;

  /** Total number of prior token launches found in DB (excluding current token). */
  priorLaunchCount: number;

  /** How many prior tokens scored MEDIUM or higher. */
  suspiciousCount: number;

  /** How many prior tokens scored HIGH or EXTREME. */
  highRiskCount: number;

  /** How many prior tokens scored EXTREME (potential rug). */
  extremeRiskCount: number;

  /** How many prior tokens were confirmed honeypots. */
  confirmedHoneypotCount: number;

  /** Ordered list of prior tokens found (newest first, capped at 10). */
  priorTokens: PriorTokenRecord[];

  /** Final developer classification tier. */
  classification: DeveloperClassification;

  /**
   * Risk score contribution (0–100, higher = more dangerous).
   * Used by scan-core to apply floors and penalties.
   */
  riskContribution: number;

  /** Human-readable explanation for the UI. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Supabase row shape (only the fields we use)
// ---------------------------------------------------------------------------

interface ScanHistoryRow {
  token_address: string;
  token_name: string | null;
  token_symbol: string | null;
  risk_score: number;
  risk_level: string;
  honey_pot_status: string | null;
  lp_status: string | null;
  scanned_at: string;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function classifyTokenRisk(row: ScanHistoryRow): PriorTokenRecord["tokenRisk"] {
  const level = (row.risk_level ?? "").toUpperCase();
  const honey = (row.honey_pot_status ?? "").toUpperCase();
  if (honey === "CONFIRMED HONEYPOT" || level === "EXTREME") return "rugged";
  if (level === "HIGH") return "high_risk";
  if (level === "MEDIUM") return "suspicious";
  return "safe";
}

function buildClassification(
  extremeRiskCount: number,
  highRiskCount: number,
  suspiciousCount: number,
  confirmedHoneypotCount: number,
): DeveloperClassification {
  if (confirmedHoneypotCount >= 1 || extremeRiskCount >= 3) {
    return "Confirmed Scammer";
  }
  if (extremeRiskCount >= 1 || highRiskCount >= 2) {
    return "Serial Offender";
  }
  if (highRiskCount >= 1 || suspiciousCount >= 2) {
    return "Suspicious";
  }
  return "Clean";
}

function buildRiskContribution(classification: DeveloperClassification, extremeRiskCount: number): number {
  switch (classification) {
    case "Confirmed Scammer":
      return Math.min(100, 80 + extremeRiskCount * 4);
    case "Serial Offender":
      return 60;
    case "Suspicious":
      return 35;
    default:
      return 0;
  }
}

function buildSummary(
  classification: DeveloperClassification,
  priorLaunchCount: number,
  extremeRiskCount: number,
  highRiskCount: number,
  confirmedHoneypotCount: number,
  developerWallet: string | null,
): string {
  const walletShort = developerWallet ? `${developerWallet.slice(0, 8)}…` : "Unknown wallet";

  if (priorLaunchCount === 0) {
    return `No prior token launches found for ${walletShort}. This appears to be a first-time deployer — history inconclusive.`;
  }

  switch (classification) {
    case "Confirmed Scammer":
      return (
        `🚨 CONFIRMED SCAMMER: Developer wallet ${walletShort} has deployed ` +
        `${priorLaunchCount} prior token${priorLaunchCount === 1 ? "" : "s"}, with ` +
        `${extremeRiskCount} scoring EXTREME risk` +
        (confirmedHoneypotCount > 0 ? ` and ${confirmedHoneypotCount} confirmed honeypot${confirmedHoneypotCount === 1 ? "" : "s"}` : "") +
        `. This is a serial scam pattern — do not invest.`
      );
    case "Serial Offender":
      return (
        `⚠️ SERIAL OFFENDER: Developer wallet ${walletShort} has ${priorLaunchCount} prior ` +
        `token${priorLaunchCount === 1 ? "" : "s"}, with ${highRiskCount + extremeRiskCount} scoring HIGH or EXTREME risk. ` +
        `Repeat high-risk behaviour strongly suggests intentional rug-pull activity.`
      );
    case "Suspicious":
      return (
        `Developer wallet ${walletShort} has ${priorLaunchCount} prior ` +
        `token${priorLaunchCount === 1 ? "" : "s"} on record, with ${highRiskCount} ` +
        `scoring HIGH risk. Treat with caution.`
      );
    default:
      return (
        `Developer wallet ${walletShort} has ${priorLaunchCount} prior ` +
        `token${priorLaunchCount === 1 ? "" : "s"} on record — no high-risk patterns detected. ` +
        `History looks clean.`
      );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run developer history lookup for a token's creator wallet.
 *
 * @param developerWallet  The creator/deployer wallet address (from rug.creator.address)
 * @param currentMint      The mint address being scanned — excluded from results
 * @param supabaseUrl      Supabase project URL
 * @param supabaseKey      Supabase service-role or anon key
 */
export async function runDeveloperHistory(params: {
  developerWallet: string | null;
  currentMint: string;
  supabaseUrl: string;
  supabaseKey: string;
}): Promise<DeveloperHistoryResult> {
  const { developerWallet, currentMint, supabaseUrl, supabaseKey } = params;

  const unavailable: DeveloperHistoryResult = {
    available: false,
    developerWallet,
    priorLaunchCount: 0,
    suspiciousCount: 0,
    highRiskCount: 0,
    extremeRiskCount: 0,
    confirmedHoneypotCount: 0,
    priorTokens: [],
    classification: "Clean",
    riskContribution: 0,
    summary: developerWallet
      ? `Developer history lookup unavailable for ${developerWallet.slice(0, 8)}….`
      : "Developer wallet address unknown — history lookup skipped.",
  };

  if (!developerWallet || !supabaseUrl || !supabaseKey) {
    return unavailable;
  }

  try {
    // Query scan_history for all tokens by this developer (excluding current scan).
    // We use the REST API directly to avoid importing the full Supabase SDK here —
    // this module has no external deps and works in both server and edge environments.
    const url = new URL(`${supabaseUrl}/rest/v1/scan_history`);
    url.searchParams.set("developer_wallet", `eq.${developerWallet}`);
    url.searchParams.set("token_address", `neq.${currentMint}`);
    url.searchParams.set(
      "select",
      "token_address,token_name,token_symbol,risk_score,risk_level,honey_pot_status,lp_status,scanned_at",
    );
    url.searchParams.set("order", "scanned_at.desc");
    url.searchParams.set("limit", "50");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    let rows: ScanHistoryRow[] = [];
    try {
      const res = await fetch(url.toString(), {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return unavailable;
      rows = await res.json();
      if (!Array.isArray(rows)) return unavailable;
    } catch {
      clearTimeout(timeout);
      return unavailable;
    }

    // De-duplicate by token_address (keep the most-recent scan per token).
    const seen = new Set<string>();
    const uniqueRows: ScanHistoryRow[] = [];
    for (const row of rows) {
      if (!seen.has(row.token_address)) {
        seen.add(row.token_address);
        uniqueRows.push(row);
      }
    }

    const priorTokens: PriorTokenRecord[] = uniqueRows.slice(0, 10).map((row) => ({
      tokenAddress: row.token_address,
      tokenName: row.token_name,
      tokenSymbol: row.token_symbol,
      riskLevel: row.risk_level,
      riskScore: row.risk_score,
      honeyPotStatus: row.honey_pot_status,
      lpStatus: row.lp_status,
      scannedAt: row.scanned_at,
      tokenRisk: classifyTokenRisk(row),
    }));

    // Aggregate counts using ALL uniqueRows (not just the capped 10).
    let suspiciousCount = 0;
    let highRiskCount = 0;
    let extremeRiskCount = 0;
    let confirmedHoneypotCount = 0;

    for (const row of uniqueRows) {
      const risk = classifyTokenRisk(row);
      if (risk === "rugged") {
        extremeRiskCount++;
        if ((row.honey_pot_status ?? "").toUpperCase() === "CONFIRMED HONEYPOT") {
          confirmedHoneypotCount++;
        }
      } else if (risk === "high_risk") {
        highRiskCount++;
      } else if (risk === "suspicious") {
        suspiciousCount++;
      }
    }

    const priorLaunchCount = uniqueRows.length;
    const classification = buildClassification(
      extremeRiskCount,
      highRiskCount,
      suspiciousCount,
      confirmedHoneypotCount,
    );
    const riskContribution = buildRiskContribution(classification, extremeRiskCount);
    const summary = buildSummary(
      classification,
      priorLaunchCount,
      extremeRiskCount,
      highRiskCount,
      confirmedHoneypotCount,
      developerWallet,
    );

    return {
      available: true,
      developerWallet,
      priorLaunchCount,
      suspiciousCount,
      highRiskCount,
      extremeRiskCount,
      confirmedHoneypotCount,
      priorTokens,
      classification,
      riskContribution,
      summary,
    };
  } catch {
    return unavailable;
  }
}
