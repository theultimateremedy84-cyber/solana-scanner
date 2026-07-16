// =============================================================================
// monitor-dashboard-handler.ts — GET /api/monitor-dashboard
//
// 22-section comprehensive pipeline monitoring endpoint.
// All 22 metric sources actively written to by the Solana scanner:
//
//   §1-6   Token Scans + risk flags + honeypot + LP + market cap + holder data
//   §7     Developer Intelligence (scan_history developer cols)
//   §8     Wallet Collection Queue (wallet_collection_jobs)
//   §9-11  Wallet Intelligence — scores, P&L, confidence/discovery tiers
//   §12    Wallet Performance History (positions, milestones, ROI, airdrop exits)
//   §13    Enrichment Coverage (wallet_raw_tx_metrics data_source breakdown)
//   §14    Token Price History (token_price_history — every 15 min)
//   §15    PostLaunchWatcher Alerts (alerts table)
//   §16    SOL Transfer Graph + Sybil Detection (wallet_sol_transfers, wallet_first_funder view)
//   §17    Intelligence Snapshots (intelligence_snapshots — daily at midnight UTC)
//   §18    Developer Reputation Snapshots (developer_reputation_snapshots — daily)
//   §18b   Token Risk Snapshots (token_risk_snapshots — daily)
//   §19    Helius CU Telemetry (helius_cu_log — flushed every 60s)
//   §20    Graduation Pipeline (scan_history graduated_at, graduation_market_cap_usd)
//   §21    Discovery Rescore Queue (scan_history needs_rescore, last_rescored_at)
//   §22    Discovery Score Engine (wallets discovery_confidence, total/successful discoveries)
//
// BUG FIXES vs prior version:
//   - helius_cu_log: columns are `component`+`cu_amount`+`logged_at` (not component_name/cu_consumed/created_at)
//   - wallet_sol_transfers: timestamp column is `transferred_at` (not block_time)
//   - token_price_history: timestamp column is `snapshotted_at` (not created_at)
//   - win_rate stored as 0–1 decimal: threshold corrected to 0.5 (not 50)
//   - honey_pot_status: stored as "HONEYPOT" (not "yes")
//   - risk_level: stored uppercase "HIGH"|"CRITICAL" (not "high")
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getSchedulerStats } from "./process-jobs-scheduler";
import { TokenDiscovery } from "./token-discovery";
import { PostLaunchWatcher } from "../postLaunchWatcher";

const LOG = "[MonitorDashboardHandler]";

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function todayDate(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

function getHeliusBudgetStats() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const hourly  = g.__heliusHourly__  as { budget: number; used: number; window: number }  | undefined;
  const daily   = g.__heliusBudget__  as { budget: number; used: number; day: number }     | undefined;
  const monthly = g.__heliusMonthly__ as { budget: number; used: number; month: number }   | undefined;
  return {
    hourlyUsed:    hourly?.used    ?? 0,
    hourlyBudget:  hourly?.budget  ?? 0,
    dailyUsed:     daily?.used     ?? 0,
    dailyBudget:   daily?.budget   ?? 0,
    monthlyUsed:   monthly?.used   ?? 0,
    monthlyBudget: monthly?.budget ?? 0,
  };
}

export async function handleMonitorDashboardGet(): Promise<Response> {
  try {
    const sb      = supabaseAdmin;
    const last1h  = hoursAgo(1);
    const last24h = hoursAgo(24);
    const last7d  = hoursAgo(24 * 7);
    const today   = todayDate();

    // ── Live process stats (synchronous) ──────────────────────────────────────
    let discoveryStats: ReturnType<InstanceType<typeof TokenDiscovery>["getStats"]> | null = null;
    let watcherStats: ReturnType<InstanceType<typeof PostLaunchWatcher>["getStats"]> | null = null;
    try { discoveryStats = TokenDiscovery.getInstance().getStats(); } catch { /* not started */ }
    try { watcherStats   = PostLaunchWatcher.getInstance().getStats(); } catch { /* not started */ }

    let schedulerStats = { inFlightCount: 0, totalProcessed: 0, totalFailed: 0, stampRunning: false };
    try {
      const s = getSchedulerStats();
      schedulerStats = {
        inFlightCount:  s.inFlightCount  ?? 0,
        totalProcessed: s.totalProcessed ?? 0,
        totalFailed:    s.totalFailed    ?? 0,
        stampRunning:   s.stampRunning   ?? false,
      };
    } catch { /* not yet initialised */ }

    // ──────────────────────────────────────────────────────────────────────────
    // All DB queries in parallel
    // ──────────────────────────────────────────────────────────────────────────
    const [
      // §8 — Collection Queue
      pendingRes,
      processingRes,
      doneRes,
      failedRes,
      completedLast24hRes,
      recentFailedJobsRes,

      // §13 — Enrichment data_source breakdown
      srcHeliusRes,
      srcHolderScanRes,
      srcPoolExtractionRes,
      ghostEnrichmentRes,
      pairsWithEvidenceRes,
      enrichedLast1hRes,
      enrichedLast24hRes,
      totalPerfRecordsRes,

      // Buy/Sell (wallet_token_activity)
      totalBuyTxsRes,
      totalSellTxsRes,
      buyTxsLast24hRes,
      sellTxsLast24hRes,
      buyVolumeLast24hRes,
      sellVolumeLast24hRes,

      // Raw TX aggregates
      solInvestedRes,
      solReceivedRes,

      // §9-11 — Win/ROI — wallets
      walletsWithWinRateRes,
      walletsNullWinRateRes,
      walletsScoredLast24hRes,
      walletsWinRateAbove50Res,
      walletsEvidenceRawRes,
      walletsEvidenceFallbackRes,
      walletsAvgStatsRes,
      confEliteRes,
      confHighRes,
      confMediumRes,
      confLowRes,
      confUnratedRes,
      discEliteRes,
      discStrongRes,
      discDevelopingRes,
      discUnprovenRes,
      discLowSampleRes,
      convictionScoredRes,
      intelligenceScoredRes,

      // §12 — wallet_performance_history
      posOpenRes,
      posClosedRes,
      posPartialRes,
      posUnknownRes,
      milestone100kRes,
      milestone500kRes,
      milestone1mRes,
      milestone5mRes,
      milestone10mRes,
      milestone50mRes,
      roi2xRes,
      roi5xRes,
      roi10xRes,
      airdropExitRes,

      // §1-6 — Token Scans + Risk Flags
      totalScansRes,
      lastScanRes,
      scansLast24hRes,
      scansDiscoveryRes,
      highRiskLast24hRes,      // risk_level IN ('HIGH','CRITICAL')
      honeypotLast24hRes,      // honey_pot_status = 'HONEYPOT'
      avgRiskRes,
      metadataHijackedRes,
      cpiManipulatedRes,
      stateHijackedRes,
      atomicExploitRes,
      nonRentExemptRes,
      metadataMutableRes,
      authorityTransitionedRes,
      accountResizedRes,
      pathObfuscatedRes,
      graduatedTotalRes,
      graduatedLast24hRes,

      // §15 — Alerts (severity: 'warn'|'critical')
      alertsTotalRes,
      alertsLast24hRes,
      alertsCriticalRes,
      alertsWarnRes,
      alertsTypesLast24hRes,

      // §19 — Helius CU Log (FIXED columns: component, cu_amount, logged_at)
      cuLast1hRes,
      cuLast24hRes,
      cuLast7dRes,

      // §9 — Wallets master
      totalWalletsRes,
      walletsLast1hRes,
      walletsLast24hRes,
      smartMoneyWalletsRes,
      whaleWalletsRes,
      botWalletsRes,
      sniperWalletsRes,
      retailWalletsRes,

      // §16 — wallet_first_funder (Sybil detection)
      wffTotalRes,
      wffFundersRes,

      // §16 — SOL Transfers (FIXED: transferred_at not block_time)
      totalSolTransfersRes,
      solTransfersLast24hRes,

      // §14 — Price Data (FIXED: snapshotted_at not created_at)
      totalPriceRecordsRes,
      priceSnapshotsLast24hRes,
      lastPriceSnapshotRes,

      // §17 — Intelligence Snapshots
      intelSnapTotalRes,
      intelSnapTodayRes,
      intelSnapOldestRes,
      intelSnapNewestRes,

      // §18 — Developer Reputation Snapshots
      devSnapTotalRes,
      devSnapTodayRes,
      devSnapOldestRes,

      // §18b — Token Risk Snapshots
      tokenSnapTotalRes,
      tokenSnapTodayRes,
      tokenSnapOldestRes,

      // §20 — Graduation Pipeline expanded
      ungraduatedPendingRes,
      avgGraduationMcapRes,

      // §21 — Discovery Rescore Queue
      needsRescorePendingRes,
      rescoredLast24hRes,
      rescoredTotalRes,

      // §22 — Discovery Score Engine
      walletsWithDiscoveryScoreRes,
      avgDiscoveryStatsRes,
      discoveryConfHighRes,
    ] = await Promise.all([
      // §8 — Collection Queue
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "processing"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "done"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "done").gte("completed_at", last24h),
      sb.from("wallet_collection_jobs").select("token_address, attempts, last_error, enqueued_at").eq("status", "failed").order("enqueued_at", { ascending: false }).limit(10),

      // §13 — Enrichment breakdown
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).eq("data_source", "helius_full_history"),
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).eq("data_source", "holder_scan"),
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).eq("data_source", "pool_extraction"),
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).eq("has_evidence", false),
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).eq("has_evidence", true),
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).gte("last_scanned_at", last1h),
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).gte("last_scanned_at", last24h),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }),

      // Buy/Sell
      sb.from("wallet_token_activity").select("id", { count: "exact", head: true }).eq("action_type", "buy"),
      sb.from("wallet_token_activity").select("id", { count: "exact", head: true }).eq("action_type", "sell"),
      sb.from("wallet_token_activity").select("id", { count: "exact", head: true }).eq("action_type", "buy").gte("timestamp", last24h),
      sb.from("wallet_token_activity").select("id", { count: "exact", head: true }).eq("action_type", "sell").gte("timestamp", last24h),
      // FIX: PostgREST aggregate functions (`.sum()`) are disabled on this project.
      // Fetch rows and sum in JS instead. 24h buy/sell txs are already <30K so limit(10000) is safe.
      sb.from("wallet_token_activity").select("amount_sol").eq("action_type", "buy").gte("timestamp", last24h).limit(10000),
      sb.from("wallet_token_activity").select("amount_sol").eq("action_type", "sell").gte("timestamp", last24h).limit(10000),

      // Raw TX aggregates — same fix: fetch per-wallet rows, sum in JS
      sb.from("wallet_raw_tx_metrics").select("total_sol_invested, total_sol_received").gt("total_sol_invested", 0).limit(5000),
      sb.from("wallet_raw_tx_metrics").select("total_sol_invested, total_sol_received").gt("total_sol_received", 0).limit(5000),

      // §9-11 — Wallets win/roi
      sb.from("wallets").select("id", { count: "exact", head: true }).not("win_rate", "is", null),
      sb.from("wallets").select("id", { count: "exact", head: true }).is("win_rate", null),
      sb.from("wallets").select("id", { count: "exact", head: true }).gte("score_computed_at", last24h),
      // FIX: win_rate stored as 0–1 decimal, not percentage
      sb.from("wallets").select("id", { count: "exact", head: true }).gt("win_rate", 0.5),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("evidence_quality", "raw"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("evidence_quality", "fallback"),
      // FIX: PostgREST aggregates disabled — fetch sample of scored wallets and compute in JS
      sb.from("wallets").select("win_rate, average_roi, realized_pnl, unrealized_pnl").not("win_rate", "is", null).limit(5000),
      // Full confidence_tier breakdown
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("confidence_tier", "elite"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("confidence_tier", "high"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("confidence_tier", "medium"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("confidence_tier", "low"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("confidence_tier", "unrated"),
      // Discovery tier breakdown
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("discovery_tier", "elite"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("discovery_tier", "strong"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("discovery_tier", "developing"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("discovery_tier", "unproven"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("discovery_tier", "low_sample"),
      sb.from("wallets").select("id", { count: "exact", head: true }).not("conviction_score", "is", null),
      sb.from("wallets").select("id", { count: "exact", head: true }).not("intelligence_score", "is", null),

      // §12 — wallet_performance_history
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("position_status", "OPEN"),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("position_status", "CLOSED"),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("position_status", "PARTIALLY_CLOSED"),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("position_status", "UNKNOWN"),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("reached_100k_mc", true),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("reached_500k_mc", true),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("reached_1m_mc", true),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("reached_5m_mc", true),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("reached_10m_mc", true),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("reached_50m_mc", true),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).gte("roi_multiple", 2),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).gte("roi_multiple", 5),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).gte("roi_multiple", 10),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).eq("is_airdrop_exit", true),

      // §1-6 — Token Scans + Risk Flags
      sb.from("scan_history").select("id", { count: "exact", head: true }),
      sb.from("scan_history").select("scanned_at").order("scanned_at", { ascending: false }).limit(1),
      sb.from("scan_history").select("id", { count: "exact", head: true }).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("source", "discovery"),
      // FIX: risk_level stored uppercase; include both HIGH and CRITICAL
      sb.from("scan_history").select("id", { count: "exact", head: true }).in("risk_level", ["HIGH", "CRITICAL"]).gte("scanned_at", last24h),
      // FIX: honey_pot_status is "HONEYPOT" not "yes"
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("honey_pot_status", "HONEYPOT").gte("scanned_at", last24h),
      sb.from("scan_history").select("risk_score").gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_metadata_hijacked", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_cpi_manipulated", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_state_hijacked", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_atomic_exploit", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("has_non_rent_exempt_accounts", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_metadata_mutable", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_authority_transitioned", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_account_resized", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("is_path_obfuscated", true).gte("scanned_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).not("graduated_at", "is", null),
      sb.from("scan_history").select("id", { count: "exact", head: true }).not("graduated_at", "is", null).gte("graduated_at", last24h),

      // §15 — Alerts (severity values are 'warn'|'critical')
      sb.from("alerts").select("id", { count: "exact", head: true }),
      sb.from("alerts").select("id", { count: "exact", head: true }).gte("created_at", last24h),
      sb.from("alerts").select("id", { count: "exact", head: true }).eq("severity", "critical").gte("created_at", last24h),
      sb.from("alerts").select("id", { count: "exact", head: true }).eq("severity", "warn").gte("created_at", last24h),
      sb.from("alerts").select("alert_type").gte("created_at", last24h),

      // §19 — Helius CU Log (FIXED: columns are component, cu_amount, logged_at)
      sb.from("helius_cu_log").select("component, cu_amount").gte("logged_at", last1h),
      sb.from("helius_cu_log").select("component, cu_amount").gte("logged_at", last24h),
      sb.from("helius_cu_log").select("component, cu_amount").gte("logged_at", last7d),

      // §9 — Wallets master
      sb.from("wallets").select("id", { count: "exact", head: true }),
      sb.from("wallets").select("id", { count: "exact", head: true }).gte("updated_at", last1h),
      sb.from("wallets").select("id", { count: "exact", head: true }).gte("updated_at", last24h),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("wallet_classification", "smart_money"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("wallet_classification", "whale"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("wallet_classification", "bot"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("wallet_classification", "sniper"),
      sb.from("wallets").select("id", { count: "exact", head: true }).eq("wallet_classification", "retail"),

      // §16 — wallet_first_funder view (Sybil detection)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sb as any).from("wallet_first_funder").select("wallet_address", { count: "exact", head: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sb as any).from("wallet_first_funder").select("first_funder").limit(10000),

      // §16 — SOL Transfers (FIXED: transferred_at not block_time)
      sb.from("wallet_sol_transfers").select("id", { count: "exact", head: true }),
      sb.from("wallet_sol_transfers").select("id", { count: "exact", head: true }).gte("transferred_at", last24h),

      // §14 — Price Data (FIXED: snapshotted_at not created_at)
      sb.from("token_price_history").select("id", { count: "exact", head: true }),
      sb.from("token_price_history").select("id", { count: "exact", head: true }).gte("snapshotted_at", last24h),
      sb.from("token_price_history").select("snapshotted_at").order("snapshotted_at", { ascending: false }).limit(1),

      // §17 — Intelligence Snapshots
      sb.from("intelligence_snapshots").select("id", { count: "exact", head: true }),
      sb.from("intelligence_snapshots").select("id", { count: "exact", head: true }).eq("snapshot_date", today),
      sb.from("intelligence_snapshots").select("snapshot_date").order("snapshot_date", { ascending: true }).limit(1),
      sb.from("intelligence_snapshots").select("snapshot_date").order("snapshot_date", { ascending: false }).limit(1),

      // §18 — Developer Reputation Snapshots
      sb.from("developer_reputation_snapshots").select("id", { count: "exact", head: true }),
      sb.from("developer_reputation_snapshots").select("id", { count: "exact", head: true }).eq("snapshot_date", today),
      sb.from("developer_reputation_snapshots").select("snapshot_date").order("snapshot_date", { ascending: true }).limit(1),

      // §18b — Token Risk Snapshots
      sb.from("token_risk_snapshots").select("id", { count: "exact", head: true }),
      sb.from("token_risk_snapshots").select("id", { count: "exact", head: true }).eq("snapshot_date", today),
      sb.from("token_risk_snapshots").select("snapshot_date").order("snapshot_date", { ascending: true }).limit(1),

      // §20 — Graduation Pipeline expanded
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("source", "discovery").is("graduated_at", null),
      sb.from("scan_history").select("graduation_market_cap_usd.avg()").not("graduated_at", "is", null),

      // §21 — Discovery Rescore Queue
      sb.from("scan_history").select("id", { count: "exact", head: true }).eq("source", "discovery").eq("needs_rescore", true),
      sb.from("scan_history").select("id", { count: "exact", head: true }).gte("last_rescored_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }).not("last_rescored_at", "is", null),

      // §22 — Discovery Score Engine
      sb.from("wallets").select("id", { count: "exact", head: true }).not("discovery_score", "is", null),
      sb.from("wallets").select("discovery_confidence.avg(), total_discoveries.avg(), successful_discoveries.avg(), avg_entry_market_cap.avg()").not("discovery_score", "is", null),
      sb.from("wallets").select("id", { count: "exact", head: true }).gte("discovery_confidence", 0.6),
    ]);

    // ── Aggregate helpers ─────────────────────────────────────────────────────

    type CuRow = { component?: string | null; cu_amount?: number | null };
    function aggregateCu(rows: CuRow[]) {
      const map: Record<string, number> = {};
      for (const r of rows) {
        const k = r.component ?? "unknown";
        map[k] = (map[k] ?? 0) + Number(r.cu_amount ?? 0);
      }
      return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([component, cuUsed]) => ({ component, cuUsed }));
    }

    // Alert type aggregation
    type AlertTypeRow = { alert_type: string };
    const alertTypeMap: Record<string, number> = {};
    for (const r of (alertsTypesLast24hRes.data ?? []) as AlertTypeRow[]) {
      alertTypeMap[r.alert_type] = (alertTypeMap[r.alert_type] ?? 0) + 1;
    }
    const alertsByType = Object.entries(alertTypeMap)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));

    // Unique funders count
    type FunderRow = { first_funder: string | null };
    const uniqueFunders = new Set(
      ((wffFundersRes.data ?? []) as FunderRow[])
        .map((r) => r.first_funder)
        .filter(Boolean),
    ).size;

    // Risk score avg
    const riskRows = (avgRiskRes.data ?? []) as Array<{ risk_score: number }>;
    const avgRiskScoreLast24h = riskRows.length > 0
      ? riskRows.reduce((s, r) => s + (r.risk_score ?? 0), 0) / riskRows.length : null;

    // Buy/sell volume — FIX: sum fetched rows in JS (PostgREST aggregates disabled)
    type VolRow = { amount_sol: number | null };
    const buyVolSol  = ((buyVolumeLast24hRes.data  ?? []) as VolRow[]).reduce((s, r) => s + (r.amount_sol ?? 0), 0);
    const sellVolSol = ((sellVolumeLast24hRes.data ?? []) as VolRow[]).reduce((s, r) => s + (r.amount_sol ?? 0), 0);

    // Raw TX aggregates — FIX: sum fetched rows in JS
    type RawMetricsRow = { total_sol_invested: number | null; total_sol_received: number | null };
    const totalSolInvested = ((solInvestedRes.data ?? []) as RawMetricsRow[]).reduce((s, r) => s + (r.total_sol_invested ?? 0), 0);
    const totalSolReceived = ((solReceivedRes.data ?? []) as RawMetricsRow[]).reduce((s, r) => s + (r.total_sol_received ?? 0), 0);

    // Wallet aggregates — FIX: compute avg/sum in JS from fetched rows
    type WalletAgg = { win_rate: number | null; average_roi: number | null; realized_pnl: number | null; unrealized_pnl: number | null };
    const walletAggRows = (walletsAvgStatsRes.data ?? []) as WalletAgg[];
    const walletAgg = walletAggRows.length === 0 ? null : {
      win_rate:      walletAggRows.reduce((s, r) => s + (r.win_rate ?? 0), 0) / walletAggRows.length,
      average_roi:   walletAggRows.reduce((s, r) => s + (r.average_roi ?? 0), 0) / walletAggRows.length,
      realized_pnl:  walletAggRows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0),
      unrealized_pnl: walletAggRows.reduce((s, r) => s + (r.unrealized_pnl ?? 0), 0),
    };

    // Hollow pairs
    const heliusEnrichedPairs = srcHeliusRes.count ?? 0;
    const totalPerfRecords    = totalPerfRecordsRes.count ?? 0;
    const hollowPairsPending  = Math.max(0, totalPerfRecords - heliusEnrichedPairs);

    // CU rows
    const cuRows1h  = (cuLast1hRes.data  ?? []) as CuRow[];
    const cuRows24h = (cuLast24hRes.data ?? []) as CuRow[];
    const cuRows7d  = (cuLast7dRes.data  ?? []) as CuRow[];

    // Timestamps
    type ScanRow  = { scanned_at: string };
    type SnapDateRow = { snapshot_date: string };
    type PriceRow = { snapshotted_at: string };

    const lastScanAt       = (lastScanRes.data          as ScanRow[]     | null)?.[0]?.scanned_at     ?? null;
    const lastPriceSnapAt  = (lastPriceSnapshotRes.data as PriceRow[]    | null)?.[0]?.snapshotted_at ?? null;
    const intelOldestDate  = (intelSnapOldestRes.data   as SnapDateRow[] | null)?.[0]?.snapshot_date  ?? null;
    const intelNewestDate  = (intelSnapNewestRes.data   as SnapDateRow[] | null)?.[0]?.snapshot_date  ?? null;
    const devOldestDate    = (devSnapOldestRes.data     as SnapDateRow[] | null)?.[0]?.snapshot_date  ?? null;
    const tokenOldestDate  = (tokenSnapOldestRes.data   as SnapDateRow[] | null)?.[0]?.snapshot_date  ?? null;

    // Graduation pipeline
    const totalDiscoveryTokens = scansDiscoveryRes.count ?? 0;
    const graduatedTotal       = graduatedTotalRes.count ?? 0;
    const ungraduatedPending   = ungraduatedPendingRes.count ?? 0;
    const graduationRatePct    = totalDiscoveryTokens > 0
      ? Math.round((graduatedTotal / totalDiscoveryTokens) * 100) : null;
    type McapRow = { graduation_market_cap_usd: number | null };
    const avgGraduationMcapUsd = Number(
      (avgGraduationMcapRes.data as McapRow[] | null)?.[0]?.graduation_market_cap_usd ?? 0,
    ) || null;

    // Discovery score engine
    type DiscoveryAgg = {
      discovery_confidence: number | null;
      total_discoveries: number | null;
      successful_discoveries: number | null;
      avg_entry_market_cap: number | null;
    };
    const discAgg = (avgDiscoveryStatsRes.data as DiscoveryAgg[] | null)?.[0] ?? null;

    // Build TokenDiscovery section
    const discovery = discoveryStats
      ? {
          running:           discoveryStats.running,
          wsAlive:           discoveryStats.wsAlive,
          wsReadyState:      discoveryStats.wsReadyState,
          lastMessageAt:     discoveryStats.lastMessageAt,
          totalReconnects:   discoveryStats.totalReconnects,
          lastCloseCode:     discoveryStats.lastCloseCode,
          lastCloseReason:   discoveryStats.lastCloseReason,
          lastWsError:       discoveryStats.lastWsError,
          pipeline: {
            messagesReceived:  discoveryStats.pipeline.messagesReceived,
            createEventsFound: discoveryStats.pipeline.createEventsFound,
            mintsExtracted:    discoveryStats.pipeline.mintsExtracted,
            dexScreenerHit:    discoveryStats.pipeline.dexScreenerHit,
            liquidityPassed:   discoveryStats.pipeline.liquidityPassed,
            tokensEnqueued:    discoveryStats.pipeline.tokensEnqueued,
          },
          bcDiag: {
            accountNotFound: discoveryStats.pipeline.bcDiag.accountNotFound,
            tooSmall:        discoveryStats.pipeline.bcDiag.tooSmall,
            sanityCap:       discoveryStats.pipeline.bcDiag.sanityCap,
            rpcError:        discoveryStats.pipeline.bcDiag.rpcError,
          },
        }
      : null;

    // Build PostLaunchWatcher section
    const watcher = watcherStats
      ? {
          enabled:               watcherStats.enabled,
          running:               watcherStats.running,
          wsAlive:               watcherStats.wsAlive,
          tokensTracked:         watcherStats.tokens,
          tokenCap:              watcherStats.tokenCap,
          mintSubsConfirmed:     watcherStats.mintSubsConfirmed,
          mintSubsPending:       watcherStats.mintSubsPending,
          metaSubsConfirmed:     watcherStats.metaSubsConfirmed,
          metaSubsPending:       watcherStats.metaSubsPending,
          totalNotifications:    watcherStats.totalNotifications,
          estimatedCreditsPerDay: watcherStats.estimatedCreditsPerDay,
          sessionAgeSeconds:     watcherStats.sessionAgeSeconds,
        }
      : null;

    return json({
      ok: true,
      fetchedAt: new Date().toISOString(),

      // §8 — Collection Queue
      collectionQueue: {
        pending:          pendingRes.count     ?? 0,
        processing:       processingRes.count  ?? 0,
        done:             doneRes.count        ?? 0,
        failed:           failedRes.count      ?? 0,
        completedLast24h: completedLast24hRes.count ?? 0,
        recentFailedJobs: (recentFailedJobsRes.data ?? []).map((j: Record<string, unknown>) => ({
          tokenAddress: j["token_address"],
          attempts:     j["attempts"],
          lastError:    j["last_error"],
          enqueuedAt:   j["enqueued_at"],
        })),
      },

      // §13 — Enrichment
      enrichment: {
        hollowPairsPending,
        heliusFullHistory: heliusEnrichedPairs,
        holderScan:        srcHolderScanRes.count     ?? 0,
        poolExtraction:    srcPoolExtractionRes.count ?? 0,
        ghostEnrichments:  ghostEnrichmentRes.count   ?? 0,
        pairsWithEvidence: pairsWithEvidenceRes.count ?? 0,
        scannedLast1h:     enrichedLast1hRes.count    ?? 0,
        scannedLast24h:    enrichedLast24hRes.count   ?? 0,
        totalPerformanceRecords: totalPerfRecords,
      },

      // Buy/Sell
      buySellData: {
        totalBuyTxs:       totalBuyTxsRes.count    ?? 0,
        totalSellTxs:      totalSellTxsRes.count   ?? 0,
        buyTxsLast24h:     buyTxsLast24hRes.count  ?? 0,
        sellTxsLast24h:    sellTxsLast24hRes.count ?? 0,
        buyVolSolLast24h:  buyVolSol,
        sellVolSolLast24h: sellVolSol,
        netVolSolLast24h:  sellVolSol - buyVolSol,
      },

      // Raw TX Aggregates
      rawTxMetrics: {
        totalSolInvested,
        totalSolReceived,
        netSolRawPnl: totalSolReceived - totalSolInvested,
      },

      // §9-11 — Win/ROI
      winRoi: {
        walletsWithWinRate:    walletsWithWinRateRes.count    ?? 0,
        walletsUnscored:       walletsNullWinRateRes.count    ?? 0,
        walletsScoredLast24h:  walletsScoredLast24hRes.count  ?? 0,
        walletsWinRateAbove50: walletsWinRateAbove50Res.count ?? 0,
        evidenceRaw:           walletsEvidenceRawRes.count      ?? 0,
        evidenceFallback:      walletsEvidenceFallbackRes.count ?? 0,
        avgWinRate:            walletAgg?.win_rate    ?? null,
        avgRoi:                walletAgg?.average_roi ?? null,
        totalRealizedPnlSol:   walletAgg?.realized_pnl   ?? null,
        totalUnrealizedPnlSol: walletAgg?.unrealized_pnl ?? null,
        confidenceTier: {
          elite:   confEliteRes.count   ?? 0,
          high:    confHighRes.count    ?? 0,
          medium:  confMediumRes.count  ?? 0,
          low:     confLowRes.count     ?? 0,
          unrated: confUnratedRes.count ?? 0,
        },
        discoveryTier: {
          elite:      discEliteRes.count      ?? 0,
          strong:     discStrongRes.count     ?? 0,
          developing: discDevelopingRes.count ?? 0,
          unproven:   discUnprovenRes.count   ?? 0,
          lowSample:  discLowSampleRes.count  ?? 0,
        },
        convictionScored:   convictionScoredRes.count    ?? 0,
        intelligenceScored: intelligenceScoredRes.count  ?? 0,
        positionsOpen:            posOpenRes.count    ?? 0,
        positionsClosed:          posClosedRes.count  ?? 0,
        positionsPartiallyClosed: posPartialRes.count ?? 0,
        positionsUnknown:         posUnknownRes.count ?? 0,
        roiAbove2x:  roi2xRes.count  ?? 0,
        roiAbove5x:  roi5xRes.count  ?? 0,
        roiAbove10x: roi10xRes.count ?? 0,
        milestones: {
          reached100k: milestone100kRes.count ?? 0,
          reached500k: milestone500kRes.count ?? 0,
          reached1m:   milestone1mRes.count   ?? 0,
          reached5m:   milestone5mRes.count   ?? 0,
          reached10m:  milestone10mRes.count  ?? 0,
          reached50m:  milestone50mRes.count  ?? 0,
        },
        airdropExits: airdropExitRes.count ?? 0,
      },

      // §1-6 — Token Scans
      scans: {
        totalScans:         totalScansRes.count   ?? 0,
        scansLast24h:       scansLast24hRes.count ?? 0,
        scansFromDiscovery: scansDiscoveryRes.count ?? 0,
        lastScanAt,
        highRiskLast24h:    highRiskLast24hRes.count  ?? 0,
        honeypotLast24h:    honeypotLast24hRes.count  ?? 0,
        avgRiskScoreLast24h,
        riskFlags: {
          metadataHijacked:      metadataHijackedRes.count      ?? 0,
          cpiManipulated:        cpiManipulatedRes.count        ?? 0,
          stateHijacked:         stateHijackedRes.count         ?? 0,
          atomicExploit:         atomicExploitRes.count         ?? 0,
          nonRentExempt:         nonRentExemptRes.count         ?? 0,
          metadataMutable:       metadataMutableRes.count       ?? 0,
          authorityTransitioned: authorityTransitionedRes.count ?? 0,
          accountResized:        accountResizedRes.count        ?? 0,
          pathObfuscated:        pathObfuscatedRes.count        ?? 0,
        },
        graduation: {
          total:   graduatedTotalRes.count   ?? 0,
          last24h: graduatedLast24hRes.count ?? 0,
        },
      },

      // §15 — Alerts
      alerts: {
        total:       alertsTotalRes.count   ?? 0,
        last24h:     alertsLast24hRes.count ?? 0,
        critical24h: alertsCriticalRes.count ?? 0,
        warn24h:     alertsWarnRes.count     ?? 0,
        byType:      alertsByType,
      },

      // §19 — Helius (CU log columns fixed)
      helius: {
        ...getHeliusBudgetStats(),
        cuLast1h:  cuRows1h.reduce((s, r)  => s + Number(r.cu_amount ?? 0), 0),
        cuLast24h: cuRows24h.reduce((s, r) => s + Number(r.cu_amount ?? 0), 0),
        cuLast7d:  cuRows7d.reduce((s, r)  => s + Number(r.cu_amount ?? 0), 0),
        topComponentsLast1h:  aggregateCu(cuRows1h),
        topComponentsLast24h: aggregateCu(cuRows24h),
      },

      // §9 — Wallets
      wallets: {
        total:          totalWalletsRes.count     ?? 0,
        updatedLast1h:  walletsLast1hRes.count    ?? 0,
        updatedLast24h: walletsLast24hRes.count   ?? 0,
        smartMoney:     smartMoneyWalletsRes.count ?? 0,
        whale:          whaleWalletsRes.count     ?? 0,
        bot:            botWalletsRes.count       ?? 0,
        sniper:         sniperWalletsRes.count    ?? 0,
        retail:         retailWalletsRes.count    ?? 0,
      },

      // §16 — Sybil Detection
      sybilDetection: {
        walletsIndexed:      wffTotalRes.count ?? 0,
        uniqueFunders,
        avgWalletsPerFunder: uniqueFunders > 0
          ? +((wffTotalRes.count ?? 0) / uniqueFunders).toFixed(2)
          : 0,
      },

      // §16 — SOL Transfers
      solTransfers: {
        total:   totalSolTransfersRes.count   ?? 0,
        last24h: solTransfersLast24hRes.count ?? 0,
      },

      // §14 — Price Data
      priceData: {
        total:            totalPriceRecordsRes.count    ?? 0,
        snapshotsLast24h: priceSnapshotsLast24hRes.count ?? 0,
        lastSnapshotAt:   lastPriceSnapAt,
      },

      // §17 — Intelligence Snapshots (daily at midnight UTC)
      intelligenceSnapshots: {
        totalRows:          intelSnapTotalRes.count ?? 0,
        walletsCapturedToday: intelSnapTodayRes.count ?? 0,
        oldestSnapshotDate: intelOldestDate,
        newestSnapshotDate: intelNewestDate,
        daysOfHistory: intelOldestDate && intelNewestDate
          ? Math.round(
              (new Date(intelNewestDate).getTime() - new Date(intelOldestDate).getTime())
              / 86_400_000,
            ) + 1
          : 0,
      },

      // §18 — Developer Reputation Snapshots
      developerSnapshots: {
        totalRows:              devSnapTotalRes.count ?? 0,
        developersCapturedToday: devSnapTodayRes.count ?? 0,
        oldestSnapshotDate:     devOldestDate,
      },

      // §18b — Token Risk Snapshots
      tokenRiskSnapshots: {
        totalRows:            tokenSnapTotalRes.count ?? 0,
        tokensCapturedToday:  tokenSnapTodayRes.count ?? 0,
        oldestSnapshotDate:   tokenOldestDate,
      },

      // §20 — Graduation Pipeline (expanded)
      graduationPipeline: {
        totalDiscoveryTokens,
        graduatedTotal,
        graduatedLast24h:    graduatedLast24hRes.count  ?? 0,
        ungraduatedPending,
        graduationRatePct,
        avgGraduationMcapUsd,
      },

      // §21 — Discovery Rescore Queue
      discoveryRescore: {
        needsRescorePending: needsRescorePendingRes.count ?? 0,
        rescoreDoneLast24h:  rescoredLast24hRes.count    ?? 0,
        rescoredTotal:       rescoredTotalRes.count      ?? 0,
      },

      // §22 — Discovery Score Engine
      discoveryScoreEngine: {
        walletsWithDiscoveryScore: walletsWithDiscoveryScoreRes.count ?? 0,
        avgDiscoveryConfidence:    discAgg?.discovery_confidence      ?? null,
        avgTotalDiscoveries:       discAgg?.total_discoveries         ?? null,
        avgSuccessfulDiscoveries:  discAgg?.successful_discoveries    ?? null,
        avgEntryMarketCapUsd:      discAgg?.avg_entry_market_cap      ?? null,
        discoveryConfidenceHigh:   discoveryConfHighRes.count         ?? 0,
      },

      // WebSocket / live process sections (unchanged)
      tokenDiscovery:   discovery,
      postLaunchWatcher: watcher,
      scheduler:        schedulerStats,
    });
  } catch (error) {
    console.error(`${LOG} failed:`, error);
    return json({ ok: false, error: "Failed to load monitor dashboard" }, 500);
  }
}
