import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Copy,
  CheckCircle,
  ExternalLink,
  ShieldAlert,
  ShieldX,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getDeveloperWatchlist,
  type WatchlistEntry,
} from "@/lib/developer-intel.functions";

type WatchlistData = Awaited<ReturnType<typeof getDeveloperWatchlist>>;

export const Route = createFileRoute("/developer/watchlist")({
  head: () => ({
    meta: [
      { title: "Developer Watchlist — Scam Intel" },
      {
        name: "description",
        content:
          "Global list of Solana developer wallets flagged as Confirmed Scammers or Serial Offenders based on cross-token scan history.",
      },
      { property: "og:title", content: "Developer Watchlist — Scam Intel" },
      {
        property: "og:description",
        content:
          "All flagged Solana developer wallets, ranked by severity and launch count.",
      },
    ],
  }),
  component: WatchlistPage,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FilterType = "all" | "Confirmed Scammer" | "Serial Offender";

const RISK_LEVEL_ORDER: Record<string, number> = {
  EXTREME: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function riskColor(level: string): string {
  const map: Record<string, string> = {
    EXTREME: "var(--risk-extreme, #ef4444)",
    HIGH: "var(--risk-high, #f97316)",
    MEDIUM: "var(--risk-medium, #f59e0b)",
    LOW: "var(--risk-low, #10b981)",
  };
  return map[(level ?? "").toUpperCase()] ?? "var(--muted-foreground)";
}

function riskBadge(level: string): string {
  const map: Record<string, string> = {
    EXTREME: "border-red-800/60 bg-red-950/40 text-red-400",
    HIGH: "border-orange-800/60 bg-orange-950/40 text-orange-400",
    MEDIUM: "border-amber-800/60 bg-amber-950/40 text-amber-400",
    LOW: "border-emerald-800/60 bg-emerald-950/40 text-emerald-400",
  };
  return (
    map[(level ?? "").toUpperCase()] ??
    "border-border bg-muted text-muted-foreground"
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function WatchlistPage() {
  const load = useServerFn(getDeveloperWatchlist);
  const [data, setData] = useState<WatchlistData | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    load({}).then(setData).catch(() => setFailed(true));
  }, [load]);

  const filtered = (data?.entries ?? []).filter((e) => {
    if (filter !== "all" && e.classification !== filter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return (
        e.walletAddress.toLowerCase().includes(q) ||
        e.tokens.some(
          (t) =>
            (t.tokenName ?? "").toLowerCase().includes(q) ||
            (t.tokenSymbol ?? "").toLowerCase().includes(q) ||
            t.tokenAddress.toLowerCase().includes(q),
        )
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-7xl border border-border bg-surface">

        {/* ── Header ── */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Phase 10 · Developer History
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">
              Developer Watchlist
            </h1>
          </div>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/history">History</Link>
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

          {/* ── Explainer banner ── */}
          <div className="flex items-start gap-3 border border-amber-900/50 bg-amber-950/20 px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              This watchlist is automatically populated every time a token scan resolves a developer wallet
              with a{" "}
              <span className="text-red-400">Confirmed Scammer</span> or{" "}
              <span className="text-orange-400">Serial Offender</span> classification.
              It only contains wallets that have been seen through the scanner — it is not a complete
              on-chain database.
            </p>
          </div>

          {/* ── Stat cards ── */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard
              label="Total flagged wallets"
              value={data?.totalFlagged ?? "—"}
              color="text-foreground"
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <StatCard
              label="Confirmed Scammers"
              value={data?.confirmedScammerCount ?? "—"}
              color="text-red-400"
              icon={<ShieldX className="size-4 text-red-400" />}
              active={filter === "Confirmed Scammer"}
              onClick={() => setFilter("Confirmed Scammer")}
            />
            <StatCard
              label="Serial Offenders"
              value={data?.serialOffenderCount ?? "—"}
              color="text-orange-400"
              icon={<ShieldAlert className="size-4 text-orange-400" />}
              active={filter === "Serial Offender"}
              onClick={() => setFilter("Serial Offender")}
            />
          </div>

          {/* ── Search bar ── */}
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by wallet address or token name / symbol…"
              className="w-full border border-border bg-background px-4 py-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none"
            />
          </div>

          {/* ── Loading / error ── */}
          {!data && !failed && (
            <p className="py-16 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Loading watchlist…
            </p>
          )}
          {failed && (
            <p className="py-16 text-center text-sm text-destructive">
              Watchlist could not be loaded. Please retry.
            </p>
          )}

          {/* ── Empty DB state ── */}
          {data && !data.dataFromDb && (
            <div className="border border-border bg-background px-6 py-12 text-center">
              <ShieldX className="mx-auto mb-3 size-8 text-muted-foreground/40" />
              <h2 className="font-display text-lg font-semibold">Watchlist is empty</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                No flagged developer wallets found yet. The watchlist populates automatically as
                you scan tokens — when a developer is classified as a Confirmed Scammer or Serial
                Offender, they will appear here.
              </p>
              <Button asChild variant="outline" className="mt-6">
                <Link to="/">Scan a token</Link>
              </Button>
            </div>
          )}

          {/* ── No results for filter/search ── */}
          {data && data.dataFromDb && filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No wallets match the current filter.
            </p>
          )}

          {/* ── Watchlist entries ── */}
          {filtered.length > 0 && (
            <section className="border border-border">
              <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide">
                  Flagged Developer Wallets
                </h2>
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {filtered.length} result{filtered.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="divide-y divide-border">
                {filtered.map((entry) => (
                  <WatchlistRow key={entry.walletAddress} entry={entry} />
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watchlist row with expandable token list
// ---------------------------------------------------------------------------

function WatchlistRow({ entry }: { entry: WatchlistEntry }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  function copyWallet() {
    navigator.clipboard.writeText(entry.walletAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }

  const isScammer = entry.classification === "Confirmed Scammer";
  const badgeClass = isScammer
    ? "border-red-700 bg-red-950/40 text-red-400"
    : "border-orange-700 bg-orange-950/40 text-orange-400";

  return (
    <div className={expanded ? "bg-accent/10" : "hover:bg-accent/5"}>
      {/* ── Main row ── */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:flex-nowrap">

        {/* Classification badge */}
        <span
          className={`shrink-0 rounded-sm border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] ${badgeClass}`}
        >
          {isScammer ? (
            <span className="flex items-center gap-1">
              <ShieldX className="size-2.5" />
              {entry.classification}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-2.5" />
              {entry.classification}
            </span>
          )}
        </span>

        {/* Wallet address */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-xs">
              {entry.walletAddress.slice(0, 12)}…{entry.walletAddress.slice(-8)}
            </span>
            <button
              onClick={copyWallet}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              title="Copy wallet address"
            >
              {copied ? (
                <CheckCircle className="size-3 text-emerald-400" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </div>
        </div>

        {/* Stats chips */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 font-mono text-[10px]">
          <Chip label="Tokens" value={entry.tokenCount} />
          <Chip
            label="Worst score"
            value={entry.highestRiskScore}
            color={riskColor(entry.worstRiskLevel)}
          />
          <Chip
            label="Last seen"
            value={new Date(entry.lastSeen).toLocaleDateString()}
          />
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[10px]">
            <Link
              to="/developer/profile/$wallet"
              params={{ wallet: entry.walletAddress }}
            >
              Profile
              <ArrowUpRight className="size-3" />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[10px]">
            <a
              href={`https://solscan.io/account/${entry.walletAddress}`}
              target="_blank"
              rel="noreferrer"
            >
              Solscan
              <ExternalLink className="size-3" />
            </a>
          </Button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="ml-1 flex items-center gap-1 rounded border border-border px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            Tokens
            {expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
        </div>
      </div>

      {/* ── Expanded token list ── */}
      {expanded && (
        <div className="border-t border-border bg-background px-4 py-3">
          <table className="w-full text-left text-xs">
            <thead className="font-mono uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="pb-2 pr-6">Token</th>
                <th className="pb-2 pr-6">Risk</th>
                <th className="pb-2 pr-6 text-right">Score</th>
                <th className="pb-2 pr-6">Scanned</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entry.tokens.map((t) => (
                <tr key={t.tokenAddress} className="hover:bg-accent/10">
                  <td className="py-2 pr-6">
                    <div className="font-medium">
                      {t.tokenName ?? "Unknown Token"}
                    </div>
                    <div className="font-mono text-[9px] text-muted-foreground">
                      {t.tokenSymbol ?? "—"} ·{" "}
                      {t.tokenAddress.slice(0, 7)}…
                      {t.tokenAddress.slice(-5)}
                    </div>
                  </td>
                  <td className="py-2 pr-6">
                    <span
                      className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${riskBadge(t.riskLevel)}`}
                    >
                      {t.riskLevel ?? "—"}
                    </span>
                  </td>
                  <td className="py-2 pr-6 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, t.riskScore)}%`,
                            backgroundColor: riskColor(t.riskLevel),
                          }}
                        />
                      </div>
                      <span className="font-mono tabular-nums">
                        {t.riskScore}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 pr-6 font-mono text-muted-foreground">
                    {t.scannedAt
                      ? new Date(t.scannedAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-1">
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[9px]"
                      >
                        <Link to="/" search={{ address: t.tokenAddress } as any}>
                          Scan
                          <ArrowUpRight className="size-3" />
                        </Link>
                      </Button>
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[9px]"
                      >
                        <a
                          href={`https://solscan.io/token/${t.tokenAddress}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Explorer
                          <ExternalLink className="size-3" />
                        </a>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  color,
  icon,
  active,
  onClick,
}: {
  label: string;
  value: number | string;
  color: string;
  icon?: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full border bg-background px-4 py-3 text-left transition-colors hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        active ? "border-primary/60" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      </div>
      <p
        className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${color}`}
      >
        {value}
      </p>
      {active && (
        <p className="mt-1 font-mono text-[8px] uppercase tracking-wider text-primary/70">
          Filtered ↑
        </p>
      )}
    </button>
  );
}

function Chip({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="text-center">
      <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className="font-mono text-[10px] font-medium"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}
