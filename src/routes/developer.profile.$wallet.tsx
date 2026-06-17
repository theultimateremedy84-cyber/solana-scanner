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
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle,
  Copy,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDeveloperProfileByWallet } from "@/lib/developer-intel.functions";
import { formatUsd } from "@/lib/mockScan";

type ProfileData = Awaited<ReturnType<typeof getDeveloperProfileByWallet>>;
type TokenEntry = ProfileData["tokens"][number];

export const Route = createFileRoute("/developer/profile/$wallet")({
  head: ({ params }) => ({
    meta: [
      {
        title: `Developer Profile — ${params.wallet.slice(0, 8)}… — Scam Intel`,
      },
      {
        name: "description",
        content:
          "Full launch history and Phase 10 Developer History risk profile for a Solana creator wallet.",
      },
      {
        property: "og:title",
        content: "Developer Profile — Scam Intel",
      },
    ],
  }),
  component: DeveloperProfilePage,
});

// ---------------------------------------------------------------------------
// Risk helpers
// ---------------------------------------------------------------------------

const RISK_COLOR: Record<string, string> = {
  EXTREME: "var(--risk-extreme, #ef4444)",
  HIGH: "var(--risk-high, #f97316)",
  MEDIUM: "var(--risk-medium, #f59e0b)",
  LOW: "var(--risk-low, #10b981)",
};

function riskColor(level: string) {
  return RISK_COLOR[(level ?? "").toUpperCase()] ?? "var(--muted-foreground)";
}

function riskBg(level: string): string {
  const map: Record<string, string> = {
    EXTREME: "bg-red-950/40 text-red-400 border-red-800/60",
    HIGH: "bg-orange-950/40 text-orange-400 border-orange-800/60",
    MEDIUM: "bg-amber-950/40 text-amber-400 border-amber-800/60",
    LOW: "bg-emerald-950/40 text-emerald-400 border-emerald-800/60",
  };
  return map[(level ?? "").toUpperCase()] ?? "bg-muted text-muted-foreground border-border";
}

type Classification = "Confirmed Scammer" | "Serial Offender" | "Suspicious" | "Clean";

const CLASSIFICATION_CONFIG: Record<
  Classification,
  { icon: React.ReactNode; badgeClass: string; bgClass: string; description: string }
> = {
  "Confirmed Scammer": {
    icon: <ShieldX className="size-5 shrink-0" />,
    badgeClass: "border-red-700 text-red-400 bg-red-950/40",
    bgClass: "border-red-900/60 bg-red-950/20",
    description:
      "This wallet has 3 or more prior tokens scoring EXTREME risk, or at least one confirmed honeypot in their launch history. Risk floor enforced: ≥ 80. Do not invest in tokens from this developer.",
  },
  "Serial Offender": {
    icon: <ShieldAlert className="size-5 shrink-0" />,
    badgeClass: "border-orange-700 text-orange-400 bg-orange-950/40",
    bgClass: "border-orange-900/60 bg-orange-950/20",
    description:
      "This wallet has 2+ prior HIGH-risk tokens or at least 1 EXTREME-risk token. Repeated high-risk behaviour strongly suggests intentional rug-pull activity. Risk floor enforced: ≥ 60.",
  },
  Suspicious: {
    icon: <TriangleAlert className="size-5 shrink-0" />,
    badgeClass: "border-amber-700 text-amber-400 bg-amber-950/40",
    bgClass: "border-amber-900/60 bg-amber-950/20",
    description:
      "This wallet has at least one prior HIGH-risk token or two MEDIUM-risk tokens. Treat new launches from this developer with extra caution. +15 risk penalty applied to associated scans.",
  },
  Clean: {
    icon: <ShieldCheck className="size-5 shrink-0" />,
    badgeClass: "border-emerald-700 text-emerald-400 bg-emerald-950/40",
    bgClass: "border-emerald-900/60 bg-emerald-950/20",
    description:
      "No high-risk patterns detected in this developer's prior launch history. All known tokens scored LOW or MEDIUM risk. This does not guarantee the current token is safe.",
  },
};

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function DeveloperProfilePage() {
  const { wallet } = Route.useParams();
  const loadProfile = useServerFn(getDeveloperProfileByWallet);
  const [data, setData] = useState<ProfileData | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setFailed(false);
    setData(null);
    loadProfile({ data: { walletAddress: wallet } })
      .then(setData)
      .catch(() => setFailed(true));
  }, [wallet, loadProfile]);

  const classification = (data?.classification ?? "Clean") as Classification;
  const cfg = CLASSIFICATION_CONFIG[classification];

  function copyWallet() {
    navigator.clipboard.writeText(wallet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-7xl border border-border bg-surface">

        {/* ── Header ── */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Phase 10 · Developer History
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Developer Profile</h1>
          </div>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/developer/watchlist">Watchlist</Link>
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

          {/* ── Wallet address bar ── */}
          <div className="flex flex-wrap items-center gap-3 border border-border bg-background px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Developer wallet</p>
              <p className="mt-0.5 break-all font-mono text-sm">{wallet}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={copyWallet}>
                {copied ? <CheckCircle className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button asChild variant="ghost" size="sm">
                <a
                  href={`https://solscan.io/account/${wallet}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Solscan
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            </div>
          </div>

          {/* ── Classification badge ── */}
          {data && (
            <div className={`flex items-start gap-3 border px-5 py-4 ${cfg.bgClass}`}>
              <span className={`mt-0.5 ${cfg.badgeClass.split(" ").find(c => c.startsWith("text-")) ?? "text-foreground"}`}>
                {cfg.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`rounded-sm border px-2.5 py-0.5 font-mono text-xs uppercase tracking-[0.18em] ${cfg.badgeClass}`}
                  >
                    {classification}
                  </span>
                  {data.totalLaunches > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {data.totalLaunches} token{data.totalLaunches === 1 ? "" : "s"} in scan history
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{cfg.description}</p>
              </div>
            </div>
          )}

          {/* ── Loading / error states ── */}
          {!data && !failed && (
            <p className="py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Loading developer profile…
            </p>
          )}
          {failed && (
            <p className="py-12 text-center text-sm text-destructive">
              Developer profile could not be loaded. Please retry.
            </p>
          )}

          {/* ── Stats grid ── */}
          {data && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatCard label="Total launches" value={data.totalLaunches} color="text-foreground" />
              <StatCard label="Extreme risk" value={data.extremeCount} color="text-red-400" />
              <StatCard label="High risk" value={data.highCount} color="text-orange-400" />
              <StatCard label="Suspicious" value={data.suspiciousCount} color="text-amber-400" />
              <StatCard label="Clean" value={data.cleanCount} color="text-emerald-400" />
            </div>
          )}

          {/* ── Risk distribution chart ── */}
          {data && data.tokens.length >= 2 && (
            <section className="border border-border">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide">
                  Risk Score Timeline
                </h2>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Risk score for each known token launch — ordered by scan date
                </p>
              </div>
              <div className="p-4">
                <RiskTimelineChart tokens={data.tokens} />
              </div>
            </section>
          )}

          {/* ── No DB data notice ── */}
          {data && !data.dataFromDb && (
            <div className="border border-border bg-background p-6 text-center">
              <h2 className="font-display text-lg font-semibold">No scan history found</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                This wallet address hasn't appeared in any scans stored in the database yet.
                Scan a token deployed by this wallet to populate developer history.
              </p>
            </div>
          )}

          {/* ── Token timeline table ── */}
          {data && data.tokens.length > 0 && (
            <section className="border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide">
                  Known Token Launches
                </h2>
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  {data.tokens.length} token{data.tokens.length === 1 ? "" : "s"} found
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-xs">
                  <thead className="border-b border-border bg-background font-mono uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Token</th>
                      <th className="px-4 py-3">Risk</th>
                      <th className="px-4 py-3 text-right">Score</th>
                      <th className="px-4 py-3">LP Status</th>
                      <th className="px-4 py-3">Market Cap</th>
                      <th className="px-4 py-3">Last Scanned</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tokens.map((token) => (
                      <TokenRow key={token.tokenAddress} token={token} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token table row
// ---------------------------------------------------------------------------

function TokenRow({ token }: { token: TokenEntry }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/20">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          {token.imageUrl ? (
            <img
              src={token.imageUrl}
              alt=""
              className="size-7 shrink-0 rounded-full"
              loading="lazy"
            />
          ) : (
            <div className="grid size-7 shrink-0 place-items-center rounded-full border border-primary/30 font-mono text-[9px] text-primary">
              {(token.tokenSymbol ?? "?").slice(0, 1)}
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate font-medium">{token.tokenName ?? "Unknown Token"}</div>
            <div className="font-mono text-[9px] text-muted-foreground">
              {token.tokenSymbol ?? "—"} · {token.tokenAddress.slice(0, 7)}…{token.tokenAddress.slice(-5)}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span
          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${riskBg(token.riskLevel)}`}
        >
          {token.riskLevel ?? "—"}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, token.riskScore)}%`,
                backgroundColor: riskColor(token.riskLevel),
              }}
            />
          </div>
          <span className="font-mono text-[10px] tabular-nums">{token.riskScore}</span>
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-muted-foreground">
        {token.lpStatus ?? "—"}
      </td>
      <td className="px-4 py-3 font-mono">
        {token.marketCap ? formatUsd(token.marketCap) : "—"}
      </td>
      <td className="px-4 py-3 font-mono text-muted-foreground">
        {token.scannedAt
          ? new Date(token.scannedAt).toLocaleDateString()
          : "—"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-[10px]">
            <Link to="/" search={{ address: token.tokenAddress } as any}>
              Scan
              <ArrowUpRight className="size-3" />
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-[10px]">
            <a
              href={`https://solscan.io/token/${token.tokenAddress}`}
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
  );
}

// ---------------------------------------------------------------------------
// Risk timeline chart
// ---------------------------------------------------------------------------

function RiskTimelineChart({ tokens }: { tokens: TokenEntry[] }) {
  const chartData = [...tokens]
    .sort((a, b) => new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime())
    .map((t) => ({
      label: t.tokenSymbol ?? t.tokenAddress.slice(0, 5),
      score: t.riskScore,
      level: (t.riskLevel ?? "").toUpperCase(),
    }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 9, fill: "var(--muted-foreground)", fontFamily: "JetBrains Mono" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
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
          formatter={(value: number) => [`${value} / 100`, "Risk Score"]}
        />
        <Bar dataKey="score" radius={[2, 2, 0, 0]}>
          {chartData.map((entry, index) => (
            <Cell key={index} fill={riskColor(entry.level)} opacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${color}`}>
        {value}
      </p>
    </div>
  );
}
