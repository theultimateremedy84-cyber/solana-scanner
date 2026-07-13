// =============================================================================
// backlog-status-handler.ts — GET /api/backlog-status
//
// Powers the "Pipeline Control" panel in the site header. Aggregates every
// pending-work pipeline (wallet collection queue, wallet enrichment/win-ROI
// computation, trade record ingestion, discovery scans) plus Helius credit
// consumption into a single response so the frontend can poll one endpoint.
//
// Read-only, no auth required (mirrors /api/discovery-status and
// /api/funding-clusters) — this exposes operational metrics, not user data
// or secrets. Uses supabaseAdmin (service role) since several source tables
// (helius_cu_log, wallet_raw_tx_metrics writes) are service_role-only, and
// counts need to bypass RLS-limited anon reads for consistency.
// =============================================================================

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG = "[BacklogStatusHandler]";

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Shared Helius hourly/daily budget counters — written by token-discovery.ts
// / postLaunchWatcher.ts / scan.functions.ts via globalThis. Reusing the same
// pattern as discovery-status-handler.ts's _getHCBudgetStats() so the numbers
// shown here always match what those schedulers are actually enforcing.
function getHeliusBudgetStats() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const hourly = g.__heliusHourly__ as
    | { budget: number; used: number; window: number }
    | undefined;
  const daily = g.__heliusBudget__ as
    | { budget: number; used: number; day: number }
    | undefined;

  return {
    hourlyUsed: hourly?.used ?? 0,
    hourlyBudget: hourly?.budget ?? 0,
    dailyUsed: daily?.used ?? 0,
    dailyBudget: daily?.budget ?? 0,
  };
}

export async function handleBacklogStatusGet(): Promise<Response> {
  try {
    const sb = supabaseAdmin;
    const last1h = isoHoursAgo(1);
    const last24h = isoHoursAgo(24);

    const [
      pendingRes,
      processingRes,
      doneRes,
      failedRes,
      completedLast24hRes,
      recentFailedJobsRes,
      totalPerformanceRecordsRes,
      totalEnrichedRecordsRes,
      hollowPairsCountRes,
      updatedLast1hRes,
      updatedLast24hRes,
      totalTradeEventsRes,
      buyEventsLast24hRes,
      sellEventsLast24hRes,
      totalSolTransfersRes,
      solTransfersLast24hRes,
      totalScansRes,
      lastScanRes,
      alertsLast24hRes,
      cuTotalsRes,
      cuTopComponentsRes,
    ] = await Promise.all([
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "processing"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "done"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "failed"),
      sb.from("wallet_collection_jobs").select("id", { count: "exact", head: true }).eq("status", "done").gte("completed_at", last24h),
      sb.from("wallet_collection_jobs").select("token_address, attempts, last_error, enqueued_at").eq("status", "failed").order("enqueued_at", { ascending: false }).limit(10),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }),
      // NOTE: wallet_raw_tx_metrics has no `id` column (composite PK on
      // wallet_address + token_address) — select an existing column for the
      // count-only query. Selecting "id" here silently 400'd every request,
      // so totalEnrichedRecordsRes.count was always null → displayed as a
      // permanent "0" on the dashboard regardless of real enrichment progress.
      sb.from("wallet_raw_tx_metrics").select("wallet_address", { count: "exact", head: true }).eq("data_source", "helius_full_history"),
      sb.rpc("count_hollow_pairs").single(),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).gte("last_updated", last1h),
      sb.from("wallet_performance_history").select("id", { count: "exact", head: true }).gte("last_updated", last24h),
      sb.from("wallet_token_activity").select("id", { count: "exact", head: true }),
      sb.from("wallet_token_activity").select("id", { count: "exact", head: true }).eq("action_type", "buy").gte("timestamp", last24h),
      sb.from("wallet_token_activity").select("id", { count: "exact", head: true }).eq("action_type", "sell").gte("timestamp", last24h),
      sb.from("wallet_sol_transfers").select("id", { count: "exact", head: true }),
      sb.from("wallet_sol_transfers").select("id", { count: "exact", head: true }).gte("transferred_at", last24h),
      sb.from("scan_history").select("id", { count: "exact", head: true }),
      sb.from("scan_history").select("scanned_at").order("scanned_at", { ascending: false }).limit(1),
      sb.from("alerts").select("id", { count: "exact", head: true }).gte("created_at", last24h),
      // Aggregated in Postgres via RPC — a plain row .select() would be
      // silently truncated by PostgREST's 1000-row response cap once this
      // table (written on every Helius API call) exceeds that many rows in
      // the window, undercounting real usage. See migration
      // 20260710000002_helius_cu_log_aggregate_rpc.sql.
      sb.rpc("get_helius_cu_totals").single(),
      sb.rpc("get_helius_cu_top_components", { p_limit: 8 }),
    ]);

    const errors = [
      pendingRes.error, processingRes.error, doneRes.error, failedRes.error,
      completedLast24hRes.error, recentFailedJobsRes.error,
      totalPerformanceRecordsRes.error, totalEnrichedRecordsRes.error,
      hollowPairsCountRes.error,
      updatedLast1hRes.error, updatedLast24hRes.error,
      totalTradeEventsRes.error, buyEventsLast24hRes.error, sellEventsLast24hRes.error,
      totalSolTransfersRes.error, solTransfersLast24hRes.error,
      totalScansRes.error, lastScanRes.error, alertsLast24hRes.error,
      cuTotalsRes.error, cuTopComponentsRes.error,
    ].filter(Boolean);
    if (errors.length > 0) {
      console.error(`${LOG} one or more sub-queries failed:`, errors.map((e) => e?.message));
    }

    const cuTotals = cuTotalsRes.data as
      | { cu_last_1h: number; cu_last_24h: number; cu_last_7d: number }
      | null;
    const topComponentsLast24h = ((cuTopComponentsRes.data ?? []) as { component: string; cu_last_24h: number }[])
      .map((row) => ({ component: row.component, cuLast24h: Number(row.cu_last_24h ?? 0) }));

    const hollowPairsPending = Number(hollowPairsCountRes.data ?? 0);
    const heliusBudget = getHeliusBudgetStats();

    return json({
      generatedAt: new Date().toISOString(),
      collectionQueue: {
        pending: pendingRes.count ?? 0,
        processing: processingRes.count ?? 0,
        done: doneRes.count ?? 0,
        failed: failedRes.count ?? 0,
        completedLast24h: completedLast24hRes.count ?? 0,
        recentFailedJobs: (recentFailedJobsRes.data ?? []).map((job: { token_address: string; attempts: number; last_error: string | null; enqueued_at: string }) => ({
          tokenAddress: job.token_address,
          attempts: job.attempts,
          lastError: job.last_error,
          enqueuedAt: job.enqueued_at,
        })),
      },
      enrichment: {
        totalPerformanceRecords: totalPerformanceRecordsRes.count ?? 0,
        totalEnrichedRecords: totalEnrichedRecordsRes.count ?? 0,
        hollowPairsPending,
        hollowPairsPendingIsFloor: false,
        updatedLast1h: updatedLast1hRes.count ?? 0,
        updatedLast24h: updatedLast24hRes.count ?? 0,
      },
      tradeRecords: {
        totalTradeEvents: totalTradeEventsRes.count ?? 0,
        buyEventsLast24h: buyEventsLast24hRes.count ?? 0,
        sellEventsLast24h: sellEventsLast24hRes.count ?? 0,
        totalSolTransfers: totalSolTransfersRes.count ?? 0,
        solTransfersLast24h: solTransfersLast24hRes.count ?? 0,
      },
      discovery: {
        totalScans: totalScansRes.count ?? 0,
        lastScanAt: lastScanRes.data?.[0]?.scanned_at ?? null,
        alertsLast24h: alertsLast24hRes.count ?? 0,
        enabled: process.env.ENABLE_TOKEN_DISCOVERY === "true",
      },
      helius: {
        hourlyUsed: heliusBudget.hourlyUsed,
        hourlyBudget: heliusBudget.hourlyBudget,
        dailyUsed: heliusBudget.dailyUsed,
        dailyBudget: heliusBudget.dailyBudget,
        cuLast1h: Number(cuTotals?.cu_last_1h ?? 0),
        cuLast24h: Number(cuTotals?.cu_last_24h ?? 0),
        cuLast7d: Number(cuTotals?.cu_last_7d ?? 0),
        topComponentsLast24h,
      },
    });
  } catch (error) {
    console.error(`${LOG} failed:`, error);
    return json({ ok: false, error: "Failed to load backlog status" }, 500);
  }
}
