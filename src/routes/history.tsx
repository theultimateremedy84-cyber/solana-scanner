import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fetchRecentScans, riskLevelColor, type ScanHistoryRow } from "@/lib/scan-history";
import { formatUsd } from "@/lib/mockScan";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Scan History — Solana Scam Intelligence" },
      {
        name: "description",
        content:
          "Browse every token scan ever performed. Append-only historical record of risk scores, honey pot status, liquidity, and more.",
      },
      { property: "og:title", content: "Scan History — Solana Scam Intelligence" },
      {
        property: "og:description",
        content: "Append-only historical record of every token scan.",
      },
    ],
  }),
  component: HistoryPage,
});

function HistoryPage() {
  const [rows, setRows] = useState<ScanHistoryRow[] | null>(null);

  useEffect(() => {
    fetchRecentScans(200).then(setRows);
  }, []);

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
            <Link to="/history" className="text-foreground">
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
        <h1 className="text-3xl font-bold tracking-tight">Scan History</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Append-only record of every token scan. Click any token to see its full historical timeline.
        </p>

        {rows === null && (
          <div className="mt-12 text-center text-sm text-muted-foreground">
            Loading scan history…
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="mt-12 rounded-lg border border-border/40 p-8 text-center text-sm text-muted-foreground">
            No scans recorded yet. Run a scan on the home page to get started.
          </div>
        )}

        {rows !== null && rows.length > 0 && (
          <div className="mt-8 overflow-x-auto rounded-lg border border-border/40">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Token</th>
                  <th className="px-4 py-3">Risk</th>
                  <th className="px-4 py-3">Honey Pot</th>
                  <th className="px-4 py-3">Liquidity</th>
                  <th className="px-4 py-3">Market Cap</th>
                  <th className="px-4 py-3">Holders</th>
                  <th className="px-4 py-3">Scanned</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-border/40 hover:bg-muted/30"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to="/token/$address"
                        params={{ address: r.token_address }}
                        className="flex items-center gap-2 hover:underline"
                      >
                        {r.image_url && (
                          <img
                            src={r.image_url}
                            alt=""
                            className="h-6 w-6 rounded-full"
                          />
                        )}
                        <span className="font-medium">{r.token_name ?? "Unknown"}</span>
                        <span className="text-xs text-muted-foreground">
                          {r.token_symbol}
                        </span>
                      </Link>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {r.token_address.slice(0, 8)}…{r.token_address.slice(-6)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-flex items-center gap-2 rounded-full px-2 py-0.5 text-xs font-semibold"
                        style={{
                          backgroundColor: `color-mix(in oklab, ${riskLevelColor(r.risk_level)} 20%, transparent)`,
                          color: riskLevelColor(r.risk_level),
                        }}
                      >
                        {r.risk_score} · {r.risk_level}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">{r.honey_pot_status}</td>
                    <td className="px-4 py-3 text-xs">
                      {r.liquidity ? formatUsd(Number(r.liquidity)) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.market_cap ? formatUsd(Number(r.market_cap)) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs">{r.holder_count ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(r.scanned_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
