// Deterministic mock scan data — same address always yields the same result.
// Swap with real Helius/RugCheck calls in a server function later.

import type { HoneyPotCheck, HoneyPotStatus } from "./honeypot";
export type { HoneyPotCheck, HoneyPotStatus } from "./honeypot";


export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type Verdict = "SAFE" | "SUSPICIOUS" | "CONFIRMED";
export type AuthorityStatus = "Revoked" | "Active";

export interface RedFlag {
  id: string;
  severity: "info" | "warn" | "high" | "critical";
  title: string;
  detail: string;
}

export interface RiskCategory {
  key: string;
  label: string;
  score: number; // 0–100, higher = riskier
  weight: number;
  notes: string;
}

export interface DevRiskIssue {
  /** Short name from upstream (e.g. RugCheck risk name). */
  name: string;
  /** Human-readable description of why this is flagged. */
  description: string;
  /** "warn" = reported / community-flagged, "danger" = verified scam pattern. */
  level: "warn" | "danger";
  /** Optional severity score from upstream (0–100). */
  score?: number | null;
  /** Optional supporting value (e.g. percentage, wallet) serialised to string. */
  value?: string | null;
}

export interface WashTradingPattern {
  id: string;
  label: string;
  description: string;
  weight: number; // 0–100 contribution
  evidence?: Record<string, unknown>;
}

export interface WashTradingReport {
  /** True when on-chain trade history was available and analysed. */
  available: boolean;
  /** Number of individual swaps fed into the engine. */
  tradesAnalyzed: number;
  /** 0 = clean, 100 = almost certainly manipulated. */
  anomalyScore: number;
  verdict: "clean" | "suspicious" | "likely_manipulated" | "manipulated";
  /** Detected patterns, highest weight first. */
  patterns: WashTradingPattern[];
  /** Per-layer score breakdown. */
  breakdown: {
    walletCluster: number;
    tradeCadence: number;
    netZero: number;
    txMetadata: number;
  };
}

/**
 * Per-phase breakdown of the Global Risk Score.
 * Each phase groups related risk categories and shows its normalized score,
 * relative weight, and contribution to the final score.
 */
export interface RiskPhaseBreakdown {
  /** Authority + honeypot — hard technical flags (weight 0.42) */
  onChainCode: {
    score: number;
    label: string;
    weight: number;
    contribution: number;
    driver: string;
  };
  /** Volume integrity + sniper activity, with wash-trading multiplier (weight 0.20) */
  marketBehavior: {
    score: number;
    label: string;
    weight: number;
    contribution: number;
    driver: string;
    washMultiplierApplied: boolean;
  };
  /** Liquidity lock + holder distribution (weight 0.28) */
  marketStructure: {
    score: number;
    label: string;
    weight: number;
    contribution: number;
    driver: string;
  };
  /** On-chain dev reputation blended with off-chain intent (weight 0.10) */
  developerIntent: {
    score: number;
    label: string;
    weight: number;
    contribution: number;
    driver: string;
    offChainAvailable: boolean;
  };
  /**
   * Post-launch authority transition phase.
   * Present only when a SetAuthority instruction has been detected after launch.
   * When populated this phase forces the token into Critical Risk status
   * (globalRiskScore ≥ 90) regardless of all other signals.
   */
  authorityTransition?: {
    score: number;
    label: string;
    /** Authority type that was transferred ("MintTokens" | "FreezeAccount") */
    authorityType: string;
    /** Transaction signature where the transition was detected. */
    signature: string;
    /** ISO timestamp of detection. */
    detectedAt: string;
    driver: string;
  };
  /**
   * Account-data-modification phase. Present only when PostLaunchWatcher
   * has detected a SystemProgram Allocate / AllocateWithSeed or realloc
   * syscall on an account owned by a tracked token program.
   *
   * When populated, the Risk Breakdown panel renders an "Account Storage
   * Tampered" warning and scan-core enforces a Critical Risk floor
   * (globalRiskScore ≥ 95).
   */
  accountResize?: {
    score: number;
    label: string;
    /** Affected account address. */
    account: string;
    /** Owner program of the affected account. */
    ownerProgram: string;
    /** Old data length in bytes (null when not derivable). */
    oldLength: number | null;
    /** New data length in bytes. */
    newLength: number;
    /** Detection source. */
    source: "system_allocate" | "system_allocate_with_seed" | "realloc_syscall";
    /** Transaction signature where the resize was detected. */
    signature: string;
    /** ISO timestamp of detection. */
    detectedAt: string;
    /** Short human-readable banner string for the UI. */
    warning: string;
    driver: string;
  };
  /**
   * Metadata Status phase — present on all live scans where metadata info
   * was available. Drives the "Metadata Status" panel in the Risk Breakdown UI.
   *
   * score 0  = immutable / authority burned (green).
   * score 65 = mutable (update_authority live) — +15 risk penalty applied.
   * score 100 = post-launch update detected (Critical alert).
   */
  metadataStatus?: {
    score: number;
    label: string;
    /** Current update_authority address (null when unavailable). */
    updateAuthority: string | null;
    /** True when the update_authority is live (not null, not burned). */
    isMetadataMutable: boolean;
    /** True when a post-launch UpdateMetadataAccount instruction was detected. */
    isMetadataHijacked: boolean;
    driver: string;
  };
}


export interface ScanResult {
  address: string;
  name: string;
  symbol: string;
  logoSeed: string;
  ageDays: number;
  price: number;
  marketCap: number;
  fdv: number;
  liquidity: number;
  volume24h: number;
  holders: number;

  riskScore: number;
  riskLevel: RiskLevel;

  honeyPot: Verdict;
  honeyPotStatus: HoneyPotStatus;
  honeyPotReasons: string[];
  honeyPotChecks: HoneyPotCheck[];
  honeyPotSource: "goplus" | "fallback";
  sellTaxPct: number | null;
  freezeAuthority: AuthorityStatus;
  mintAuthority: AuthorityStatus;
  sellControl: "Safe" | "Developer Controlled" | "High Risk";

  lpStatus: "Burned" | "Locked" | "Unlocked";
  lpLockDays: number;
  lpProvider: string;

  top10Pct: number;
  teamPct: number;
  insiderPct: number;

  volumeIntegrity: number; // 0–100, higher = cleaner
  washTrading: WashTradingReport;
  sniperPct: number;
  sniperWallets: number;
  sniperRisk: "Low" | "Medium" | "High" | "Unknown";

  devTrustScore: number;
  devTokensLaunched: number;
  devReportedScams: number;
  devVerifiedScams: number;
  /**
   * Rugged-token count surfaced from the wallet-cluster cross-check.
   * Always present on live scans (scan-core); optional on the mock for
   * back-compat with any older fixture.
   */
  devRuggedFromCluster?: number;
  devReportedIssues: DevRiskIssue[];
  devVerifiedIssues: DevRiskIssue[];

  serialScammerProbability: "Low" | "Medium" | "High" | "Confirmed Pattern";
  scammerDnaScore: number;

  clusterId: string;
  clusterWallets: number;
  clusterTokens: number;

  categories: RiskCategory[];
  redFlags: RedFlag[];

  // ---- Weighted Global Risk Synthesis ----
  /** Final weighted score after hard floors and multipliers (authoritative). */
  globalRiskScore: number;
  /** Data availability confidence for the scan. */
  confidenceLevel: "Low" | "Medium" | "High";
  /** One-sentence summary of the single biggest risk driver. */
  verdictSummary: string;
  /** Per-phase contribution breakdown feeding the globalRiskScore. */
  riskBreakdown: RiskPhaseBreakdown;

  // ---- Mapped data fields for frontend risk breakdown panel ----
  /** 0–100 wash-trading anomaly score from the manipulation engine. */
  washTradingScore: number;
  /** 0–100 off-chain intent risk score (0 = unavailable). */
  intentScore: number;
  /** Letter grade from the website authenticity audit (or "unavailable"). */
  websiteAuthenticityGrade: string;

  /**
   * Current update_authority of the token's metadata account.
   * null = authority not available or account doesn't exist.
   * "11111111111111111111111111111111" = burned / permanently immutable.
   */
  metadataUpdateAuthority: string | null;

  /**
   * True when the metadata update_authority is live (not null, not burned).
   * Applies a +15 risk-score penalty in the scoring engine.
   * DB column: scan_history.is_metadata_mutable BOOLEAN NOT NULL DEFAULT TRUE
   */
  isMetadataMutable: boolean;

  /**
   * True when PostLaunchWatcher detected a post-launch UpdateMetadataAccount /
   * UpdateV1 / SetAndVerifyCollection instruction on this mint.
   * Triggers a Critical alert in the redFlags array.
   * DB column: scan_history.is_metadata_hijacked BOOLEAN NOT NULL DEFAULT FALSE
   */
  isMetadataHijacked: boolean;

  /**
   * True when a post-launch SetAuthority instruction (MintTokens or FreezeAccount)
   * has been detected by the PostLaunchWatcher for this mint.
   *
   * When true, scan-core enforces a Critical Risk floor (globalRiskScore ≥ 90)
   * and adds an Immediate Red Alert to the redFlags array.
   *
   * DB column: scan_history.is_authority_transitioned BOOLEAN NOT NULL DEFAULT FALSE
   */
  is_authority_transitioned: boolean;

  /**
   * True when PostLaunchWatcher has detected an account-data-length
   * modification on an account owned by this token's program.
   * Drives the "Account Storage Tampered" warning in the Risk Breakdown panel
   * and forces a Critical Risk floor (globalRiskScore ≥ 95) in scan-core.
   *
   * DB column: scan_history.is_account_resized BOOLEAN NOT NULL DEFAULT FALSE
   */
  is_account_resized: boolean;



  // Optional enrichments from DexScreener / metadata APIs
  imageUrl?: string;
  websites?: { label: string; url: string }[];
  socials?: { type: string; url: string }[];
  resolvedFromPair?: boolean;
}

// FNV-1a hash → seeded RNG so the same address always yields the same result.
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

function range(r: () => number, min: number, max: number): number {
  return min + r() * (max - min);
}

const NAMES = [
  "Lunar Pepe", "Solbonk", "Degen Wif", "Astro Inu", "Cosmic Cat",
  "Floki Sol", "Moon Doge", "Rocket Frog", "Cyber Shiba", "Galaxy Ape",
  "Neon Pup", "Quantum Cat", "Void Wolf", "Hyper Sol", "Mega Bonk",
];
const SYMBOLS = ["LPEPE", "SBONK", "DWIF", "ASTRO", "CCAT", "FSOL", "MDOGE", "RFROG", "CSHIB", "GAPE", "NPUP", "QCAT", "VWOLF", "HSOL", "MBONK"];

function level(score: number): RiskLevel {
  if (score >= 70) return "EXTREME";
  if (score >= 40) return "HIGH";
  if (score >= 20) return "MEDIUM";
  return "LOW";
}

export function isLikelySolanaAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}

export function scanToken(address: string): ScanResult {
  const seed = hash(address);
  const r = rng(seed);
  const idx = seed % NAMES.length;

  const mintActive = r() < 0.35;
  const freezeActive = r() < 0.30;
  const lpRoll = r();
  const lpStatus: ScanResult["lpStatus"] = lpRoll < 0.45 ? "Burned" : lpRoll < 0.85 ? "Locked" : "Unlocked";
  const lpLockDays = lpStatus === "Locked" ? Math.floor(range(r, 30, 730)) : 0;

  const honeyRoll = r();
  const honeyPot: Verdict = honeyRoll < 0.08 ? "CONFIRMED" : honeyRoll < 0.22 ? "SUSPICIOUS" : "SAFE";

  const top10Pct = range(r, 15, 78);
  const teamPct = range(r, 1, 22);
  const insiderPct = range(r, 0, 18);

  const volumeIntegrity = Math.round(range(r, 35, 98));
  const sniperPct = range(r, 0.5, 38);
  const sniperWallets = Math.floor(range(r, 2, 180));

  const devTokensLaunched = Math.floor(range(r, 1, 24));
  const devReportedScams = Math.floor(range(r, 0, Math.max(1, devTokensLaunched - 1)));
  const devVerifiedScams = Math.floor(devReportedScams * range(r, 0.2, 0.9));
  const devTrustScore = Math.max(0, Math.round(100 - devVerifiedScams * 18 - devReportedScams * 6 + range(r, -10, 10)));

  const authorityScore = (mintActive ? 70 : 5) + (freezeActive ? 25 : 0);
  const liquidityScore = lpStatus === "Unlocked" ? 85 : lpStatus === "Locked" ? (lpLockDays < 90 ? 55 : 25) : 10;
  const honeypotScore = honeyPot === "CONFIRMED" ? 100 : honeyPot === "SUSPICIOUS" ? 60 : 8;
  const holderScore = Math.min(100, top10Pct + (teamPct > 10 ? 15 : 0) + (insiderPct > 8 ? 10 : 0)) * 0.6;
  const volumeScore = 100 - volumeIntegrity;
  const sniperScore = Math.min(100, sniperPct * 2.2);
  const devScore = 100 - devTrustScore;

  const categories: RiskCategory[] = [
    { key: "authority", label: "Authority Controls", score: clamp(authorityScore), weight: 0.22,
      notes: `${mintActive ? "Mint authority active." : "Mint revoked."} ${freezeActive ? "Freeze authority active." : "Freeze revoked."}` },
    { key: "honeypot", label: "Honeypot Simulation", score: clamp(honeypotScore), weight: 0.20,
      notes: honeyPot === "SAFE" ? "Sell simulation succeeded." : honeyPot === "SUSPICIOUS" ? "Sell tax > 15% or transfer restrictions." : "Sell transaction reverted." },
    { key: "liquidity", label: "Liquidity Lock", score: clamp(liquidityScore), weight: 0.16,
      notes: lpStatus === "Burned" ? "LP tokens burned." : lpStatus === "Locked" ? `Locked for ${lpLockDays}d.` : "LP unlocked — dev can pull." },
    { key: "holders", label: "Holder Distribution", score: clamp(holderScore), weight: 0.12,
      notes: `Top 10 hold ${top10Pct.toFixed(1)}% of supply.` },
    { key: "volume", label: "Volume Integrity", score: clamp(volumeScore), weight: 0.10,
      notes: `${volumeIntegrity}% organic volume estimate.` },
    { key: "snipers", label: "Sniper Activity", score: clamp(sniperScore), weight: 0.10,
      notes: `${sniperWallets} snipers captured ${sniperPct.toFixed(1)}% at launch.` },
    { key: "dev", label: "Developer Reputation", score: clamp(devScore), weight: 0.10,
      notes: `${devTokensLaunched} prior launches, ${devVerifiedScams} verified scam${devVerifiedScams === 1 ? "" : "s"}.` },
  ];

  const riskScore = Math.round(categories.reduce((acc, c) => acc + c.score * c.weight, 0));
  const washTradingScore = Math.round(100 - volumeIntegrity);

  // --- Weighted Global Risk Synthesis (mock) ---
  const onChainCodeScore = clamp(Math.round((clamp(authorityScore) * 0.22 + clamp(honeypotScore) * 0.20) / 0.42));
  const marketBehaviorScore = clamp(Math.round((clamp(volumeScore) * 0.10 + clamp(sniperScore) * 0.10) / 0.20));
  const marketStructureScore = clamp(Math.round((clamp(liquidityScore) * 0.16 + clamp(holderScore) * 0.12) / 0.28));
  const developerIntentScore = clamp(devScore);

  let globalRiskScore = clamp(Math.round(
    onChainCodeScore * 0.42 + marketBehaviorScore * 0.20 + marketStructureScore * 0.28 + developerIntentScore * 0.10,
  ));

  // Hard floor
  if (honeyPot === "CONFIRMED") globalRiskScore = Math.max(globalRiskScore, 70);

  // Liquidity-unlocked floor — unlocked LP can never be presented as LOW (green).
  if (lpStatus === "Unlocked") globalRiskScore = Math.max(globalRiskScore, 55);

  // Wash multiplier
  const washVerdict = volumeIntegrity < 40 ? "likely_manipulated" : volumeIntegrity < 60 ? "suspicious" : "clean";
  const washMultiplier = washVerdict === "likely_manipulated" ? 1.12 : washVerdict === "suspicious" ? 1.06 : 1.0;
  globalRiskScore = clamp(Math.round(globalRiskScore * washMultiplier));

  // Mock never has a detected authority transition or account resize.
  const is_authority_transitioned = false;
  const is_account_resized = false;

  // Mock metadata: deterministically flip mutability based on seed so the
  // demo surfaces both states. ~40% of mock tokens show mutable metadata.
  // No mock token ever has is_metadata_hijacked=true (only live watcher data).
  const isMetadataMutable = r() < 0.40;
  const isMetadataHijacked = false;
  const metadataUpdateAuthority: string | null = isMetadataMutable
    ? "So1anaDeVAuthoritySeedXXXXXXXXXXXXXXXXXXXXX".slice(0, 44)
    : null; // null = burned / immutable


  const riskLevel = level(globalRiskScore);

  const confidenceLevel: ScanResult["confidenceLevel"] = "Low"; // mock always low — no real data

  const verdictSummary =
    honeyPot === "CONFIRMED"
      ? "Confirmed honeypot — sells are blocked by contract; funds cannot be exited."
      : mintActive
        ? "Mint authority is active — developer can inflate supply at will, diluting all holders."
        : lpStatus === "Unlocked"
          ? "Liquidity is fully unlocked — developer can pull all funds at any time without warning."
          : devVerifiedScams >= 2
            ? `Developer linked to ${devVerifiedScams} verified scams — high probability of serial rug-pull behavior.`
            : honeyPot === "SUSPICIOUS"
              ? "Sell mechanics are suspicious — transfer restrictions or high tax may trap investors."
              : globalRiskScore >= 40
                ? "Multiple risk signals across authority, liquidity, and distribution layers."
                : "No critical flags detected — risk vectors appear within normal bounds.";

  const riskBreakdown: RiskPhaseBreakdown = {
    onChainCode: {
      score: onChainCodeScore,
      label: "On-chain Code Safety",
      weight: 0.42,
      contribution: Math.round(onChainCodeScore * 0.42),
      driver: honeyPot === "CONFIRMED" ? "Confirmed honeypot" : mintActive ? "Mint authority active" : freezeActive ? "Freeze authority active" : "Clean",
    },
    marketBehavior: {
      score: marketBehaviorScore,
      label: "Market Behavior",
      weight: 0.20,
      contribution: Math.round(marketBehaviorScore * 0.20 * washMultiplier),
      driver: washVerdict !== "clean" ? `Volume anomaly (${washVerdict.replace(/_/g, " ")})` : sniperPct > 15 ? "Heavy sniper activity" : "Clean",
      washMultiplierApplied: washMultiplier > 1,
    },
    marketStructure: {
      score: marketStructureScore,
      label: "Market Structure",
      weight: 0.28,
      contribution: Math.round(marketStructureScore * 0.28),
      driver: lpStatus === "Unlocked" ? "LP unlocked" : top10Pct > 50 ? `${top10Pct.toFixed(0)}% top-10 concentration` : "Clean",
    },
    developerIntent: {
      score: developerIntentScore,
      label: "Developer & Intent",
      weight: 0.10,
      contribution: Math.round(developerIntentScore * 0.10),
      driver: devVerifiedScams >= 1 ? `${devVerifiedScams} verified scam${devVerifiedScams === 1 ? "" : "s"}` : "Clean",
      offChainAvailable: false,
    },
    // authorityTransition absent in mock — only set by live PostLaunchWatcher.
    // metadataStatus always present so the UI panel renders in mock mode.
    metadataStatus: {
      score: isMetadataMutable ? 65 : 0,
      label: "Metadata Status",
      updateAuthority: metadataUpdateAuthority,
      isMetadataMutable,
      isMetadataHijacked,
      driver: isMetadataMutable
        ? `⚠️ Metadata is mutable (update_authority: ${metadataUpdateAuthority?.slice(0, 8) ?? "unknown"}…)`
        : "✅ Metadata is immutable / update authority burned",
    },
  };

  const redFlags: RedFlag[] = [];
  if (mintActive) redFlags.push({ id: "mint", severity: "critical", title: "Mint authority active", detail: "Developer can mint unlimited additional tokens, diluting holders." });
  if (freezeActive) redFlags.push({ id: "freeze", severity: "high", title: "Freeze authority active", detail: "Developer can freeze any holder's tokens, blocking sells." });
  if (honeyPot === "CONFIRMED") redFlags.push({ id: "honey", severity: "critical", title: "Confirmed honeypot", detail: "Sell transactions revert in simulation — funds cannot be exited." });
  if (honeyPot === "SUSPICIOUS") redFlags.push({ id: "honey-s", severity: "high", title: "Suspicious sell mechanics", detail: "High sell tax or whitelist behavior detected." });
  if (lpStatus === "Unlocked") redFlags.push({ id: "lp", severity: "critical", title: "Liquidity unlocked", detail: "LP tokens are not burned or locked — rug pull possible at any moment." });
  if (lpStatus === "Locked" && lpLockDays < 90) redFlags.push({ id: "lp-short", severity: "warn", title: "Short LP lock", detail: `LP unlocks in ${lpLockDays} days.` });
  if (top10Pct > 50) redFlags.push({ id: "concentration", severity: "high", title: "Extreme holder concentration", detail: `Top 10 wallets hold ${top10Pct.toFixed(1)}% of supply.` });
  if (sniperPct > 20) redFlags.push({ id: "snipers", severity: "warn", title: "Heavy sniper presence", detail: `${sniperPct.toFixed(1)}% captured by bots at launch.` });
  if (volumeIntegrity < 55) redFlags.push({ id: "wash", severity: "warn", title: "Wash trading suspected", detail: `Only ${volumeIntegrity}% of volume appears organic.` });
  if (devVerifiedScams >= 2) redFlags.push({ id: "serial", severity: "critical", title: "Serial scammer cluster", detail: `Developer linked to ${devVerifiedScams} verified scams.` });
  // Metadata status flag — shown on every mock token so users see both states
  if (isMetadataMutable) {
    redFlags.push({
      id: "metadata-mutable",
      severity: "warn",
      title: "⚠️ Metadata is Mutable — Name Hijacking Risk",
      detail: `The update_authority has NOT been burned. Developer can rename or re-image this token. Authority: ${metadataUpdateAuthority ?? "unknown"}.`,
    });
  }
  if (redFlags.length === 0) redFlags.push({ id: "clean", severity: "info", title: "No critical flags detected", detail: "Standard checks passed. Continue monitoring." });

  const dna = clamp(
    riskScore * 0.35 + (100 - devTrustScore) * 0.4 + devVerifiedScams * 8 + (lpStatus === "Unlocked" ? 12 : 0),
  );
  const serialProb: ScanResult["serialScammerProbability"] =
    devVerifiedScams >= 3 ? "Confirmed Pattern" : devVerifiedScams >= 2 ? "High" : devVerifiedScams === 1 ? "Medium" : "Low";

  return {
    address,
    name: NAMES[idx],
    symbol: SYMBOLS[idx],
    logoSeed: address.slice(0, 6),
    ageDays: Math.floor(range(r, 1, 420)),
    price: range(r, 0.0000001, 0.025),
    marketCap: range(r, 8_000, 18_000_000),
    fdv: range(r, 10_000, 42_000_000),
    liquidity: range(r, 2_000, 1_400_000),
    volume24h: range(r, 1_000, 9_500_000),
    holders: Math.floor(range(r, 80, 24_000)),

    riskScore,
    riskLevel,
    honeyPot,
    honeyPotStatus: honeyPot === "CONFIRMED" ? "CONFIRMED HONEYPOT" : honeyPot === "SUSPICIOUS" ? "SUSPICIOUS" : "SAFE",
    honeyPotReasons: [],
    honeyPotChecks: [],
    honeyPotSource: "fallback",
    sellTaxPct: null,
    freezeAuthority: freezeActive ? "Active" : "Revoked",
    mintAuthority: mintActive ? "Active" : "Revoked",
    sellControl: honeyPot === "CONFIRMED" ? "High Risk" : (freezeActive || mintActive) ? "Developer Controlled" : "Safe",

    lpStatus,
    lpLockDays,
    lpProvider: pick(r, ["PinkLock", "Team Finance", "Unicrypt", "Streamflow", "—"]),

    top10Pct,
    teamPct,
    insiderPct,

    volumeIntegrity,
    washTrading: {
      available: false,
      tradesAnalyzed: 0,
      anomalyScore: washTradingScore,
      verdict: washVerdict,
      patterns: volumeIntegrity < 55
        ? [{ id: "volume_liquidity_ratio", label: "Low organic-volume estimate",
            description: `Only ${volumeIntegrity}% of volume appears organic in the fallback model.`,
            weight: washTradingScore, evidence: { organicVolumeEstimate: `${volumeIntegrity}%` } }]
        : [],
      breakdown: { walletCluster: 0, tradeCadence: 0, netZero: 0, txMetadata: 0 },
    },
    sniperPct,
    sniperWallets,
    sniperRisk: "Unknown",

    devTrustScore,
    devTokensLaunched,
    devReportedScams,
    devVerifiedScams,
    devReportedIssues: [],
    devVerifiedIssues: [],

    serialScammerProbability: serialProb,
    scammerDnaScore: Math.round(dna),

    clusterId: "CL-" + (seed % 9999).toString(16).toUpperCase().padStart(4, "0"),
    clusterWallets: Math.floor(range(r, 1, 64)),
    clusterTokens: Math.max(1, devTokensLaunched),

    categories,
    redFlags,

    globalRiskScore,
    confidenceLevel,
    verdictSummary,
    riskBreakdown,
    washTradingScore,
    intentScore: 0,
    websiteAuthenticityGrade: "unavailable",

    is_authority_transitioned,
    is_account_resized,

    metadataUpdateAuthority,
    isMetadataMutable,
    isMetadataHijacked,
  };
}

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

export function riskColorVar(l: RiskLevel): string {
  return {
    LOW: "var(--risk-low)",
    MEDIUM: "var(--risk-medium)",
    HIGH: "var(--risk-high)",
    EXTREME: "var(--risk-extreme)",
  }[l];
}

export function formatUsd(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(2) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toPrecision(3);
}

export function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  return n.toString();
}
