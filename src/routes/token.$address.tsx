import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchTokenHistory,
  riskLevelColor,
  summarizeHistory,
  type ScanHistoryRow,
  type TokenHistorySummary,
} from "@/lib/scan-history";
import { formatUsd } from "@/lib/mockScan";

export const Route = createFileRoute("/token/$address")({
  head: ({ params }) => ({
    meta: [
      { title: `Token History — ${params.address.slice(0, 8)}…` },
      {
        name: "description",
        content: "Complete historical risk timeline for this Solana token.",
      },
    ],
  }),
  component: TokenHistoryPage,
});

function TokenHistoryPage() {
  const { address } = Route.useParams();
  const [rows, setRows] = useState<ScanHistoryRow[] | null>(null);
  const [summary, setSummary] = useState<TokenHistorySummary | null>(null);

  useEffect(() => {
    fetchTokenHistory(address).then((r) => {
      setRows(r);
      setSummary(summarizeHistory(r));
    });
  }, [address]);

  const chartData = (rows ?? []).map((r) => ({
    t: new Date(r.scanned_at).getTime(),
    label: new Date(r.scanned_at).toLocaleDateString(),
    risk: r.risk_score,
    liquidity: r.liquidity ? Number(r.liquidity) : 0,
  }));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/40">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            ← Scam Intelligence
          </Link>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link to="/" className="hover:text-foreground">
              Scanner
            </Link>
            <Link to="/history" className="hover:text-foreground">
              History
            </Link>
            <Link to="/developer/watchlist" className="hover:text-foreground">
              Watchlist
            </Link>
            <Link to="/atomic-exploits" className="hover:text-foreground">
              Atomic Exploits
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-wrap items-center gap-3">
          {summary?.latest?.image_url && (
            <img
              src={summary.latest.image_url}
              alt=""
              className="h-10 w-10 rounded-full"
            />
          )}
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {summary?.latest?.token_name ?? "Token History"}
            </h1>
            <div className="font-mono text-xs text-muted-foreground">{address}</div>
          </div>
        </div>

        {rows === null && (
          <div className="mt-12 text-center text-sm text-muted-foreground">
            Loading history…
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="mt-12 rounded-lg border border-border/40 p-8 text-center text-sm text-muted-foreground">
            No scans for this token yet.{" "}
            <Link to="/" className="underline">
              Run one
            </Link>
            .
          </div>
        )}

        {summary && summary.total > 0 && (
          <>
            <section className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryCard label="Total scans" value={String(summary.total)} />
              <SummaryCard
                label="First scan"
                value={summary.first ? new Date(summary.first.scanned_at).toLocaleDateString() : "—"}
                sub={
                  summary.first ? `Risk ${summary.first.risk_score} · ${summary.first.risk_level}` : ""
                }
                color={summary.first ? riskLevelColor(summary.first.risk_level) : undefined}
              />
              <SummaryCard
                label="Latest scan"
                value={
                  summary.latest ? new Date(summary.latest.scanned_at).toLocaleDateString() : "—"
                }
                sub={
                  summary.latest
                    ? `Risk ${summary.latest.risk_score} · ${summary.latest.risk_level}`
                    : ""
                }
                color={summary.latest ? riskLevelColor(summary.latest.risk_level) : undefined}
              />
              <SummaryCard
                label="Highest risk ever"
                value={summary.highest ? String(summary.highest.risk_score) : "—"}
                sub={summary.highest?.risk_level ?? ""}
                color={summary.highest ? riskLevelColor(summary.highest.risk_level) : undefined}
              />
            </section>

            <section className="mt-4">
              <SummaryCard
                label="Lowest risk ever"
                value={summary.lowest ? String(summary.lowest.risk_score) : "—"}
                sub={
                  summary.lowest
                    ? `${summary.lowest.risk_level} · ${new Date(summary.lowest.scanned_at).toLocaleDateString()}`
                    : ""
                }
                color={summary.lowest ? riskLevelColor(summary.lowest.risk_level) : undefined}
              />
            </section>

            <section className="mt-8 rounded-lg border border-border/40 p-4">
              <h2 className="text-lg font-semibold">Historical Risk Timeline</h2>
              <p className="text-xs text-muted-foreground">
                Risk score (0–100) over time across {summary.total} scan
                {summary.total === 1 ? "" : "s"}.
              </p>
              <div className="mt-4 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <YAxis
                      domain={[0, 100]}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--background))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 12,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="risk"
                      stroke="#f97316"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      name="Risk score"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="mt-8 overflow-x-auto rounded-lg border border-border/40">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Scanned</th>
                    <th className="px-4 py-3">Risk</th>
                    <th className="px-4 py-3">Honey Pot</th>
                    <th className="px-4 py-3">Mint</th>
                    <th className="px-4 py-3">Freeze</th>
                    <th className="px-4 py-3">LP</th>
                    <th className="px-4 py-3">Liquidity</th>
                    <th className="px-4 py-3">MCap</th>
                    <th className="px-4 py-3">Vol 24h</th>
                    <th className="px-4 py-3">Holders</th>
                    <th className="px-4 py-3">Top 10%</th>
                    <th className="px-4 py-3">Snipers</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows!]
                    .sort(
                      (a, b) =>
                        new Date(b.scanned_at).getTime() -
                        new Date(a.scanned_at).getTime(),
                    )
                    .map((r) => (
                      <tr key={r.id} className="border-t border-border/40">
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {new Date(r.scanned_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold"
                            style={{
                              backgroundColor: `color-mix(in oklab, ${riskLevelColor(r.risk_level)} 20%, transparent)`,
                              color: riskLevelColor(r.risk_level),
                            }}
                          >
                            {r.risk_score} · {r.risk_level}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs">{r.honey_pot_status}</td>
                        <td className="px-4 py-2 text-xs">{r.mint_authority ?? "—"}</td>
                        <td className="px-4 py-2 text-xs">{r.freeze_authority ?? "—"}</td>
                        <td className="px-4 py-2 text-xs">
                          {r.lp_status ?? "—"}
                          {r.lp_lock_days ? ` (${r.lp_lock_days}d)` : ""}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {r.liquidity ? formatUsd(Number(r.liquidity)) : "—"}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {r.market_cap ? formatUsd(Number(r.market_cap)) : "—"}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {r.volume_24h ? formatUsd(Number(r.volume_24h)) : "—"}
                        </td>
                        <td className="px-4 py-2 text-xs">{r.holder_count ?? "—"}</td>
                        <td className="px-4 py-2 text-xs">
                          {r.top_holder_pct ? `${Number(r.top_holder_pct).toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {r.sniper_wallets ?? 0} ·{" "}
                          {r.sniper_pct ? `${Number(r.sniper_pct).toFixed(1)}%` : "0%"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function SummaryCard({
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
    <div className="rounded-lg border border-border/40 p-4">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
