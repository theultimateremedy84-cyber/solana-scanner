// =============================================================================
// discovery-status-handler.ts — GET /api/discovery-status
//
// PATCH v2 — adds ProcessJobsScheduler diagnostics block
//
// Returns the runtime state of the P2-A autonomous token discovery system
// without requiring any credentials. Useful for diagnosing Railway deployments.
//
// NEW in v2:
//   - scheduler: { stampRunning, inFlightCount, totalProcessed, totalFailed,
//                  consecutiveTickErr, ... } — surfaces the scheduler's live
//                  concurrency state so you can immediately see whether the
//                  running lock is stuck (cause of attempts=0 backlog).
//   - diagnosis[] now includes a warning when SUPABASE_SERVICE_ROLE_KEY is
//     absent (the silent RLS failure that keeps attempts=0 forever).
// =============================================================================

import { TokenDiscovery } from "./token-discovery";
import { PostLaunchWatcher } from "../postLaunchWatcher";
import { getSchedulerStats } from "./process-jobs-scheduler";

// Read the shared Helius budget counter written by PostLaunchWatcher /
// TokenDiscovery via globalThis — no import needed.
function _getHCBudgetStats() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const b = g.__heliusBudget__ as
    | { budget: number; used: number; day: number } | undefined;
  const h = g.__heliusHourly__ as
    | { budget: number; used: number; window: number } | undefined;

  const daily = b
    ? {
        enabled:        b.budget > 0,
        dailyBudget:    b.budget,
        usedToday:      b.used,
        remainingToday: Math.max(0, b.budget - b.used),
        percentUsed:    b.budget > 0 ? Math.round((b.used / b.budget) * 100) : 0,
        resetAt:        new Date(b.day + 86_400_000).toISOString(),
      }
    : { enabled: false, dailyBudget: 0, usedToday: 0, remainingToday: 0, percentUsed: 0, resetAt: "not yet initialized" };

  const hourly = h
    ? {
        enabled:          h.budget > 0,
        hourlyBudget:     h.budget,
        usedThisHour:     h.used,
        remainingThisHour: Math.max(0, h.budget - h.used),
        percentUsed:      h.budget > 0 ? Math.round((h.used / h.budget) * 100) : 0,
        windowStartedAt:  new Date(h.window).toISOString(),
        resetsAt:         new Date(h.window + 3_600_000).toISOString(),
      }
    : { enabled: false, hourlyBudget: 0, usedThisHour: 0, remainingThisHour: 0, percentUsed: 0, windowStartedAt: "not yet initialized", resetsAt: "not yet initialized" };

  return { daily, hourly };
}

export function handleDiscoveryStatusGet(): Response {
  const stats        = TokenDiscovery.getInstance().getStats();
  const watcherStats = PostLaunchWatcher.getInstance().getStats();
  const scheduler    = getSchedulerStats();  // NEW
  const p            = stats.pipeline;

  const env = {
    HELIUS_API_KEY:            !!process.env.HELIUS_API_KEY,
    SUPABASE_URL:              !!(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY:         !!process.env.SUPABASE_ANON_KEY,
    CRON_SECRET:               !!process.env.CRON_SECRET,
  };

  const diagnosis: string[] = [];

  if (!env.HELIUS_API_KEY) {
    diagnosis.push("CRITICAL: HELIUS_API_KEY is not set — TokenDiscovery WebSocket cannot start");
  }
  if (!env.SUPABASE_URL) {
    diagnosis.push("CRITICAL: SUPABASE_URL (or VITE_SUPABASE_URL) is not set — cannot write jobs");
  }
  // NEW — surface the silent RLS failure that causes attempts=0
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    diagnosis.push(
      "CRITICAL: SUPABASE_SERVICE_ROLE_KEY is not set. " +
      "After migration 20260627000001, all UPDATEs to wallet_collection_jobs require " +
      "service_role. Without this key the scheduler's stamp UPDATE is silently rejected " +
      "by RLS — jobs stay at pending/attempts=0 forever. " +
      "Set SUPABASE_SERVICE_ROLE_KEY in Railway → Variables immediately.",
    );
  }
  if (!env.CRON_SECRET) {
    diagnosis.push("WARNING: CRON_SECRET is not set — /api/process-jobs rejects all requests");
  }
  if (!stats.wsGlobalAvailable) {
    diagnosis.push(
      "CRITICAL: WebSocket global is NOT available in this runtime. " +
      "The server must run under Bun (not Node.js <22). " +
      "Check Railway startCommand — it should be `bun .output/server/index.mjs`.",
    );
  }
  if (!stats.running) {
    diagnosis.push("TokenDiscovery is NOT running — check HELIUS_API_KEY");
  }
  if (stats.running && !stats.wsAlive) {
    const closeInfo = stats.lastCloseCode !== null
      ? ` Last close: code=${stats.lastCloseCode}${stats.lastCloseReason ? ` reason="${stats.lastCloseReason}"` : ""}.`
      : "";
    const errInfo = stats.lastWsError ? ` Last error: ${stats.lastWsError}.` : "";
    diagnosis.push(
      `TokenDiscovery WebSocket is DOWN (${stats.totalReconnects} reconnect attempt(s)).${closeInfo}${errInfo} ` +
      "If persists >5 min: check Helius API key validity, plan tier (needs logsSubscribe), and Railway logs.",
    );
  }
  if (stats.running && stats.wsAlive && stats.subscriptionId === null) {
    diagnosis.push(
      "WebSocket is open but subscription not confirmed — Helius may have rejected the logsSubscribe request",
    );
  }

  // NEW — scheduler health diagnosis
  if (scheduler.consecutiveTickErr >= 3) {
    diagnosis.push(
      `SCHEDULER: ${scheduler.consecutiveTickErr} consecutive tick errors — ` +
      "check Supabase connectivity and env vars.",
    );
  }
  if (scheduler.stampRunning) {
    diagnosis.push(
      "SCHEDULER: stamp phase is currently running (this is normal during a tick).",
    );
  }
  if (scheduler.inFlightCount >= scheduler.maxConcurrent) {
    diagnosis.push(
      `SCHEDULER: at concurrency cap (${scheduler.inFlightCount}/${scheduler.maxConcurrent} collect() calls in flight). ` +
      "New ticks are paused until a slot opens.",
    );
  }

  // Pipeline bottleneck diagnosis
  if (p.messagesReceived > 0 && p.createEventsFound === 0) {
    diagnosis.push(
      `PIPELINE BLOCKED at step 2: ${p.messagesReceived} Pump.fun messages received but ` +
      `0 passed the "Instruction: Create" pre-filter — ` +
      `Pump.fun log format may have changed`,
    );
  } else if (p.createEventsFound > 0 && p.mintsExtracted === 0) {
    diagnosis.push(
      `PIPELINE BLOCKED at step 3: ${p.createEventsFound} Create events found but ` +
      `extractMint() returned null for all of them — ` +
      `transaction account structure may have changed`,
    );
  } else if (p.mintsExtracted > 0 && p.dexScreenerHit === 0) {
    const d = p.bcDiag;
    const total = d.accountNotFound + d.tooSmall + d.sanityCap + d.rpcError;
    if (total === 0) {
      diagnosis.push(
        `PIPELINE BLOCKED at step 4: ${p.mintsExtracted} mints detected but 0 bonding curve ` +
        `accounts readable — counters at zero means fetchBondingCurveData is not yet being called ` +
        `(server just restarted — wait 30s for first token to complete the pipeline)`,
      );
    } else {
      const reasons = [
        d.accountNotFound ? `accountNotFound:${d.accountNotFound}` : "",
        d.tooSmall        ? `tooSmall:${d.tooSmall}` : "",
        d.sanityCap       ? `sanityCap:${d.sanityCap}` : "",
        d.rpcError        ? `rpcError:${d.rpcError}` : "",
      ].filter(Boolean).join(", ");
      diagnosis.push(
        `PIPELINE BLOCKED at step 4: ${p.mintsExtracted} mints → 0 reads. ` +
        `Failure breakdown: ${reasons}. ` +
        (d.accountNotFound > d.sanityCap + d.rpcError
          ? "Most failures are accountNotFound — bonding curve PDA may be wrong (check extractBondingCurve) or account takes >36s to appear on-chain."
          : d.sanityCap > d.accountNotFound + d.rpcError
          ? "Most failures are sanityCap — accounts[1] is pointing to a non-bonding-curve account (wrong PDA index). Pump.fun instruction layout may have changed."
          : d.rpcError > d.accountNotFound + d.sanityCap
          ? "Most failures are rpcError — Helius getAccountInfo is throwing. Check API key rate limits."
          : "Mixed failures — see Railway logs for details."),
      );
    }
  } else if (p.dexScreenerHit > 0 && p.liquidityPassed === 0) {
    diagnosis.push(
      `PIPELINE BLOCKED at step 5: ${p.dexScreenerHit} bonding curves read but ` +
      `all have < 0.5 SOL invested — tokens are launching with no buyers. ` +
      `Consider lowering MIN_SOL_INVESTED_LAMPORTS.`,
    );
  }

  if (diagnosis.length === 0) {
    diagnosis.push("All checks passed");
  }

  // Map wsReadyState number to human-readable string
  const readyStateLabel: Record<number, string> = {
    0: "CONNECTING",
    1: "OPEN",
    2: "CLOSING",
    3: "CLOSED",
  };
  const rsLabel =
    stats.wsReadyState !== null
      ? (readyStateLabel[stats.wsReadyState] ?? `UNKNOWN(${stats.wsReadyState})`)
      : "null (ws object is null)";

  // ── PostLaunchWatcher diagnosis ────────────────────────────────────────────
  const watcherDiagnosis: string[] = [];
  if (!watcherStats.enabled) {
    watcherDiagnosis.push("PostLaunchWatcher is disabled via PLW_ENABLED=false.");
  } else if (!watcherStats.running) {
    watcherDiagnosis.push("PostLaunchWatcher is NOT running — check HELIUS_API_KEY.");
  } else if (!watcherStats.wsAlive) {
    watcherDiagnosis.push("PostLaunchWatcher WebSocket is DOWN — check Railway logs.");
  } else if (watcherStats.tokens === 0) {
    watcherDiagnosis.push("PostLaunchWatcher is running but tracking 0 mints (scan_history empty or DB unavailable).");
  } else if (watcherStats.mintSubsConfirmed === 0 && watcherStats.tokens > 0) {
    watcherDiagnosis.push("PostLaunchWatcher has tokens but no confirmed subscriptions — still connecting or Helius rejected logsSubscribe.");
  } else {
    watcherDiagnosis.push(
      `OK — ${watcherStats.tokens} tokens tracked, ` +
      `${watcherStats.totalSubs}/${watcherStats.totalSubsCap} subs active ` +
      `(${watcherStats.mintSubsConfirmed} mint + ${watcherStats.metaSubsConfirmed} metadata PDA confirmed).`,
    );
  }

  return new Response(
    JSON.stringify(
      {
        ok:            true,
        serverTime:    new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        // NEW — scheduler block
        scheduler: {
          stampRunning:       scheduler.stampRunning,
          inFlightCount:      scheduler.inFlightCount,
          maxConcurrent:      scheduler.maxConcurrent,
          batchSize:          scheduler.batchSize,
          intervalMs:         scheduler.intervalMs,
          totalProcessed:     scheduler.totalProcessed,
          totalFailed:        scheduler.totalFailed,
          consecutiveTickErr: scheduler.consecutiveTickErr,
          note: scheduler.inFlightCount > 0
            ? `${scheduler.inFlightCount} collect() call(s) actively running in background`
            : "idle",
        },
        discovery: {
          running:           stats.running,
          subscriptionId:    stats.subscriptionId,
          tokensEnqueued:    stats.tokensEnqueued,
          wsAlive:           stats.wsAlive,
          lastMessageAt:     stats.lastMessageAt,
          wsGlobalAvailable: stats.wsGlobalAvailable,
          wsReadyState:      rsLabel,
          totalReconnects:   stats.totalReconnects,
          lastCloseCode:     stats.lastCloseCode,
          lastCloseReason:   stats.lastCloseReason || null,
          lastWsError:       stats.lastWsError || null,
        },
        pipeline: {
          "1_messagesReceived":    p.messagesReceived,
          "2_createEventsFound":   p.createEventsFound,
          "3_mintsExtracted":      p.mintsExtracted,
          "4_bondingCurveRead":    p.dexScreenerHit,
          "5_solInvestedPassed":   p.liquidityPassed,
          "6_tokensEnqueued":      p.tokensEnqueued,
          "4_bcDiag": p.bcDiag,
          filters: {
            minSolInvested:    "0.5 SOL",
            priceCheckDelayMs: 20000,
            retries:           3,
            dataSource:        "helius getAccountInfo (on-chain bonding curve)",
          },
        },
        watcher: {
          enabled:               watcherStats.enabled,
          running:               watcherStats.running,
          wsAlive:               watcherStats.wsAlive,
          tokens:                watcherStats.tokens,
          tokenCap:              watcherStats.tokenCap,
          subscriptions: {
            mintConfirmed:        watcherStats.mintSubsConfirmed,
            mintPending:          watcherStats.mintSubsPending,
            metadataPDAConfirmed: watcherStats.metaSubsConfirmed,
            metadataPDAPending:   watcherStats.metaSubsPending,
            total:                watcherStats.totalSubs,
            cap:                  watcherStats.totalSubsCap,
          },
          metrics: {
            totalNotifications:      watcherStats.totalNotifications,
            sessionAgeSeconds:       watcherStats.sessionAgeSeconds,
            estimatedCreditsPerDay:  watcherStats.estimatedCreditsPerDay,
            topMintsByNotifications: watcherStats.topMintsByNotifications,
          },
          diagnosis: watcherDiagnosis,
        },
        heliusBudget: _getHCBudgetStats(),
        env,
        diagnosis,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}
