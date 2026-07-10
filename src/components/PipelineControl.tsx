// =============================================================================
// PipelineControl.tsx
//
// Fixed "Pipeline Control" icon shown on every page (mounted once in
// __root.tsx). Clicking it opens a dialog with a live-polled snapshot of
// every backlog pipeline (wallet collection queue, wallet enrichment,
// trade record ingestion, discovery scans) plus Helius API credit
// consumption — sourced from GET /api/backlog-status.
// =============================================================================

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FailedJob {
  tokenAddress: string;
  attempts: number;
  lastError: string | null;
  enqueuedAt: string;
}

interface BacklogStatus {
  generatedAt: string;
  collectionQueue: {
    pending: number;
    processing: number;
    done: number;
    failed: number;
    completedLast24h: number;
    recentFailedJobs: FailedJob[];
  };
  enrichment: {
    totalPerformanceRecords: number;
    totalEnrichedRecords: number;
    hollowPairsPending: number;
    hollowPairsPendingIsFloor: boolean;
    updatedLast1h: number;
    updatedLast24h: number;
  };
  tradeRecords: {
    totalTradeEvents: number;
    buyEventsLast24h: number;
    sellEventsLast24h: number;
    totalSolTransfers: number;
    solTransfersLast24h: number;
  };
  discovery: {
    totalScans: number;
    lastScanAt: string | null;
    alertsLast24h: number;
    enabled: boolean;
  };
  helius: {
    hourlyUsed: number;
    hourlyBudget: number;
    dailyUsed: number;
    dailyBudget: number;
    cuLast1h: number;
    cuLast24h: number;
    cuLast7d: number;
    topComponentsLast24h: { component: string; cuLast24h: number }[];
  };
}

const POLL_INTERVAL_MS = 8000;

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "danger" | "muted" }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-mono text-xl font-semibold",
          tone === "danger" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function BudgetBar({ used, budget }: { used: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full transition-all",
          pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-yellow-500" : "bg-primary",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function PipelineControl() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<BacklogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function fetchStatus() {
      setLoading(true);
      try {
        const res = await fetch("/api/backlog-status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as BacklogStatus;
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [open]);

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        title="Pipeline Control"
        aria-label="Pipeline Control"
        className="fixed bottom-4 right-4 z-40 h-11 w-11 rounded-full border-border bg-background/90 shadow-lg backdrop-blur"
      >
        <Activity className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Pipeline Control
              {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </DialogTitle>
            <DialogDescription>
              Live backlog + Helius credit usage, refreshed every {POLL_INTERVAL_MS / 1000}s.
              {status && (
                <span className="ml-1">Updated {formatRelativeTime(status.generatedAt)}.</span>
              )}
            </DialogDescription>
          </DialogHeader>

          {error && !status && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Failed to load pipeline status: {error}
            </div>
          )}

          {status && (
            <div className="grid gap-3 sm:grid-cols-2">
              <StatCard label="Wallet Collection Queue">
                <div className="grid grid-cols-4 gap-2">
                  <Metric label="Pending" value={status.collectionQueue.pending} tone={status.collectionQueue.pending === 0 ? "muted" : undefined} />
                  <Metric label="Processing" value={status.collectionQueue.processing} tone={status.collectionQueue.processing === 0 ? "muted" : undefined} />
                  <Metric label="Done" value={formatNumber(status.collectionQueue.done)} />
                  <Metric label="Failed" value={status.collectionQueue.failed} tone={status.collectionQueue.failed > 0 ? "danger" : "muted"} />
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {formatNumber(status.collectionQueue.completedLast24h)} completed in last 24h
                </div>
                {status.collectionQueue.recentFailedJobs.length > 0 && (
                  <div className="mt-3 space-y-1 border-t border-border pt-2">
                    {status.collectionQueue.recentFailedJobs.slice(0, 4).map((job) => (
                      <div key={`${job.tokenAddress}-${job.enqueuedAt}`} className="truncate text-[11px] text-muted-foreground">
                        <span className="font-mono text-destructive">{job.tokenAddress.slice(0, 6)}…</span>{" "}
                        {job.attempts} attempts — {job.lastError ?? "unknown error"}
                      </div>
                    ))}
                  </div>
                )}
              </StatCard>

              <StatCard label="Wallet Enrichment">
                <div className="grid grid-cols-2 gap-2">
                  <Metric
                    label="Hollow Pairs Pending"
                    value={`${formatNumber(status.enrichment.hollowPairsPending)}${status.enrichment.hollowPairsPendingIsFloor ? "+" : ""}`}
                    tone={status.enrichment.hollowPairsPending === 0 ? "muted" : undefined}
                  />
                  <Metric label="Updated (1h)" value={formatNumber(status.enrichment.updatedLast1h)} />
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {formatNumber(status.enrichment.totalEnrichedRecords)} / {formatNumber(status.enrichment.totalPerformanceRecords)} performance records enriched
                </div>
              </StatCard>

              <StatCard label="Trade Records">
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="Total Events" value={formatNumber(status.tradeRecords.totalTradeEvents)} />
                  <Metric label="SOL Transfers" value={formatNumber(status.tradeRecords.totalSolTransfers)} />
                </div>
                <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                  <span>+{formatNumber(status.tradeRecords.buyEventsLast24h)} buys/24h</span>
                  <span>+{formatNumber(status.tradeRecords.sellEventsLast24h)} sells/24h</span>
                </div>
              </StatCard>

              <StatCard label="Discovery Scans">
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="Total Scans" value={formatNumber(status.discovery.totalScans)} />
                  <Metric label="Alerts (24h)" value={status.discovery.alertsLast24h} tone={status.discovery.alertsLast24h === 0 ? "muted" : undefined} />
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Last scan: {formatRelativeTime(status.discovery.lastScanAt)}
                  {!status.discovery.enabled && " · autonomous discovery paused"}
                </div>
              </StatCard>

              <StatCard label="Helius Budget">
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>Hourly</span>
                      <span>{formatNumber(status.helius.hourlyUsed)} / {status.helius.hourlyBudget > 0 ? formatNumber(status.helius.hourlyBudget) : "∞"}</span>
                    </div>
                    <BudgetBar used={status.helius.hourlyUsed} budget={status.helius.hourlyBudget} />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>Daily</span>
                      <span>{formatNumber(status.helius.dailyUsed)} / {status.helius.dailyBudget > 0 ? formatNumber(status.helius.dailyBudget) : "∞"}</span>
                    </div>
                    <BudgetBar used={status.helius.dailyUsed} budget={status.helius.dailyBudget} />
                  </div>
                </div>
              </StatCard>

              <StatCard label="Helius CU Consumption">
                <div className="grid grid-cols-3 gap-2">
                  <Metric label="1h" value={formatNumber(status.helius.cuLast1h)} />
                  <Metric label="24h" value={formatNumber(status.helius.cuLast24h)} />
                  <Metric label="7d" value={formatNumber(status.helius.cuLast7d)} />
                </div>
                {status.helius.topComponentsLast24h.length > 0 && (
                  <div className="mt-3 space-y-1 border-t border-border pt-2">
                    {status.helius.topComponentsLast24h.slice(0, 4).map((c) => (
                      <div key={c.component} className="flex justify-between text-[11px] text-muted-foreground">
                        <span>{c.component}</span>
                        <span className="font-mono">{formatNumber(c.cuLast24h)} CU</span>
                      </div>
                    ))}
                  </div>
                )}
              </StatCard>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
