import type {
  ScanResult,
  RiskLevel,
  RiskCategory,
  RedFlag,
  Verdict,
  RiskPhaseBreakdown,
} from "./mockScan";
import type { HoneyPotReport } from "./honeypot";
import { detectManipulation, type Trade } from "@/services/analysis";
import type { WashTradingReport } from "./mockScan";
import type { OffChainIntelligenceResult } from "@/services/analysis/types";
import type { AuthorityMonitorResult } from "@/services/analysis/authorityMonitor";
import { computeClusterStats } from "./clusterStats";


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
  parsed: any | null;
  largest: any | null;
  supplyResp: any | null;
  rug: any | null;
  asset: any | null;
  pair: any | null;
  sniper?: {
    sniperWallets: number;
    sniperPct: number;
    analyzedSwaps: number;
    available: boolean;
  } | null;
  honey?: HoneyPotReport | null;
  trades?: Trade[] | null;
  resolvedFromPair?: boolean;
  originalInput?: string;
  offChain?: OffChainIntelligenceResult | null;
  /**
   * Result of runAuthorityMonitor (upgrade / mint / freeze authority classification).
   * When overallClassification === "Unsafe/Upgradeable", scan-core enforces a
   * MEDIUM-risk floor on globalRiskScore (min 20) so an upgradeable token can
   * never be rated LOW trust.
   */
  authority?: AuthorityMonitorResult | null;
  /**
   * Post-launch authority transition flag, populated by PostLaunchWatcher.
   *
   * When true, scan-core enforces a Critical Risk floor (globalRiskScore ≥ 90)
   * and inserts an Immediate Red Alert into the redFlags array. This is the
   * highest-priority scoring override in the engine — it overrides all other floors.
   *
   * Populated from:
   *   1. The Supabase scan_history.is_authority_transitioned column (DB lookup
   *      before building the result), OR
   *   2. A real-time notification fired by PostLaunchWatcher during the scan.
   */
  authorityTransitioned?: {
    detected: boolean;
    /** Authority type: "MintTokens" | "FreezeAccount" */
    authorityType?: string;
    /** Transaction signature where the transition was detected. */
    signature?: string;
    /** ISO timestamp of detection. */
    detectedAt?: string;
  } | null;
  /**
   * Post-launch account-data-modification flag, populated by PostLaunchWatcher.
   *
   * When true, scan-core enforces a Critical Risk floor (globalRiskScore ≥ 95)
   * and inserts an Immediate Red Alert into the redFlags array. This is the
   * highest-priority scoring override in the engine — it overrides authority
   * transition floors and all other floors.
   *
   * Populated from:
   *   1. The Supabase scan_history.is_account_resized column (DB lookup
   *      before building the result), OR
   *   2. A real-time notification fired by PostLaunchWatcher during the scan.
   */
  accountResized?: {
    detected: boolean;
    /** Affected account address. */
    account?: string;
    /** Owner program of the affected account. */
    ownerProgram?: string;
    /** Old data length (bytes), null when not derivable. */
    oldLength?: number | null;
    /** New data length (bytes). */
    newLength?: number;
    /** Detection source. */
    source?: "system_allocate" | "system_allocate_with_seed" | "realloc_syscall";
    /** Transaction signature where the resize was detected. */
    signature?: string;
    /** ISO timestamp of detection. */
    detectedAt?: string;
  } | null;

  /**
   * Token Metadata Program info, populated during the scan:
   *   - updateAuthority: the current update_authority of the metadata account
   *     (null when not available). If equal to SystemProgram the metadata is
   *     permanently burned / immutable.
   *   - isMetadataMutable: true when update_authority is live (not null and not
   *     the SystemProgram burn address). Adds a +15 risk-score penalty.
   *   - isMetadataHijacked: true when PostLaunchWatcher detected a post-launch
   *     UpdateMetadataAccount / UpdateV1 instruction and persisted the flag to DB.
   *     Triggers a Critical alert in the scan result.
   */
  metadataInfo?: {
    updateAuthority: string | null;
    isMetadataMutable: boolean;
    isMetadataHijacked: boolean;
  } | null;

}

/**
 * Combine live data sources into the ScanResult shape.
 */
export function buildScanResult(input: RawInputs): ScanResult {
  const {
    address, parsed, largest, supplyResp, rug, asset, pair,
    sniper, honey, trades, resolvedFromPair, originalInput, offChain, authority,
    authorityTransitioned,
    accountResized,
    metadataInfo,
  } = input;


  // --- Authorities ---
  const mintAuthorityRaw = parsed?.mintAuthority ?? rug?.mintAuthority ?? null;
  const freezeAuthorityRaw = parsed?.freezeAuthority ?? rug?.freezeAuthority ?? null;
  const mintActive = !!mintAuthorityRaw;
  const freezeActive = !!freezeAuthorityRaw;

  // --- Supply ---
  const decimals: number = parsed?.decimals ?? supplyResp?.value?.decimals ?? 0;
  const supplyUi: number = supplyResp?.value?.uiAmount ?? 0;

  // --- Metadata ---
  const meta = asset?.content?.metadata ?? null;
  const name: string = meta?.name ?? rug?.tokenMeta?.name ?? pair?.baseToken?.name ?? "Unknown Token";
  const symbol: string = meta?.symbol ?? rug?.tokenMeta?.symbol ?? pair?.baseToken?.symbol ?? "—";

  const imageUrl: string | undefined =
    pair?.info?.imageUrl ?? asset?.content?.links?.image ??
    asset?.content?.files?.[0]?.uri ?? meta?.image ?? undefined;
  const websites: { label: string; url: string }[] = Array.isArray(pair?.info?.websites)
    ? pair.info.websites.filter((w: any) => w?.url).map((w: any) => ({ label: w.label ?? "Website", url: w.url }))
    : [];
  const socials: { type: string; url: string }[] = Array.isArray(pair?.info?.socials)
    ? pair.info.socials.filter((s: any) => s?.url).map((s: any) => ({ type: s.type ?? "link", url: s.url }))
    : [];

  // --- Market data ---
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
  const totalHolders: number = Number(rug?.totalHolders ?? rug?.token?.totalHolders ?? 0) || 0;

  let top10Pct = 0;
  if (Array.isArray(rug?.topHolders) && rug.topHolders.length) {
    const top10 = rug.topHolders.slice(0, 10);
    top10Pct = top10.reduce((s: number, h: any) => s + Number(h?.pct ?? 0), 0);
    if (top10Pct <= 1.5) top10Pct = top10Pct * 100;
  } else if (Array.isArray(largest?.value) && supplyUi > 0) {
    const top10 = largest.value.slice(0, 10);
    const sum = top10.reduce((s: number, a: any) => s + Number(a?.uiAmount ?? 0), 0);
    top10Pct = (sum / supplyUi) * 100;
  }
  top10Pct = clamp(top10Pct, 0, 100);

  const teamPct: number = clamp(
    Number(rug?.creatorBalance ?? 0) && supplyUi > 0
      ? (Number(rug.creatorBalance) / (supplyUi * Math.pow(10, decimals))) * 100
      : Number(rug?.creator?.percent ?? 0),
    0, 100,
  );
  const insiderPct: number = clamp(
    Number(rug?.insiderNetworks?.[0]?.tokenAmount ?? 0) && supplyUi > 0
      ? (Number(rug.insiderNetworks[0].tokenAmount) / (supplyUi * Math.pow(10, decimals))) * 100
      : 0,
    0, 100,
  );

  // --- LP status ---
  const market = Array.isArray(rug?.markets) ? rug.markets[0] : null;
  const lp = market?.lp ?? null;
  const lpLockedPct = Number(lp?.lpLockedPct ?? 0);
  const lpBurnt = lpLockedPct >= 99 || !!market?.lp?.lpLocked;
  const lpUnlocked = lpLockedPct < 50 && !lpBurnt;
  const lpStatus: ScanResult["lpStatus"] = lpBurnt ? "Burned" : lpUnlocked ? "Unlocked" : "Locked";
  const lpLockDays: number = Number(lp?.lpLockedDays ?? 0) || 0;
  const lpProvider: string = market?.marketType ?? market?.pubkey?.slice(0, 6) ?? "—";

  // --- Honeypot ---
  const risks: any[] = Array.isArray(rug?.risks) ? rug.risks : [];
  const honeyStatus = honey?.status ?? "SAFE";
  const honeyPot: Verdict =
    honeyStatus === "CONFIRMED HONEYPOT" ? "CONFIRMED"
    : honeyStatus === "HIGH RISK" || honeyStatus === "SUSPICIOUS" ? "SUSPICIOUS"
    : "SAFE";

  // --- Volume integrity ---
  const ratio = liquidity > 0 ? volume24h / liquidity : 0;
  const volumeIntegrity = ratio === 0
    ? 50
    : clamp(100 - Math.max(0, ratio - 3) * 6, 20, 98);

  // --- Manipulation engine ---
  const tradeList: Trade[] = Array.isArray(trades) ? trades : [];
  const detection = tradeList.length >= 6 ? detectManipulation(tradeList) : null;

  const washTrading: WashTradingReport = detection
    ? {
        available: true,
        tradesAnalyzed: tradeList.length,
        anomalyScore: detection.anomalyScore,
        verdict: detection.verdict,
        patterns: detection.patterns.map((pat) => ({
          id: pat.id, label: pat.label, description: pat.description,
          weight: pat.weight, evidence: pat.evidence,
        })),
        breakdown: detection.breakdown,
      }
    : {
        available: false,
        tradesAnalyzed: tradeList.length,
        anomalyScore: Math.round(100 - volumeIntegrity),
        verdict: ratio > 8 ? "likely_manipulated" : ratio > 4 ? "suspicious" : "clean",
        patterns: ratio > 4 && volume24h > 0
          ? [{
              id: "volume_liquidity_ratio",
              label: ratio > 8 ? "Abnormal volume/liquidity ratio" : "Elevated volume/liquidity ratio",
              description: `24h volume is ${ratio.toFixed(2)}x the available liquidity.`,
              weight: Math.round(100 - volumeIntegrity),
              evidence: { volume24h, liquidity, volumeLiquidityRatio: Number(ratio.toFixed(2)) },
            }]
          : [],
        breakdown: { walletCluster: 0, tradeCadence: 0, netZero: 0, txMetadata: 0 },
      };

  const effectiveVolumeIntegrity = detection
    ? clamp(100 - detection.anomalyScore, 2, 100)
    : volumeIntegrity;

  // --- Sniper info ---
  const sniperAvailable = !!sniper?.available;
  const sniperWallets = sniperAvailable ? sniper!.sniperWallets : 0;
  const sniperPct = sniperAvailable ? clamp(sniper!.sniperPct, 0, 100) : 0;
  const sniperRisk: ScanResult["sniperRisk"] = !sniperAvailable
    ? "Unknown"
    : sniperPct >= 15 ? "High" : sniperPct >= 5 ? "Medium" : "Low";

  // --- Developer reputation ---
  const creatorTokens = Number(rug?.creatorTokens?.length ?? 0);
  const toIssueValue = (v: unknown): string | null => {
    if (v == null || v === "") return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try { return JSON.stringify(v); } catch { return null; }
  };
  const verifiedIssues = risks.filter((r) => r?.level === "danger").map((r) => ({
    name: String(r?.name ?? "Verified scam pattern"),
    description: String(r?.description ?? "Flagged as a confirmed scam pattern by RugCheck."),
    level: "danger" as const,
    score: typeof r?.score === "number" ? r.score : null,
    value: toIssueValue(r?.value),
  }));
  const reportedIssues = risks.filter((r) => r?.level === "warn").map((r) => ({
    name: String(r?.name ?? "Reported issue"),
    description: String(r?.description ?? "Community-reported risk flagged by RugCheck."),
    level: "warn" as const,
    score: typeof r?.score === "number" ? r.score : null,
    value: toIssueValue(r?.value),
  }));
  const verifiedScams = verifiedIssues.length;
  const reportedScams = reportedIssues.length;

  // ---------------------------------------------------------------------
  // Wallet-cluster cross-check: pull the rugged-token count from the
  // SAME deterministic source used by /cluster/:tokenAddress/tokens so
  // the Developer Reputation panel and the Wallet Cluster panel agree.
  // Previously the dev reputation ignored cluster rugs entirely, which
  // produced the contradictory "3 rugged coins / Trust 100" state.
  // ---------------------------------------------------------------------
  const clusterStats = computeClusterStats(address);
  const devRuggedFromCluster = clusterStats.ruggedTokens;

  // Penalty model (risk units, higher = worse, clamped 0–100):
  //   verified scam:        +22 each
  //   reported scam:        +8  each
  //   cluster-rugged token: +18 each
  //   mint authority live:  +10
  //   freeze authority live:+6
  const devRiskPenalty = clamp(
    verifiedScams * 22 +
    reportedScams * 8 +
    devRuggedFromCluster * 18 +
    (mintActive ? 10 : 0) +
    (freezeActive ? 6 : 0),
    0, 100,
  );
  const devTrustScore = clamp(100 - devRiskPenalty, 0, 100);

  // --- Off-chain integration ---
  const offChainAvailable = offChain?.available === true;
  const effectiveDevScore = offChainAvailable
    ? clamp(offChain!.unifiedDevScore)
    : devRiskPenalty;

  const offChainDevNotes: string = offChainAvailable
    ? `Off-chain intent: ${offChain!.intentVerdict.replace(/_/g, " ")} (${offChain!.intentScore}/100). ` +
      `Website grade: ${offChain!.websiteAuthenticityGrade}. Hype: ${offChain!.hypeVerdict}.`
    : "";

  // --- Category scores ---
  const authorityScore = (mintActive ? 70 : 5) + (freezeActive ? 25 : 0);
  const liquidityScore = lpStatus === "Unlocked" ? 85 : lpStatus === "Locked" ? (lpLockDays < 90 ? 55 : 25) : 10;
  const honeypotScore = honeyStatus === "CONFIRMED HONEYPOT" ? 100 : honeyStatus === "HIGH RISK" ? 80 : honeyStatus === "SUSPICIOUS" ? 55 : 8;
  const holderScore = Math.min(100, top10Pct + (teamPct > 10 ? 15 : 0) + (insiderPct > 8 ? 10 : 0)) * 0.6;
  const volumeScore = 100 - effectiveVolumeIntegrity;
  const sniperScore = sniperAvailable ? clamp(sniperPct * 4) : 0;

  const categories: RiskCategory[] = [
    {
      key: "authority", label: "Authority Controls", score: clamp(authorityScore), weight: 0.22,
      notes: `${mintActive ? "Mint authority active." : "Mint revoked."} ${freezeActive ? "Freeze authority active." : "Freeze revoked."}`,
    },
    {
      key: "honeypot", label: "Honey Pot Simulation", score: clamp(honeypotScore), weight: 0.2,
      notes: honey?.available
        ? honey.reasons.length === 0
          ? "GoPlus simulation: buys and sells pass, no transfer restrictions, no excessive tax."
          : `GoPlus flagged ${honey.reasons.length} issue${honey.reasons.length === 1 ? "" : "s"}: ${honey.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}.`
        : "GoPlus unreachable — using on-chain authority signals only.",
    },
    {
      key: "liquidity", label: "Liquidity Lock", score: clamp(liquidityScore), weight: 0.16,
      notes: lpStatus === "Burned" ? "LP tokens burned."
        : lpStatus === "Locked" ? `${lpLockedPct.toFixed(0)}% LP locked.`
        : "LP unlocked — dev can pull.",
    },
    {
      key: "holders", label: "Holder Distribution", score: clamp(holderScore), weight: 0.12,
      notes: `Top 10 hold ${top10Pct.toFixed(1)}% of supply.`,
    },
    {
      key: "volume", label: "Volume Integrity", score: clamp(volumeScore), weight: 0.1,
      notes: washTrading.available
        ? `Manipulation engine analysed ${washTrading.tradesAnalyzed} swaps — anomaly score ${washTrading.anomalyScore}/100 (${washTrading.verdict.replace(/_/g, " ")}).`
        : `${effectiveVolumeIntegrity.toFixed(0)}% organic estimate (vol/liq ratio ${ratio.toFixed(2)}).`,
    },
    {
      key: "snipers", label: "Sniper Activity", score: clamp(sniperScore), weight: 0.1,
      notes: sniperAvailable
        ? `${sniperWallets} wallet${sniperWallets === 1 ? "" : "s"} captured ${sniperPct.toFixed(2)}% in first ${sniper!.analyzedSwaps} swap${sniper!.analyzedSwaps === 1 ? "" : "s"}.`
        : "Helius transaction history unavailable for this pool.",
    },
    {
      key: "dev",
      label: offChainAvailable ? "Developer & Intent" : "Developer Reputation",
      score: clamp(effectiveDevScore),
      weight: 0.1,
      notes: offChainAvailable
        ? `${creatorTokens} known launches. ${verifiedScams} danger flag${verifiedScams === 1 ? "" : "s"}. ${offChainDevNotes}`
        : `${creatorTokens} known launches by creator. ${verifiedScams} danger flag${verifiedScams === 1 ? "" : "s"}.`,
    },
  ];

  // -----------------------------------------------------------------------
  // WEIGHTED GLOBAL RISK SYNTHESIS ENGINE
  // -----------------------------------------------------------------------

  // Step 1: Compute normalized phase scores.
  const onChainCodeScore = clamp(Math.round(
    (clamp(authorityScore) * 0.22 + clamp(honeypotScore) * 0.20) / 0.42,
  ));
  const marketBehaviorScore = clamp(Math.round(
    (clamp(volumeScore) * 0.10 + clamp(sniperScore) * 0.10) / 0.20,
  ));
  const marketStructureScore = clamp(Math.round(
    (clamp(liquidityScore) * 0.16 + clamp(holderScore) * 0.12) / 0.28,
  ));
  const developerIntentScore = clamp(effectiveDevScore);

  // Step 2: Base weighted sum across 4 phases.
  const baseScore = Math.round(
    onChainCodeScore * 0.42 +
    marketBehaviorScore * 0.20 +
    marketStructureScore * 0.28 +
    developerIntentScore * 0.10,
  );

  // Step 3: Blend with RugCheck native score if available.
  const rugScore: number | null =
    typeof rug?.score_normalised === "number" ? Math.round(rug.score_normalised)
    : typeof rug?.score === "number" ? Math.min(100, Math.round(rug.score / 10))
    : null;
  let globalRiskScore = clamp(rugScore != null ? Math.round(baseScore * 0.6 + rugScore * 0.4) : baseScore);

  // Step 4: PRIMARY WEIGHT — Hard floor for confirmed hard-red-flag conditions.
  const isConfirmedHoneypot = honeyStatus === "CONFIRMED HONEYPOT";
  const isOffChainLikelyScam = offChain?.intentVerdict === "likely_scam";
  if (isConfirmedHoneypot || isOffChainLikelyScam) {
    globalRiskScore = Math.max(globalRiskScore, 70);
  }

  // Step 5: SECONDARY WEIGHT — Wash-trading penalty multiplier.
  const washMultiplier =
    washTrading.available && washTrading.verdict === "manipulated" ? 1.20
    : washTrading.available && washTrading.verdict === "likely_manipulated" ? 1.12
    : washTrading.available && washTrading.verdict === "suspicious" ? 1.06
    : 1.0;
  globalRiskScore = clamp(Math.round(globalRiskScore * washMultiplier));

  // Step 6: Off-chain suspicious floor (weaker than the hard-red-flag floor).
  if (offChain?.intentVerdict === "suspicious") {
    globalRiskScore = Math.max(globalRiskScore, 40);
  }

  // Step 7: AUTHORITY FLOOR — upgradeable contracts cap trust at MEDIUM.
  if (authority?.available && authority.overallClassification === "Unsafe/Upgradeable") {
    const before = globalRiskScore;
    globalRiskScore = Math.max(globalRiskScore, 20);
    if (globalRiskScore > before) {
      authority.upgradeableRiskFloorApplied = true;
    }
  }

  // Step 8: LIQUIDITY-UNLOCKED FLOOR.
  if (lpStatus === "Unlocked") {
    globalRiskScore = Math.max(globalRiskScore, 55);
  }

  // -----------------------------------------------------------------------
  // Step 9: POST-LAUNCH AUTHORITY TRANSITION — CRITICAL RISK OVERRIDE
  //
  // When a SetAuthority instruction (MintTokens or FreezeAccount) has been
  // detected by PostLaunchWatcher after the token's initial launch, this is
  // treated as an Immediate Red Alert and a primary rug-pull indicator.
  //
  // This is the HIGHEST-PRIORITY override in the scoring engine:
  //   • Enforces globalRiskScore ≥ 90 (Critical Risk, deep inside EXTREME).
  //   • Overrides ALL other floors and multipliers.
  //   • Adds a critical-severity red flag visible on the dashboard.
  //   • Populates riskBreakdown.authorityTransition for the frontend panel.
  // -----------------------------------------------------------------------
  const isAuthorityTransitioned = !!authorityTransitioned?.detected;

  if (isAuthorityTransitioned) {
    globalRiskScore = Math.max(globalRiskScore, 90);
  }

  // -----------------------------------------------------------------------
  // Step 10: ACCOUNT DATA MODIFICATION — CRITICAL RISK OVERRIDE
  //
  // When PostLaunchWatcher has detected a SystemProgram Allocate /
  // AllocateWithSeed instruction (or a realloc-syscall data-length delta)
  // on an account owned by a tracked token program, this is an Immediate
  // Red Alert: account storage has been resized, which can be used to
  // inject malicious logic into an already-deployed contract.
  //
  // This is the HIGHEST-PRIORITY override in the scoring engine:
  //   • Enforces globalRiskScore ≥ 95 (deep Critical).
  //   • Overrides authority-transition and all other floors.
  //   • Adds a critical-severity red flag visible on the dashboard.
  //   • Populates riskBreakdown.accountResize for the "Account Storage
  //     Tampered" warning in the Risk Breakdown panel.
  // -----------------------------------------------------------------------
  const isAccountResized = !!accountResized?.detected;
  if (isAccountResized) {
    globalRiskScore = Math.max(globalRiskScore, 95);
  }

  // -----------------------------------------------------------------------
  // Step 11: METADATA MUTABILITY — RISK PENALTY
  //
  // When the token's metadata update_authority is still active (not null
  // and not the SystemProgram burn address), the developer can silently
  // change the token's Name, Symbol, or Image at any time — a "Name
  // Hijacking" vector used in rug pulls and impersonation attacks.
  //
  //   • Adds +15 to globalRiskScore (additive penalty — does NOT cap at 90).
  //   • Adds a "warn"-severity red flag to the redFlags array.
  //   • Populates riskBreakdown.metadataStatus for the UI panel.
  //
  // When a post-launch UpdateMetadataAccount instruction is ALSO detected
  // (is_metadata_hijacked = true), the red flag is escalated to "critical".
  // -----------------------------------------------------------------------
  const isMetadataMutable: boolean = metadataInfo?.isMetadataMutable ?? false;
  const isMetadataHijacked: boolean = metadataInfo?.isMetadataHijacked ?? false;
  const metadataUpdateAuthority: string | null = metadataInfo?.updateAuthority ?? null;

  if (isMetadataMutable) {
    globalRiskScore = clamp(globalRiskScore + 15);
  }

  const riskScore = globalRiskScore;

  const riskLevel = level(globalRiskScore);

  // -----------------------------------------------------------------------
  // CONFIDENCE METRIC
  // -----------------------------------------------------------------------
  const confidenceLevel: ScanResult["confidenceLevel"] = (() => {
    let pts = 0;
    if (washTrading.tradesAnalyzed >= 50) pts += 3;
    else if (washTrading.tradesAnalyzed >= 20) pts += 2;
    else if (washTrading.tradesAnalyzed >= 6) pts += 1;
    if (offChainAvailable) pts += 2;
    if (ageDays >= 14) pts += 1;
    if (honey?.available) pts += 1;
    if (pair !== null) pts += 1;
    if (pts >= 6) return "High";
    if (pts >= 3) return "Medium";
    return "Low";
  })();

  // -----------------------------------------------------------------------
  // VERDICT SUMMARY — one-sentence description of the biggest risk driver.
  // Authority transition is always surfaced first — it is the most acute signal.
  // -----------------------------------------------------------------------
  const verdictSummary: string = (() => {
    if (isAccountResized) {
      const sigShort = accountResized?.signature
        ? ` (tx: ${accountResized.signature.slice(0, 8)}…)`
        : "";
      const lenStr =
        accountResized?.oldLength != null && accountResized?.newLength != null
          ? ` ${accountResized.oldLength}→${accountResized.newLength} bytes`
          : "";
      return `🚨 CRITICAL RED ALERT — Unauthorized Account Data Modification detected${sigShort}.${lenStr} Account storage was resized — possible logic injection into a live contract.`;
    }
    if (isAuthorityTransitioned) {
      const aType = authorityTransitioned?.authorityType ?? "authority";
      const sigShort = authorityTransitioned?.signature
        ? ` (tx: ${authorityTransitioned.signature.slice(0, 8)}…)`
        : "";
      return `🚨 IMMEDIATE RED ALERT — post-launch ${aType} transfer detected${sigShort}. This is a primary indicator of a rug pull in progress.`;
    }

    if (isConfirmedHoneypot)
      return "Confirmed honeypot — sells are blocked by contract; funds cannot be exited.";
    if (isOffChainLikelyScam)
      return `Off-chain presence signals scam intent — website grade ${offChain!.websiteAuthenticityGrade} with ${offChain!.hypeVerdict.replace(/_/g, " ")} social channels.`;
    if (washTrading.available && washTrading.verdict === "manipulated")
      return `Volume is almost entirely artificial — ${washTrading.tradesAnalyzed} swaps confirm ${washTrading.patterns[0]?.label ?? "coordinated wash-trading"}.`;
    if (washTrading.available && washTrading.verdict === "likely_manipulated")
      return `Likely manipulated trading — ${washTrading.patterns[0]?.label ?? "wash-trading patterns"} detected across ${washTrading.tradesAnalyzed} swaps.`;
    if (mintActive)
      return "Mint authority is active — developer can inflate supply at will, permanently diluting all holders.";
    if (lpStatus === "Unlocked")
      return "Liquidity is fully unlocked — developer can pull all funds at any time without warning.";
    if (verifiedScams >= 2)
      return `Developer linked to ${verifiedScams} verified scams — high probability of serial rug-pull behavior.`;
    if (honeyStatus === "HIGH RISK" || honeyStatus === "SUSPICIOUS")
      return "Sell mechanics are suspicious — GoPlus flagged transfer restrictions or high tax that may trap investors.";
    if (top10Pct > 60)
      return `Extreme supply concentration — top 10 wallets control ${top10Pct.toFixed(1)}% and could dump simultaneously.`;
    if (freezeActive)
      return "Freeze authority is active — developer can freeze any holder account and block sell access.";
    if (offChain?.intentVerdict === "suspicious")
      return `Off-chain signals are mixed — website grade ${offChain.websiteAuthenticityGrade} and ${offChain.hypeVerdict.replace(/_/g, " ")} social tone.`;
    if (globalRiskScore >= 70)
      return "Multiple high-severity risk vectors across authority, liquidity, and behavioral layers.";
    if (globalRiskScore >= 40)
      return "Moderate risk detected — some yellow flags across market structure and developer reputation.";
    return "No critical flags detected — risk vectors appear within normal bounds for this token class.";
  })();

  // -----------------------------------------------------------------------
  // RISK PHASE BREAKDOWN — per-phase contribution to globalRiskScore
  // -----------------------------------------------------------------------
  const washTradingScore = washTrading.anomalyScore;
  const intentScore = offChainAvailable ? offChain!.intentScore : 0;
  const websiteAuthenticityGrade = offChainAvailable
    ? offChain!.websiteAuthenticityGrade
    : "unavailable";

  const riskBreakdown: RiskPhaseBreakdown = {
    onChainCode: {
      score: onChainCodeScore,
      label: "On-chain Code Safety",
      weight: 0.42,
      contribution: Math.round(onChainCodeScore * 0.42),
      driver: isConfirmedHoneypot
        ? `Honeypot: ${honeyStatus}`
        : mintActive
          ? "Mint authority active"
          : freezeActive
            ? "Freeze authority active"
            : honeyPot !== "SAFE"
              ? "Suspicious sell mechanics"
              : "Clean",
    },
    marketBehavior: {
      score: marketBehaviorScore,
      label: "Market Behavior",
      weight: 0.20,
      contribution: Math.round(marketBehaviorScore * 0.20 * washMultiplier),
      driver: washTrading.available && washTrading.anomalyScore >= 35
        ? `Wash trading: ${washTrading.verdict.replace(/_/g, " ")}`
        : ratio > 4
          ? `Vol/liq ratio ${ratio.toFixed(1)}x`
          : sniperRisk === "High"
            ? "Heavy sniper activity"
            : "Clean",
      washMultiplierApplied: washMultiplier > 1,
    },
    marketStructure: {
      score: marketStructureScore,
      label: "Market Structure",
      weight: 0.28,
      contribution: Math.round(marketStructureScore * 0.28),
      driver: lpStatus === "Unlocked"
        ? "LP unlocked"
        : top10Pct > 50
          ? `${top10Pct.toFixed(0)}% top-10 concentration`
          : lpStatus === "Locked" && lpLockDays < 90
            ? `Short LP lock (${lpLockDays}d)`
            : "Clean",
    },
    developerIntent: {
      score: developerIntentScore,
      label: "Developer & Intent",
      weight: 0.10,
      contribution: Math.round(developerIntentScore * 0.10),
      driver: verifiedScams >= 2
        ? `${verifiedScams} verified scams`
        : offChainAvailable
          ? `Intent: ${offChain!.intentVerdict.replace(/_/g, " ")}`
          : verifiedScams === 1
            ? "1 verified scam"
            : "Clean",
      offChainAvailable,
    },
    // Populate authorityTransition phase only when a post-launch transition
    // has been detected. This drives the dashboard alert panel.
    ...(isAuthorityTransitioned
      ? {
          authorityTransition: {
            score: 100,
            label: "Post-Launch Authority Transition",
            authorityType: authorityTransitioned?.authorityType ?? "Unknown",
            signature: authorityTransitioned?.signature ?? "",
            detectedAt: authorityTransitioned?.detectedAt ?? new Date().toISOString(),
            driver: `🚨 ${authorityTransitioned?.authorityType ?? "Authority"} transferred post-launch — Critical Risk`,
          },
        }
      : {}),
    // Populate accountResize phase only when an unauthorized account-data
    // modification has been detected. Drives the "Account Storage Tampered"
    // warning in the Risk Breakdown panel.
    ...(isAccountResized
      ? {
          accountResize: {
            score: 100,
            label: "Account Storage Tampered",
            account: accountResized?.account ?? "",
            ownerProgram: accountResized?.ownerProgram ?? "",
            oldLength: accountResized?.oldLength ?? null,
            newLength: accountResized?.newLength ?? 0,
            source: (accountResized?.source ?? "system_allocate") as
              | "system_allocate"
              | "system_allocate_with_seed"
              | "realloc_syscall",
            signature: accountResized?.signature ?? "",
            detectedAt:
              accountResized?.detectedAt ?? new Date().toISOString(),
            warning: "⚠️ Account Storage Tampered — unauthorized data resize",
            driver: `🚨 Account data length changed${
              accountResized?.oldLength != null && accountResized?.newLength != null
                ? ` (${accountResized.oldLength}→${accountResized.newLength} bytes)`
                : ""
            } — Critical Risk`,
          },
        }
      : {}),
    // Populate metadataStatus when metadata info is available.
    // isMetadataMutable = true → +15 risk penalty. isMetadataHijacked = true →
    // Critical alert. Both conditions drive the Metadata Status panel in the UI.
    ...(metadataInfo != null
      ? {
          metadataStatus: {
            score: isMetadataHijacked ? 100 : isMetadataMutable ? 65 : 0,
            label: "Metadata Status",
            updateAuthority: metadataUpdateAuthority,
            isMetadataMutable,
            isMetadataHijacked,
            driver: isMetadataHijacked
              ? "🚨 Post-launch metadata update detected — Critical Risk"
              : isMetadataMutable
                ? `⚠️ Metadata is mutable (update_authority: ${metadataUpdateAuthority?.slice(0, 8) ?? "unknown"}…)`
                : "✅ Metadata is immutable / update authority burned",
          },
        }
      : {}),
  };

  // -----------------------------------------------------------------------
  // RED FLAGS
  // -----------------------------------------------------------------------
  const redFlags: RedFlag[] = [];

  // Account-resize is the most severe signal — always FIRST when present.
  if (isAccountResized) {
    const lenStr =
      accountResized?.oldLength != null && accountResized?.newLength != null
        ? `${accountResized.oldLength} → ${accountResized.newLength} bytes`
        : `${accountResized?.newLength ?? "?"} bytes`;
    redFlags.push({
      id: "account-resize",
      severity: "critical",
      title: "⚠️ Account Storage Tampered — Unauthorized Account Data Modification",
      detail:
        `A SystemProgram ${accountResized?.source ?? "allocate"} (or realloc syscall) ` +
        `was detected on account ${accountResized?.account ?? "(unknown)"} ` +
        `owned by ${accountResized?.ownerProgram ?? "(unknown program)"}. ` +
        `Data length: ${lenStr}. ` +
        `Transaction: ${accountResized?.signature ?? "unknown"}. ` +
        `This can be used to inject malicious logic into a live contract — exit immediately.`,
    });
  }

  // Authority transition is always near the top when present — highest severity.
  if (isAuthorityTransitioned) {
    redFlags.push({

      id: "authority-transition",
      severity: "critical",
      title: "🚨 Post-launch authority transition detected",
      detail:
        `A SetAuthority instruction for ${authorityTransitioned?.authorityType ?? "a critical authority"} ` +
        `was detected on-chain after this token's initial launch. ` +
        `Transaction: ${authorityTransitioned?.signature ?? "unknown"}. ` +
        `Detected at: ${authorityTransitioned?.detectedAt ?? "unknown"}. ` +
        `This is the primary indicator of a rug pull attempt — exit immediately.`,
    });
  }

  if (mintActive)
    redFlags.push({ id: "mint", severity: "critical", title: "Mint authority active", detail: `Mint authority: ${mintAuthorityRaw}. Holder supply can be diluted.` });
  if (freezeActive)
    redFlags.push({ id: "freeze", severity: "high", title: "Freeze authority active", detail: `Freeze authority: ${freezeAuthorityRaw}. Sells can be blocked.` });
  if (honey) {
    for (const c of honey.checks) {
      if (c.ok) continue;
      redFlags.push({ id: `honey-${c.id}`, severity: c.severity, title: `Honey pot: ${c.label.replace(/^[A-Z]/, (m) => m.toLowerCase())} failed`, detail: c.detail });
    }
  }
  if (lpStatus === "Unlocked")
    redFlags.push({ id: "lp", severity: "critical", title: "Liquidity unlocked", detail: `Only ${lpLockedPct.toFixed(0)}% of LP is locked or burned.` });
  if (top10Pct > 50)
    redFlags.push({ id: "concentration", severity: "high", title: "Extreme holder concentration", detail: `Top 10 wallets hold ${top10Pct.toFixed(1)}% of supply.` });
  if (washTrading.available && washTrading.anomalyScore >= 35) {
    const sev = washTrading.verdict === "manipulated" ? "critical" : washTrading.verdict === "likely_manipulated" ? "high" : "warn";
    const topPatterns = washTrading.patterns.slice(0, 3).map((p) => p.label);
    redFlags.push({
      id: "wash", severity: sev as RedFlag["severity"],
      title: `Wash trading / manipulation: ${washTrading.verdict.replace(/_/g, " ")}`,
      detail: `Anomaly score ${washTrading.anomalyScore}/100 across ${washTrading.tradesAnalyzed} swaps.${topPatterns.length ? ` Patterns: ${topPatterns.join(", ")}.` : ""}`,
    });
  } else if (!washTrading.available && ratio > 8 && volume24h > 0) {
    redFlags.push({ id: "wash", severity: "warn", title: "Wash trading suspected", detail: `Volume/liquidity ratio ${ratio.toFixed(1)} is abnormally high.` });
  }
  if (sniperAvailable && sniperRisk === "High")
    redFlags.push({ id: "snipers", severity: "high", title: "Heavy sniper capture at launch", detail: `${sniperWallets} wallets captured ${sniperPct.toFixed(2)}% in the first ${sniper!.analyzedSwaps} swaps.` });
  if (sniperAvailable && sniperRisk === "Medium")
    redFlags.push({ id: "snipers-m", severity: "warn", title: "Moderate sniper activity", detail: `${sniperWallets} wallets captured ${sniperPct.toFixed(2)}% at launch.` });
  for (const risk of risks) {
    if (risk?.level === "danger" && !redFlags.find((f) => f.title === risk.name)) {
      redFlags.push({ id: `rug-${risk.name}`, severity: "high", title: risk.name, detail: risk.description ?? "Flagged by RugCheck." });
    }
  }
  // Metadata status flags — placed after authority flags, before market flags.
  if (isMetadataHijacked) {
    redFlags.push({
      id: "metadata-hijacked",
      severity: "critical",
      title: "🚨 High Risk: Metadata Hijacking Attempt Detected",
      detail:
        `A post-launch UpdateMetadataAccount / UpdateV1 instruction was detected ` +
        `on this token's metadata account. The name, symbol, or image may have been ` +
        `changed after launch — a known rug-pull and impersonation technique. ` +
        `Update authority: ${metadataUpdateAuthority ?? "unknown"}.`,
    });
  } else if (isMetadataMutable) {
    redFlags.push({
      id: "metadata-mutable",
      severity: "warn",
      title: "⚠️ Metadata is Mutable — Name Hijacking Risk",
      detail:
        `The update_authority has NOT been set to null or burned. ` +
        `The developer can silently rename or re-image this token at any time. ` +
        `Authority: ${metadataUpdateAuthority ?? "unknown"}. ` +
        `Risk penalty: +15 pts added to global score.`,
    });
  }

  if (!pair)
    redFlags.push({ id: "no-market", severity: "warn", title: "No active DEX market", detail: "DexScreener returned no Solana pair — token may be untradeable." });
  if (resolvedFromPair && originalInput)
    redFlags.push({ id: "resolved-pair", severity: "info", title: "Resolved pool address to token mint", detail: `Input ${originalInput.slice(0, 6)}… is a DEX pool. Scanned underlying token mint ${address.slice(0, 6)}… instead.` });

  // Off-chain red flags
  if (offChainAvailable) {
    for (const wf of offChain!.websiteFlags.filter((f) => f.severity === "critical" || f.severity === "high")) {
      redFlags.push({ id: `offchain-web-${wf.id}`, severity: wf.severity, title: `Website: ${wf.label}`, detail: wf.detail });
    }
    if (isOffChainLikelyScam) {
      redFlags.push({
        id: "offchain-intent", severity: "critical", title: "Off-chain intent: likely scam",
        detail: `Intent score ${offChain!.intentScore}/100. Website grade ${offChain!.websiteAuthenticityGrade}, hype signal: ${offChain!.hypeVerdict}. Dangerous off-chain presence overrides clean on-chain signals.`,
      });
    } else if (offChain!.intentVerdict === "suspicious") {
      redFlags.push({
        id: "offchain-intent", severity: "high", title: "Off-chain intent: suspicious",
        detail: `Intent score ${offChain!.intentScore}/100. Website grade ${offChain!.websiteAuthenticityGrade}, hype signal: ${offChain!.hypeVerdict}.`,
      });
    }
    if (offChain!.hypeVerdict === "spam_heavy") {
      redFlags.push({
        id: "offchain-hype", severity: "warn", title: "Social channels dominated by spam",
        detail: `Hype score ${offChain!.hypeScore}/100. Detected repetitive low-effort messaging across linked social channels.`,
      });
    }
  }

  if (redFlags.length === 0)
    redFlags.push({ id: "clean", severity: "info", title: "No critical flags detected", detail: "On-chain authority checks and RugCheck risks passed." });

  const dna = clamp(globalRiskScore * 0.5 + (100 - devTrustScore) * 0.3 + (lpStatus === "Unlocked" ? 12 : 0));
  const serialEvidence = verifiedScams + devRuggedFromCluster;
  const serialProb: ScanResult["serialScammerProbability"] =
    serialEvidence >= 3 ? "Confirmed Pattern"
    : serialEvidence >= 2 ? "High"
    : serialEvidence === 1 ? "Medium"
    : "Low";

  return {
    address, name, symbol,
    logoSeed: address.slice(0, 6),
    ageDays, price, marketCap, fdv, liquidity, volume24h,
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
    sellControl: honeyPot === "CONFIRMED" ? "High Risk" : freezeActive || mintActive ? "Developer Controlled" : "Safe",

    lpStatus, lpLockDays, lpProvider,
    top10Pct, teamPct, insiderPct,

    volumeIntegrity: Math.round(effectiveVolumeIntegrity),
    washTrading,
    sniperPct, sniperWallets, sniperRisk,

    devTrustScore,
    devTokensLaunched: creatorTokens,
    devReportedScams: reportedScams,
    devVerifiedScams: verifiedScams,
    devRuggedFromCluster,
    devReportedIssues: reportedIssues,
    devVerifiedIssues: verifiedIssues,

    serialScammerProbability: serialProb,
    scammerDnaScore: Math.round(dna),

    clusterId: "CL-" + (parseInt(address.slice(-6), 36) % 0xffff).toString(16).toUpperCase().padStart(4, "0"),
    clusterWallets: Array.isArray(rug?.insiderNetworks)
      ? rug.insiderNetworks.reduce((s: number, n: any) => s + Number(n?.size ?? 0), 0)
      : 0,
    clusterTokens: Math.max(1, creatorTokens),

    categories,
    redFlags,

    // Synthesis fields
    globalRiskScore,
    confidenceLevel,
    verdictSummary,
    riskBreakdown,
    washTradingScore,
    intentScore,
    websiteAuthenticityGrade,

    is_authority_transitioned: isAuthorityTransitioned,
    is_account_resized: isAccountResized,

    metadataUpdateAuthority,
    isMetadataMutable,
    isMetadataHijacked,

    imageUrl,
    websites,
    socials,
    resolvedFromPair: !!resolvedFromPair,
  };
}
