import type {
  ScanResult,
  RiskLevel,
  RiskCategory,
  RedFlag,
  Verdict,
} from "./mockScan";
import type { HoneyPotReport } from "./honeypot";
import { detectManipulation, type Trade } from "@/services/analysis";
import type { WashTradingReport } from "./mockScan";


function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function level(score: number): RiskLevel {
  if (score >= 70) return "EXTREME";
  if (score >= 40) return "HIGH";
  if (score >= 20) return "MEDIUM";
  return "LOW";
}

interface RawInputs {
  address: string;
  parsed: any | null;        // Solana mint parsed info
  largest: any | null;       // getTokenLargestAccounts result
  supplyResp: any | null;    // getTokenSupply result
  rug: any | null;           // RugCheck full report
  asset: any | null;         // Helius DAS getAsset result
  pair: any | null;          // Best DexScreener pair
  sniper?: {
    sniperWallets: number;
    sniperPct: number;
    analyzedSwaps: number;
    available: boolean;
  } | null;
  honey?: HoneyPotReport | null;
  trades?: Trade[] | null;     // recent swap history for manipulation engine
  resolvedFromPair?: boolean;
  originalInput?: string;
}


/**
 * Combine live data sources into the existing ScanResult shape so the
 * UI does not need to change.
 */
export function buildScanResult(input: RawInputs): ScanResult {
  const { address, parsed, largest, supplyResp, rug, asset, pair, sniper, honey, trades, resolvedFromPair, originalInput } = input;


  // --- Authorities (Solana RPC is authoritative) ---
  const mintAuthorityRaw = parsed?.mintAuthority ?? rug?.mintAuthority ?? null;
  const freezeAuthorityRaw = parsed?.freezeAuthority ?? rug?.freezeAuthority ?? null;
  const mintActive = !!mintAuthorityRaw;
  const freezeActive = !!freezeAuthorityRaw;

  // --- Supply ---
  const decimals: number = parsed?.decimals ?? supplyResp?.value?.decimals ?? 0;
  const supplyUi: number = supplyResp?.value?.uiAmount ?? 0;

  // --- Metadata (Helius DAS > RugCheck > DexScreener > fallback) ---
  const meta = asset?.content?.metadata ?? null;
  const name: string =
    meta?.name ??
    rug?.tokenMeta?.name ??
    pair?.baseToken?.name ??
    "Unknown Token";
  const symbol: string =
    meta?.symbol ??
    rug?.tokenMeta?.symbol ??
    pair?.baseToken?.symbol ??
    "—";

  // Image + socials from DexScreener pair.info, with Helius fallback for image
  const imageUrl: string | undefined =
    pair?.info?.imageUrl ??
    asset?.content?.links?.image ??
    asset?.content?.files?.[0]?.uri ??
    meta?.image ??
    undefined;
  const websites: { label: string; url: string }[] = Array.isArray(pair?.info?.websites)
    ? pair.info.websites
        .filter((w: any) => w?.url)
        .map((w: any) => ({ label: w.label ?? "Website", url: w.url }))
    : [];
  const socials: { type: string; url: string }[] = Array.isArray(pair?.info?.socials)
    ? pair.info.socials.filter((s: any) => s?.url).map((s: any) => ({ type: s.type ?? "link", url: s.url }))
    : [];

  // --- Market data (DexScreener) ---
  const price: number = Number(pair?.priceUsd ?? 0) || 0;
  const marketCap: number = Number(pair?.marketCap ?? 0) || 0;
  const fdv: number = Number(pair?.fdv ?? 0) || marketCap;
  const liquidity: number = Number(pair?.liquidity?.usd ?? 0) || 0;
  const volume24h: number = Number(pair?.volume?.h24 ?? 0) || 0;
  const pairCreatedAt: number | null = pair?.pairCreatedAt ?? null;
  const ageDays: number = pairCreatedAt
    ? Math.max(0, Math.floor((Date.now() - pairCreatedAt) / 86_400_000))
    : 0;

  // --- Holder distribution ---
  // Prefer RugCheck (gives real holder count & topHolders %). Fall back to RPC.
  const totalHolders: number =
    Number(rug?.totalHolders ?? rug?.token?.totalHolders ?? 0) || 0;

  let top10Pct = 0;
  if (Array.isArray(rug?.topHolders) && rug.topHolders.length) {
    const top10 = rug.topHolders.slice(0, 10);
    top10Pct = top10.reduce((s: number, h: any) => s + Number(h?.pct ?? 0), 0);
    if (top10Pct <= 1.5) top10Pct = top10Pct * 100; // some endpoints return fraction
  } else if (Array.isArray(largest?.value) && supplyUi > 0) {
    const top10 = largest.value.slice(0, 10);
    const sum = top10.reduce(
      (s: number, a: any) => s + Number(a?.uiAmount ?? 0),
      0,
    );
    top10Pct = (sum / supplyUi) * 100;
  }
  top10Pct = clamp(top10Pct, 0, 100);

  // Team / insider percentages from RugCheck where available
  const teamPct: number = clamp(
    Number(rug?.creatorBalance ?? 0) && supplyUi > 0
      ? (Number(rug.creatorBalance) / (supplyUi * Math.pow(10, decimals))) * 100
      : Number(rug?.creator?.percent ?? 0),
    0,
    100,
  );
  const insiderPct: number = clamp(
    Number(rug?.insiderNetworks?.[0]?.tokenAmount ?? 0) && supplyUi > 0
      ? (Number(rug.insiderNetworks[0].tokenAmount) /
          (supplyUi * Math.pow(10, decimals))) *
          100
      : 0,
    0,
    100,
  );

  // --- LP status (RugCheck markets[].lp) ---
  const market = Array.isArray(rug?.markets) ? rug.markets[0] : null;
  const lp = market?.lp ?? null;
  const lpLockedPct = Number(lp?.lpLockedPct ?? 0);
  const lpBurnt = lpLockedPct >= 99 || !!market?.lp?.lpLocked;
  const lpUnlocked = lpLockedPct < 50 && !lpBurnt;
  const lpStatus: ScanResult["lpStatus"] = lpBurnt
    ? "Burned"
    : lpUnlocked
      ? "Unlocked"
      : "Locked";
  const lpLockDays: number = Number(lp?.lpLockedDays ?? 0) || 0;
  const lpProvider: string = market?.marketType ?? market?.pubkey?.slice(0, 6) ?? "—";

  // --- Honeypot / sell control (GoPlus token-security simulation) ---
  const risks: any[] = Array.isArray(rug?.risks) ? rug.risks : [];
  const honeyStatus = honey?.status ?? "SAFE";
  const honeyPot: Verdict =
    honeyStatus === "CONFIRMED HONEYPOT"
      ? "CONFIRMED"
      : honeyStatus === "HIGH RISK" || honeyStatus === "SUSPICIOUS"
        ? "SUSPICIOUS"
        : "SAFE";


  // --- Volume integrity ---
  // Heuristic: ratio of 24h volume to liquidity. >10x = wash-y, ~1-3x = healthy.
  const ratio = liquidity > 0 ? volume24h / liquidity : 0;
  const volumeIntegrity =
    ratio === 0
      ? 50
      : clamp(100 - Math.max(0, ratio - 3) * 6, 20, 98);

  // --- Advanced wash-trading / manipulation detection ---
  // Replaces the naive vol/liquidity ratio with a 4-layer engine when real
  // trade history is available. Falls back to the ratio heuristic otherwise.
  const tradeList: Trade[] = Array.isArray(trades) ? trades : [];
  const detection = tradeList.length >= 6 ? detectManipulation(tradeList) : null;

  const washTrading: WashTradingReport = detection
    ? {
        available: true,
        tradesAnalyzed: tradeList.length,
        anomalyScore: detection.anomalyScore,
        verdict: detection.verdict,
        patterns: detection.patterns.map((pat) => ({
          id: pat.id,
          label: pat.label,
          description: pat.description,
          weight: pat.weight,
        })),
        breakdown: detection.breakdown,
      }
    : {
        available: false,
        tradesAnalyzed: tradeList.length,
        anomalyScore: Math.round(100 - volumeIntegrity),
        verdict:
          ratio > 8
            ? "likely_manipulated"
            : ratio > 4
              ? "suspicious"
              : "clean",
        patterns: [],
        breakdown: { walletCluster: 0, tradeCadence: 0, netZero: 0, txMetadata: 0 },
      };

  // When the engine ran, let its anomaly score drive Volume Integrity so the
  // category breakdown reflects the richer analysis.
  const effectiveVolumeIntegrity = detection
    ? clamp(100 - detection.anomalyScore, 2, 100)
    : volumeIntegrity;

  // --- Sniper info (Helius-derived: first swaps after pool creation) ---
  const sniperAvailable = !!sniper?.available;
  const sniperWallets = sniperAvailable ? sniper!.sniperWallets : 0;
  const sniperPct = sniperAvailable ? clamp(sniper!.sniperPct, 0, 100) : 0;
  const sniperRisk: ScanResult["sniperRisk"] = !sniperAvailable
    ? "Unknown"
    : sniperPct >= 15
      ? "High"
      : sniperPct >= 5
        ? "Medium"
        : "Low";

  // --- Developer reputation (RugCheck creator stats if present) ---
  const creatorTokens = Number(rug?.creatorTokens?.length ?? 0);
  const verifiedScams = risks.filter((r) => r?.level === "danger").length;
  const reportedScams = risks.filter((r) => r?.level === "warn").length;
  const devTrustScore = clamp(
    100 - verifiedScams * 18 - reportedScams * 6 - (mintActive ? 10 : 0),
    0,
    100,
  );

  // --- Category scoring (mirrors original weighting) ---
  const authorityScore =
    (mintActive ? 70 : 5) + (freezeActive ? 25 : 0);
  const liquidityScore =
    lpStatus === "Unlocked"
      ? 85
      : lpStatus === "Locked"
        ? lpLockDays < 90
          ? 55
          : 25
        : 10;
  const honeypotScore =
    honeyStatus === "CONFIRMED HONEYPOT"
      ? 100
      : honeyStatus === "HIGH RISK"
        ? 80
        : honeyStatus === "SUSPICIOUS"
          ? 55
          : 8;

  const holderScore =
    Math.min(
      100,
      top10Pct + (teamPct > 10 ? 15 : 0) + (insiderPct > 8 ? 10 : 0),
    ) * 0.6;
  const volumeScore = 100 - effectiveVolumeIntegrity;
  const sniperScore = sniperAvailable ? clamp(sniperPct * 4) : 0;
  const devScore = 100 - devTrustScore;

  const categories: RiskCategory[] = [
    {
      key: "authority",
      label: "Authority Controls",
      score: clamp(authorityScore),
      weight: 0.22,
      notes: `${mintActive ? "Mint authority active." : "Mint revoked."} ${
        freezeActive ? "Freeze authority active." : "Freeze revoked."
      }`,
    },
    {
      key: "honeypot",
      label: "Honey Pot Simulation",
      score: clamp(honeypotScore),
      weight: 0.2,
      notes: honey?.available
        ? honey.reasons.length === 0
          ? "GoPlus simulation: buys and sells pass, no transfer restrictions, no excessive tax."
          : `GoPlus flagged ${honey.reasons.length} issue${honey.reasons.length === 1 ? "" : "s"}: ${honey.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}.`
        : "GoPlus unreachable — using on-chain authority signals only.",
    },

    {
      key: "liquidity",
      label: "Liquidity Lock",
      score: clamp(liquidityScore),
      weight: 0.16,
      notes:
        lpStatus === "Burned"
          ? "LP tokens burned."
          : lpStatus === "Locked"
            ? `${lpLockedPct.toFixed(0)}% LP locked.`
            : "LP unlocked — dev can pull.",
    },
    {
      key: "holders",
      label: "Holder Distribution",
      score: clamp(holderScore),
      weight: 0.12,
      notes: `Top 10 hold ${top10Pct.toFixed(1)}% of supply.`,
    },
    {
      key: "volume",
      label: "Volume Integrity",
      score: clamp(volumeScore),
      weight: 0.1,
      notes: washTrading.available
        ? `Manipulation engine analysed ${washTrading.tradesAnalyzed} swaps — anomaly score ${washTrading.anomalyScore}/100 (${washTrading.verdict.replace(/_/g, " ")}).`
        : `${effectiveVolumeIntegrity.toFixed(0)}% organic estimate (vol/liq ratio ${ratio.toFixed(2)}).`,
    },
    {
      key: "snipers",
      label: "Sniper Activity",
      score: clamp(sniperScore),
      weight: 0.1,
      notes: sniperAvailable
        ? `${sniperWallets} wallet${sniperWallets === 1 ? "" : "s"} captured ${sniperPct.toFixed(2)}% of supply in first ${sniper!.analyzedSwaps} swap${sniper!.analyzedSwaps === 1 ? "" : "s"} after launch.`
        : "Helius transaction history unavailable for this pool.",
    },
    {
      key: "dev",
      label: "Developer Reputation",
      score: clamp(devScore),
      weight: 0.1,
      notes: `${creatorTokens} known launches by creator. ${verifiedScams} danger flag${verifiedScams === 1 ? "" : "s"}.`,
    },
  ];

  // Blend RugCheck native score with our weighted score, when present.
  const ourScore = Math.round(
    categories.reduce((acc, c) => acc + c.score * c.weight, 0),
  );
  const rugScore: number | null =
    typeof rug?.score_normalised === "number"
      ? Math.round(rug.score_normalised)
      : typeof rug?.score === "number"
        ? Math.min(100, Math.round(rug.score / 10))
        : null;
  const riskScore = clamp(
    rugScore != null ? Math.round(ourScore * 0.6 + rugScore * 0.4) : ourScore,
  );
  const riskLevel = level(riskScore);

  // --- Red flags ---
  const redFlags: RedFlag[] = [];
  if (mintActive)
    redFlags.push({
      id: "mint",
      severity: "critical",
      title: "Mint authority active",
      detail: `Mint authority: ${mintAuthorityRaw}. Holder supply can be diluted.`,
    });
  if (freezeActive)
    redFlags.push({
      id: "freeze",
      severity: "high",
      title: "Freeze authority active",
      detail: `Freeze authority: ${freezeAuthorityRaw}. Sells can be blocked.`,
    });
  if (honey) {
    for (const c of honey.checks) {
      if (c.ok) continue;
      redFlags.push({
        id: `honey-${c.id}`,
        severity: c.severity,
        title: `Honey pot: ${c.label.replace(/^[A-Z]/, (m) => m.toLowerCase())} failed`,
        detail: c.detail,
      });
    }
  }

  if (lpStatus === "Unlocked")
    redFlags.push({
      id: "lp",
      severity: "critical",
      title: "Liquidity unlocked",
      detail: `Only ${lpLockedPct.toFixed(0)}% of LP is locked or burned.`,
    });
  if (top10Pct > 50)
    redFlags.push({
      id: "concentration",
      severity: "high",
      title: "Extreme holder concentration",
      detail: `Top 10 wallets hold ${top10Pct.toFixed(1)}% of supply.`,
    });
  if (washTrading.available && washTrading.anomalyScore >= 35) {
    const sev =
      washTrading.verdict === "manipulated"
        ? "critical"
        : washTrading.verdict === "likely_manipulated"
          ? "high"
          : "warn";
    const topPatterns = washTrading.patterns.slice(0, 3).map((pat) => pat.label);
    redFlags.push({
      id: "wash",
      severity: sev as RedFlag["severity"],
      title: `Wash trading / manipulation: ${washTrading.verdict.replace(/_/g, " ")}`,
      detail: `Anomaly score ${washTrading.anomalyScore}/100 across ${washTrading.tradesAnalyzed} analysed swaps.${
        topPatterns.length ? ` Patterns: ${topPatterns.join(", ")}.` : ""
      }`,
    });
  } else if (!washTrading.available && ratio > 8 && volume24h > 0) {
    redFlags.push({
      id: "wash",
      severity: "warn",
      title: "Wash trading suspected",
      detail: `Volume/liquidity ratio ${ratio.toFixed(1)} is abnormally high (trade history unavailable for deep analysis).`,
    });
  }
  if (sniperAvailable && sniperRisk === "High")
    redFlags.push({
      id: "snipers",
      severity: "high",
      title: "Heavy sniper capture at launch",
      detail: `${sniperWallets} wallets captured ${sniperPct.toFixed(2)}% of supply in the first ${sniper!.analyzedSwaps} swaps after pool creation.`,
    });
  if (sniperAvailable && sniperRisk === "Medium")
    redFlags.push({
      id: "snipers-m",
      severity: "warn",
      title: "Moderate sniper activity",
      detail: `${sniperWallets} wallets captured ${sniperPct.toFixed(2)}% of supply at launch.`,
    });
  for (const risk of risks) {
    if (risk?.level === "danger" && !redFlags.find((f) => f.title === risk.name)) {
      redFlags.push({
        id: `rug-${risk.name}`,
        severity: "high",
        title: risk.name,
        detail: risk.description ?? "Flagged by RugCheck.",
      });
    }
  }
  if (!pair)
    redFlags.push({
      id: "no-market",
      severity: "warn",
      title: "No active DEX market",
      detail: "DexScreener returned no Solana pair — token may be untradeable.",
    });
  if (resolvedFromPair && originalInput)
    redFlags.push({
      id: "resolved-pair",
      severity: "info",
      title: "Resolved pool address to token mint",
      detail: `Input ${originalInput.slice(0, 6)}… is a DEX pool. Scanned underlying token mint ${address.slice(0, 6)}… instead.`,
    });
  if (redFlags.length === 0)
    redFlags.push({
      id: "clean",
      severity: "info",
      title: "No critical flags detected",
      detail: "On-chain authority checks and RugCheck risks passed.",
    });

  const dna = clamp(
    riskScore * 0.5 + (100 - devTrustScore) * 0.3 + (lpStatus === "Unlocked" ? 12 : 0),
  );
  const serialProb: ScanResult["serialScammerProbability"] =
    verifiedScams >= 3
      ? "Confirmed Pattern"
      : verifiedScams >= 2
        ? "High"
        : verifiedScams === 1
          ? "Medium"
          : "Low";

  return {
    address,
    name,
    symbol,
    logoSeed: address.slice(0, 6),
    ageDays,
    price,
    marketCap,
    fdv,
    liquidity,
    volume24h,
    holders: totalHolders,

    riskScore,
    riskLevel,
    honeyPot,
    honeyPotStatus: honey?.status ?? (honeyPot === "CONFIRMED" ? "CONFIRMED HONEYPOT" : honeyPot === "SUSPICIOUS" ? "SUSPICIOUS" : "SAFE"),
    honeyPotReasons: honey?.reasons ?? [],
    honeyPotChecks: honey?.checks ?? [],
    honeyPotSource: honey?.source ?? "fallback",
    sellTaxPct: honey?.sellTaxPct ?? null,
    freezeAuthority: freezeActive ? "Active" : "Revoked",
    mintAuthority: mintActive ? "Active" : "Revoked",
    sellControl:
      honeyPot === "CONFIRMED"
        ? "High Risk"
        : freezeActive || mintActive
          ? "Developer Controlled"
          : "Safe",


    lpStatus,
    lpLockDays,
    lpProvider,

    top10Pct,
    teamPct,
    insiderPct,

    volumeIntegrity: Math.round(effectiveVolumeIntegrity),
    washTrading,
    sniperPct,
    sniperWallets,
    sniperRisk,

    devTrustScore,
    devTokensLaunched: creatorTokens,
    devReportedScams: reportedScams,
    devVerifiedScams: verifiedScams,

    serialScammerProbability: serialProb,
    scammerDnaScore: Math.round(dna),

    clusterId:
      "CL-" +
      (parseInt(address.slice(-6), 36) % 0xffff)
        .toString(16)
        .toUpperCase()
        .padStart(4, "0"),
    clusterWallets: Array.isArray(rug?.insiderNetworks)
      ? rug.insiderNetworks.reduce(
          (s: number, n: any) => s + Number(n?.size ?? 0),
          0,
        )
      : 0,
    clusterTokens: Math.max(1, creatorTokens),

    categories,
    redFlags,
    imageUrl,
    websites,
    socials,
    resolvedFromPair: !!resolvedFromPair,
  };
}
