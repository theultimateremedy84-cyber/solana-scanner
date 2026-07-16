// =============================================================================
// /wallet/$address — Wallet Intelligence Profile  (Volume 1)
//
// Replaces the earlier P3-B profitability page with a full 10-section profile.
// All data comes from a single getWalletProfile() call — no duplicated SQL.
// Reads existing tables only — no schema changes.
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowLeft,
  ArrowUpDown,
  CheckCircle,
  Copy,
  ExternalLink,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { getWalletProfile } from "@/lib/api/wallet-profile.functions";
import type {
  WalletProfileData,
  TokenHistoryEntry,
  TimelineEvent,
  Badge,
  BadgeColor,
  Recommendation,
  RecommendationType,
} from "@/lib/api/wallet-profile.types";

export const Route = createFileRoute("/wallet/$address")({
  head: ({ params }) => ({
    meta: [
      { title: `Wallet Profile — ${params.address.slice(0, 8)}… — Scam Intel` },
      {
        name: "description",
        content:
          "Full intelligence profile: identity, performance, discovery ability, trading style, and insights for a Solana wallet.",
      },
    ],
  }),
  component: WalletProfilePage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function na(v: string | null | undefined): string {
  return v ?? "—";
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtRoi(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}×`;
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function fmtMc(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtHold(secs: number | null | undefined): string {
  if (secs == null) return "—";
  if (secs < 60)    return `${Math.round(secs)}s`;
  if (secs < 3_600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${(secs / 3_600).toFixed(1)}h`;
  return `${(secs / 86_400).toFixed(1)}d`;
}

function fmtAge(secs: number | null | undefined): string {
  if (secs == null) return "—";
  if (secs < 3_600)  return `${Math.round(secs / 60)}m after mint`;
  if (secs < 86_400) return `${(secs / 3_600).toFixed(1)}h after mint`;
  return `${(secs / 86_400).toFixed(1)}d after mint`;
}

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDatetime(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtToken(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function solscanAccount(addr: string) {
  return `https://solscan.io/account/${addr}`;
}
function solscanToken(addr: string) {
  return `https://solscan.io/token/${addr}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification helpers
// ─────────────────────────────────────────────────────────────────────────────

const CLS_COLOR: Record<string, string> = {
  smart_money: "oklch(0.74 0.18 155)",
  sniper:      "oklch(0.78 0.17 75)",
  whale:       "oklch(0.70 0.18 220)",
  bot:         "oklch(0.74 0.19 50)",
  retail:      "oklch(0.72 0.05 250)",
};

function clsColor(cls: string | null) {
  return CLS_COLOR[cls ?? ""] ?? "oklch(0.55 0.02 250)";
}

function clsLabel(cls: string | null) {
  const MAP: Record<string, string> = {
    smart_money: "Smart Money",
    sniper:      "Sniper",
    whale:       "Whale",
    bot:         "Bot",
    retail:      "Retail",
  };
  return MAP[cls ?? ""] ?? "Unknown";
}

const BADGE_COLORS: Record<BadgeColor, string> = {
  gold:   "oklch(0.80 0.17 80)",
  silver: "oklch(0.72 0.04 250)",
  green:  "oklch(0.74 0.18 155)",
  blue:   "oklch(0.70 0.18 220)",
  orange: "oklch(0.78 0.17 50)",
  red:    "oklch(0.65 0.22 25)",
  purple: "oklch(0.72 0.18 295)",
};

const RISK_LABEL: Record<string, string> = {
  degen:        "Degen",
  high:         "High Risk",
  medium:       "Medium Risk",
  conservative: "Conservative",
  unknown:      "Unknown",
};

const RISK_COLOR: Record<string, string> = {
  degen:        "oklch(0.65 0.22 25)",
  high:         "oklch(0.78 0.17 50)",
  medium:       "oklch(0.78 0.17 75)",
  conservative: "oklch(0.74 0.18 155)",
  unknown:      "oklch(0.55 0.02 250)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton
// ─────────────────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <div className="h-2 w-16 rounded bg-muted animate-pulse mb-2" />
      <div className="h-5 w-24 rounded bg-muted animate-pulse" />
    </div>
  );
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable StatCard
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`mt-1 truncate font-mono text-lg font-semibold tabular-nums ${color ?? "text-foreground"}`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[9px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section header
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="border-b border-border px-4 py-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
      {sub && <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1 — Profile (Identity + Intelligence + Performance + ROI chart)
// ─────────────────────────────────────────────────────────────────────────────

function ProfileTab({ profile }: { profile: WalletProfileData }) {
  const { identity, intelligence, performance, tokenHistory } = profile;

  const roiChartData = useMemo(
    () =>
      [...tokenHistory]
        .filter((t) => t.roi != null)
        .sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
        .slice(0, 20)
        .map((t) => ({ label: fmtToken(t.tokenAddress), roi: t.roi ?? 0 })),
    [tokenHistory],
  );

  return (
    <div className="space-y-4">
      {/* Intelligence */}
      <section className="border border-border">
        <SectionHeader title="Intelligence" sub="Existing scores — not recalculated" />
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          <StatCard
            label="Intel Score"
            value={intelligence.intelligenceScore != null ? fmtPct(intelligence.intelligenceScore) : "—"}
            color="text-foreground"
          />
          <StatCard
            label="Discovery Score"
            value={intelligence.discoveryScore != null ? intelligence.discoveryScore.toFixed(3) : "—"}
            sub={intelligence.discoveryTier ? `Tier: ${intelligence.discoveryTier}` : undefined}
          />
          <StatCard
            label="Discovery Confidence"
            value={intelligence.discoveryConfidence != null ? fmtPct(intelligence.discoveryConfidence) : "—"}
          />
          <StatCard
            label="Win Rate"
            value={fmtPct(intelligence.winRate)}
            color={intelligence.winRate != null && intelligence.winRate >= 0.6 ? "text-emerald-400" : "text-foreground"}
          />
          <StatCard
            label="Avg ROI"
            value={fmtRoi(intelligence.avgRoi)}
            color="text-emerald-400"
          />
          <StatCard
            label="Best ROI"
            value={fmtRoi(intelligence.bestRoi)}
            color="text-emerald-400"
          />
          <StatCard
            label="Worst ROI"
            value={fmtRoi(intelligence.worstRoi)}
            color={
              intelligence.worstRoi != null && intelligence.worstRoi < 1
                ? "text-red-400"
                : "text-foreground"
            }
          />
          <StatCard
            label="Conviction"
            value={intelligence.convictionScore != null ? `${intelligence.convictionScore}` : "—"}
            sub="% open positions"
          />
          <StatCard
            label="Verified Positions"
            value={
              intelligence.verifiedPositions != null
                ? String(intelligence.verifiedPositions)
                : intelligence.closedPositionCount != null
                  ? String(intelligence.closedPositionCount)
                  : "—"
            }
            sub="exits with confirmed cost-basis"
          />
        </div>
      </section>

      {/* Performance Summary */}
      <section className="border border-border">
        <SectionHeader title="Performance" />
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          <StatCard label="Total Invested" value={fmtUsd(performance.totalInvested)} />
          <StatCard label="Total Returned" value={fmtUsd(performance.totalReturned)} />
          <StatCard
            label="Total Profit"
            value={fmtUsd(performance.totalProfit)}
            color={performance.totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard
            label="Realized P&L"
            value={fmtUsd(performance.realizedPnl)}
            color={performance.realizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard
            label="Unrealized P&L"
            value={fmtUsd(performance.unrealizedPnl)}
            color={performance.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard label="Avg Multiple" value={fmtRoi(performance.avgMultiple)} />
          <StatCard
            label="Largest Win"
            value={fmtUsd(performance.largestWin)}
            color="text-emerald-400"
          />
          <StatCard
            label="Largest Loss"
            value={fmtUsd(performance.largestLoss)}
            color="text-red-400"
          />
        </div>
        {/* Position Status */}
        <div className="grid grid-cols-4 gap-px border-t border-border">
          {[
            { label: "Open", value: performance.openPositions, color: "text-emerald-400" },
            { label: "Partially Closed", value: performance.partiallyClosedPositions, color: "text-amber-400" },
            { label: "Closed", value: performance.closedPositions, color: "text-muted-foreground" },
            { label: "Unknown", value: performance.unknownPositions, color: "text-muted-foreground" },
          ].map((s) => (
            <div key={s.label} className="bg-background px-4 py-3">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{s.label}</p>
              <p className={`mt-1 font-mono text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ROI Distribution Chart */}
      {roiChartData.length >= 2 && (
        <section className="border border-border">
          <SectionHeader title="Per-Token ROI" sub="Top 20 positions ranked by ROI multiple" />
          <div className="p-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={roiChartData} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: "var(--muted-foreground)", fontFamily: "JetBrains Mono" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: "var(--muted-foreground)", fontFamily: "JetBrains Mono" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 0,
                    fontSize: 11,
                    fontFamily: "JetBrains Mono",
                  }}
                  formatter={(v: number) => [`${v.toFixed(2)}×`, "ROI"]}
                />
                <Bar dataKey="roi" radius={[2, 2, 0, 0]}>
                  {roiChartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={entry.roi >= 1 ? "var(--risk-low, #10b981)" : "var(--risk-high, #f97316)"}
                      opacity={0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2 — Discovery
// ─────────────────────────────────────────────────────────────────────────────

function DiscoveryTab({ profile }: { profile: WalletProfileData }) {
  const { discovery } = profile;

  return (
    <div className="space-y-4">
      <section className="border border-border">
        <SectionHeader
          title="Discovery Ability"
          sub="Reuses existing discovery_score infrastructure — no alternative calculations"
        />
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          <StatCard label="Total Discoveries" value={String(discovery.totalDiscoveries)} />
          <StatCard
            label="Discovery Success %"
            value={discovery.discoverySuccessPct != null ? fmtPct(discovery.discoverySuccessPct) : "—"}
            sub="tokens reaching $1M+"
          />
          <StatCard label="Avg Entry MC" value={fmtMc(discovery.avgEntryMarketCap)} />
          <StatCard label="Avg Token Age at Entry" value={fmtAge(discovery.avgTokenAgeSecs)} />
        </div>
      </section>

      {/* Milestone table */}
      <section className="border border-border">
        <SectionHeader title="Milestone Conversion" sub="Tokens holding through each market cap milestone" />
        <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
          {[
            { label: "$100K MC", value: discovery.tokensReaching100k, total: discovery.totalDiscoveries },
            { label: "$500K MC", value: discovery.tokensReaching500k, total: discovery.totalDiscoveries },
            { label: "$1M MC",   value: discovery.tokensReaching1m,   total: discovery.totalDiscoveries },
            { label: "$5M MC",   value: discovery.tokensReaching5m,   total: discovery.totalDiscoveries },
          ].map((m) => {
            const pct = m.total > 0 ? (m.value / m.total) * 100 : 0;
            return (
              <div key={m.label} className="border border-border bg-background px-4 py-4">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{m.label}</p>
                <p className="mt-1 font-mono text-2xl font-bold text-foreground">{m.value}</p>
                <div className="mt-2 h-1 w-full rounded-full bg-muted">
                  <div
                    className="h-1 rounded-full bg-primary"
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
                <p className="mt-1 text-[9px] text-muted-foreground">{pct.toFixed(0)}% of discoveries</p>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3 — Trading Style
// ─────────────────────────────────────────────────────────────────────────────

function StyleTab({ profile }: { profile: WalletProfileData }) {
  const { tradingStyle } = profile;
  const riskColor = RISK_COLOR[tradingStyle.riskAppetite] ?? "oklch(0.55 0.02 250)";

  return (
    <div className="space-y-4">
      <section className="border border-border">
        <SectionHeader
          title="Trading Style"
          sub="Deterministic calculations from existing trade history — no AI"
        />
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
          <StatCard label="Avg Buy Size" value={fmtUsd(tradingStyle.avgBuySize)} />
          <StatCard label="Median Buy Size" value={fmtUsd(tradingStyle.medianBuySize)} />
          <StatCard label="Avg Hold Time" value={fmtHold(tradingStyle.avgHoldTimeSecs)} />
          <StatCard
            label="Preferred Market Cap"
            value={fmtMc(tradingStyle.preferredMarketCap)}
            sub="median entry MC (buys)"
          />
          <StatCard
            label="Preferred Liquidity"
            value={fmtUsd(tradingStyle.preferredLiquidity)}
            sub="median liquidity at entry"
          />
          <StatCard
            label="Preferred Token Age"
            value={fmtAge(tradingStyle.preferredTokenAgeSecs)}
          />
        </div>
      </section>

      {/* Risk Appetite */}
      <section className="border border-border">
        <SectionHeader
          title="Risk Appetite"
          sub="Derived from avg entry MC and avg token age at entry"
        />
        <div className="flex items-center gap-4 p-5">
          <span
            className="rounded-sm border px-4 py-2 font-mono text-sm uppercase tracking-[0.18em] font-semibold"
            style={{
              backgroundColor: `color-mix(in oklab, ${riskColor} 18%, transparent)`,
              color:            riskColor,
              borderColor:     `color-mix(in oklab, ${riskColor} 40%, transparent)`,
            }}
          >
            {RISK_LABEL[tradingStyle.riskAppetite]}
          </span>
          <p className="text-xs text-muted-foreground">
            {tradingStyle.riskAppetite === "degen"        && "Enters very new tokens at micro-cap — maximum risk tolerance"}
            {tradingStyle.riskAppetite === "high"         && "Enters early, often before $50K MC — high risk, high reward profile"}
            {tradingStyle.riskAppetite === "medium"       && "Balances entry timing — $50K–$200K range — moderate risk profile"}
            {tradingStyle.riskAppetite === "conservative" && "Enters at higher market caps — lower risk, typically lower volatility"}
            {tradingStyle.riskAppetite === "unknown"      && "Insufficient entry market cap data to determine risk profile"}
          </p>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 4 — Token History (sortable, searchable, paginated)
// ─────────────────────────────────────────────────────────────────────────────

type SortKey = "roi" | "profit" | "buyTime" | "entryMc" | "holdTimeSecs";
const PAGE_SIZE = 25;

function HistoryTab({ profile }: { profile: WalletProfileData }) {
  const { tokenHistory } = profile;
  const [search, setSearch]       = useState("");
  const [sortKey, setSortKey]     = useState<SortKey>("roi");
  const [sortAsc, setSortAsc]     = useState(false);
  const [page, setPage]           = useState(0);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(false); }
    setPage(0);
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tokenHistory.filter((t) => t.tokenAddress.toLowerCase().includes(q));
  }, [tokenHistory, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const va = a[sortKey] ?? -Infinity;
      const vb = b[sortKey] ?? -Infinity;
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
  }, [filtered, sortKey, sortAsc]);

  const pageCount = Math.ceil(sorted.length / PAGE_SIZE);
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function SortBtn({ k, children }: { k: SortKey; children: ReactNode }) {
    return (
      <button
        onClick={() => toggleSort(k)}
        className="flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {children}
        <ArrowUpDown
          className={`size-3 ${sortKey === k ? "text-primary" : "text-muted-foreground/40"}`}
        />
      </button>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input
          placeholder="Search token address…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="pl-9 font-mono text-xs h-8"
        />
      </div>

      <div className="border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide">Token History</h2>
          <span className="font-mono text-[9px] text-muted-foreground">
            {filtered.length} token{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="border-b border-border bg-background font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">
                  <SortBtn k="buyTime">Buy Time</SortBtn>
                </th>
                <th className="px-4 py-3">Sell Time</th>
                <th className="px-4 py-3 text-right">
                  <SortBtn k="entryMc">Entry MC</SortBtn>
                </th>
                <th className="px-4 py-3 text-right text-muted-foreground/50">Exit MC</th>
                <th className="px-4 py-3 text-right">
                  <SortBtn k="holdTimeSecs">Hold Time</SortBtn>
                </th>
                <th className="px-4 py-3 text-right">
                  <SortBtn k="roi">ROI</SortBtn>
                </th>
                <th className="px-4 py-3 text-right">
                  <SortBtn k="profit">Profit</SortBtn>
                </th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Milestones</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((t) => (
                <TokenHistoryRow key={t.tokenAddress} row={t} />
              ))}
            </tbody>
          </table>
        </div>

        {paginated.length === 0 && (
          <p className="py-8 text-center text-xs text-muted-foreground">No tokens match your search.</p>
        )}

        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="font-mono text-[10px] text-muted-foreground">
              Page {page + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TokenHistoryRow({ row }: { row: TokenHistoryEntry }) {
  const milestones = [
    row.reached5m && "$5M",
    row.reached1m && "$1M",
    row.reached500k && "$500K",
    row.reached100k && "$100K",
  ].filter(Boolean) as string[];

  const statusColor: Record<string, string> = {
    OPEN:              "text-emerald-400",
    PARTIALLY_CLOSED:  "text-amber-400",
    CLOSED:            "text-muted-foreground",
    UNKNOWN:           "text-muted-foreground/50",
  };

  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/20">
      <td className="px-4 py-3">
        <a
          href={solscanToken(row.tokenAddress)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-foreground/80 hover:text-foreground"
          title={row.tokenAddress}
        >
          {fmtToken(row.tokenAddress)}
        </a>
      </td>
      <td className="px-4 py-3 font-mono text-muted-foreground">{fmtDatetime(row.buyTime)}</td>
      <td className="px-4 py-3 font-mono text-muted-foreground">{fmtDatetime(row.sellTime)}</td>
      <td className="px-4 py-3 text-right font-mono">{fmtMc(row.entryMc)}</td>
      <td className="px-4 py-3 text-right font-mono text-muted-foreground/40" title="Exit market cap not stored — deferred to future version">N/A</td>
      <td className="px-4 py-3 text-right font-mono">{fmtHold(row.holdTimeSecs)}</td>
      <td
        className={`px-4 py-3 text-right font-mono font-semibold ${
          row.roi != null && row.roi >= 1 ? "text-emerald-400" : "text-red-400"
        }`}
      >
        {fmtRoi(row.roi)}
      </td>
      <td
        className={`px-4 py-3 text-right font-mono ${
          row.profit != null && row.profit >= 0 ? "text-emerald-400" : "text-red-400"
        }`}
      >
        {fmtUsd(row.profit)}
      </td>
      <td className={`px-4 py-3 font-mono text-[10px] uppercase tracking-wide ${statusColor[row.status ?? "UNKNOWN"] ?? ""}`}>
        {row.status ?? "—"}
      </td>
      <td className="px-4 py-3">
        {milestones.length > 0 ? (
          <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {milestones[0]}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 5 — Timeline
// ─────────────────────────────────────────────────────────────────────────────

const TIMELINE_TYPE_STYLE: Record<
  string,
  { color: string; dot: string; prefix: string }
> = {
  buy:           { color: "text-emerald-400", dot: "bg-emerald-400", prefix: "BUY" },
  sell:          { color: "text-orange-400",  dot: "bg-orange-400",  prefix: "SELL" },
  milestone_100k:{ color: "text-amber-400",   dot: "bg-amber-400",   prefix: "→ $100K" },
  milestone_500k:{ color: "text-amber-400",   dot: "bg-amber-400",   prefix: "→ $500K" },
  milestone_1m:  { color: "text-amber-400",   dot: "bg-amber-400",   prefix: "→ $1M" },
  milestone_5m:  { color: "text-amber-400",   dot: "bg-amber-400",   prefix: "→ $5M" },
};

function TimelineTab({ profile }: { profile: WalletProfileData }) {
  const { timeline } = profile;

  if (timeline.length === 0) {
    return (
      <div className="border border-border bg-background p-8 text-center">
        <p className="text-sm text-muted-foreground">No timeline events available for this wallet.</p>
      </div>
    );
  }

  return (
    <div className="border border-border">
      <SectionHeader
        title="Activity Timeline"
        sub={`${timeline.length} most recent events (buys, sells, milestones)`}
      />
      <div className="divide-y divide-border">
        {timeline.map((ev, i) => {
          const style = TIMELINE_TYPE_STYLE[ev.type] ?? TIMELINE_TYPE_STYLE.buy;
          return (
            <div key={i} className="flex items-start gap-4 px-5 py-3 hover:bg-accent/10">
              <div className="mt-1.5 flex-shrink-0">
                <div className={`size-2 rounded-full ${style.dot}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`font-mono text-[10px] font-semibold uppercase tracking-wide ${style.color}`}>
                    {style.prefix}
                  </span>
                  <a
                    href={solscanToken(ev.tokenAddress)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[11px] text-foreground/70 hover:text-foreground"
                    title={ev.tokenAddress}
                  >
                    {fmtToken(ev.tokenAddress)}
                  </a>
                  {ev.amountSol != null && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {ev.amountSol.toFixed(3)} SOL
                    </span>
                  )}
                  {ev.entryMc != null && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      MC: {fmtMc(ev.entryMc)}
                    </span>
                  )}
                </div>
              </div>
              <span className="flex-shrink-0 font-mono text-[9px] text-muted-foreground">
                {fmtDatetime(ev.timestamp)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 6 — Insights (Badges + Strengths + Weaknesses)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Recommendation Banner — shown prominently before the tabs
// ─────────────────────────────────────────────────────────────────────────────

const REC_STYLES: Record<
  RecommendationType,
  { border: string; bg: string; text: string; dot: string; label: string }
> = {
  worth_following: {
    border: "border-emerald-500/40",
    bg:     "bg-emerald-950/20",
    text:   "text-emerald-400",
    dot:    "bg-emerald-400",
    label:  "Worth Following",
  },
  watch_only: {
    border: "border-amber-500/40",
    bg:     "bg-amber-950/20",
    text:   "text-amber-400",
    dot:    "bg-amber-400",
    label:  "Watch Only",
  },
  avoid: {
    border: "border-red-500/40",
    bg:     "bg-red-950/20",
    text:   "text-red-400",
    dot:    "bg-red-400",
    label:  "Avoid",
  },
};

function RecommendationBanner({ rec }: { rec: Recommendation }) {
  const s = REC_STYLES[rec.verdict];
  return (
    <div className={`border ${s.border} ${s.bg} px-5 py-4`}>
      <div className="flex items-start gap-4">
        <div className={`mt-1.5 size-2.5 flex-shrink-0 rounded-full ${s.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className={`font-mono text-xs font-bold uppercase tracking-[0.2em] ${s.text}`}>
              {s.label}
            </span>
            <span className="text-[10px] text-muted-foreground">
              Verdict based on stored scores — not financial advice
            </span>
          </div>
          <ul className="mt-2 space-y-0.5">
            {rec.rationale.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-foreground/80">
                <span className={`mt-0.5 flex-shrink-0 font-mono ${s.text}`}>›</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function BadgePill({ badge }: { badge: Badge }) {
  const color = BADGE_COLORS[badge.color] ?? BADGE_COLORS.silver;
  return (
    <div
      title={badge.description}
      className="rounded-sm border px-3 py-1.5 font-mono text-xs uppercase tracking-[0.14em] cursor-default"
      style={{
        backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
        color,
        borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
      }}
    >
      {badge.label}
    </div>
  );
}

function InsightsTab({ profile }: { profile: WalletProfileData }) {
  const { badges, strengths, weaknesses, recommendation } = profile;
  const s = REC_STYLES[recommendation.verdict];

  return (
    <div className="space-y-4">
      {/* Recommendation — full card with rationale */}
      <section className={`border ${s.border} ${s.bg}`}>
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <div className={`size-2 rounded-full ${s.dot}`} />
            <h2 className="text-xs font-semibold uppercase tracking-wide">Recommendation</h2>
            <span className={`ml-1 font-mono text-xs font-bold uppercase tracking-[0.18em] ${s.text}`}>
              {s.label}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Deterministic verdict derived from stored intelligence score, win rate, ROI, and classification. Not financial advice.
          </p>
        </div>
        <ul className="divide-y divide-border">
          {recommendation.rationale.map((r, i) => (
            <li key={i} className="flex items-start gap-3 px-5 py-3 text-sm">
              <span className={`mt-0.5 flex-shrink-0 font-mono font-semibold ${s.text}`}>›</span>
              {r}
            </li>
          ))}
        </ul>
      </section>

      {/* Badges */}
      <section className="border border-border">
        <SectionHeader
          title="Badges"
          sub="Deterministic — all thresholds are constants in badge-config. No AI."
        />
        <div className="p-4">
          {badges.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {badges.map((b) => (
                <BadgePill key={b.id} badge={b} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No badges earned yet — more data needed.
            </p>
          )}
          {badges.length > 0 && (
            <div className="mt-4 space-y-1">
              {badges.map((b) => (
                <p key={b.id} className="text-[10px] text-muted-foreground">
                  <span className="font-semibold text-foreground/80">{b.label}:</span>{" "}
                  {b.description}
                </p>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Strengths */}
      <section className="border border-border">
        <SectionHeader title="Strengths" sub="Deterministic observations from existing data" />
        <div className="p-4">
          {strengths.length > 0 ? (
            <ul className="space-y-2">
              {strengths.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 flex-shrink-0 text-emerald-400">✓</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No significant strengths identified — more trade history needed.
            </p>
          )}
        </div>
      </section>

      {/* Weaknesses */}
      <section className="border border-border">
        <SectionHeader title="Weaknesses" sub="Areas of concern identified from existing data" />
        <div className="p-4">
          {weaknesses.length > 0 ? (
            <ul className="space-y-2">
              {weaknesses.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 flex-shrink-0 text-red-400">✗</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No significant weaknesses identified.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

function WalletProfilePage() {
  const { address } = Route.useParams();

  const [profile, setProfile]   = useState<WalletProfileData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [failed, setFailed]     = useState(false);
  const [copied, setCopied]     = useState(false);

  const loadProfile = useServerFn(getWalletProfile);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setNotFound(false);
    setProfile(null);

    loadProfile({ data: { walletAddress: address } })
      .then((res) => {
        if (cancelled) return;
        if (res.error) { setFailed(true); return; }
        if (!res.data)  { setNotFound(true); return; }
        setProfile(res.data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [address, loadProfile]);

  function copyAddress() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const cls   = profile?.identity.classification ?? null;
  const color = clsColor(cls);

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-7xl border border-border bg-surface">

        {/* ── Header ── */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Wallet Intelligence Profile
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">
              {profile ? clsLabel(cls) : "Wallet Profile"}
            </h1>
          </div>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/smart-money">Leaderboard</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/">
                <ArrowLeft />
                Scanner
              </Link>
            </Button>
          </nav>
        </header>

        <main className="space-y-5 px-5 py-6 sm:px-8">

          {/* ── Address bar ── */}
          <div className="flex flex-wrap items-center gap-3 border border-border bg-background px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Wallet address</p>
              <p className="mt-0.5 break-all font-mono text-sm">{address}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={copyAddress}>
                {copied
                  ? <CheckCircle className="size-4 text-emerald-400" />
                  : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button asChild variant="ghost" size="sm">
                <a href={solscanAccount(address)} target="_blank" rel="noreferrer">
                  Solscan
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            </div>
          </div>

          {/* ── Classification + metadata bar ── */}
          {profile && (
            <div className="flex flex-wrap items-center gap-4 border border-border bg-background px-5 py-4">
              <span
                className="rounded-sm border px-2.5 py-0.5 font-mono text-xs uppercase tracking-[0.18em]"
                style={{
                  backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
                  color,
                  borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
                }}
              >
                {clsLabel(cls)}
              </span>
              <span className="text-xs text-muted-foreground">
                First seen {fmtDate(profile.identity.firstSeen)}
              </span>
              <span className="text-xs text-muted-foreground">
                Last active {fmtDate(profile.identity.lastSeen)}
              </span>
              {profile.identity.discoveryConfidence != null && (
                <span className="text-xs text-muted-foreground">
                  Discovery confidence {fmtPct(profile.identity.discoveryConfidence)}
                </span>
              )}
              {profile.badges.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {profile.badges.slice(0, 3).map((b) => {
                    const bc = BADGE_COLORS[b.color] ?? BADGE_COLORS.silver;
                    return (
                      <span
                        key={b.id}
                        title={b.description}
                        className="rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]"
                        style={{
                          backgroundColor: `color-mix(in oklab, ${bc} 14%, transparent)`,
                          color:           bc,
                          borderColor:    `color-mix(in oklab, ${bc} 35%, transparent)`,
                        }}
                      >
                        {b.label}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Recommendation banner — shown before tabs so retail users see it immediately ── */}
          {profile && <RecommendationBanner rec={profile.recommendation} />}

          {/* ── States ── */}
          {loading && (
            <div className="space-y-4">
              <SkeletonGrid count={8} />
              <SkeletonGrid count={4} />
            </div>
          )}

          {!loading && failed && (
            <div className="border border-destructive/40 bg-background p-8 text-center">
              <p className="text-sm text-destructive">
                Could not load wallet profile. Please retry.
              </p>
            </div>
          )}

          {!loading && notFound && (
            <div className="border border-border bg-background p-8 text-center">
              <h2 className="font-display text-lg font-semibold">Wallet not tracked</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                This address hasn't appeared in wallet intelligence data yet.
              </p>
            </div>
          )}

          {/* ── Six-tab profile ── */}
          {profile && (
            <Tabs defaultValue="profile">
              <TabsList className="mb-4 flex-wrap h-auto gap-1">
                <TabsTrigger value="profile">Profile</TabsTrigger>
                <TabsTrigger value="discovery">Discovery</TabsTrigger>
                <TabsTrigger value="style">Style</TabsTrigger>
                <TabsTrigger value="history">
                  History
                  {profile.tokenHistory.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 py-px font-mono text-[9px]">
                      {profile.tokenHistory.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="timeline">
                  Timeline
                  {profile.timeline.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 py-px font-mono text-[9px]">
                      {profile.timeline.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="insights">
                  Insights
                  {profile.badges.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-muted px-1.5 py-px font-mono text-[9px]">
                      {profile.badges.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="profile">
                <ProfileTab profile={profile} />
              </TabsContent>

              <TabsContent value="discovery">
                <DiscoveryTab profile={profile} />
              </TabsContent>

              <TabsContent value="style">
                <StyleTab profile={profile} />
              </TabsContent>

              <TabsContent value="history">
                <HistoryTab profile={profile} />
              </TabsContent>

              <TabsContent value="timeline">
                <TimelineTab profile={profile} />
              </TabsContent>

              <TabsContent value="insights">
                <InsightsTab profile={profile} />
              </TabsContent>
            </Tabs>
          )}
        </main>
      </div>
    </div>
  );
}
