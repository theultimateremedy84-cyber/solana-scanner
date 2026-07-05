// =============================================================================
// /funding-clusters — Common Funding Source Clusters (Signal 1)
//
// Real-data UI panel for whale fund-distribution tracing. Calls
// /api/funding-clusters (backed by wallet_sol_transfers + detectCommonFundingSource)
// and shows which whale/smart_money wallets share a first funder — a strong
// signal they're controlled by the same entity.
//
// Unlike cluster.$tokenAddress.funding.tsx (which generates deterministic
// FAKE data from a seeded RNG), every number on this page comes straight
// from wallet_sol_transfers, populated by sol-transfer-indexer.ts.
// =============================================================================

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { ArrowLeft, RefreshCw, Info, Copy, CheckCheck, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/funding-clusters")({
  head: () => ({
    meta: [
      { title: "Funding Clusters — Scam Intel" },
      {
        name: "description",
        content:
          "Whale and smart-money wallets that share a common funding source — a strong signal of coordinated or same-entity control.",
      },
    ],
  }),
  component: FundingClustersPage,
});

interface ClusterWallet {
  address:        string;
  classification: string;
}

interface FundingCluster {
  firstFunder:        string;
  wallets:             ClusterWallet[];
  walletCount:         number;
  fundedWithinWindow:  boolean;
  earliestFundedAt:    string;
  latestFundedAt:      string;
}

interface FundingClustersResponse {
  ok:                boolean;
  classifications?:  string[];
  maxSpreadMinutes?: number;
  walletsConsidered?: number;
  clustersFound?:    number;
  clusters?:         FundingCluster[];
  note?:             string;
  error?:            string;
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function solscanUrl(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

function classificationColor(cls: string): string {
  switch (cls) {
    case "smart_money": return "oklch(0.74 0.18 155)";
    case "whale":        return "oklch(0.70 0.18 220)";
    default:              return "oklch(0.55 0.02 250)";
  }
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 shrink-0 rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
      title="Copy address"
    >
      {copied ? <CheckCheck className="size-2.5 text-risk-low" /> : <Copy className="size-2.5" />}
    </button>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-border bg-background px-4 py-3">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold">{value}</div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function FundingClustersPage() {
  const [data, setData]       = useState<FundingClustersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [maxSpreadMinutes, setMaxSpreadMinutes] = useState(60);

  const fetchClusters = useCallback(async (spread: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/funding-clusters?maxSpreadMinutes=${spread}`);
      const json = (await res.json()) as FundingClustersResponse;
      setData(json);
    } catch (err) {
      setData({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchClusters(maxSpreadMinutes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clusters = data?.clusters ?? [];
  const tightClusters = clusters.filter((c) => c.fundedWithinWindow).length;

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto max-w-7xl border border-border bg-surface">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">Discovery Intelligence</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Funding Clusters</h1>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Whale / smart-money wallets funded by the same source — real on-chain data
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchClusters(maxSpreadMinutes)}
              disabled={loading}
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/"><ArrowLeft className="size-4" />Back to Scanner</Link>
            </Button>
          </div>
        </header>

        <main className="space-y-6 px-5 py-6 sm:px-8">

          <section className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 sm:px-5 sm:py-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-primary/15 p-1.5 text-primary shrink-0">
                <Info className="size-4" />
              </div>
              <div className="space-y-1.5 text-sm leading-relaxed text-foreground/90">
                <p className="font-semibold text-foreground">What is a Funding Cluster?</p>
                <p>
                  When two or more whale or smart-money wallets received their very first SOL
                  from the same address, they are very likely controlled by the same entity —
                  a common pattern when a wallet books profit and splits it across 10-15 fresh
                  wallets to obscure the trail. This page shows only clusters found in real
                  wallet-to-wallet transfer data — nothing here is simulated.
                </p>
                <p className="text-muted-foreground text-xs">
                  Data builds up as your wallet enrichment pipeline runs — whale/smart_money
                  wallets are indexed automatically as they're enriched. If this list is thin,
                  give it more time; it grows continuously in the background.
                </p>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox label="Wallets Considered" value={String(data?.walletsConsidered ?? 0)} />
            <StatBox label="Clusters Found"     value={String(data?.clustersFound ?? 0)} />
            <StatBox label="Tight Clusters (≤ window)" value={String(tightClusters)} />
            <div className="rounded-sm border border-border bg-background px-4 py-3">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Time Window</div>
              <select
                className="mt-1 w-full bg-transparent text-lg font-bold outline-none"
                value={maxSpreadMinutes}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxSpreadMinutes(v);
                  void fetchClusters(v);
                }}
              >
                <option value={15}>15 min</option>
                <option value={60}>1 hour</option>
                <option value={240}>4 hours</option>
                <option value={1440}>24 hours</option>
              </select>
            </div>
          </section>

          {data?.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Error: {data.error}
            </div>
          )}

          {!loading && data?.ok && clusters.length === 0 && (
            <div className="rounded-md border border-border bg-background px-5 py-8 text-center text-sm text-muted-foreground">
              {data.note ?? "No funding clusters found yet."}
            </div>
          )}

          {clusters.length > 0 && (
            <div className="space-y-4">
              {clusters.map((c) => (
                <div key={c.firstFunder} className="rounded-md border border-border bg-surface">
                  <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide flex items-center gap-2">
                        Cluster · {c.walletCount} wallets
                        {c.fundedWithinWindow && (
                          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-semibold text-primary">
                            HIGH CONFIDENCE
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        Funded {timeAgo(c.earliestFundedAt)} → {timeAgo(c.latestFundedAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[10px] text-amber-400/80">
                      Funder: {short(c.firstFunder)}
                      <CopyBtn value={c.firstFunder} />
                      <a
                        href={solscanUrl(c.firstFunder)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary/70 hover:text-primary"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                          <th className="px-4 py-2 text-left font-medium">Wallet</th>
                          <th className="px-4 py-2 text-center font-medium">Copy</th>
                          <th className="px-4 py-2 text-left font-medium">Classification</th>
                          <th className="px-4 py-2 text-right font-medium">Solscan</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {c.wallets.map((w) => (
                          <tr key={w.address} className="hover:bg-surface-2 transition-colors">
                            <td className="px-4 py-2.5 font-mono text-[11px]">{short(w.address)}</td>
                            <td className="px-4 py-2.5 text-center">
                              <CopyBtn value={w.address} />
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                style={{
                                  color: classificationColor(w.classification),
                                  backgroundColor: `color-mix(in oklch, ${classificationColor(w.classification)} 15%, transparent)`,
                                }}
                              >
                                {w.classification}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <a
                                href={solscanUrl(w.address)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary/70 hover:text-primary"
                              >
                                <ExternalLink className="size-3" />
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
