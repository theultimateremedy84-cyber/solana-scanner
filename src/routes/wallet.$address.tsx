// =============================================================================
// /wallet/$address — Wallet Profitability Dashboard  (P3-B)
//
// Per-wallet deep dive: summary stats, per-token P&L (wallet_performance_history),
// and chronological trade history (wallet_token_activity). All reads are
// read-only aggregation against tables that already exist — no new schema.
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
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
import { ArrowLeft, CheckCircle, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getWallet,
  getWalletActivity,
  getWalletPerformance,
} from "@/lib/api/wallet-intelligence.functions";
import type {
  WalletRow,
  WalletPerformanceRow,
  WalletTokenActivityRow,
} from "@/lib/api/wallet-intelligence.types";

export const Route = createFileRoute("/wallet/$address")({
  head: ({ params }) => ({
    meta: [
      {
        title: `Wallet Profile — ${params.address.slice(0, 8)}… — Scam Intel`,
      },
      {
        name: "description",
        content:
          "Full trading history, per-token P&L, and intelligence score breakdown for a Solana wallet.",
      },
    ],
  }),
  component: WalletProfilePage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (mirrors formatting conventions used on /smart-money)
// ─────────────────────────────────────────────────────────────────────────────

const CLASSIFICATION_COLOR: Record<string, string> = {
  smart_money: "oklch(0.74 0.18 155)",
  sniper: "oklch(0.78 0.17 75)",
  whale: "oklch(0.70 0.18 220)",
  bot: "oklch(0.74 0.19 50)",
  retail: "oklch(0.72 0.05 250)",
};

function classificationColor(cls: string | null): string {
  return CLASSIFICATION_COLOR[cls ?? ""] ?? "oklch(0.55 0.02 250)";
}

function classificationLabel(cls: string | null): string {
  switch (cls) {
    case "smart_money": return "Smart Money";
    case "sniper":      return "Sniper";
    case "whale":       return "Whale";
    case "bot":         return "Bot";
    case "retail":      return "Retail";
    default:            return "Unknown";
  }
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

function fmtRoi(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}×`;
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function fmtSol(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(3)} SOL`;
}

function fmtToken(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function solscanAccountUrl(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

function solscanTokenUrl(addr: string): string {
  return `https://solscan.io/token/${addr}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

function WalletProfilePage() {
  const { address } = Route.useParams();

  const loadWallet = useServerFn(getWallet);
  const loadPerformance = useServerFn(getWalletPerformance);
  const loadActivity = useServerFn(getWalletActivity);

  const [wallet, setWallet] = useState<WalletRow | null>(null);
  const [performance, setPerformance] = useState<WalletPerformanceRow[]>([]);
  const [activity, setActivity] = useState<WalletTokenActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setWallet(null);
    setPerformance([]);
    setActivity([]);

    Promise.all([
      loadWallet({ data: { walletAddress: address } }),
      loadPerformance({ data: { walletAddress: address, sortBy: "roi_multiple", limit: 100, offset: 0 } }),
      loadActivity({ data: { walletAddress: address, limit: 100, offset: 0 } }),
    ])
      .then(([walletRes, perfRes, activityRes]) => {
        if (cancelled) return;
        if (walletRes.error || perfRes.error || activityRes.error) {
          setFailed(true);
          return;
        }
        setWallet(walletRes.data);
        setPerformance(perfRes.data ?? []);
        setActivity(activityRes.data ?? []);
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
  }, [address, loadWallet, loadPerformance, loadActivity]);

  function copyAddress() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const color = classificationColor(wallet?.wallet_classification ?? null);

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-7xl border border-border bg-surface">

        {/* ── Header ── */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              P3-B · Wallet Profitability
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Wallet Profile</h1>
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

          {/* ── Address bar ── */}
          <div className="flex flex-wrap items-center gap-3 border border-border bg-background px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Wallet address</p>
              <p className="mt-0.5 break-all font-mono text-sm">{address}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={copyAddress}>
                {copied ? <CheckCircle className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button asChild variant="ghost" size="sm">
                <a href={solscanAccountUrl(address)} target="_blank" rel="noreferrer">
                  Solscan
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            </div>
          </div>

          {/* ── Classification badge ── */}
          {wallet && (
            <div className="flex items-center gap-3 border border-border bg-background px-5 py-4">
              <span
                className="rounded-sm border px-2.5 py-0.5 font-mono text-xs uppercase tracking-[0.18em]"
                style={{
                  backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
                  color,
                  borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
                }}
              >
                {classificationLabel(wallet.wallet_classification)}
              </span>
              <span className="text-xs text-muted-foreground">
                First seen {wallet.first_seen_timestamp ? new Date(wallet.first_seen_timestamp).toLocaleDateString() : "—"}
                {" · "}
                Last active {wallet.last_seen_timestamp ? new Date(wallet.last_seen_timestamp).toLocaleDateString() : "—"}
              </span>
            </div>
          )}

          {/* ── Loading / error / not-found states ── */}
          {loading && (
            <p className="py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Loading wallet profile…
            </p>
          )}
          {!loading && failed && (
            <p className="py-12 text-center text-sm text-destructive">
              Wallet profile could not be loaded. Please retry.
            </p>
          )}
          {!loading && !failed && !wallet && (
            <div className="border border-border bg-background p-6 text-center">
              <h2 className="font-display text-lg font-semibold">Wallet not tracked</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                This address hasn't appeared in wallet intelligence data yet.
              </p>
            </div>
          )}

          {/* ── Summary stats ── */}
          {wallet && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              <StatCard label="Intel Score" value={fmtPct(wallet.intelligence_score)} color="text-foreground" />
              <StatCard label="Discovery Score" value={wallet.discovery_score != null ? String(wallet.discovery_score) : "—"} color="text-foreground" />
              <StatCard label="Win Rate" value={fmtPct(wallet.win_rate)} color="text-emerald-400" />
              <StatCard label="Avg ROI" value={fmtRoi(wallet.average_roi)} color="text-emerald-400" />
              <StatCard label="Tokens Traded" value={String(wallet.total_tokens_traded)} color="text-foreground" />
              <StatCard label="Buys / Sells" value={`${wallet.total_buys} / ${wallet.total_sells}`} color="text-foreground" />
              <StatCard label="Realized P&L" value={fmtSol(wallet.realized_pnl)} color={wallet.realized_pnl >= 0 ? "text-emerald-400" : "text-red-400"} />
              <StatCard label="Unrealized P&L" value={fmtSol(wallet.unrealized_pnl)} color={wallet.unrealized_pnl >= 0 ? "text-emerald-400" : "text-red-400"} />
              <StatCard label="Volume Bought" value={fmtUsd(wallet.total_volume_bought_usd)} color="text-foreground" />
              <StatCard label="Volume Sold" value={fmtUsd(wallet.total_volume_sold_usd)} color="text-foreground" />
            </div>
          )}

          {/* ── Per-token ROI chart ── */}
          {performance.length >= 2 && (
            <section className="border border-border">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide">Per-Token ROI</h2>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  ROI multiple per token, ranked highest to lowest
                </p>
              </div>
              <div className="p-4">
                <RoiChart performance={performance} />
              </div>
            </section>
          )}

          {/* ── Per-token performance table ── */}
          {performance.length > 0 && (
            <section className="border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide">Token Positions &amp; P&amp;L</h2>
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {performance.length} token{performance.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-xs">
                  <thead className="border-b border-border bg-background font-mono uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Token</th>
                      <th className="px-4 py-3 text-right">Invested</th>
                      <th className="px-4 py-3 text-right">Current Value</th>
                      <th className="px-4 py-3 text-right">Realized</th>
                      <th className="px-4 py-3 text-right">Unrealized</th>
                      <th className="px-4 py-3 text-right">ROI</th>
                      <th className="px-4 py-3 text-right">Peak ROI</th>
                      <th className="px-4 py-3">Milestones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performance.map((p) => (
                      <PerformanceRow key={p.token_address} row={p} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Trade history ── */}
          {activity.length > 0 && (
            <section className="border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide">Trade History</h2>
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  Most recent {activity.length} trade{activity.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-border bg-background font-mono uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Token</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3 text-right">Amount (SOL)</th>
                      <th className="px-4 py-3 text-right">Amount (USD)</th>
                      <th className="px-4 py-3 text-right">Entry Mkt Cap</th>
                      <th className="px-4 py-3">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((a) => (
                      <ActivityRow key={a.id} row={a} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {!loading && wallet && performance.length === 0 && activity.length === 0 && (
            <div className="border border-border bg-background p-6 text-center">
              <h2 className="font-display text-lg font-semibold">No trade history yet</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                This wallet has been discovered but hasn't recorded any tracked trades.
              </p>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 truncate font-mono text-lg font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function PerformanceRow({ row }: { row: WalletPerformanceRow }) {
  const milestones = [
    row.reached_50m_mc && "50M",
    row.reached_10m_mc && "10M",
    row.reached_5m_mc && "5M",
    row.reached_1m_mc && "1M",
    row.reached_500k_mc && "500K",
    row.reached_100k_mc && "100K",
  ].filter(Boolean) as string[];
  const topMilestone = milestones[0];

  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/20">
      <td className="px-4 py-3">
        <a
          href={solscanTokenUrl(row.token_address)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-foreground/80 hover:text-foreground"
          title={row.token_address}
        >
          {fmtToken(row.token_address)}
        </a>
      </td>
      <td className="px-4 py-3 text-right font-mono">{fmtUsd(row.initial_investment)}</td>
      <td className="px-4 py-3 text-right font-mono">{fmtUsd(row.current_value)}</td>
      <td className={`px-4 py-3 text-right font-mono ${row.realized_profit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        {fmtUsd(row.realized_profit)}
      </td>
      <td className={`px-4 py-3 text-right font-mono ${row.unrealized_profit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        {fmtUsd(row.unrealized_profit)}
      </td>
      <td className="px-4 py-3 text-right font-mono font-semibold">{fmtRoi(row.roi_multiple)}</td>
      <td className="px-4 py-3 text-right font-mono text-muted-foreground">{fmtRoi(row.peak_roi)}</td>
      <td className="px-4 py-3">
        {topMilestone ? (
          <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {topMilestone}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </td>
    </tr>
  );
}

function ActivityRow({ row }: { row: WalletTokenActivityRow }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/20">
      <td className="px-4 py-3">
        <a
          href={solscanTokenUrl(row.token_address)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-foreground/80 hover:text-foreground"
          title={row.token_address}
        >
          {fmtToken(row.token_address)}
        </a>
      </td>
      <td className="px-4 py-3">
        <span
          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
            row.action_type === "buy"
              ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-400"
              : "border-orange-800/60 bg-orange-950/40 text-orange-400"
          }`}
        >
          {row.action_type}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono">{row.amount_sol != null ? row.amount_sol.toFixed(3) : "—"}</td>
      <td className="px-4 py-3 text-right font-mono">{fmtUsd(row.amount_usd)}</td>
      <td className="px-4 py-3 text-right font-mono text-muted-foreground">{fmtUsd(row.entry_market_cap)}</td>
      <td className="px-4 py-3 font-mono text-muted-foreground">
        {new Date(row.timestamp).toLocaleString()}
      </td>
    </tr>
  );
}

function RoiChart({ performance }: { performance: WalletPerformanceRow[] }) {
  const chartData = [...performance]
    .filter((p) => p.roi_multiple != null)
    .sort((a, b) => (b.roi_multiple ?? 0) - (a.roi_multiple ?? 0))
    .slice(0, 20)
    .map((p) => ({
      label: fmtToken(p.token_address),
      roi: p.roi_multiple ?? 0,
    }));

  if (chartData.length === 0) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">
        Not enough ROI data to chart yet.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
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
          labelStyle={{ color: "var(--foreground)", marginBottom: 4 }}
          formatter={(value: number) => [`${value.toFixed(2)}×`, "ROI"]}
        />
        <Bar dataKey="roi" radius={[2, 2, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell key={index} fill={entry.roi >= 1 ? "var(--risk-low, #10b981)" : "var(--risk-high, #f97316)"} opacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
