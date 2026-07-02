// =============================================================================
// /smart-money — Smart Money Leaderboard  (P3-A)
//
// Displays all 835 wallets ranked by intelligence_score, with:
//   • Live enrichment progress bar (X/835 wallets fully scored)
//   • Classification filter tabs (All / Smart Money / Sniper / Whale / Bot / Retail)
//   • Sort toggle (Intelligence Score / Discovery Score / Win Rate / Avg ROI)
//   • Paginated table with rank, address, classification badge, key metrics,
//     and score bars
//   • Wallet address links to Solscan
//   • Empty / loading states
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLeaderboard,
  getLeaderboardStats,
  getEnrichmentStatus,
  type LeaderboardWallet,
  type LeaderboardStats,
  type EnrichmentStatus,
} from "@/lib/api/leaderboard.functions";

// ─────────────────────────────────────────────────────────────────────────────
// Route definition
// ─────────────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/smart-money")({
  head: () => ({
    meta: [
      { title: "Smart Money Leaderboard — Scam Intel" },
      {
        name: "description",
        content:
          "The wallets that entered before 10× moves. 835 Solana wallets ranked by intelligence score, win rate, and discovery precision.",
      },
      { property: "og:title", content: "Smart Money Leaderboard — Scam Intel" },
      {
        property: "og:description",
        content:
          "835 wallets. Ranked by who entered first, won most, and left cleanest.",
      },
    ],
  }),
  component: SmartMoneyLeaderboard,
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

type ClassificationFilter =
  | "all"
  | "smart_money"
  | "sniper"
  | "whale"
  | "bot"
  | "retail"
  | "unknown";

type SortKey = "intelligence_score" | "discovery_score" | "win_rate" | "average_roi";

const CLASSIFICATION_TABS: { id: ClassificationFilter; label: string }[] = [
  { id: "all",         label: "All" },
  { id: "smart_money", label: "Smart Money" },
  { id: "sniper",      label: "Sniper" },
  { id: "whale",       label: "Whale" },
  { id: "bot",         label: "Bot" },
  { id: "retail",      label: "Retail" },
  { id: "unknown",     label: "Unknown" },
];

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: "intelligence_score", label: "Intel Score" },
  { id: "discovery_score",    label: "Discovery" },
  { id: "win_rate",           label: "Win Rate" },
  { id: "average_roi",        label: "Avg ROI" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

function classificationColor(cls: string | null): string {
  switch (cls) {
    case "smart_money": return "oklch(0.74 0.18 155)";  // green
    case "sniper":      return "oklch(0.78 0.17 75)";   // amber
    case "whale":       return "oklch(0.70 0.18 220)";  // blue
    case "bot":         return "oklch(0.74 0.19 50)";   // orange
    case "retail":      return "oklch(0.72 0.05 250)";  // grey-blue
    default:            return "oklch(0.55 0.02 250)";  // muted grey
  }
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

function scoreBar(value: number | null, max = 1): JSX.Element {
  const pct = value != null ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const color =
    pct >= 70 ? "var(--risk-low)"
    : pct >= 40 ? "var(--risk-medium)"
    : pct > 0 ? "var(--risk-high)"
    : "oklch(0.35 0.005 250)";

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted/50">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {value != null ? `${pct}%` : "—"}
      </span>
    </div>
  );
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

function fmtRoi(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(2)}×`;
}

function fmtPnl(v: number): string {
  if (v === 0) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(3)} SOL`;
}

function fmtAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function solscanUrl(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

function copyToClipboard(text: string): void {
  void navigator.clipboard.writeText(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function EnrichmentBar({ status }: { status: EnrichmentStatus | null }) {
  if (!status) return null;

  const { totalWallets, enrichedWallets, hollowWallets, coveragePct } = status;
  const barColor =
    coveragePct >= 90 ? "var(--risk-low)"
    : coveragePct >= 60 ? "var(--risk-medium)"
    : "var(--risk-high)";

  return (
    <div className="rounded-md border border-border/40 bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Enrichment Coverage
        </span>
        <span className="font-mono text-xs text-foreground">
          {enrichedWallets} / {totalWallets} wallets
        </span>
      </div>

      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
          style={{ width: `${coveragePct}%`, background: barColor }}
        />
      </div>

      <div className="mt-2 flex items-center gap-4 text-[10px] text-muted-foreground">
        <span>
          <span style={{ color: barColor }} className="font-semibold">{coveragePct}%</span>
          {" "}fully scored
        </span>
        {hollowWallets > 0 && (
          <span className="text-muted-foreground/60">
            {hollowWallets} wallets enriching in background
          </span>
        )}
        {hollowWallets === 0 && (
          <span style={{ color: "var(--risk-low)" }}>All wallets enriched ✓</span>
        )}
      </div>
    </div>
  );
}

function StatsBar({ stats }: { stats: LeaderboardStats | null }) {
  if (!stats) return null;

  const items: { label: string; value: number; color: string }[] = [
    { label: "Smart Money", value: stats.smart_money, color: "oklch(0.74 0.18 155)" },
    { label: "Snipers",     value: stats.sniper,       color: "oklch(0.78 0.17 75)" },
    { label: "Whales",      value: stats.whale,        color: "oklch(0.70 0.18 220)" },
    { label: "Bots",        value: stats.bot,          color: "oklch(0.74 0.19 50)" },
    { label: "Retail",      value: stats.retail,       color: "oklch(0.72 0.05 250)" },
    { label: "Unscored",    value: stats.without_score, color: "oklch(0.40 0.01 250)" },
  ];

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {items.map(({ label, value, color }) => (
        <div
          key={label}
          className="rounded-md border border-border/30 bg-surface px-3 py-2.5 text-center"
        >
          <div className="font-mono text-xl font-bold" style={{ color }}>
            {value}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}

function WalletRow({
  rank,
  wallet,
  sortBy,
}: {
  rank: number;
  wallet: LeaderboardWallet;
  sortBy: SortKey;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(wallet.wallet_address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const color = classificationColor(wallet.wallet_classification);
  const isUnenriched = wallet.intelligence_score == null;

  return (
    <tr className="group border-t border-border/30 hover:bg-muted/20 transition-colors">
      {/* Rank */}
      <td className="px-4 py-3 text-right">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {rank <= 3 ? (
            <span style={{ color: rank === 1 ? "oklch(0.82 0.18 80)" : rank === 2 ? "oklch(0.72 0.05 250)" : "oklch(0.74 0.19 50)" }}>
              #{rank}
            </span>
          ) : (
            `#${rank}`
          )}
        </span>
      </td>

      {/* Address */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <a
            href={solscanUrl(wallet.wallet_address)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-foreground/80 hover:text-foreground transition-colors"
            title={wallet.wallet_address}
          >
            {fmtAddress(wallet.wallet_address)}
          </a>
          <button
            onClick={handleCopy}
            title="Copy address"
            className="opacity-0 group-hover:opacity-100 text-[9px] text-muted-foreground hover:text-foreground transition-all px-1 py-0.5 rounded border border-border/40 hover:border-border/80"
          >
            {copied ? "✓" : "copy"}
          </button>
        </div>
      </td>

      {/* Classification */}
      <td className="px-4 py-3">
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{
            backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
            color,
          }}
        >
          {classificationLabel(wallet.wallet_classification)}
        </span>
      </td>

      {/* Intel Score */}
      <td className="px-4 py-3">
        {isUnenriched ? (
          <span className="text-[10px] text-muted-foreground/50 italic">enriching…</span>
        ) : (
          scoreBar(wallet.intelligence_score, 1)
        )}
      </td>

      {/* Discovery Score */}
      <td className="px-4 py-3">
        {wallet.discovery_score != null ? (
          <div className="flex flex-col gap-0.5">
            {scoreBar(wallet.discovery_score, 1)}
            {wallet.discovery_tier && (
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                {wallet.discovery_tier}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>

      {/* Win Rate */}
      <td className="px-4 py-3">
        <span
          className="font-mono text-xs tabular-nums"
          style={{
            color:
              wallet.win_rate == null ? "var(--muted-foreground)"
              : wallet.win_rate >= 0.65 ? "var(--risk-low)"
              : wallet.win_rate >= 0.45 ? "var(--risk-medium)"
              : "var(--risk-high)",
          }}
        >
          {fmtPct(wallet.win_rate)}
        </span>
      </td>

      {/* Avg ROI */}
      <td className="px-4 py-3">
        <span
          className="font-mono text-xs tabular-nums"
          style={{
            color:
              wallet.average_roi == null ? "var(--muted-foreground)"
              : wallet.average_roi >= 2 ? "var(--risk-low)"
              : wallet.average_roi >= 1 ? "var(--risk-medium)"
              : "var(--risk-high)",
          }}
        >
          {fmtRoi(wallet.average_roi)}
        </span>
      </td>

      {/* Tokens */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {wallet.total_tokens_traded ?? 0}
        </span>
      </td>

      {/* Realized PnL */}
      <td className="px-4 py-3">
        <span
          className="font-mono text-xs tabular-nums"
          style={{
            color:
              wallet.realized_pnl > 0 ? "var(--risk-low)"
              : wallet.realized_pnl < 0 ? "var(--risk-high)"
              : "var(--muted-foreground)",
          }}
        >
          {fmtPnl(wallet.realized_pnl)}
        </span>
      </td>

      {/* Last seen */}
      <td className="px-4 py-3 text-[10px] text-muted-foreground/60">
        {wallet.last_seen_timestamp
          ? new Date(wallet.last_seen_timestamp).toLocaleDateString()
          : "—"}
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page component
// ─────────────────────────────────────────────────────────────────────────────

function SmartMoneyLeaderboard() {
  // ── State ────────────────────────────────────────────────────────────────
  const [wallets, setWallets]           = useState<LeaderboardWallet[]>([]);
  const [total, setTotal]               = useState(0);
  const [stats, setStats]               = useState<LeaderboardStats | null>(null);
  const [enrichmentStatus, setEnrichStatus] = useState<EnrichmentStatus | null>(null);

  const [classification, setClassification] = useState<ClassificationFilter>("all");
  const [sortBy, setSortBy]                 = useState<SortKey>("intelligence_score");
  const [page, setPage]                     = useState(0);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState<string | null>(null);

  const fetchLeaderboard = useServerFn(getLeaderboard);
  const fetchStats       = useServerFn(getLeaderboardStats);
  const fetchStatus      = useServerFn(getEnrichmentStatus);

  // ── Load stats & enrichment status once ──────────────────────────────────
  const statsLoaded = useRef(false);

  useEffect(() => {
    if (statsLoaded.current) return;
    statsLoaded.current = true;

    Promise.all([
      fetchStats({ data: {} }).then((r) => {
        if (r.error) console.warn("[leaderboard] stats error:", r.error);
        else setStats(r.stats);
      }),
      fetchStatus({ data: {} }).then((r) => {
        if (r.error) console.warn("[leaderboard] status error:", r.error);
        else setEnrichStatus(r.status);
      }),
    ]);
  }, [fetchStats, fetchStatus]);

  // ── Load wallet page ──────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await fetchLeaderboard({
        data: {
          limit:          PAGE_SIZE,
          offset:         page * PAGE_SIZE,
          classification: classification === "all" ? undefined : classification,
          sortBy,
        },
      });

      if (result.error) {
        setError(result.error);
      } else {
        setWallets(result.wallets);
        setTotal(result.total);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, [fetchLeaderboard, page, classification, sortBy]);

  useEffect(() => { void load(); }, [load]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleClassification = (cls: ClassificationFilter) => {
    setClassification(cls);
    setPage(0);
  };

  const handleSort = (key: SortKey) => {
    setSortBy(key);
    setPage(0);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border/40">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            ← Scam Intelligence
          </Link>
          <nav className="hidden items-center gap-7 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground md:flex">
            <Link to="/" className="transition hover:text-foreground">Scanner</Link>
            <Link to="/history" className="transition hover:text-foreground">History</Link>
            <Link to="/developer/watchlist" className="transition hover:text-foreground">Watchlist</Link>
            <Link to="/smart-money" className="text-primary">Leaderboard</Link>
            <Link to="/atomic-exploits" className="transition hover:text-foreground">Atomic Exploits</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 lg:px-8">
        {/* Page title */}
        <div className="mb-8">
          <div className="flex items-baseline gap-3">
            <h1 className="font-display text-3xl font-bold tracking-tight">
              Smart Money Leaderboard
            </h1>
            <span className="font-mono text-sm text-muted-foreground">
              {total > 0 ? `${total.toLocaleString()} wallets` : ""}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Wallets ranked by who entered before 10× moves, won most, and left
            cleanest. Intelligence score is a composite of win rate, ROI,
            conviction, and classification.
          </p>
        </div>

        {/* Enrichment progress */}
        <div className="mb-6">
          <EnrichmentBar status={enrichmentStatus} />
        </div>

        {/* Stats */}
        <div className="mb-6">
          <StatsBar stats={stats} />
        </div>

        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* Classification tabs */}
          <div className="flex flex-wrap gap-1.5">
            {CLASSIFICATION_TABS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => handleClassification(id)}
                className="rounded px-3 py-1.5 text-xs font-medium transition-all"
                style={{
                  background:
                    classification === id
                      ? `color-mix(in oklab, ${
                          id === "all"
                            ? "var(--primary)"
                            : classificationColor(id === "all" ? null : id)
                        } 25%, transparent)`
                      : "transparent",
                  color:
                    classification === id
                      ? id === "all"
                        ? "var(--primary)"
                        : classificationColor(id === "all" ? null : id)
                      : "var(--muted-foreground)",
                  border: `1px solid ${
                    classification === id
                      ? id === "all"
                        ? "color-mix(in oklab, var(--primary) 50%, transparent)"
                        : `color-mix(in oklab, ${classificationColor(id === "all" ? null : id)} 50%, transparent)`
                      : "color-mix(in oklab, var(--border) 80%, transparent)"
                  }`,
                }}
              >
                {label}
                {stats && id !== "all" && (
                  <span className="ml-1.5 opacity-60">
                    {(stats as Record<string, number>)[id] ?? 0}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Sort
            </span>
            {SORT_OPTIONS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => handleSort(id)}
                className="rounded px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-all"
                style={{
                  background: sortBy === id ? "color-mix(in oklab, var(--primary) 20%, transparent)" : "transparent",
                  color: sortBy === id ? "var(--primary)" : "var(--muted-foreground)",
                  border: `1px solid ${sortBy === id ? "color-mix(in oklab, var(--primary) 40%, transparent)" : "transparent"}`,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto rounded-lg border border-border/40">
          <table className="w-full text-sm">
            <thead className="border-b border-border/40 bg-muted/30">
              <tr>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-muted-foreground">
                  Rank
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Wallet
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Intel Score
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Discovery
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Win Rate
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Avg ROI
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Tokens
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Realized PnL
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  Last Seen
                </th>
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      <span className="text-sm text-muted-foreground">
                        Loading leaderboard…
                      </span>
                    </div>
                  </td>
                </tr>
              )}

              {!loading && wallets.length === 0 && !error && (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
                    <div className="text-sm text-muted-foreground">
                      No wallets found for this filter.
                    </div>
                  </td>
                </tr>
              )}

              {!loading &&
                wallets.map((wallet, i) => (
                  <WalletRow
                    key={wallet.wallet_address}
                    rank={page * PAGE_SIZE + i + 1}
                    wallet={wallet}
                    sortBy={sortBy}
                  />
                ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Showing {page * PAGE_SIZE + 1}–
              {Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded border border-border/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
              >
                ← Prev
              </button>

              {/* Page numbers — show current ±2 */}
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const start = Math.max(0, Math.min(page - 2, totalPages - 5));
                const p = start + i;
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className="rounded border px-3 py-1.5 text-xs tabular-nums transition-colors"
                    style={{
                      background: p === page ? "color-mix(in oklab, var(--primary) 20%, transparent)" : "transparent",
                      color: p === page ? "var(--primary)" : "var(--muted-foreground)",
                      borderColor: p === page ? "color-mix(in oklab, var(--primary) 40%, transparent)" : "color-mix(in oklab, var(--border) 60%, transparent)",
                    }}
                  >
                    {p + 1}
                  </button>
                );
              })}

              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="rounded border border-border/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {/* Footer note */}
        <p className="mt-8 text-center text-[10px] text-muted-foreground/50">
          Scores update every 20 minutes · Enrichment runs every 30 minutes · Data sourced from Helius transaction history
        </p>
      </main>
    </div>
  );
}
