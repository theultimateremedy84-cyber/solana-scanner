// =============================================================================
// /discovery-quality — Discovery Quality Filter Dashboard  (P3-E)
//
// Internal operator tool: shows autonomous discovery volume, job success/
// failure rate, and rug detection rate per day, so discovery filters can be
// tuned from real data instead of reading Railway logs.
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getDiscoveryQualityDaily,
  type DiscoveryQualityDay,
  type DiscoveryQualitySummary,
} from "@/lib/api/discovery-quality.functions";

export const Route = createFileRoute("/discovery-quality")({
  head: () => ({
    meta: [
      { title: "Discovery Quality Dashboard — Scam Intel" },
      {
        name: "description",
        content:
          "Internal operator view of autonomous token discovery volume, job success rate, and rug detection rate per day.",
      },
    ],
  }),
  component: DiscoveryQualityPage,
});

const RANGE_OPTIONS = [7, 14, 30, 90] as const;

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

function fmtNum(v: number | null): string {
  if (v == null) return "—";
  return Math.round(v).toLocaleString();
}

function fmtUsd(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function DiscoveryQualityPage() {
  const loadDaily = useServerFn(getDiscoveryQualityDaily);
  const [rangeDays, setRangeDays] = useState<number>(14);
  const [summary, setSummary] = useState<DiscoveryQualitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    loadDaily({ data: { rangeDays } })
      .then((res) => {
        if (!cancelled) setSummary(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rangeDays, loadDaily]);

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-7xl border border-border bg-surface">

        {/* ── Header ── */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              P3-E · Internal Operator Tool
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Discovery Quality Dashboard</h1>
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

        <main className="space-y-6 px-5 py-8 sm:px-8">

          {/* ── Range selector ── */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Range</span>
            {RANGE_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setRangeDays(n)}
                className="rounded border px-3 py-1.5 text-xs transition-colors"
                style={{
                  background: n === rangeDays ? "color-mix(in oklab, var(--primary) 20%, transparent)" : "transparent",
                  color: n === rangeDays ? "var(--primary)" : "var(--muted-foreground)",
                  borderColor: n === rangeDays ? "color-mix(in oklab, var(--primary) 40%, transparent)" : "color-mix(in oklab, var(--border) 60%, transparent)",
                }}
              >
                {n}d
              </button>
            ))}
          </div>

          {loading && (
            <p className="py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Loading discovery quality data…
            </p>
          )}
          {!loading && failed && (
            <p className="py-12 text-center text-sm text-destructive">
              Discovery quality data could not be loaded. Please retry.
            </p>
          )}

          {!loading && !failed && summary && (
            <>
              {/* ── Summary stats ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Tokens Discovered" value={String(summary.totalTokensDiscovered)} color="text-foreground" />
                <StatCard label="Scanned (risk-scored)" value={String(summary.totalScanned)} color="text-foreground" />
                <StatCard label="Rugs Detected" value={String(summary.totalRugs)} color="text-red-400" />
                <StatCard label="Overall Rug Rate" value={fmtPct(summary.overallRugRate)} color={summary.overallRugRate != null && summary.overallRugRate > 0.3 ? "text-red-400" : "text-emerald-400"} />
              </div>

              {summary.days.length === 0 && (
                <div className="border border-border bg-background p-6 text-center">
                  <h2 className="font-display text-lg font-semibold">No discovery activity in this range</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    No wallet_collection_jobs were enqueued in the last {rangeDays} days.
                  </p>
                </div>
              )}

              {/* ── Volume + rug rate chart ── */}
              {summary.days.length > 0 && (
                <section className="border border-border">
                  <div className="border-b border-border px-4 py-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wide">Discovery Volume &amp; Rug Rate</h2>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      Bars = tokens discovered per day · Line = rug rate among scanned tokens
                    </p>
                  </div>
                  <div className="p-4">
                    <VolumeRugChart days={summary.days} />
                  </div>
                </section>
              )}

              {/* ── Daily breakdown table ── */}
              {summary.days.length > 0 && (
                <section className="border border-border">
                  <div className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wide">Daily Breakdown</h2>
                    <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      {summary.days.length} day{summary.days.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[920px] text-left text-xs">
                      <thead className="border-b border-border bg-background font-mono uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3">Date</th>
                          <th className="px-4 py-3 text-right">Discovered</th>
                          <th className="px-4 py-3 text-right">Done</th>
                          <th className="px-4 py-3 text-right">Failed</th>
                          <th className="px-4 py-3 text-right">Pending</th>
                          <th className="px-4 py-3 text-right">Scanned</th>
                          <th className="px-4 py-3 text-right">Rugs</th>
                          <th className="px-4 py-3 text-right">Rug Rate</th>
                          <th className="px-4 py-3 text-right">Avg Risk</th>
                          <th className="px-4 py-3 text-right">Avg Mkt Cap</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.days.map((d) => (
                          <DayRow key={d.date} day={d} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}

          <p className="mt-2 text-center text-[10px] text-muted-foreground/50">
            Rug threshold: latest scanned risk_score &gt; 80 · Data sourced from wallet_collection_jobs + scan_history
          </p>

        </main>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function DayRow({ day }: { day: DiscoveryQualityDay }) {
  const rugHigh = day.rugRate != null && day.rugRate > 0.3;
  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/20">
      <td className="px-4 py-3 font-mono">{day.date}</td>
      <td className="px-4 py-3 text-right font-mono">{day.tokensDiscovered}</td>
      <td className="px-4 py-3 text-right font-mono text-emerald-400">{day.jobsDone}</td>
      <td className="px-4 py-3 text-right font-mono text-red-400">{day.jobsFailed}</td>
      <td className="px-4 py-3 text-right font-mono text-muted-foreground">{day.jobsPending}</td>
      <td className="px-4 py-3 text-right font-mono">{day.scannedCount}</td>
      <td className="px-4 py-3 text-right font-mono">{day.rugCount}</td>
      <td className={`px-4 py-3 text-right font-mono font-semibold ${rugHigh ? "text-red-400" : "text-foreground"}`}>
        {fmtPct(day.rugRate)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-muted-foreground">{fmtNum(day.avgRiskScore)}</td>
      <td className="px-4 py-3 text-right font-mono text-muted-foreground">{fmtUsd(day.avgMarketCapUsd)}</td>
    </tr>
  );
}

function VolumeRugChart({ days }: { days: DiscoveryQualityDay[] }) {
  const chartData = [...days]
    .sort((a, b) => (a.date < b.date ? -1 : 1)) // chronological for the chart
    .map((d) => ({
      date: d.date.slice(5), // MM-DD
      discovered: d.tokensDiscovered,
      rugRatePct: d.rugRate != null ? Math.round(d.rugRate * 100) : 0,
    }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 9, fill: "var(--muted-foreground)", fontFamily: "JetBrains Mono" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 9, fill: "var(--muted-foreground)", fontFamily: "JetBrains Mono" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          domain={[0, 100]}
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
          labelStyle={{ color: "var(--foreground)", marginBottom: 4 }}
        />
        <Bar yAxisId="left" dataKey="discovered" name="Tokens Discovered" fill="var(--primary)" opacity={0.6} radius={[2, 2, 0, 0]} />
        <Line yAxisId="right" type="monotone" dataKey="rugRatePct" name="Rug Rate %" stroke="#ef4444" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
