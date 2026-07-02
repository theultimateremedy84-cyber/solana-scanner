// =============================================================================
// Discovery Quality Filter Dashboard — server functions  (P3-E)
//
// Internal operator tool. Aggregates wallet_collection_jobs (autonomous
// discovery queue) joined against scan_history (risk scoring) by day, so the
// discovery filters can be tuned from real data instead of Railway logs.
//
// Read-only. No new tables, no schema changes, no write operations.
// Uses the canonical service-role client only (no anon-key fallback) — same
// hardened pattern as wallet-collection-trigger.functions.ts.
// =============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOG = "[DiscoveryQuality]";

// A token is treated as "rug detected" when its most recent scanned risk
// score exceeds this threshold — matches the audit's P3-E recommendation
// (risk_score > 80).
const RUG_RISK_THRESHOLD = 80;

export interface DiscoveryQualityDay {
  date: string; // YYYY-MM-DD, UTC
  tokensDiscovered: number;
  jobsDone: number;
  jobsFailed: number;
  jobsPending: number;
  scannedCount: number; // tokens discovered that day with a matching scan_history row
  rugCount: number; // scanned tokens with risk_score > RUG_RISK_THRESHOLD
  rugRate: number | null; // rugCount / scannedCount, null if scannedCount === 0
  avgRiskScore: number | null;
  avgMarketCapUsd: number | null;
  avgLiquidityUsd: number | null;
  avgHolderCount: number | null;
}

export interface DiscoveryQualitySummary {
  days: DiscoveryQualityDay[];
  totalTokensDiscovered: number;
  totalScanned: number;
  totalRugs: number;
  overallRugRate: number | null;
  rangeDays: number;
}

interface CollectionJobRow {
  token_address: string;
  status: string;
  enqueued_at: string;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  holder_count: number | null;
}

interface ScanHistoryRow {
  token_address: string;
  risk_score: number;
  scanned_at: string;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

/**
 * Aggregates the discovery queue + risk scoring by day for the last
 * `rangeDays` days (default 14, max 90).
 */
export const getDiscoveryQualityDaily = createServerFn({ method: "GET" })
  .inputValidator(
    z.object({
      rangeDays: z.number().int().min(1).max(90).optional().default(14),
    }),
  )
  .handler(async ({ data }): Promise<DiscoveryQualitySummary> => {
    const since = new Date(Date.now() - data.rangeDays * 24 * 60 * 60 * 1000).toISOString();

    const [jobsResult, scansResult] = await Promise.all([
      supabaseAdmin
        .from("wallet_collection_jobs")
        .select("token_address, status, enqueued_at, market_cap_usd, liquidity_usd, holder_count")
        .gte("enqueued_at", since)
        .order("enqueued_at", { ascending: false })
        .limit(5000),
      supabaseAdmin
        .from("scan_history")
        .select("token_address, risk_score, scanned_at")
        .gte("scanned_at", since)
        .order("scanned_at", { ascending: false })
        .limit(5000),
    ]);

    if (jobsResult.error) {
      console.error(`${LOG} wallet_collection_jobs query failed: ${jobsResult.error.message}`);
    }
    if (scansResult.error) {
      console.error(`${LOG} scan_history query failed: ${scansResult.error.message}`);
    }

    const jobs = (jobsResult.data ?? []) as CollectionJobRow[];
    const scans = (scansResult.data ?? []) as ScanHistoryRow[];

    // Most recent scan per token (scans already ordered scanned_at desc, so
    // first occurrence per token_address wins).
    const latestScanByToken = new Map<string, ScanHistoryRow>();
    for (const scan of scans) {
      if (!latestScanByToken.has(scan.token_address)) {
        latestScanByToken.set(scan.token_address, scan);
      }
    }

    const byDay = new Map<string, CollectionJobRow[]>();
    for (const job of jobs) {
      const key = dayKey(job.enqueued_at);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(job);
      else byDay.set(key, [job]);
    }

    const days: DiscoveryQualityDay[] = [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1)) // newest day first
      .map(([date, dayJobs]) => {
        const jobsDone = dayJobs.filter((j) => j.status === "done").length;
        const jobsFailed = dayJobs.filter((j) => j.status === "failed").length;
        const jobsPending = dayJobs.filter((j) => j.status === "pending" || j.status === "processing").length;

        const riskScores: number[] = [];
        let rugCount = 0;
        let scannedCount = 0;
        for (const job of dayJobs) {
          const scan = latestScanByToken.get(job.token_address);
          if (!scan) continue;
          scannedCount++;
          riskScores.push(scan.risk_score);
          if (scan.risk_score > RUG_RISK_THRESHOLD) rugCount++;
        }

        return {
          date,
          tokensDiscovered: dayJobs.length,
          jobsDone,
          jobsFailed,
          jobsPending,
          scannedCount,
          rugCount,
          rugRate: scannedCount > 0 ? rugCount / scannedCount : null,
          avgRiskScore: avg(riskScores),
          avgMarketCapUsd: avg(dayJobs.map((j) => j.market_cap_usd).filter((v): v is number => v != null)),
          avgLiquidityUsd: avg(dayJobs.map((j) => j.liquidity_usd).filter((v): v is number => v != null)),
          avgHolderCount: avg(dayJobs.map((j) => j.holder_count).filter((v): v is number => v != null)),
        };
      });

    const totalTokensDiscovered = jobs.length;
    const totalScanned = days.reduce((sum, d) => sum + d.scannedCount, 0);
    const totalRugs = days.reduce((sum, d) => sum + d.rugCount, 0);

    return {
      days,
      totalTokensDiscovered,
      totalScanned,
      totalRugs,
      overallRugRate: totalScanned > 0 ? totalRugs / totalScanned : null,
      rangeDays: data.rangeDays,
    };
  });
