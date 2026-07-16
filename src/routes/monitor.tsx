// =============================================================================
// monitor.tsx — /monitor
//
// 22-section live pipeline monitoring dashboard.
// Polls /api/monitor-dashboard every 15 seconds.
//
// Sections:
//   §1-6   Token Scans, Risk Distribution, Honeypot, LP, MarketCap, Holders
//   §7     Developer Intelligence
//   §8     Wallet Collection Queue + Scheduler
//   §9-11  Wallet Intelligence — scores, P&L, tiers
//   §12    Wallet Performance History — positions, milestones, ROI
//   §13    Hollow Wallet Enrichment — data source coverage
//   §14    Token Price History
//   §15    PostLaunchWatcher Alerts
//   §16    SOL Transfer Graph + Sybil Detection
//   §17    Intelligence Snapshots (daily history)
//   §18    Developer Reputation Snapshots (daily history)
//   §18b   Token Risk Snapshots (daily history)
//   §19    Helius CU Telemetry
//   §20    Graduation Pipeline
//   §21    Discovery Rescore Queue
//   §22    Discovery Score Engine
//   WS     TokenDiscovery WebSocket + PostLaunchWatcher live panels
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/monitor")({
  head: () => ({
    meta: [
      { title: "Pipeline Monitor — Scam Intel Ops" },
      { name: "description", content: "Live 22-section monitoring for all pipeline metrics." },
    ],
  }),
  component: MonitorPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface FailedJob {
  tokenAddress: string;
  attempts: number;
  lastError: string | null;
  enqueuedAt: string;
}

interface MonitorData {
  ok: boolean;
  fetchedAt: string;
  collectionQueue: {
    pending: number; processing: number; done: number; failed: number;
    completedLast24h: number; recentFailedJobs: FailedJob[];
  };
  enrichment: {
    hollowPairsPending: number;
    heliusFullHistory: number; holderScan: number; poolExtraction: number;
    ghostEnrichments: number; pairsWithEvidence: number;
    scannedLast1h: number; scannedLast24h: number; totalPerformanceRecords: number;
  };
  buySellData: {
    totalBuyTxs: number; totalSellTxs: number;
    buyTxsLast24h: number; sellTxsLast24h: number;
    buyVolSolLast24h: number; sellVolSolLast24h: number; netVolSolLast24h: number;
  };
  rawTxMetrics: { totalSolInvested: number; totalSolReceived: number; netSolRawPnl: number };
  winRoi: {
    walletsWithWinRate: number; walletsUnscored: number;
    walletsScoredLast24h: number; walletsWinRateAbove50: number;
    evidenceRaw: number; evidenceFallback: number;
    avgWinRate: number | null; avgRoi: number | null;
    totalRealizedPnlSol: number | null; totalUnrealizedPnlSol: number | null;
    confidenceTier: { elite: number; high: number; medium: number; low: number; unrated: number };
    discoveryTier: { elite: number; strong: number; developing: number; unproven: number; lowSample: number };
    convictionScored: number; intelligenceScored: number;
    positionsOpen: number; positionsClosed: number;
    positionsPartiallyClosed: number; positionsUnknown: number;
    roiAbove2x: number; roiAbove5x: number; roiAbove10x: number;
    milestones: { reached100k: number; reached500k: number; reached1m: number; reached5m: number; reached10m: number; reached50m: number };
    airdropExits: number;
  };
  scans: {
    totalScans: number; scansLast24h: number; scansFromDiscovery: number;
    lastScanAt: string | null; highRiskLast24h: number; honeypotLast24h: number;
    avgRiskScoreLast24h: number | null;
    riskFlags: {
      metadataHijacked: number; cpiManipulated: number; stateHijacked: number;
      atomicExploit: number; nonRentExempt: number; metadataMutable: number;
      authorityTransitioned: number; accountResized: number; pathObfuscated: number;
    };
    graduation: { total: number; last24h: number };
  };
  alerts: {
    total: number; last24h: number; critical24h: number; warn24h: number;
    byType: { type: string; count: number }[];
  };
  helius: {
    hourlyUsed: number; hourlyBudget: number; dailyUsed: number; dailyBudget: number;
    monthlyUsed: number; monthlyBudget: number;
    cuLast1h: number; cuLast24h: number; cuLast7d: number;
    topComponentsLast1h: { component: string; cuUsed: number }[];
    topComponentsLast24h: { component: string; cuUsed: number }[];
  };
  wallets: {
    total: number; updatedLast1h: number; updatedLast24h: number;
    smartMoney: number; whale: number; bot: number; sniper: number; retail: number;
  };
  sybilDetection: { walletsIndexed: number; uniqueFunders: number; avgWalletsPerFunder: number };
  solTransfers: { total: number; last24h: number };
  priceData: { total: number; snapshotsLast24h: number; lastSnapshotAt: string | null };
  // §17 — Daily intelligence snapshots
  intelligenceSnapshots: {
    totalRows: number; walletsCapturedToday: number;
    oldestSnapshotDate: string | null; newestSnapshotDate: string | null;
    daysOfHistory: number;
  };
  // §18 — Developer reputation snapshots
  developerSnapshots: {
    totalRows: number; developersCapturedToday: number;
    oldestSnapshotDate: string | null;
  };
  // §18b — Token risk snapshots
  tokenRiskSnapshots: {
    totalRows: number; tokensCapturedToday: number;
    oldestSnapshotDate: string | null;
  };
  // §20 — Graduation pipeline
  graduationPipeline: {
    totalDiscoveryTokens: number; graduatedTotal: number; graduatedLast24h: number;
    ungraduatedPending: number; graduationRatePct: number | null;
    avgGraduationMcapUsd: number | null;
  };
  // §21 — Discovery rescore queue
  discoveryRescore: {
    needsRescorePending: number; rescoreDoneLast24h: number; rescoredTotal: number;
  };
  // §22 — Discovery score engine
  discoveryScoreEngine: {
    walletsWithDiscoveryScore: number; avgDiscoveryConfidence: number | null;
    avgTotalDiscoveries: number | null; avgSuccessfulDiscoveries: number | null;
    avgEntryMarketCapUsd: number | null; discoveryConfidenceHigh: number;
  };
  tokenDiscovery: {
    running: boolean; wsAlive: boolean; wsReadyState: number | null;
    lastMessageAt: string | null; totalReconnects: number;
    lastCloseCode: number | null; lastCloseReason: string; lastWsError: string;
    pipeline: {
      messagesReceived: number; createEventsFound: number; mintsExtracted: number;
      dexScreenerHit: number; liquidityPassed: number; tokensEnqueued: number;
    };
    bcDiag: { accountNotFound: number; tooSmall: number; sanityCap: number; rpcError: number };
  } | null;
  postLaunchWatcher: {
    enabled: boolean; running: boolean; wsAlive: boolean;
    tokensTracked: number; tokenCap: number;
    mintSubsConfirmed: number; mintSubsPending: number;
    metaSubsConfirmed: number; metaSubsPending: number;
    totalNotifications: number; estimatedCreditsPerDay: number; sessionAgeSeconds: number;
  } | null;
  scheduler: { inFlightCount: number; totalProcessed: number; totalFailed: number; stampRunning: boolean };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt    = (n: number) => n.toLocaleString();
const fmtSol = (n: number) => `${n.toFixed(2)} SOL`;
const fmtPct = (n: number | null) => n !== null ? `${(n * 100).toFixed(1)}%` : "—";
const fmtRaw = (n: number | null, digits = 1) => n !== null ? `${n.toFixed(digits)}%` : "—";
const fmtX   = (n: number | null) => n !== null ? `${n.toFixed(2)}×` : "—";
const fmtUsd = (n: number | null) => n !== null ? `$${n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : n.toFixed(0)}` : "—";
const fmtConf = (n: number | null) => n !== null ? `${(n * 100).toFixed(0)}%` : "—";

function rel(iso: string | null): string {
  if (!iso) return "never";
  const d = Date.now() - new Date(iso).getTime();
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pctOf(used: number, budget: number) {
  return budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
}

// ─── Primitive UI ─────────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "danger" | "muted";

function tc(t?: Tone) {
  if (t === "ok")     return "text-risk-low";
  if (t === "warn")   return "text-risk-medium";
  if (t === "danger") return "text-destructive";
  return "text-muted-foreground";
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded border border-border bg-card p-4", className)}>
      <h2 className="mb-3 font-display text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone, large }: {
  label: string; value: string | number; sub?: string; tone?: Tone; large?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono font-semibold tabular-nums leading-tight", large ? "text-3xl" : "text-lg", tc(tone))}>
        {typeof value === "number" ? fmt(value) : value}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function G({ cols = 2, children }: { cols?: 2 | 3 | 4; children: React.ReactNode }) {
  return (
    <div className={cn("grid gap-3", {
      "grid-cols-2": cols === 2,
      "grid-cols-3": cols === 3,
      "grid-cols-4": cols === 4,
    })}>
      {children}
    </div>
  );
}

function Sub({ label }: { label: string }) {
  return <div className="mt-3 border-t border-border/40 pt-2 mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>;
}

function BudgetBar({ label, used, budget }: { label: string; used: number; budget: number }) {
  const p = pctOf(used, budget);
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{budget > 0 ? `${fmt(used)} / ${fmt(budget)} (${p}%)` : `${fmt(used)} CU (no limit)`}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", p >= 90 ? "bg-destructive" : p >= 70 ? "bg-risk-medium" : "bg-risk-low")}
          style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function Flag({ label, count }: { label: string; count: number }) {
  return (
    <div className={cn("flex items-center justify-between rounded px-2 py-1 text-[11px]",
      count > 0 ? "bg-destructive/10 text-destructive" : "bg-muted/20 text-muted-foreground")}>
      <span>{label}</span>
      <span className="font-mono font-semibold">{fmt(count)}</span>
    </div>
  );
}

function SrcBar({ label, value, total, tone }: { label: string; value: number; total: number; tone?: Tone }) {
  const p = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px]">
        <span className={cn("font-semibold", tc(tone))}>{label}</span>
        <span className="font-mono text-muted-foreground">{fmt(value)} ({p.toFixed(0)}%)</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full",
          tone === "ok" ? "bg-risk-low" : tone === "warn" ? "bg-risk-medium" : tone === "danger" ? "bg-destructive" : "bg-primary/40")}
          style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function CompBar({ label, value, max }: { label: string; value: number; max: number }) {
  const p = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span className="truncate pr-2">{label}</span>
        <span className="font-mono shrink-0">{fmt(value)}</span>
      </div>
      <div className="h-0.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary/60 transition-all" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function FunnelStep({ label, value, prev }: { label: string; value: number; prev?: number }) {
  const rate = prev !== undefined && prev > 0 ? ((value / prev) * 100).toFixed(0) : null;
  return (
    <div className="flex items-center justify-between rounded bg-muted/20 px-3 py-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        {rate !== null && (
          <span className={cn("text-[10px] font-mono", Number(rate) < 10 ? "text-destructive" : Number(rate) < 50 ? "text-risk-medium" : "text-risk-low")}>
            {rate}%
          </span>
        )}
        <span className="font-mono text-sm font-semibold text-foreground">{fmt(value)}</span>
      </span>
    </div>
  );
}

function Pill({ alive, label }: { alive: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
      alive ? "bg-risk-low/15 text-risk-low" : "bg-destructive/15 text-destructive")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", alive ? "bg-risk-low animate-pulse" : "bg-destructive")} />
      {label}
    </span>
  );
}

function SnapshotCard({ title, totalRows, capturedToday, oldestDate, newestDate, daysOfHistory }: {
  title: string; totalRows: number; capturedToday: number;
  oldestDate?: string | null; newestDate?: string | null; daysOfHistory?: number;
}) {
  return (
    <Section title={title}>
      <G cols={2}>
        <Stat label="Total Rows" value={totalRows} tone="muted" sub="all-time snapshots" />
        <Stat label="Captured Today" value={capturedToday}
          tone={capturedToday > 0 ? "ok" : "warn"}
          sub={capturedToday > 0 ? "midnight UTC run ✓" : "not yet snapshotted today"} />
      </G>
      {(oldestDate || daysOfHistory !== undefined) && (
        <>
          <Sub label="Historical Depth" />
          <div className="space-y-1 text-[11px] text-muted-foreground">
            {oldestDate && <div className="flex justify-between"><span>Oldest</span><span className="font-mono">{oldestDate}</span></div>}
            {newestDate && <div className="flex justify-between"><span>Latest</span><span className="font-mono">{newestDate}</span></div>}
            {daysOfHistory !== undefined && (
              <div className="flex justify-between">
                <span>Days of history</span>
                <span className={cn("font-mono font-semibold", daysOfHistory >= 30 ? "text-risk-low" : daysOfHistory >= 7 ? "text-risk-medium" : "text-destructive")}>
                  {daysOfHistory}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const POLL_MS = 15_000;

function MonitorPage() {
  const [data, setData]       = useState<MonitorData | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [secsAgo, setSecsAgo] = useState(0);
  const lastFetchRef = useRef<number | null>(null);

  const load = async (bg = false) => {
    bg ? setSyncing(true) : setLoading(true);
    try {
      const res  = await fetch("/api/monitor-dashboard");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Unknown error");
      setData(json);
      setError(null);
      lastFetchRef.current = Date.now();
      setSecsAgo(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); setSyncing(false); }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => { const id = setInterval(() => void load(true), POLL_MS); return () => clearInterval(id); }, []);
  useEffect(() => {
    const id = setInterval(() => {
      if (lastFetchRef.current) setSecsAgo(Math.floor((Date.now() - lastFetchRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const d = data;
  const hollowTone: Tone = !d ? "muted" : d.enrichment.hollowPairsPending === 0 ? "ok" : d.enrichment.hollowPairsPending <= 100 ? "warn" : "danger";
  const totalPairs = d ? (d.enrichment.heliusFullHistory + d.enrichment.holderScan + d.enrichment.poolExtraction) : 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-4">
            <Link to="/" className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors">← Home</Link>
            <span className="font-display text-sm font-semibold uppercase tracking-widest">Pipeline Monitor</span>
            <span className="hidden sm:inline font-mono text-[10px] text-muted-foreground">22 sections · all metrics</span>
          </div>
          <div className="flex items-center gap-3">
            {syncing ? (
              <span className="font-mono text-[11px] text-primary animate-pulse">SYNCING…</span>
            ) : (
              <span className={cn("flex items-center gap-1.5 font-mono text-[11px]",
                secsAgo > 20 ? "text-risk-medium" : "text-risk-low")}>
                <span className={cn("h-1.5 w-1.5 rounded-full",
                  secsAgo > 20 ? "bg-risk-medium" : "bg-risk-low animate-pulse")} />
                LIVE · {secsAgo}s ago
              </span>
            )}
            <button onClick={() => void load(true)}
              className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-border-strong hover:text-foreground transition-colors">
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-screen-2xl px-4 py-5 sm:px-6 space-y-4">
        {loading && (
          <div className="flex h-64 items-center justify-center">
            <span className="font-mono text-sm text-muted-foreground animate-pulse">Loading pipeline metrics…</span>
          </div>
        )}
        {error && !loading && (
          <div className="rounded border border-destructive/40 bg-destructive/10 px-4 py-3 font-mono text-sm text-destructive">
            Error: {error}
          </div>
        )}

        {d && (
          <>
            {/* ══ Row 1: Critical backlogs + status pills ══════════════════════ */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {/* §13 — Enrichment Backlog */}
              <Section title="Enrichment Backlog">
                <Stat label="Hollow Pairs Pending" value={d.enrichment.hollowPairsPending} large tone={hollowTone}
                  sub={d.enrichment.hollowPairsPending === 0
                    ? "All pairs enriched ✓"
                    : `${fmt(d.enrichment.totalPerformanceRecords)} positions, ${fmt(d.enrichment.heliusFullHistory)} enriched`} />
              </Section>

              {/* §8 — Collection Queue */}
              <Section title="Collection Queue">
                <G cols={2}>
                  <Stat label="Pending"    value={d.collectionQueue.pending}    tone={d.collectionQueue.pending > 50 ? "warn" : "muted"} />
                  <Stat label="Processing" value={d.collectionQueue.processing} tone={d.collectionQueue.processing > 0 ? "ok" : "muted"} />
                  <Stat label="Failed"     value={d.collectionQueue.failed}     tone={d.collectionQueue.failed > 0 ? "danger" : "ok"} />
                  <Stat label="Done (24h)" value={d.collectionQueue.completedLast24h} tone="muted" />
                </G>
                {d.collectionQueue.failed > 0 && (
                  <div className="mt-2 rounded bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-bold text-destructive">
                    {fmt(d.collectionQueue.failed)} FAILED — ACTION REQUIRED
                  </div>
                )}
              </Section>

              {/* Scheduler */}
              <Section title="Scheduler">
                <G cols={2}>
                  <Stat label="In-Flight"  value={d.scheduler.inFlightCount}  tone={d.scheduler.inFlightCount >= 3 ? "warn" : "ok"} />
                  <Stat label="Processed"  value={d.scheduler.totalProcessed} tone="muted" />
                  <Stat label="Failed"     value={d.scheduler.totalFailed}    tone={d.scheduler.totalFailed > 0 ? "danger" : "ok"} />
                  <Stat label="Lock"       value={d.scheduler.stampRunning ? "LOCKED" : "FREE"} tone={d.scheduler.stampRunning ? "warn" : "ok"} />
                </G>
              </Section>

              {/* §15 — Alerts summary */}
              <Section title="Alerts (24h)">
                <G cols={2}>
                  <Stat label="Critical" value={d.alerts.critical24h} tone={d.alerts.critical24h > 0 ? "danger" : "muted"} />
                  <Stat label="Warn"     value={d.alerts.warn24h}     tone={d.alerts.warn24h > 0 ? "warn" : "muted"} />
                </G>
                {d.alerts.byType.length > 0 && (
                  <>
                    <Sub label="By Type (24h)" />
                    <div className="space-y-0.5">
                      {d.alerts.byType.map(({ type, count }) => (
                        <div key={type} className="flex justify-between text-[11px]">
                          <span className="text-muted-foreground truncate pr-2">{type.replace(/_/g, " ")}</span>
                          <span className={cn("font-mono font-semibold shrink-0", count > 0 ? "text-destructive" : "text-muted-foreground")}>{count}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="mt-2 font-mono text-[10px] text-muted-foreground">{fmt(d.alerts.total)} total all-time</div>
              </Section>
            </div>

            {/* ══ Row 2: TokenDiscovery + PostLaunchWatcher WebSocket panels ══ */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section title="Token Discovery — WebSocket + Pipeline Funnel">
                {!d.tokenDiscovery ? (
                  <p className="text-[12px] text-risk-medium">Not started (ENABLE_TOKEN_DISCOVERY may be false)</p>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div>
                      <div className="mb-2 flex flex-wrap gap-2">
                        <Pill alive={d.tokenDiscovery.wsAlive} label={d.tokenDiscovery.wsAlive ? "WS CONNECTED" : "WS DOWN"} />
                        <Pill alive={d.tokenDiscovery.running} label={d.tokenDiscovery.running ? "RUNNING" : "STOPPED"} />
                      </div>
                      <G cols={2}>
                        <Stat label="Reconnects" value={d.tokenDiscovery.totalReconnects}
                          tone={d.tokenDiscovery.totalReconnects > 5 ? "warn" : "muted"} />
                        <Stat label="Last Msg" value={rel(d.tokenDiscovery.lastMessageAt)}
                          tone={!d.tokenDiscovery.lastMessageAt || Date.now() - new Date(d.tokenDiscovery.lastMessageAt).getTime() > 120_000 ? "danger" : "ok"} />
                      </G>
                      {(d.tokenDiscovery.lastWsError || d.tokenDiscovery.lastCloseCode) && (
                        <div className="mt-2 rounded bg-destructive/10 px-2 py-1 text-[10px] font-mono text-destructive">
                          {d.tokenDiscovery.lastCloseCode && `Close: ${d.tokenDiscovery.lastCloseCode} ${d.tokenDiscovery.lastCloseReason}`}
                          {d.tokenDiscovery.lastWsError && ` | ${d.tokenDiscovery.lastWsError}`}
                        </div>
                      )}
                      <Sub label="Bonding Curve Drop Reasons" />
                      <G cols={2}>
                        <Stat label="Acct Not Found" value={d.tokenDiscovery.bcDiag.accountNotFound} tone={d.tokenDiscovery.bcDiag.accountNotFound > 100 ? "warn" : "muted"} />
                        <Stat label="Too Small"      value={d.tokenDiscovery.bcDiag.tooSmall} tone="muted" />
                        <Stat label="Sanity Cap"     value={d.tokenDiscovery.bcDiag.sanityCap} tone="muted" />
                        <Stat label="RPC Error"      value={d.tokenDiscovery.bcDiag.rpcError} tone={d.tokenDiscovery.bcDiag.rpcError > 10 ? "danger" : "muted"} />
                      </G>
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Conversion Funnel (session)</div>
                      <div className="space-y-1">
                        <FunnelStep label="WS Messages Received"  value={d.tokenDiscovery.pipeline.messagesReceived} />
                        <FunnelStep label="Create Events Found"   value={d.tokenDiscovery.pipeline.createEventsFound} prev={d.tokenDiscovery.pipeline.messagesReceived} />
                        <FunnelStep label="Mints Extracted"       value={d.tokenDiscovery.pipeline.mintsExtracted}   prev={d.tokenDiscovery.pipeline.createEventsFound} />
                        <FunnelStep label="DexScreener Hit"       value={d.tokenDiscovery.pipeline.dexScreenerHit}   prev={d.tokenDiscovery.pipeline.mintsExtracted} />
                        <FunnelStep label="Liquidity Passed"      value={d.tokenDiscovery.pipeline.liquidityPassed}  prev={d.tokenDiscovery.pipeline.dexScreenerHit} />
                        <FunnelStep label="Jobs Enqueued ✓"       value={d.tokenDiscovery.pipeline.tokensEnqueued}  prev={d.tokenDiscovery.pipeline.liquidityPassed} />
                      </div>
                    </div>
                  </div>
                )}
              </Section>

              <Section title="Post-Launch Watcher — Contract Monitoring">
                {!d.postLaunchWatcher ? (
                  <p className="text-[12px] text-risk-medium">Not started</p>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div>
                      <div className="mb-2 flex flex-wrap gap-2">
                        <Pill alive={d.postLaunchWatcher.wsAlive} label={d.postLaunchWatcher.wsAlive ? "WS CONNECTED" : "WS DOWN"} />
                        <Pill alive={d.postLaunchWatcher.enabled && d.postLaunchWatcher.running} label={d.postLaunchWatcher.running ? "RUNNING" : "STOPPED"} />
                      </div>
                      <G cols={2}>
                        <Stat label="Tokens Tracked" value={d.postLaunchWatcher.tokensTracked}
                          sub={`cap: ${d.postLaunchWatcher.tokenCap}`}
                          tone={d.postLaunchWatcher.tokensTracked >= d.postLaunchWatcher.tokenCap ? "warn" : "ok"} />
                        <Stat label="Notifications" value={d.postLaunchWatcher.totalNotifications} tone="muted" />
                        <Stat label="Credits/Day"   value={fmt(d.postLaunchWatcher.estimatedCreditsPerDay)}
                          tone={d.postLaunchWatcher.estimatedCreditsPerDay > 50_000 ? "warn" : "muted"} />
                        <Stat label="Session Age"
                          value={d.postLaunchWatcher.sessionAgeSeconds < 3600
                            ? `${Math.round(d.postLaunchWatcher.sessionAgeSeconds / 60)}m`
                            : `${Math.round(d.postLaunchWatcher.sessionAgeSeconds / 3600)}h`}
                          tone="muted" />
                      </G>
                    </div>
                    <div>
                      <Sub label="LaserStream Subscriptions" />
                      <G cols={2}>
                        <Stat label="Mint Confirmed"     value={d.postLaunchWatcher.mintSubsConfirmed}    tone="ok" />
                        <Stat label="Mint Pending"       value={d.postLaunchWatcher.mintSubsPending}      tone={d.postLaunchWatcher.mintSubsPending > 0 ? "warn" : "muted"} />
                        <Stat label="Meta Confirmed"     value={d.postLaunchWatcher.metaSubsConfirmed}    tone="ok" />
                        <Stat label="Meta Pending"       value={d.postLaunchWatcher.metaSubsPending}      tone={d.postLaunchWatcher.metaSubsPending > 0 ? "warn" : "muted"} />
                      </G>
                    </div>
                  </div>
                )}
              </Section>
            </div>

            {/* ══ Row 3: §13 Hollow Wallet Enrichment ══════════════════════════ */}
            <Section title="§13 — Hollow Wallet Enrichment · Data Source Coverage">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <SrcBar label="Helius Full History (fully enriched)" value={d.enrichment.heliusFullHistory} total={totalPairs} tone="ok" />
                  <SrcBar label="Holder Scan (hollow)"                 value={d.enrichment.holderScan}        total={totalPairs} tone="warn" />
                  <SrcBar label="Pool Extraction (hollow)"             value={d.enrichment.poolExtraction}    total={totalPairs} tone="warn" />
                </div>
                <G cols={3}>
                  <Stat label="Ghost Enrichments" value={d.enrichment.ghostEnrichments}    tone={d.enrichment.ghostEnrichments > 0 ? "warn" : "ok"} sub="has_evidence=false" />
                  <Stat label="With Evidence"     value={d.enrichment.pairsWithEvidence}   tone="ok" />
                  <Stat label="Scanned (1h)"      value={d.enrichment.scannedLast1h}       tone={d.enrichment.scannedLast1h === 0 ? "warn" : "ok"} />
                  <Stat label="Scanned (24h)"     value={d.enrichment.scannedLast24h}      tone="muted" />
                  <Stat label="Perf Records"      value={d.enrichment.totalPerformanceRecords} tone="muted" />
                  <Stat label="Fully Enriched"    value={d.enrichment.heliusFullHistory}   tone="ok" />
                </G>
              </div>
            </Section>

            {/* ══ Row 4: Buy/Sell + Raw TX ══════════════════════════════════════ */}
            <Section title="Buy / Sell Transaction Data + Raw TX Aggregates">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
                <div className="space-y-3">
                  <Stat label="Total Buy Txs"  value={d.buySellData.totalBuyTxs}  tone="ok" />
                  <Stat label="Total Sell Txs" value={d.buySellData.totalSellTxs} tone="muted" />
                </div>
                <div className="space-y-3">
                  <Stat label="Buys (24h)"  value={d.buySellData.buyTxsLast24h}  tone="ok" />
                  <Stat label="Sells (24h)" value={d.buySellData.sellTxsLast24h} tone="muted" />
                </div>
                <div className="space-y-3">
                  <Stat label="Buy Vol (24h)"  value={fmtSol(d.buySellData.buyVolSolLast24h)}  tone="ok" />
                  <Stat label="Sell Vol (24h)" value={fmtSol(d.buySellData.sellVolSolLast24h)} tone="muted" />
                </div>
                <div className="space-y-3">
                  <Stat label="Net Flow (24h)" value={fmtSol(Math.abs(d.buySellData.netVolSolLast24h))}
                    sub={d.buySellData.netVolSolLast24h >= 0 ? "net outflow" : "net inflow"}
                    tone={d.buySellData.netVolSolLast24h >= 0 ? "ok" : "muted"} />
                </div>
                <div className="space-y-3">
                  <Stat label="Total SOL Invested" value={fmtSol(d.rawTxMetrics.totalSolInvested)} tone="muted" />
                  <Stat label="Total SOL Received" value={fmtSol(d.rawTxMetrics.totalSolReceived)} tone="muted" />
                  <Stat label="Net Raw P&L" value={fmtSol(Math.abs(d.rawTxMetrics.netSolRawPnl))}
                    tone={d.rawTxMetrics.netSolRawPnl >= 0 ? "ok" : "danger"}
                    sub={d.rawTxMetrics.netSolRawPnl >= 0 ? "profitable" : "loss"} />
                </div>
              </div>
            </Section>

            {/* ══ Row 5: §9-12 Win/ROI / P&L / Wallet Scores ══════════════════ */}
            <Section title="§9–12 — Win Rate / ROI / P&L / Wallet Scores / Positions">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
                {/* Scoring coverage */}
                <div>
                  <Sub label="Scoring Coverage" />
                  <div className="space-y-2 mb-3">
                    <SrcBar label="Scored (win_rate set)"  value={d.winRoi.walletsWithWinRate} total={d.wallets.total} tone="ok" />
                    <SrcBar label="Unscored (win_rate null)" value={d.winRoi.walletsUnscored} total={d.wallets.total} tone="warn" />
                  </div>
                  <G cols={2}>
                    <Stat label="Scored (24h)"       value={d.winRoi.walletsScoredLast24h}  tone="ok" />
                    <Stat label="Win Rate > 50%"     value={d.winRoi.walletsWinRateAbove50}  tone="ok" />
                    <Stat label="Evidence: Raw"      value={d.winRoi.evidenceRaw}            sub="helius data" tone="ok" />
                    <Stat label="Evidence: Fallback" value={d.winRoi.evidenceFallback}       sub="wph-only" tone="warn" />
                    <Stat label="Conviction Scored"  value={d.winRoi.convictionScored}       tone="muted" />
                    <Stat label="Intel Scored"       value={d.winRoi.intelligenceScored}     tone="muted" />
                  </G>
                </div>

                {/* Aggregate P&L */}
                <div>
                  <Sub label="Aggregate Stats" />
                  <G cols={2}>
                    <Stat label="Avg Win Rate" value={fmtPct(d.winRoi.avgWinRate)}
                      tone={d.winRoi.avgWinRate !== null && d.winRoi.avgWinRate > 0.5 ? "ok" : "muted"} />
                    <Stat label="Avg ROI"      value={fmtX(d.winRoi.avgRoi)} tone="muted" />
                    <Stat label="Realized P&L" value={d.winRoi.totalRealizedPnlSol !== null ? fmtSol(d.winRoi.totalRealizedPnlSol) : "—"}
                      tone={d.winRoi.totalRealizedPnlSol !== null && d.winRoi.totalRealizedPnlSol >= 0 ? "ok" : "danger"} />
                    <Stat label="Unrealized P&L" value={d.winRoi.totalUnrealizedPnlSol !== null ? fmtSol(d.winRoi.totalUnrealizedPnlSol) : "—"}
                      tone={d.winRoi.totalUnrealizedPnlSol !== null && d.winRoi.totalUnrealizedPnlSol >= 0 ? "ok" : "danger"} />
                  </G>
                  <Sub label="ROI Distribution" />
                  <G cols={3}>
                    <Stat label="≥ 2×"  value={d.winRoi.roiAbove2x}  tone="ok" />
                    <Stat label="≥ 5×"  value={d.winRoi.roiAbove5x}  tone="ok" />
                    <Stat label="≥ 10×" value={d.winRoi.roiAbove10x} tone="ok" />
                  </G>
                </div>

                {/* Confidence + Discovery tiers */}
                <div>
                  <Sub label="Confidence Tier" />
                  <div className="space-y-1 text-[11px]">
                    {(["elite", "high", "medium", "low", "unrated"] as const).map((tier) => (
                      <div key={tier} className="flex justify-between text-muted-foreground">
                        <span className="capitalize">{tier}</span>
                        <span className={cn("font-mono", tier === "elite" || tier === "high" ? "text-risk-low" : "")}>
                          {fmt(d.winRoi.confidenceTier[tier])}
                        </span>
                      </div>
                    ))}
                  </div>
                  <Sub label="Discovery Tier" />
                  <div className="space-y-1 text-[11px]">
                    {(["elite", "strong", "developing", "unproven", "lowSample"] as const).map((tier) => (
                      <div key={tier} className="flex justify-between text-muted-foreground">
                        <span className="capitalize">{tier === "lowSample" ? "Low Sample" : tier}</span>
                        <span className={cn("font-mono", tier === "elite" || tier === "strong" ? "text-risk-low" : "")}>
                          {fmt(d.winRoi.discoveryTier[tier])}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Positions + Milestones */}
                <div>
                  <Sub label="Position Status" />
                  <G cols={2}>
                    <Stat label="Open"          value={d.winRoi.positionsOpen}            tone="ok" />
                    <Stat label="Closed"        value={d.winRoi.positionsClosed}          tone="muted" />
                    <Stat label="Partly Closed" value={d.winRoi.positionsPartiallyClosed} tone="warn" />
                    <Stat label="Unknown"       value={d.winRoi.positionsUnknown}         tone={d.winRoi.positionsUnknown > 100 ? "warn" : "muted"} />
                    <Stat label="Airdrop Exits" value={d.winRoi.airdropExits}             tone="muted" />
                  </G>
                  <Sub label="MC Milestones Reached" />
                  <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
                    {(["reached100k", "reached500k", "reached1m", "reached5m", "reached10m", "reached50m"] as const).map((k) => (
                      <div key={k} className="flex justify-between text-muted-foreground">
                        <span>{k.replace("reached", "").replace("m", "M").replace("k", "K")}</span>
                        <span className={cn("font-mono", d.winRoi.milestones[k] > 0 ? "text-risk-low" : "")}>
                          {fmt(d.winRoi.milestones[k])}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            {/* ══ Row 6: §1-6 Token Scans + §15 Risk Flags ════════════════════ */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section title="§1–6 — Token Scans (scan_history)">
                <G cols={3}>
                  <Stat label="Total Scans"         value={d.scans.totalScans}          tone="muted" />
                  <Stat label="Scans (24h)"          value={d.scans.scansLast24h}        tone="muted" />
                  <Stat label="From Discovery"       value={d.scans.scansFromDiscovery}  tone="muted" sub="source='discovery'" />
                  <Stat label="High Risk (24h)"      value={d.scans.highRiskLast24h}     tone={d.scans.highRiskLast24h > 0 ? "danger" : "ok"} />
                  <Stat label="Honeypot (24h)"       value={d.scans.honeypotLast24h}     tone={d.scans.honeypotLast24h > 0 ? "danger" : "ok"} />
                  <Stat label="Avg Risk Score (24h)" value={d.scans.avgRiskScoreLast24h !== null ? d.scans.avgRiskScoreLast24h.toFixed(1) : "—"}
                    tone={d.scans.avgRiskScoreLast24h === null ? "muted" : d.scans.avgRiskScoreLast24h >= 70 ? "danger" : d.scans.avgRiskScoreLast24h >= 40 ? "warn" : "ok"} />
                  <Stat label="Last Scan" value={rel(d.scans.lastScanAt)} colSpan={3}
                    tone={!d.scans.lastScanAt ? "danger" : Date.now() - new Date(d.scans.lastScanAt).getTime() > 3_600_000 ? "warn" : "ok"} />
                </G>
              </Section>

              <Section title="§15 — Risk Flags Detected (Last 24h)">
                <div className="space-y-1">
                  <Flag label="Metadata Hijacked"      count={d.scans.riskFlags.metadataHijacked} />
                  <Flag label="CPI Manipulated"        count={d.scans.riskFlags.cpiManipulated} />
                  <Flag label="State Hijacked"         count={d.scans.riskFlags.stateHijacked} />
                  <Flag label="Atomic Exploit"         count={d.scans.riskFlags.atomicExploit} />
                  <Flag label="Authority Transitioned" count={d.scans.riskFlags.authorityTransitioned} />
                  <Flag label="Account Resized"        count={d.scans.riskFlags.accountResized} />
                  <Flag label="Metadata Mutable"       count={d.scans.riskFlags.metadataMutable} />
                  <Flag label="Path Obfuscated (CPI)"  count={d.scans.riskFlags.pathObfuscated} />
                  <Flag label="Non-Rent-Exempt Accts"  count={d.scans.riskFlags.nonRentExempt} />
                </div>
              </Section>
            </div>

            {/* ══ Row 7: §19 Helius CU Telemetry ══════════════════════════════ */}
            <Section title="§19 — Helius Compute Unit Telemetry (helius_cu_log · flushed every 60s)">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="space-y-3">
                  <BudgetBar label="Hourly"  used={d.helius.hourlyUsed}  budget={d.helius.hourlyBudget} />
                  <BudgetBar label="Daily"   used={d.helius.dailyUsed}   budget={d.helius.dailyBudget} />
                  <BudgetBar label="Monthly" used={d.helius.monthlyUsed} budget={d.helius.monthlyBudget} />
                  <G cols={3}>
                    <Stat label="CU (1h)"  value={d.helius.cuLast1h}  tone="muted" />
                    <Stat label="CU (24h)" value={d.helius.cuLast24h} tone="muted" />
                    <Stat label="CU (7d)"  value={d.helius.cuLast7d}  tone="muted" />
                  </G>
                </div>
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Top Consumers (1h)</div>
                  {d.helius.topComponentsLast1h.length === 0
                    ? <p className="text-[11px] text-muted-foreground">No data for last 1h</p>
                    : <div className="space-y-2">
                        {d.helius.topComponentsLast1h.map((c) => (
                          <CompBar key={c.component} label={c.component} value={c.cuUsed} max={d.helius.topComponentsLast1h[0]?.cuUsed ?? 1} />
                        ))}
                      </div>}
                </div>
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Top Consumers (24h)</div>
                  {d.helius.topComponentsLast24h.length === 0
                    ? <p className="text-[11px] text-muted-foreground">No data for last 24h</p>
                    : <div className="space-y-2">
                        {d.helius.topComponentsLast24h.map((c) => (
                          <CompBar key={c.component} label={c.component} value={c.cuUsed} max={d.helius.topComponentsLast24h[0]?.cuUsed ?? 1} />
                        ))}
                      </div>}
                </div>
              </div>
            </Section>

            {/* ══ Row 8: §9 Wallets + §16 Sybil + SOL Transfers + §14 Price ══ */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Section title="§9 — Wallet Intelligence">
                <G cols={2}>
                  <Stat label="Total"         value={d.wallets.total}          tone="muted" />
                  <Stat label="Updated (1h)"  value={d.wallets.updatedLast1h}  tone={d.wallets.updatedLast1h === 0 ? "warn" : "ok"} />
                  <Stat label="Updated (24h)" value={d.wallets.updatedLast24h} tone="muted" />
                </G>
                <Sub label="Classification" />
                <div className="space-y-1 text-[11px]">
                  {([
                    ["Smart Money", d.wallets.smartMoney, "ok"],
                    ["Whale",       d.wallets.whale,      "ok"],
                    ["Sniper",      d.wallets.sniper,     "warn"],
                    ["Bot",         d.wallets.bot,        "warn"],
                    ["Retail",      d.wallets.retail,     "muted"],
                  ] as [string, number, Tone][]).map(([label, val, tone]) => (
                    <div key={label} className="flex justify-between text-muted-foreground">
                      <span>{label}</span>
                      <span className={cn("font-mono font-semibold", tc(tone))}>{fmt(val)}</span>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="§16 — Sybil Detection">
                <G cols={2}>
                  <Stat label="Wallets Indexed"  value={d.sybilDetection.walletsIndexed} tone="muted" />
                  <Stat label="Unique Funders"   value={d.sybilDetection.uniqueFunders}  tone="muted" />
                </G>
                <div className="mt-3">
                  <Stat
                    label="Avg Wallets / Funder"
                    value={d.sybilDetection.avgWalletsPerFunder.toFixed(2)}
                    tone={d.sybilDetection.avgWalletsPerFunder > 1.5 ? "danger" : d.sybilDetection.avgWalletsPerFunder > 1.1 ? "warn" : "ok"}
                    sub={d.sybilDetection.avgWalletsPerFunder > 1.5
                      ? "suspicious clustering"
                      : d.sybilDetection.walletsIndexed === 0 ? "not yet indexed" : "healthy"} />
                </div>
                <Sub label="SOL Transfer Index" />
                <G cols={2}>
                  <Stat label="Total"    value={d.solTransfers.total}   tone="muted" />
                  <Stat label="(24h)"    value={d.solTransfers.last24h} tone={d.solTransfers.last24h === 0 ? "warn" : "ok"} />
                </G>
              </Section>

              <Section title="§14 — Price Data">
                <G cols={2}>
                  <Stat label="Total Snapshots"  value={d.priceData.total}            tone="muted" />
                  <Stat label="Snapshots (24h)"  value={d.priceData.snapshotsLast24h} tone={d.priceData.snapshotsLast24h === 0 ? "warn" : "ok"} />
                </G>
                <div className="mt-3 font-mono text-[11px] text-muted-foreground">
                  Last: <span className={cn(!d.priceData.lastSnapshotAt || Date.now() - new Date(d.priceData.lastSnapshotAt).getTime() > 3_600_000 ? "text-risk-medium" : "text-risk-low")}>
                    {rel(d.priceData.lastSnapshotAt)}
                  </span>
                </div>
                <Sub label="Refresh cadence" />
                <p className="text-[10px] text-muted-foreground">DexScreener · every 15 min · auto-rotating token coverage</p>
              </Section>

              {/* §7 Developer Intelligence (scan_history developer cols) */}
              <Section title="§7 — Developer Intelligence">
                <Stat label="Discovery Scans" value={d.scans.scansFromDiscovery} tone="muted" sub="source='discovery'" />
                <Sub label="Graduation Tracker (30 min)" />
                <G cols={2}>
                  <Stat label="Graduated"       value={d.scans.graduation.total}   tone="muted" />
                  <Stat label="Graduated (24h)" value={d.scans.graduation.last24h} tone={d.scans.graduation.last24h > 0 ? "ok" : "muted"} />
                </G>
              </Section>
            </div>

            {/* ══ Row 9: §17/18/18b Daily Snapshot Tables ══════════════════════ */}
            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-0.5">
                §17–18b — Daily Snapshot Tables (written at midnight UTC · insert-only moat data)
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <SnapshotCard
                  title="§17 — Intelligence Snapshots (wallets)"
                  totalRows={d.intelligenceSnapshots.totalRows}
                  capturedToday={d.intelligenceSnapshots.walletsCapturedToday}
                  oldestDate={d.intelligenceSnapshots.oldestSnapshotDate}
                  newestDate={d.intelligenceSnapshots.newestSnapshotDate}
                  daysOfHistory={d.intelligenceSnapshots.daysOfHistory}
                />
                <SnapshotCard
                  title="§18 — Developer Reputation Snapshots"
                  totalRows={d.developerSnapshots.totalRows}
                  capturedToday={d.developerSnapshots.developersCapturedToday}
                  oldestDate={d.developerSnapshots.oldestSnapshotDate}
                />
                <SnapshotCard
                  title="§18b — Token Risk Snapshots"
                  totalRows={d.tokenRiskSnapshots.totalRows}
                  capturedToday={d.tokenRiskSnapshots.tokensCapturedToday}
                  oldestDate={d.tokenRiskSnapshots.oldestSnapshotDate}
                />
              </div>
            </div>

            {/* ══ Row 10: §20 Graduation Pipeline ═════════════════════════════ */}
            <Section title="§20 — Graduation Pipeline (Pump.fun → Raydium · checked every 30 min via DexScreener)">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div>
                  <G cols={2}>
                    <Stat label="Total Discovery Tokens" value={d.graduationPipeline.totalDiscoveryTokens} tone="muted" />
                    <Stat label="Graduated (all-time)"   value={d.graduationPipeline.graduatedTotal}       tone={d.graduationPipeline.graduatedTotal > 0 ? "ok" : "muted"} />
                    <Stat label="Graduated (24h)"        value={d.graduationPipeline.graduatedLast24h}     tone={d.graduationPipeline.graduatedLast24h > 0 ? "ok" : "muted"} />
                    <Stat label="Ungraduated (pending)"  value={d.graduationPipeline.ungraduatedPending}   tone="muted" sub="still on Pump.fun bonding curve" />
                  </G>
                </div>
                <div>
                  <Sub label="Graduation Rate" />
                  <Stat
                    label="Overall Graduation Rate"
                    value={d.graduationPipeline.graduationRatePct !== null ? `${d.graduationPipeline.graduationRatePct}%` : "—"}
                    large
                    tone={d.graduationPipeline.graduationRatePct === null ? "muted"
                      : d.graduationPipeline.graduationRatePct >= 10 ? "ok"
                      : d.graduationPipeline.graduationRatePct >= 5 ? "warn" : "muted"}
                    sub="graduated ÷ total discovery tokens" />
                </div>
                <div>
                  <Sub label="Avg Graduation Market Cap" />
                  <Stat
                    label="Avg Market Cap at Graduation"
                    value={fmtUsd(d.graduationPipeline.avgGraduationMcapUsd)}
                    large
                    tone="muted"
                    sub="DexScreener market cap when Raydium pair first seen" />
                </div>
              </div>
            </Section>

            {/* ══ Row 11: §21 Discovery Rescore Queue ══════════════════════════ */}
            <Section title="§21 — Discovery Rescore Queue (tokens rescored >24h after launch · runs every 30 min via RugCheck)">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <G cols={3}>
                  <Stat label="Pending Rescore"   value={d.discoveryRescore.needsRescorePending}
                    tone={d.discoveryRescore.needsRescorePending > 100 ? "warn" : "muted"}
                    sub="needs_rescore=true, source='discovery'" />
                  <Stat label="Rescored (24h)"    value={d.discoveryRescore.rescoreDoneLast24h}
                    tone={d.discoveryRescore.rescoreDoneLast24h > 0 ? "ok" : "muted"}
                    sub="last_rescored_at >= 24h ago" />
                  <Stat label="Rescored Total"    value={d.discoveryRescore.rescoredTotal}
                    tone="muted"
                    sub="last_rescored_at IS NOT NULL" />
                </G>
                <div className="rounded bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground space-y-1">
                  <p className="font-semibold text-foreground">Why this matters</p>
                  <p>RugCheck scores at T=0 (launch) are ~1 (LOW) — no trading history yet. After 24h, the score reflects real wash-trade patterns, holder concentration, and honeypot signals — 5–10× more meaningful. This queue tracks how many tokens still need that post-launch upgrade.</p>
                </div>
              </div>
            </Section>

            {/* ══ Row 12: §22 Discovery Score Engine ═══════════════════════════ */}
            <Section title="§22 — Discovery Score Engine (5-factor model · recomputed every 20 min)">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                {/* Coverage */}
                <div>
                  <Sub label="Coverage" />
                  <G cols={2}>
                    <Stat label="Wallets with Score" value={d.discoveryScoreEngine.walletsWithDiscoveryScore}
                      tone={d.discoveryScoreEngine.walletsWithDiscoveryScore > 0 ? "ok" : "warn"} />
                    <Stat label="High Confidence (≥60%)" value={d.discoveryScoreEngine.discoveryConfidenceHigh}
                      tone={d.discoveryScoreEngine.discoveryConfidenceHigh > 0 ? "ok" : "muted"}
                      sub="discovery_confidence ≥ 0.60" />
                  </G>
                </div>
                {/* Averages */}
                <div>
                  <Sub label="Population Averages (scored wallets)" />
                  <G cols={2}>
                    <Stat label="Avg Confidence"
                      value={d.discoveryScoreEngine.avgDiscoveryConfidence !== null
                        ? fmtConf(d.discoveryScoreEngine.avgDiscoveryConfidence) : "—"}
                      tone="muted" sub="Bayesian certainty 0–100%" />
                    <Stat label="Avg Entry Market Cap"
                      value={fmtUsd(d.discoveryScoreEngine.avgEntryMarketCapUsd)}
                      tone="muted" sub="USD at wallet's first buy" />
                    <Stat label="Avg Total Discoveries"
                      value={d.discoveryScoreEngine.avgTotalDiscoveries !== null
                        ? d.discoveryScoreEngine.avgTotalDiscoveries.toFixed(1) : "—"}
                      tone="muted" sub="early-buy positions" />
                    <Stat label="Avg Successful Discoveries"
                      value={d.discoveryScoreEngine.avgSuccessfulDiscoveries !== null
                        ? d.discoveryScoreEngine.avgSuccessfulDiscoveries.toFixed(1) : "—"}
                      tone="muted" sub="positions reaching 5× MC" />
                  </G>
                </div>
                {/* Formula legend */}
                <div className="rounded bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground space-y-1">
                  <p className="font-semibold uppercase tracking-wider text-foreground">5-Factor Formula</p>
                  <div className="space-y-0.5">
                    {[
                      ["Milestone Rate",  "30%", "fraction of positions reaching $1M+ MC"],
                      ["ROI Quality",     "25%", "normalised avg ROI (capped at 20×)"],
                      ["Win Rate",        "20%", "profitable closed ÷ total closed (min 3)"],
                      ["Entry Timing",    "15%", "bracket score from avg entry market cap"],
                      ["Repeatability",   "10%", "log-scaled distinct token count"],
                    ].map(([factor, weight, desc]) => (
                      <div key={factor} className="flex gap-2">
                        <span className="font-mono text-risk-low w-8 shrink-0">{weight}</span>
                        <span><span className="font-semibold text-foreground">{factor}</span> — {desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            {/* ══ Row 13: Recent Failed Jobs ═══════════════════════════════════ */}
            {d.collectionQueue.recentFailedJobs.length > 0 && (
              <Section title={`Recent Failed Jobs — ${fmt(d.collectionQueue.failed)} total failed`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-border/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="pb-2 pr-4">Token Address</th>
                        <th className="pb-2 pr-4">Attempts</th>
                        <th className="pb-2 pr-4">Enqueued</th>
                        <th className="pb-2">Last Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.collectionQueue.recentFailedJobs.map((j) => (
                        <tr key={j.tokenAddress} className="border-b border-border/20 hover:bg-muted/10">
                          <td className="py-1.5 pr-4 font-mono text-primary">{j.tokenAddress.slice(0, 8)}…{j.tokenAddress.slice(-6)}</td>
                          <td className="py-1.5 pr-4 font-mono text-destructive">{j.attempts}</td>
                          <td className="py-1.5 pr-4 text-muted-foreground">{rel(j.enqueuedAt)}</td>
                          <td className="py-1.5 max-w-xs truncate text-muted-foreground">{j.lastError ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
