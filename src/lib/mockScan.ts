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

  serialScammerProbability: "Low" | "Medium" | "High" | "Confirmed Pattern";
  scammerDnaScore: number;

  clusterId: string;
  clusterWallets: number;
  clusterTokens: number;

  categories: RiskCategory[];
  redFlags: RedFlag[];

  // Optional enrichments from DexScreener / metadata APIs
  imageUrl?: string;
  websites?: { label: string; url: string }[];
  socials?: { type: string; url: string }[];
  resolvedFromPair?: boolean;
}

// FNV-1a hash → seeded RNG so the same address yields the same scan.
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

  // Category scoring
  const authorityScore =
    (mintActive ? 70 : 5) + (freezeActive ? 25 : 0);
  const liquidityScore =
    lpStatus === "Unlocked" ? 85 : lpStatus === "Locked" ? (lpLockDays < 90 ? 55 : 25) : 10;
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
  const riskLevel = level(riskScore);

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
  if (redFlags.length === 0) redFlags.push({ id: "clean", severity: "info", title: "No critical flags detected", detail: "Standard checks passed. Continue monitoring." });

  const dna = clamp(
    riskScore * 0.35 + (100 - devTrustScore) * 0.4 + devVerifiedScams * 8 + (lpStatus === "Unlocked" ? 12 : 0)
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
      anomalyScore: Math.round(100 - volumeIntegrity),
      verdict:
        volumeIntegrity < 40
          ? "likely_manipulated"
          : volumeIntegrity < 60
            ? "suspicious"
            : "clean",
      patterns: volumeIntegrity < 55
        ? [
            {
              id: "volume_liquidity_ratio",
              label: "Low organic-volume estimate",
              description: `Only ${volumeIntegrity}% of volume appears organic in the fallback model.`,
              weight: Math.round(100 - volumeIntegrity),
              evidence: { organicVolumeEstimate: `${volumeIntegrity}%` },
            },
          ]
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

    serialScammerProbability: serialProb,
    scammerDnaScore: Math.round(dna),

    clusterId: "CL-" + (seed % 9999).toString(16).toUpperCase().padStart(4, "0"),
    clusterWallets: Math.floor(range(r, 1, 64)),
    clusterTokens: Math.max(1, devTokensLaunched),

    categories,
    redFlags,
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
