// =============================================================================
// monitor.tsx — /monitor
//
// Live pipeline monitoring dashboard. Polls /api/monitor-dashboard every 15s.
// Covers every metric actively tracked by the Solana scanner system.
// Download Report button generates a comprehensive PDF via jsPDF (CDN-loaded,
// no package install required).
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/monitor")({
  head: () => ({
    meta: [
      { title: "Pipeline Monitor — Scam Intel Ops" },
      { name: "description", content: "Live monitoring for all pipeline metrics." },
    ],
  }),
  component: MonitorPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface FailedJob {
  tokenAddress: string; attempts: number; lastError: string | null; enqueuedAt: string;
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
    smartMoney: number; whale: number; bot: number; sniper: number;
  };
  sybilDetection: { walletsIndexed: number; uniqueFunders: number; avgWalletsPerFunder: number };
  solTransfers: { total: number; last24h: number };
  priceData: { total: number; snapshotsLast24h: number; lastSnapshotAt: string | null };
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
const fmtPct = (n: number | null) => n !== null ? `${n.toFixed(1)}%` : "—";
const fmtX   = (n: number | null) => n !== null ? `${n.toFixed(2)}x` : "—";

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

// ─── PDF Report Generator ─────────────────────────────────────────────────────

// Loads jsPDF from CDN (UMD build) on first use — no package install needed.
async function loadJsPDF(): Promise<new (orientation?: string, unit?: string, format?: string) => JsPDFInstance> {
  if (typeof window === "undefined") throw new Error("PDF generation is browser-only");
  const w = window as Record<string, unknown>;
  if (!w["jspdf"]) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[data-jspdf]');
      if (existing) { resolve(); return; }
      const script = document.createElement("script");
      script.src = "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js";
      script.setAttribute("data-jspdf", "1");
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load jsPDF from CDN"));
      document.head.appendChild(script);
    });
  }
  return ((w["jspdf"] as Record<string, unknown>)["jsPDF"]) as new (
    orientation?: string, unit?: string, format?: string
  ) => JsPDFInstance;
}

// Minimal type shim for the jsPDF instance we use
interface JsPDFInstance {
  setFontSize(size: number): this;
  setFont(fontName: string, fontStyle: string): this;
  setTextColor(r: number, g: number, b: number): this;
  setDrawColor(r: number, g: number, b: number): this;
  setFillColor(r: number, g: number, b: number): this;
  text(text: string, x: number, y: number, options?: Record<string, unknown>): this;
  line(x1: number, y1: number, x2: number, y2: number): this;
  rect(x: number, y: number, w: number, h: number, style?: string): this;
  addPage(): this;
  save(filename: string): void;
  internal: { pageSize: { getWidth(): number; getHeight(): number } };
}

async function generatePdf(d: MonitorData): Promise<void> {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF("portrait", "mm", "a4");

  const PW   = doc.internal.pageSize.getWidth();   // 210
  const PH   = doc.internal.pageSize.getHeight();  // 297
  const L    = 14;   // left margin
  const R    = PW - L;
  const COL2 = PW / 2 + 2;
  let y      = 0;

  const SECTION_GAP  = 7;
  const LINE_H       = 5.5;
  const HEADER_H     = 8;

  // ── colour palette ──────────────────────────────────────────────────────────
  const C = {
    bg:       [18,  18,  24 ] as [number,number,number],  // dark card
    header:   [30,  30,  40 ] as [number,number,number],  // section header
    ok:       [34, 197,  94 ] as [number,number,number],  // green
    warn:     [234,179,   8 ] as [number,number,number],  // amber
    danger:   [239, 68,  68 ] as [number,number,number],  // red
    muted:    [120,120,140 ] as [number,number,number],   // grey
    white:    [255,255,255 ] as [number,number,number],
    offwhite: [220,220,230 ] as [number,number,number],
    accent:   [99, 102,241 ] as [number,number,number],   // indigo
    pageBg:   [12,  12,  18 ] as [number,number,number],
  };

  // ── helpers ─────────────────────────────────────────────────────────────────
  function newPage() {
    doc.addPage();
    doc.setFillColor(...C.pageBg);
    doc.rect(0, 0, PW, PH, "F");
    y = 14;
  }

  function ensureSpace(needed: number) {
    if (y + needed > PH - 12) newPage();
  }

  function sectionHeader(title: string) {
    ensureSpace(HEADER_H + 6);
    doc.setFillColor(...C.header);
    doc.rect(L - 2, y - 1, R - L + 4, HEADER_H, "F");
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...C.accent);
    doc.text(title.toUpperCase(), L, y + 5);
    y += HEADER_H + 2;
  }

  function row(label: string, value: string, tone: "ok"|"warn"|"danger"|"muted" = "muted", x = L, col2 = 130) {
    ensureSpace(LINE_H + 1);
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.muted);
    doc.text(label, x, y);
    doc.setFont("helvetica", "bold");
    const color = tone === "ok" ? C.ok : tone === "warn" ? C.warn : tone === "danger" ? C.danger : C.offwhite;
    doc.setTextColor(...color);
    doc.text(value, x + col2 - x, y);
    y += LINE_H;
  }

  function rowPair(
    l1: string, v1: string, t1: "ok"|"warn"|"danger"|"muted",
    l2: string, v2: string, t2: "ok"|"warn"|"danger"|"muted",
  ) {
    ensureSpace(LINE_H + 1);
    const mid = PW / 2 - 4;
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.muted);
    doc.text(l1, L, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...(t1 === "ok" ? C.ok : t1 === "warn" ? C.warn : t1 === "danger" ? C.danger : C.offwhite));
    doc.text(v1, L + 68, y);

    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.muted);
    doc.text(l2, mid, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...(t2 === "ok" ? C.ok : t2 === "warn" ? C.warn : t2 === "danger" ? C.danger : C.offwhite));
    doc.text(v2, mid + 68, y);
    y += LINE_H;
  }

  function divider() {
    ensureSpace(4);
    doc.setDrawColor(...C.header);
    doc.line(L, y, R, y);
    y += 3;
  }

  function gap(n = SECTION_GAP) { y += n; }

  // ── Cover page ───────────────────────────────────────────────────────────────
  doc.setFillColor(...C.pageBg);
  doc.rect(0, 0, PW, PH, "F");
  y = 50;

  // accent bar
  doc.setFillColor(...C.accent);
  doc.rect(L, y, 4, 36, "F");

  doc.setFontSize(24);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...C.white);
  doc.text("Pipeline Monitor", L + 10, y + 14);

  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...C.muted);
  doc.text("Solana Scanner — Full System Report", L + 10, y + 24);

  doc.setFontSize(8);
  doc.text(`Generated: ${new Date(d.fetchedAt).toLocaleString()}`, L + 10, y + 33);
  y += 55;

  // summary bar on cover
  const tiles: [string, string, typeof C.ok][] = [
    ["Hollow Pending",   fmt(d.enrichment.hollowPairsPending),
      d.enrichment.hollowPairsPending === 0 ? C.ok : d.enrichment.hollowPairsPending <= 100 ? C.warn : C.danger],
    ["Failed Jobs",      fmt(d.collectionQueue.failed),      d.collectionQueue.failed > 0 ? C.danger : C.ok],
    ["Alerts (24h)",     fmt(d.alerts.last24h),              d.alerts.critical24h > 0 ? C.danger : d.alerts.warn24h > 0 ? C.warn : C.ok],
    ["Total Wallets",    fmt(d.wallets.total),               C.offwhite],
    ["Total Scans",      fmt(d.scans.totalScans),            C.offwhite],
    ["Avg Win Rate",     fmtPct(d.winRoi.avgWinRate),        d.winRoi.avgWinRate !== null && d.winRoi.avgWinRate > 50 ? C.ok : C.warn],
  ];
  const tw = (R - L) / 3 - 3;
  const th = 22;
  tiles.forEach(([label, val, color], i) => {
    const tx = L + (i % 3) * (tw + 4.5);
    const ty = y + Math.floor(i / 3) * (th + 4);
    doc.setFillColor(...C.header);
    doc.rect(tx, ty, tw, th, "F");
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.muted);
    doc.text(label.toUpperCase(), tx + 4, ty + 7);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...color);
    doc.text(val, tx + 4, ty + 17);
  });
  y += 2 * (th + 4) + 10;

  doc.setFontSize(6.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...C.muted);
  doc.text("This report is auto-generated from live Supabase queries. All figures reflect database state at the timestamp above.", L, y);

  // ── Page 2+ content ──────────────────────────────────────────────────────────
  newPage();

  // ── 1. Collection Queue ──────────────────────────────────────────────────────
  sectionHeader("1 · Collection Queue");
  rowPair("Pending",         fmt(d.collectionQueue.pending),
            d.collectionQueue.pending > 50 ? "warn" : "muted",
          "Processing",      fmt(d.collectionQueue.processing),
            d.collectionQueue.processing > 0 ? "ok" : "muted");
  rowPair("Failed",          fmt(d.collectionQueue.failed),
            d.collectionQueue.failed > 0 ? "danger" : "ok",
          "Completed (24h)", fmt(d.collectionQueue.completedLast24h), "muted");
  rowPair("Done (total)",    fmt(d.collectionQueue.done), "muted",
          "In-Flight",       fmt(d.scheduler.inFlightCount),
            d.scheduler.inFlightCount >= 3 ? "warn" : "ok");
  gap(3);

  // ── 2. Scheduler ────────────────────────────────────────────────────────────
  sectionHeader("2 · Scheduler");
  rowPair("Total Processed", fmt(d.scheduler.totalProcessed), "muted",
          "Total Failed",    fmt(d.scheduler.totalFailed),    d.scheduler.totalFailed > 0 ? "danger" : "ok");
  row("Stamp Lock", d.scheduler.stampRunning ? "LOCKED" : "FREE", d.scheduler.stampRunning ? "warn" : "ok");
  gap();

  // ── 3. Enrichment Backlog ────────────────────────────────────────────────────
  sectionHeader("3 · Enrichment Backlog — Data Source Coverage");
  const totalPairs = d.enrichment.heliusFullHistory + d.enrichment.holderScan + d.enrichment.poolExtraction;
  rowPair("Hollow Pairs Pending", fmt(d.enrichment.hollowPairsPending),
            d.enrichment.hollowPairsPending === 0 ? "ok" : d.enrichment.hollowPairsPending <= 100 ? "warn" : "danger",
          "Total Performance Records", fmt(d.enrichment.totalPerformanceRecords), "muted");
  rowPair("Helius Full History (enriched)", fmt(d.enrichment.heliusFullHistory), "ok",
          "Holder Scan (hollow)",           fmt(d.enrichment.holderScan),         "warn");
  rowPair("Pool Extraction (hollow)",  fmt(d.enrichment.poolExtraction),   "warn",
          "Ghost Enrichments",         fmt(d.enrichment.ghostEnrichments),
            d.enrichment.ghostEnrichments > 0 ? "warn" : "ok");
  rowPair("With Evidence",   fmt(d.enrichment.pairsWithEvidence), "ok",
          "Scanned (1h)",    fmt(d.enrichment.scannedLast1h),
            d.enrichment.scannedLast1h === 0 ? "warn" : "ok");
  rowPair("Scanned (24h)",   fmt(d.enrichment.scannedLast24h), "muted",
          "Total Pairs (coverage base)", fmt(totalPairs), "muted");
  gap();

  // ── 4. Buy / Sell Transactions ───────────────────────────────────────────────
  sectionHeader("4 · Buy / Sell Transactions");
  rowPair("Total Buy Txs",   fmt(d.buySellData.totalBuyTxs),   "ok",
          "Total Sell Txs",  fmt(d.buySellData.totalSellTxs),  "muted");
  rowPair("Buys (24h)",      fmt(d.buySellData.buyTxsLast24h), "ok",
          "Sells (24h)",     fmt(d.buySellData.sellTxsLast24h),"muted");
  rowPair("Buy Vol (24h)",   fmtSol(d.buySellData.buyVolSolLast24h),  "ok",
          "Sell Vol (24h)",  fmtSol(d.buySellData.sellVolSolLast24h), "muted");
  row("Net Flow (24h)",
    `${fmtSol(Math.abs(d.buySellData.netVolSolLast24h))} (${d.buySellData.netVolSolLast24h >= 0 ? "net outflow" : "net inflow"})`,
    d.buySellData.netVolSolLast24h >= 0 ? "ok" : "muted");
  gap();

  // ── 5. Raw TX Metrics ────────────────────────────────────────────────────────
  sectionHeader("5 · Raw TX Metrics (wallet_raw_tx_metrics)");
  rowPair("Total SOL Invested", fmtSol(d.rawTxMetrics.totalSolInvested), "muted",
          "Total SOL Received", fmtSol(d.rawTxMetrics.totalSolReceived), "muted");
  row("Net Raw P&L",
    `${fmtSol(Math.abs(d.rawTxMetrics.netSolRawPnl))} (${d.rawTxMetrics.netSolRawPnl >= 0 ? "profitable" : "loss"})`,
    d.rawTxMetrics.netSolRawPnl >= 0 ? "ok" : "danger");
  gap();

  // ── 6. Win Rate / ROI / P&L ─────────────────────────────────────────────────
  sectionHeader("6 · Win Rate / ROI / P&L (wallet_performance_history)");
  rowPair("Wallets Scored",          fmt(d.winRoi.walletsWithWinRate), "ok",
          "Wallets Unscored",         fmt(d.winRoi.walletsUnscored),   "warn");
  rowPair("Scored (24h)",            fmt(d.winRoi.walletsScoredLast24h), "ok",
          "Win Rate > 50%",           fmt(d.winRoi.walletsWinRateAbove50), "ok");
  rowPair("Evidence: Raw (Helius)",  fmt(d.winRoi.evidenceRaw),        "ok",
          "Evidence: Fallback (wph)", fmt(d.winRoi.evidenceFallback),   "warn");
  rowPair("Conviction Scored",       fmt(d.winRoi.convictionScored),   "muted",
          "Intelligence Scored",      fmt(d.winRoi.intelligenceScored), "muted");
  divider();
  rowPair("Avg Win Rate",   fmtPct(d.winRoi.avgWinRate),
            d.winRoi.avgWinRate !== null && d.winRoi.avgWinRate > 50 ? "ok" : "muted",
          "Avg ROI",        fmtX(d.winRoi.avgRoi), "muted");
  rowPair("Realized P&L",
    d.winRoi.totalRealizedPnlSol !== null ? fmtSol(d.winRoi.totalRealizedPnlSol) : "—",
    d.winRoi.totalRealizedPnlSol !== null && d.winRoi.totalRealizedPnlSol >= 0 ? "ok" : "danger",
    "Unrealized P&L",
    d.winRoi.totalUnrealizedPnlSol !== null ? fmtSol(d.winRoi.totalUnrealizedPnlSol) : "—",
    d.winRoi.totalUnrealizedPnlSol !== null && d.winRoi.totalUnrealizedPnlSol >= 0 ? "ok" : "danger");
  gap();

  // ── 7. ROI Distribution ─────────────────────────────────────────────────────
  sectionHeader("7 · ROI Distribution");
  row("Wallets >= 2x ROI",  fmt(d.winRoi.roiAbove2x),  "ok");
  row("Wallets >= 5x ROI",  fmt(d.winRoi.roiAbove5x),  "ok");
  row("Wallets >= 10x ROI", fmt(d.winRoi.roiAbove10x), "ok");
  gap();

  // ── 8. Wallet Confidence & Discovery Tiers ───────────────────────────────────
  sectionHeader("8 · Wallet Confidence Tier");
  (["elite","high","medium","low","unrated"] as const).forEach(tier => {
    row(tier.charAt(0).toUpperCase() + tier.slice(1),
      fmt(d.winRoi.confidenceTier[tier]),
      tier === "elite" || tier === "high" ? "ok" : "muted");
  });
  gap(3);
  sectionHeader("9 · Wallet Discovery Tier");
  (["elite","strong","developing","unproven","lowSample"] as const).forEach(tier => {
    row(tier === "lowSample" ? "Low Sample" : tier.charAt(0).toUpperCase() + tier.slice(1),
      fmt(d.winRoi.discoveryTier[tier]),
      tier === "elite" || tier === "strong" ? "ok" : "muted");
  });
  gap();

  // ── 10. Position Status ──────────────────────────────────────────────────────
  sectionHeader("10 · Position Status (wallet_token_activity)");
  rowPair("Open",           fmt(d.winRoi.positionsOpen),             "ok",
          "Closed",         fmt(d.winRoi.positionsClosed),           "muted");
  rowPair("Partly Closed",  fmt(d.winRoi.positionsPartiallyClosed),  "warn",
          "Unknown",        fmt(d.winRoi.positionsUnknown),
            d.winRoi.positionsUnknown > 100 ? "warn" : "muted");
  row("Airdrop Exits",      fmt(d.winRoi.airdropExits), "muted");
  gap();

  // ── 11. Market Cap Milestones ────────────────────────────────────────────────
  sectionHeader("11 · Market Cap Milestones Reached");
  rowPair("$100K",  fmt(d.winRoi.milestones.reached100k), d.winRoi.milestones.reached100k > 0 ? "ok" : "muted",
          "$500K",  fmt(d.winRoi.milestones.reached500k), d.winRoi.milestones.reached500k > 0 ? "ok" : "muted");
  rowPair("$1M",    fmt(d.winRoi.milestones.reached1m),   d.winRoi.milestones.reached1m > 0 ? "ok" : "muted",
          "$5M",    fmt(d.winRoi.milestones.reached5m),   d.winRoi.milestones.reached5m > 0 ? "ok" : "muted");
  rowPair("$10M",   fmt(d.winRoi.milestones.reached10m),  d.winRoi.milestones.reached10m > 0 ? "ok" : "muted",
          "$50M",   fmt(d.winRoi.milestones.reached50m),  d.winRoi.milestones.reached50m > 0 ? "ok" : "muted");
  gap();

  // ── 12. Token Scans ──────────────────────────────────────────────────────────
  newPage();
  sectionHeader("12 · Token Scans (scan_history)");
  rowPair("Total Scans",        fmt(d.scans.totalScans),          "muted",
          "Scans (24h)",        fmt(d.scans.scansLast24h),        "muted");
  rowPair("From Discovery",     fmt(d.scans.scansFromDiscovery),  "muted",
          "High Risk (24h)",    fmt(d.scans.highRiskLast24h),
            d.scans.highRiskLast24h > 0 ? "danger" : "ok");
  rowPair("Honeypot (24h)",     fmt(d.scans.honeypotLast24h),
            d.scans.honeypotLast24h > 0 ? "danger" : "ok",
          "Avg Risk Score (24h)",
            d.scans.avgRiskScoreLast24h !== null ? d.scans.avgRiskScoreLast24h.toFixed(1) : "—",
            d.scans.avgRiskScoreLast24h === null ? "muted"
              : d.scans.avgRiskScoreLast24h >= 70 ? "danger"
              : d.scans.avgRiskScoreLast24h >= 40 ? "warn" : "ok");
  row("Last Scan",              rel(d.scans.lastScanAt),
    !d.scans.lastScanAt ? "danger"
      : Date.now() - new Date(d.scans.lastScanAt).getTime() > 3_600_000 ? "warn" : "ok");
  divider();
  rowPair("Graduated Total",    fmt(d.scans.graduation.total),   "muted",
          "Graduated (24h)",    fmt(d.scans.graduation.last24h),
            d.scans.graduation.last24h > 0 ? "ok" : "muted");
  gap();

  // ── 13. Risk Flags ───────────────────────────────────────────────────────────
  sectionHeader("13 · Risk Flags Detected (Last 24h)");
  const flags: [string, number][] = [
    ["Metadata Hijacked",      d.scans.riskFlags.metadataHijacked],
    ["CPI Manipulated",        d.scans.riskFlags.cpiManipulated],
    ["State Hijacked",         d.scans.riskFlags.stateHijacked],
    ["Atomic Exploit",         d.scans.riskFlags.atomicExploit],
    ["Authority Transitioned", d.scans.riskFlags.authorityTransitioned],
    ["Account Resized",        d.scans.riskFlags.accountResized],
    ["Metadata Mutable",       d.scans.riskFlags.metadataMutable],
    ["Path Obfuscated (CPI)",  d.scans.riskFlags.pathObfuscated],
    ["Non-Rent-Exempt Accts",  d.scans.riskFlags.nonRentExempt],
  ];
  for (let i = 0; i < flags.length; i += 2) {
    const [l1, v1] = flags[i];
    const pair = flags[i + 1];
    if (pair) {
      const [l2, v2] = pair;
      rowPair(l1, fmt(v1), v1 > 0 ? "danger" : "ok", l2, fmt(v2), v2 > 0 ? "danger" : "ok");
    } else {
      row(l1, fmt(v1), v1 > 0 ? "danger" : "ok");
    }
  }
  gap();

  // ── 14. Alerts ───────────────────────────────────────────────────────────────
  sectionHeader("14 · Alerts");
  rowPair("Total (all-time)", fmt(d.alerts.total),       "muted",
          "Last 24h",          fmt(d.alerts.last24h),     "muted");
  rowPair("Critical (24h)",   fmt(d.alerts.critical24h),
            d.alerts.critical24h > 0 ? "danger" : "ok",
          "Warn (24h)",        fmt(d.alerts.warn24h),
            d.alerts.warn24h > 0 ? "warn" : "ok");
  if (d.alerts.byType.length > 0) {
    divider();
    d.alerts.byType.forEach(({ type, count }) => {
      row(type.replace(/_/g, " "), fmt(count), count > 0 ? "warn" : "muted");
    });
  }
  gap();

  // ── 15. Helius CU Budget ─────────────────────────────────────────────────────
  sectionHeader("15 · Helius Compute Unit Budget");
  const heliusRows: [string, number, number][] = [
    ["Hourly",  d.helius.hourlyUsed,  d.helius.hourlyBudget],
    ["Daily",   d.helius.dailyUsed,   d.helius.dailyBudget],
    ["Monthly", d.helius.monthlyUsed, d.helius.monthlyBudget],
  ];
  heliusRows.forEach(([label, used, budget]) => {
    const p = pctOf(used, budget);
    const t = p >= 90 ? "danger" : p >= 70 ? "warn" : "ok";
    row(`${label} (${budget > 0 ? `${p}%` : "no limit"})`,
      `${fmt(used)} / ${budget > 0 ? fmt(budget) : "—"} CU`, t);
  });
  divider();
  rowPair("CU Used (1h)",  fmt(d.helius.cuLast1h),  "muted",
          "CU Used (24h)", fmt(d.helius.cuLast24h), "muted");
  row("CU Used (7d)", fmt(d.helius.cuLast7d), "muted");
  if (d.helius.topComponentsLast24h.length > 0) {
    divider();
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...C.muted);
    doc.text("TOP CONSUMERS (24H)", L, y); y += LINE_H;
    d.helius.topComponentsLast24h.slice(0, 8).forEach(c => {
      row(c.component, fmt(c.cuUsed) + " CU", "muted");
    });
  }
  gap();

  // ── 16. Wallet Intelligence ──────────────────────────────────────────────────
  newPage();
  sectionHeader("16 · Wallet Intelligence");
  rowPair("Total Wallets",   fmt(d.wallets.total),          "muted",
          "Updated (1h)",    fmt(d.wallets.updatedLast1h),
            d.wallets.updatedLast1h === 0 ? "warn" : "ok");
  row("Updated (24h)",       fmt(d.wallets.updatedLast24h), "muted");
  divider();
  rowPair("Smart Money",     fmt(d.wallets.smartMoney), "ok",
          "Whale",           fmt(d.wallets.whale),      "ok");
  rowPair("Bot",             fmt(d.wallets.bot),        "warn",
          "Sniper",          fmt(d.wallets.sniper),     "warn");
  gap();

  // ── 17. Sybil Detection ──────────────────────────────────────────────────────
  sectionHeader("17 · Sybil Detection (wallet_first_funder)");
  rowPair("Wallets Indexed",       fmt(d.sybilDetection.walletsIndexed),  "muted",
          "Unique Funders",         fmt(d.sybilDetection.uniqueFunders),   "muted");
  row("Avg Wallets / Funder",
    d.sybilDetection.avgWalletsPerFunder.toFixed(2) +
      (d.sybilDetection.avgWalletsPerFunder > 1.5 ? " — suspicious clustering"
       : d.sybilDetection.walletsIndexed === 0 ? " — not yet indexed" : " — healthy"),
    d.sybilDetection.avgWalletsPerFunder > 1.5 ? "danger"
      : d.sybilDetection.avgWalletsPerFunder > 1.1 ? "warn" : "ok");
  gap();

  // ── 18. SOL Transfer Index ───────────────────────────────────────────────────
  sectionHeader("18 · SOL Transfer Index (wallet_sol_transfers)");
  rowPair("Total Indexed",  fmt(d.solTransfers.total),   "muted",
          "Indexed (24h)",  fmt(d.solTransfers.last24h),
            d.solTransfers.last24h === 0 ? "warn" : "ok");
  gap();

  // ── 19. Price Data ───────────────────────────────────────────────────────────
  sectionHeader("19 · Price Data (token_price_history)");
  rowPair("Total Snapshots",   fmt(d.priceData.total),            "muted",
          "Snapshots (24h)",   fmt(d.priceData.snapshotsLast24h),
            d.priceData.snapshotsLast24h === 0 ? "warn" : "ok");
  row("Last Snapshot",
    rel(d.priceData.lastSnapshotAt),
    !d.priceData.lastSnapshotAt || Date.now() - new Date(d.priceData.lastSnapshotAt).getTime() > 3_600_000
      ? "warn" : "ok");
  gap();

  // ── 20. Token Discovery ──────────────────────────────────────────────────────
  sectionHeader("20 · Token Discovery — WebSocket + Pipeline Funnel");
  if (!d.tokenDiscovery) {
    row("Status", "Not started (ENABLE_TOKEN_DISCOVERY may be false)", "warn");
  } else {
    rowPair("WebSocket",      d.tokenDiscovery.wsAlive ? "CONNECTED" : "DOWN",
              d.tokenDiscovery.wsAlive ? "ok" : "danger",
            "Running",        d.tokenDiscovery.running ? "YES" : "NO",
              d.tokenDiscovery.running ? "ok" : "danger");
    rowPair("Total Reconnects", fmt(d.tokenDiscovery.totalReconnects),
              d.tokenDiscovery.totalReconnects > 5 ? "warn" : "muted",
            "Last Message",   rel(d.tokenDiscovery.lastMessageAt),
              !d.tokenDiscovery.lastMessageAt
                || Date.now() - new Date(d.tokenDiscovery.lastMessageAt).getTime() > 120_000
                  ? "danger" : "ok");
    divider();
    const p = d.tokenDiscovery.pipeline;
    row("Messages Received",   fmt(p.messagesReceived),  "muted");
    row("Create Events Found", fmt(p.createEventsFound), "muted");
    row("Mints Extracted",     fmt(p.mintsExtracted),    "muted");
    row("DexScreener Hit",     fmt(p.dexScreenerHit),    "muted");
    row("Liquidity Passed",    fmt(p.liquidityPassed),   "muted");
    row("Jobs Enqueued",       fmt(p.tokensEnqueued),    "ok");
    divider();
    const bc = d.tokenDiscovery.bcDiag;
    rowPair("BC: Account Not Found", fmt(bc.accountNotFound),
              bc.accountNotFound > 100 ? "warn" : "muted",
            "BC: Too Small",          fmt(bc.tooSmall), "muted");
    rowPair("BC: Sanity Cap",         fmt(bc.sanityCap), "muted",
            "BC: RPC Error",          fmt(bc.rpcError),
              bc.rpcError > 10 ? "danger" : "muted");
  }
  gap();

  // ── 21. Post-Launch Watcher ──────────────────────────────────────────────────
  sectionHeader("21 · Post-Launch Watcher — Contract Monitoring");
  if (!d.postLaunchWatcher) {
    row("Status", "Not started", "warn");
  } else {
    rowPair("WebSocket",        d.postLaunchWatcher.wsAlive ? "CONNECTED" : "DOWN",
              d.postLaunchWatcher.wsAlive ? "ok" : "danger",
            "Running",          d.postLaunchWatcher.running ? "YES" : "NO",
              d.postLaunchWatcher.running ? "ok" : "danger");
    rowPair("Tokens Tracked",   `${fmt(d.postLaunchWatcher.tokensTracked)} / ${d.postLaunchWatcher.tokenCap}`,
              d.postLaunchWatcher.tokensTracked >= d.postLaunchWatcher.tokenCap ? "warn" : "ok",
            "Notifications",    fmt(d.postLaunchWatcher.totalNotifications), "muted");
    rowPair("Credits/Day",      fmt(d.postLaunchWatcher.estimatedCreditsPerDay),
              d.postLaunchWatcher.estimatedCreditsPerDay > 50_000 ? "warn" : "muted",
            "Session Age",
              d.postLaunchWatcher.sessionAgeSeconds < 3600
                ? `${Math.round(d.postLaunchWatcher.sessionAgeSeconds / 60)}m`
                : `${Math.round(d.postLaunchWatcher.sessionAgeSeconds / 3600)}h`,
              "muted");
    divider();
    rowPair("Mint Subs Confirmed", fmt(d.postLaunchWatcher.mintSubsConfirmed), "ok",
            "Mint Subs Pending",   fmt(d.postLaunchWatcher.mintSubsPending),
              d.postLaunchWatcher.mintSubsPending > 0 ? "warn" : "muted");
    rowPair("Meta Subs Confirmed", fmt(d.postLaunchWatcher.metaSubsConfirmed), "ok",
            "Meta Subs Pending",   fmt(d.postLaunchWatcher.metaSubsPending),
              d.postLaunchWatcher.metaSubsPending > 0 ? "warn" : "muted");
  }
  gap();

  // ── 22. Recent Failed Jobs ───────────────────────────────────────────────────
  if (d.collectionQueue.recentFailedJobs.length > 0) {
    newPage();
    sectionHeader(`22 · Recent Failed Jobs (${fmt(d.collectionQueue.failed)} total failed)`);
    // table header
    doc.setFontSize(6.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...C.muted);
    doc.text("TOKEN ADDRESS",  L,       y);
    doc.text("ATTEMPTS",       L + 60,  y);
    doc.text("ENQUEUED",       L + 85,  y);
    doc.text("LAST ERROR",     L + 115, y);
    y += 4;
    divider();
    d.collectionQueue.recentFailedJobs.forEach(j => {
      ensureSpace(LINE_H + 1);
      doc.setFontSize(6.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...C.accent);
      doc.text(`${j.tokenAddress.slice(0, 8)}…${j.tokenAddress.slice(-6)}`, L, y);
      doc.setTextColor(...C.danger);
      doc.text(String(j.attempts),  L + 60, y);
      doc.setTextColor(...C.muted);
      doc.text(rel(j.enqueuedAt),   L + 85, y);
      const errText = (j.lastError ?? "—").slice(0, 55);
      doc.text(errText,             L + 115, y);
      y += LINE_H;
    });
  }

  // ── Footer on every page ─────────────────────────────────────────────────────
  const totalPages = (doc as unknown as { internal: { pages: unknown[] } }).internal.pages.length - 1;
  for (let p = 1; p <= totalPages; p++) {
    // jsPDF doesn't expose setPage in the type shim but it exists on the instance
    (doc as unknown as { setPage(n: number): void }).setPage(p);
    doc.setFontSize(6);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.muted);
    doc.text("Scam Intel Ops — Pipeline Monitor Report", L, PH - 6);
    doc.text(
      `Page ${p} of ${totalPages} · ${new Date(d.fetchedAt).toLocaleString()}`,
      R, PH - 6, { align: "right" } as Record<string, unknown>
    );
    doc.setDrawColor(...C.header);
    doc.line(L, PH - 8, R, PH - 8);
  }

  const ts = new Date(d.fetchedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  doc.save(`pipeline-monitor-${ts}.pdf`);
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
    <div className={cn("grid gap-3", { "grid-cols-2": cols === 2, "grid-cols-3": cols === 3, "grid-cols-4": cols === 4 })}>
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
        <span className="font-mono">{budget > 0 ? `${fmt(used)} / ${fmt(budget)} (${p}%)` : `${fmt(used)} CU (no limit set)`}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", p >= 90 ? "bg-destructive" : p >= 70 ? "bg-risk-medium" : "bg-risk-low")} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function Flag({ label, count }: { label: string; count: number }) {
  return (
    <div className={cn("flex items-center justify-between rounded px-2 py-1 text-[11px]", count > 0 ? "bg-destructive/10 text-destructive" : "bg-muted/20 text-muted-foreground")}>
      <span>{label}</span><span className="font-mono font-semibold">{fmt(count)}</span>
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
        <div className={cn("h-full rounded-full", tone === "ok" ? "bg-risk-low" : tone === "warn" ? "bg-risk-medium" : tone === "danger" ? "bg-destructive" : "bg-primary/40")} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function CompBar({ label, value, max }: { label: string; value: number; max: number }) {
  const p = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span className="truncate pr-2">{label}</span><span className="font-mono shrink-0">{fmt(value)}</span>
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
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", alive ? "bg-risk-low/15 text-risk-low" : "bg-destructive/15 text-destructive")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", alive ? "bg-risk-low animate-pulse" : "bg-destructive")} />
      {label}
    </span>
  );
}

// ─── Download button ──────────────────────────────────────────────────────────

function DownloadReportButton({ data }: { data: MonitorData | null }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const handleClick = async () => {
    if (!data) return;
    setState("loading");
    try {
      await generatePdf(data);
      setState("idle");
    } catch (err) {
      console.error("PDF generation failed:", err);
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  };

  return (
    <button
      onClick={() => void handleClick()}
      disabled={!data || state === "loading"}
      title={!data ? "Waiting for data…" : "Download full pipeline report as PDF"}
      className={cn(
        "flex items-center gap-1.5 rounded border px-2.5 py-0.5 font-mono text-[10px] transition-colors",
        state === "error"
          ? "border-destructive/60 text-destructive"
          : state === "loading"
          ? "border-border text-primary animate-pulse cursor-wait"
          : !data
          ? "border-border/40 text-muted-foreground/40 cursor-not-allowed"
          : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground cursor-pointer",
      )}
    >
      {state === "loading" ? (
        <>
          <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          GENERATING…
        </>
      ) : state === "error" ? (
        <>
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          PDF FAILED
        </>
      ) : (
        <>
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          DOWNLOAD REPORT
        </>
      )}
    </button>
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
          </div>
          <div className="flex items-center gap-3">
            {syncing ? (
              <span className="font-mono text-[11px] text-primary animate-pulse">SYNCING…</span>
            ) : (
              <span className={cn("flex items-center gap-1.5 font-mono text-[11px]", secsAgo > 20 ? "text-risk-medium" : "text-risk-low")}>
                <span className={cn("h-1.5 w-1.5 rounded-full", secsAgo > 20 ? "bg-risk-medium" : "bg-risk-low animate-pulse")} />
                LIVE · {secsAgo}s ago
              </span>
            )}
            <button onClick={() => void load(true)} className="rounded border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-border-strong hover:text-foreground transition-colors">Refresh</button>
            <DownloadReportButton data={data} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-screen-2xl px-4 py-5 sm:px-6 space-y-4">
        {loading && <div className="flex h-64 items-center justify-center"><span className="font-mono text-sm text-muted-foreground animate-pulse">Loading pipeline metrics…</span></div>}
        {error && !loading && <div className="rounded border border-destructive/40 bg-destructive/10 px-4 py-3 font-mono text-sm text-destructive">Error: {error}</div>}

        {d && (
          <>
            {/* ── Row 1: Critical backlogs + status pills ── */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Section title="Enrichment Backlog">
                <Stat label="Hollow Pairs Pending" value={d.enrichment.hollowPairsPending} large tone={hollowTone}
                  sub={d.enrichment.hollowPairsPending === 0 ? "All pairs enriched ✓" : `${fmt(d.enrichment.totalPerformanceRecords)} positions, ${fmt(d.enrichment.heliusFullHistory)} enriched`} />
              </Section>

              <Section title="Collection Queue">
                <G cols={2}>
                  <Stat label="Pending"    value={d.collectionQueue.pending}    tone={d.collectionQueue.pending > 50 ? "warn" : "muted"} />
                  <Stat label="Processing" value={d.collectionQueue.processing} tone={d.collectionQueue.processing > 0 ? "ok" : "muted"} />
                  <Stat label="Failed"     value={d.collectionQueue.failed}     tone={d.collectionQueue.failed > 0 ? "danger" : "ok"} />
                  <Stat label="Done (24h)" value={d.collectionQueue.completedLast24h} tone="muted" />
                </G>
                {d.collectionQueue.failed > 0 && (
                  <div className="mt-2 rounded bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-bold text-destructive">{fmt(d.collectionQueue.failed)} FAILED — ACTION REQUIRED</div>
                )}
              </Section>

              <Section title="Scheduler">
                <G cols={2}>
                  <Stat label="In-Flight"  value={d.scheduler.inFlightCount}  tone={d.scheduler.inFlightCount >= 3 ? "warn" : "ok"} />
                  <Stat label="Processed"  value={d.scheduler.totalProcessed} tone="muted" />
                  <Stat label="Failed"     value={d.scheduler.totalFailed}    tone={d.scheduler.totalFailed > 0 ? "danger" : "ok"} />
                  <Stat label="Lock"       value={d.scheduler.stampRunning ? "LOCKED" : "FREE"} tone={d.scheduler.stampRunning ? "warn" : "ok"} />
                </G>
              </Section>

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

            {/* ── Row 2: TokenDiscovery + PostLaunchWatcher ── */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* TokenDiscovery */}
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
                        <Stat label="Reconnects" value={d.tokenDiscovery.totalReconnects} tone={d.tokenDiscovery.totalReconnects > 5 ? "warn" : "muted"} />
                        <Stat label="Last Msg"   value={rel(d.tokenDiscovery.lastMessageAt)}
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
                        <Stat label="Too Small"      value={d.tokenDiscovery.bcDiag.tooSmall}        tone="muted" />
                        <Stat label="Sanity Cap"     value={d.tokenDiscovery.bcDiag.sanityCap}       tone="muted" />
                        <Stat label="RPC Error"      value={d.tokenDiscovery.bcDiag.rpcError}        tone={d.tokenDiscovery.bcDiag.rpcError > 10 ? "danger" : "muted"} />
                      </G>
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Conversion Funnel (session)</div>
                      <div className="space-y-1">
                        <FunnelStep label="WS Messages Received"  value={d.tokenDiscovery.pipeline.messagesReceived} />
                        <FunnelStep label="Create Events Found"   value={d.tokenDiscovery.pipeline.createEventsFound} prev={d.tokenDiscovery.pipeline.messagesReceived} />
                        <FunnelStep label="Mints Extracted"       value={d.tokenDiscovery.pipeline.mintsExtracted}    prev={d.tokenDiscovery.pipeline.createEventsFound} />
                        <FunnelStep label="DexScreener Hit"       value={d.tokenDiscovery.pipeline.dexScreenerHit}    prev={d.tokenDiscovery.pipeline.mintsExtracted} />
                        <FunnelStep label="Liquidity Passed"      value={d.tokenDiscovery.pipeline.liquidityPassed}   prev={d.tokenDiscovery.pipeline.dexScreenerHit} />
                        <FunnelStep label="Jobs Enqueued ✓"       value={d.tokenDiscovery.pipeline.tokensEnqueued}   prev={d.tokenDiscovery.pipeline.liquidityPassed} />
                      </div>
                    </div>
                  </div>
                )}
              </Section>

              {/* PostLaunchWatcher */}
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
                        <Stat label="Notifications"  value={d.postLaunchWatcher.totalNotifications} tone="muted" />
                        <Stat label="Credits/Day"    value={fmt(d.postLaunchWatcher.estimatedCreditsPerDay)} tone={d.postLaunchWatcher.estimatedCreditsPerDay > 50_000 ? "warn" : "muted"} />
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
                        <Stat label="Mint Confirmed"    value={d.postLaunchWatcher.mintSubsConfirmed}    tone="ok" />
                        <Stat label="Mint Pending"      value={d.postLaunchWatcher.mintSubsPending}      tone={d.postLaunchWatcher.mintSubsPending > 0 ? "warn" : "muted"} />
                        <Stat label="Metadata Confirmed" value={d.postLaunchWatcher.metaSubsConfirmed}   tone="ok" />
                        <Stat label="Metadata Pending"   value={d.postLaunchWatcher.metaSubsPending}     tone={d.postLaunchWatcher.metaSubsPending > 0 ? "warn" : "muted"} />
                      </G>
                    </div>
                  </div>
                )}
              </Section>
            </div>

            {/* ── Row 3: Hollow wallet enrichment ── */}
            <Section title="Hollow Wallet Enrichment — Data Source Coverage">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <SrcBar label="Helius Full History (fully enriched)" value={d.enrichment.heliusFullHistory} total={totalPairs} tone="ok" />
                  <SrcBar label="Holder Scan (hollow)"                 value={d.enrichment.holderScan}        total={totalPairs} tone="warn" />
                  <SrcBar label="Pool Extraction (hollow)"             value={d.enrichment.poolExtraction}    total={totalPairs} tone="warn" />
                </div>
                <G cols={3}>
                  <Stat label="Ghost Enrichments" value={d.enrichment.ghostEnrichments} tone={d.enrichment.ghostEnrichments > 0 ? "warn" : "ok"} sub="has_evidence=false" />
                  <Stat label="With Evidence"     value={d.enrichment.pairsWithEvidence} tone="ok" />
                  <Stat label="Scanned (1h)"      value={d.enrichment.scannedLast1h}     tone={d.enrichment.scannedLast1h === 0 ? "warn" : "ok"} />
                  <Stat label="Scanned (24h)"     value={d.enrichment.scannedLast24h}    tone="muted" />
                  <Stat label="Perf Records"      value={d.enrichment.totalPerformanceRecords} tone="muted" />
                  <Stat label="Fully Enriched"    value={d.enrichment.heliusFullHistory}  tone="ok" />
                </G>
              </div>
            </Section>

            {/* ── Row 4: Buy/Sell + Raw TX ── */}
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

            {/* ── Row 5: Win/ROI full breakdown ── */}
            <Section title="Win Rate / ROI / P&amp;L / Wallet Scores">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
                {/* Scoring coverage */}
                <div>
                  <Sub label="Scoring Coverage" />
                  <div className="space-y-2 mb-3">
                    <SrcBar label="Scored (win_rate computed)" value={d.winRoi.walletsWithWinRate} total={d.wallets.total} tone="ok" />
                    <SrcBar label="Unscored (win_rate = null)" value={d.winRoi.walletsUnscored}    total={d.wallets.total} tone="warn" />
                  </div>
                  <G cols={2}>
                    <Stat label="Scored (24h)"     value={d.winRoi.walletsScoredLast24h}  tone="ok" />
                    <Stat label="Win Rate > 50%"   value={d.winRoi.walletsWinRateAbove50} tone="ok" />
                    <Stat label="Evidence: Raw"    value={d.winRoi.evidenceRaw}           sub="helius data" tone="ok" />
                    <Stat label="Evidence: Fallback" value={d.winRoi.evidenceFallback}    sub="wph-only"    tone="warn" />
                    <Stat label="Conviction Scored"  value={d.winRoi.convictionScored}    tone="muted" />
                    <Stat label="Intel Scored"       value={d.winRoi.intelligenceScored}  tone="muted" />
                  </G>
                </div>

                {/* Aggregate P&L */}
                <div>
                  <Sub label="Aggregate Stats" />
                  <G cols={2}>
                    <Stat label="Avg Win Rate" value={fmtPct(d.winRoi.avgWinRate)} tone={d.winRoi.avgWinRate !== null && d.winRoi.avgWinRate > 50 ? "ok" : "muted"} />
                    <Stat label="Avg ROI"      value={fmtX(d.winRoi.avgRoi)}       tone="muted" />
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

                {/* Tiers */}
                <div>
                  <Sub label="Confidence Tier" />
                  <div className="space-y-1 text-[11px]">
                    {(["elite","high","medium","low","unrated"] as const).map(tier => (
                      <div key={tier} className="flex justify-between text-muted-foreground">
                        <span className="capitalize">{tier}</span>
                        <span className={cn("font-mono", tier === "elite" || tier === "high" ? "text-risk-low" : "")}>{fmt(d.winRoi.confidenceTier[tier])}</span>
                      </div>
                    ))}
                  </div>
                  <Sub label="Discovery Tier" />
                  <div className="space-y-1 text-[11px]">
                    {(["elite","strong","developing","unproven","lowSample"] as const).map(tier => (
                      <div key={tier} className="flex justify-between text-muted-foreground">
                        <span className="capitalize">{tier === "lowSample" ? "Low Sample" : tier}</span>
                        <span className={cn("font-mono", tier === "elite" || tier === "strong" ? "text-risk-low" : "")}>{fmt(d.winRoi.discoveryTier[tier])}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Positions + Milestones */}
                <div>
                  <Sub label="Position Status" />
                  <G cols={2}>
                    <Stat label="Open"           value={d.winRoi.positionsOpen}             tone="ok" />
                    <Stat label="Closed"         value={d.winRoi.positionsClosed}           tone="muted" />
                    <Stat label="Partly Closed"  value={d.winRoi.positionsPartiallyClosed}  tone="warn" />
                    <Stat label="Unknown"        value={d.winRoi.positionsUnknown}          tone={d.winRoi.positionsUnknown > 100 ? "warn" : "muted"} />
                    <Stat label="Airdrop Exits"  value={d.winRoi.airdropExits}             tone="muted" />
                  </G>
                  <Sub label="MC Milestones Reached" />
                  <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
                    {(["reached100k","reached500k","reached1m","reached5m","reached10m","reached50m"] as const).map(k => (
                      <div key={k} className="flex justify-between text-muted-foreground">
                        <span>{k.replace("reached","").replace("m","M").replace("k","K")}</span>
                        <span className={cn("font-mono", d.winRoi.milestones[k] > 0 ? "text-risk-low" : "")}>{fmt(d.winRoi.milestones[k])}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            {/* ── Row 6: Token Scans + Risk Flags ── */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Section title="Token Scans (scan_history)">
                <G cols={3}>
                  <Stat label="Total Scans"          value={d.scans.totalScans}           tone="muted" />
                  <Stat label="Scans (24h)"           value={d.scans.scansLast24h}         tone="muted" />
                  <Stat label="From Discovery"        value={d.scans.scansFromDiscovery}   tone="muted" sub="source='discovery'" />
                  <Stat label="High Risk (24h)"       value={d.scans.highRiskLast24h}      tone={d.scans.highRiskLast24h > 0 ? "danger" : "ok"} />
                  <Stat label="Honeypot (24h)"        value={d.scans.honeypotLast24h}      tone={d.scans.honeypotLast24h > 0 ? "danger" : "ok"} />
                  <Stat label="Avg Risk Score (24h)"  value={d.scans.avgRiskScoreLast24h !== null ? d.scans.avgRiskScoreLast24h.toFixed(1) : "—"}
                    tone={d.scans.avgRiskScoreLast24h === null ? "muted" : d.scans.avgRiskScoreLast24h >= 70 ? "danger" : d.scans.avgRiskScoreLast24h >= 40 ? "warn" : "ok"} />
                  <Stat label="Last Scan" value={rel(d.scans.lastScanAt)}
                    tone={!d.scans.lastScanAt ? "danger" : Date.now() - new Date(d.scans.lastScanAt).getTime() > 3_600_000 ? "warn" : "ok"} />
                </G>
                <Sub label="Raydium Graduation" />
                <G cols={2}>
                  <Stat label="Graduated Total" value={d.scans.graduation.total}   tone="muted" />
                  <Stat label="Graduated (24h)" value={d.scans.graduation.last24h} tone={d.scans.graduation.last24h > 0 ? "ok" : "muted"} />
                </G>
              </Section>

              <Section title="Risk Flags Detected (Last 24h)">
                <div className="space-y-1">
                  <Flag label="Metadata Hijacked"       count={d.scans.riskFlags.metadataHijacked} />
                  <Flag label="CPI Manipulated"         count={d.scans.riskFlags.cpiManipulated} />
                  <Flag label="State Hijacked"          count={d.scans.riskFlags.stateHijacked} />
                  <Flag label="Atomic Exploit"          count={d.scans.riskFlags.atomicExploit} />
                  <Flag label="Authority Transitioned"  count={d.scans.riskFlags.authorityTransitioned} />
                  <Flag label="Account Resized"         count={d.scans.riskFlags.accountResized} />
                  <Flag label="Metadata Mutable"        count={d.scans.riskFlags.metadataMutable} />
                  <Flag label="Path Obfuscated (CPI)"   count={d.scans.riskFlags.pathObfuscated} />
                  <Flag label="Non-Rent-Exempt Accts"   count={d.scans.riskFlags.nonRentExempt} />
                </div>
              </Section>
            </div>

            {/* ── Row 7: Helius CU ── */}
            <Section title="Helius Compute Unit Budget">
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
                    : <div className="space-y-2">{d.helius.topComponentsLast1h.map(c => <CompBar key={c.component} label={c.component} value={c.cuUsed} max={d.helius.topComponentsLast1h[0]?.cuUsed ?? 1} />)}</div>}
                </div>
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Top Consumers (24h)</div>
                  {d.helius.topComponentsLast24h.length === 0
                    ? <p className="text-[11px] text-muted-foreground">No data for last 24h</p>
                    : <div className="space-y-2">{d.helius.topComponentsLast24h.map(c => <CompBar key={c.component} label={c.component} value={c.cuUsed} max={d.helius.topComponentsLast24h[0]?.cuUsed ?? 1} />)}</div>}
                </div>
              </div>
            </Section>

            {/* ── Row 8: Wallets + Sybil + SOL Transfers + Price ── */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Section title="Wallet Intelligence">
                <G cols={2}>
                  <Stat label="Total"         value={d.wallets.total}          tone="muted" />
                  <Stat label="Updated (1h)"  value={d.wallets.updatedLast1h}  tone={d.wallets.updatedLast1h === 0 ? "warn" : "ok"} />
                  <Stat label="Updated (24h)" value={d.wallets.updatedLast24h} tone="muted" />
                </G>
                <Sub label="Classification" />
                <G cols={2}>
                  <Stat label="Smart Money" value={d.wallets.smartMoney} tone="ok" />
                  <Stat label="Whale"       value={d.wallets.whale}      tone="ok" />
                  <Stat label="Bot"         value={d.wallets.bot}        tone="warn" />
                  <Stat label="Sniper"      value={d.wallets.sniper}     tone="warn" />
                </G>
              </Section>

              <Section title="Sybil Detection (wallet_first_funder)">
                <G cols={2}>
                  <Stat label="Wallets Indexed"   value={d.sybilDetection.walletsIndexed}  tone="muted" />
                  <Stat label="Unique Funders"     value={d.sybilDetection.uniqueFunders}   tone="muted" />
                </G>
                <div className="mt-3">
                  <Stat
                    label="Avg Wallets / Funder"
                    value={d.sybilDetection.avgWalletsPerFunder.toFixed(2)}
                    tone={d.sybilDetection.avgWalletsPerFunder > 1.5 ? "danger" : d.sybilDetection.avgWalletsPerFunder > 1.1 ? "warn" : "ok"}
                    sub={d.sybilDetection.avgWalletsPerFunder > 1.5 ? "suspicious clustering" : d.sybilDetection.walletsIndexed === 0 ? "not yet indexed" : "healthy"}
                  />
                </div>
              </Section>

              <Section title="SOL Transfer Index">
                <G cols={2}>
                  <Stat label="Total Indexed" value={d.solTransfers.total}   tone="muted" />
                  <Stat label="Indexed (24h)" value={d.solTransfers.last24h} tone={d.solTransfers.last24h === 0 ? "warn" : "ok"} />
                </G>
              </Section>

              <Section title="Price Data (token_price_history)">
                <G cols={2}>
                  <Stat label="Total Snapshots"   value={d.priceData.total}             tone="muted" />
                  <Stat label="Snapshots (24h)"   value={d.priceData.snapshotsLast24h}  tone={d.priceData.snapshotsLast24h === 0 ? "warn" : "ok"} />
                </G>
                <div className="mt-3 font-mono text-[11px] text-muted-foreground">
                  Last: <span className={cn(!d.priceData.lastSnapshotAt || Date.now() - new Date(d.priceData.lastSnapshotAt).getTime() > 3_600_000 ? "text-risk-medium" : "text-risk-low")}>
                    {rel(d.priceData.lastSnapshotAt)}
                  </span>
                </div>
              </Section>
            </div>

            {/* ── Row 9: Recent Failed Jobs ── */}
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
                      {d.collectionQueue.recentFailedJobs.map(j => (
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
