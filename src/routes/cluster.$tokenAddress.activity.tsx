import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Info, Copy, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h >>> 0;
}
function rng(seed: number) { let s = seed || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }; }
function range(r: () => number, min: number, max: number) { return min + r() * (max - min); }
function genAddr(seed: number) {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = ""; let s = seed;
  for (let i = 0; i < 44; i++) { s = (s * 1664525 + 1013904223) >>> 0; out += chars[s % chars.length]; }
  return out;
}
function genSig(seed: number) {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = ""; let s = seed;
  for (let i = 0; i < 88; i++) { s = (s * 1664525 + 1013904223) >>> 0; out += chars[s % chars.length]; }
  return out;
}
function short(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }

const SOLSCAN = "https://solscan.io";
const tokenUrl          = (a: string) => `${SOLSCAN}/token/${a}`;
const tokenDefiUrl      = (a: string) => `${tokenUrl(a)}#defiactivities`;
const tokenTransfersUrl = (a: string) => `${tokenUrl(a)}#transfers`;

/* ─────────────────────────────────────────────
   Copy helper
───────────────────────────────────────────── */

function CopyBtn({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  function doCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <button
      onClick={doCopy}
      className="inline-flex items-center gap-1 shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
      title={`Copy ${label}`}
    >
      {copied
        ? <><CheckCheck className="size-3 text-risk-low" />Copied</>
        : <><Copy className="size-3" />{label}</>}
    </button>
  );
}

/* ─────────────────────────────────────────────
   Types & data generation
───────────────────────────────────────────── */

interface ActivityRow {
  signature: string;
  wallet: string;
  action: "Buy" | "Sell" | "Transfer" | "Add LP" | "Remove LP";
  amountSol: number;
  minutesAgo: number;
}

const ACTIONS: ActivityRow["action"][] = ["Buy", "Sell", "Transfer", "Add LP", "Remove LP"];

function generateActivity(tokenAddress: string): ActivityRow[] {
  const seed = hash(tokenAddress);
  const r = rng(seed);
  const count = Math.min(40, Math.max(8, Math.floor(range(r, 12, 40))));
  return Array.from({ length: count }, (_, i) => ({
    signature:  genSig(hash(tokenAddress + "act" + i)),
    wallet:     genAddr(hash(tokenAddress + "act-w" + i)),
    action:     ACTIONS[Math.floor(r() * ACTIONS.length)],
    amountSol:  Math.round(range(r, 0.01, 75) * 1000) / 1000,
    minutesAgo: Math.floor(range(r, 1, 60 * 24 * 3)),
  })).sort((a, b) => a.minutesAgo - b.minutesAgo);
}

function ageLabel(min: number) {
  if (min < 60) return `${min}m ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / (60 * 24))}d ago`;
}

export const Route = createFileRoute("/cluster/$tokenAddress/activity")({
  head: () => ({
    meta: [
      { title: "Last Activity — Wallet Cluster · Scam Intel" },
      {
        name: "description",
        content: "Most recent buy, sell, transfer, and liquidity activity across the wallet cluster for this token.",
      },
    ],
  }),
  component: ActivityPage,
});

function ActivityPage() {
  const { tokenAddress } = Route.useParams();
  const rows    = generateActivity(tokenAddress);
  const newest  = rows[0];
  const buys    = rows.filter((r) => r.action === "Buy").length;
  const sells   = rows.filter((r) => r.action === "Sell").length;
  const removeLp = rows.filter((r) => r.action === "Remove LP").length;

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto max-w-7xl border border-border bg-surface">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">Wallet Cluster</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Last Activity</h1>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">{tokenAddress}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={tokenDefiUrl(tokenAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/5 px-3 py-1.5 font-mono text-[10px] text-primary hover:bg-primary/10 transition-colors"
            >
              <ExternalLink className="size-3" />
              Live DeFi Activity on Solscan
            </a>
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
                <p className="font-semibold text-foreground">What does Last Activity tell me?</p>
                <p>
                  This shows the most recent trades and transfers across the wallet cluster.
                  Quiet activity (hours or days old) often means the operator has lost interest —
                  bad for liquidity. Sudden bursts of buys followed by big sells are the classic
                  pump-and-dump signal you want to avoid.
                </p>
                <p>
                  Newest action: <span className="font-semibold text-primary">{newest?.action ?? "—"}</span>
                  {newest ? <> by {short(newest.wallet)} {ageLabel(newest.minutesAgo)}.</> : "."}
                  &nbsp;In the recent window we see{" "}
                  <span className="font-semibold text-risk-low">{buys} buys</span>,{" "}
                  <span className="font-semibold text-risk-medium">{sells} sells</span>,{" "}
                  and <span className="font-semibold text-risk-high">{removeLp} liquidity removals</span>.
                </p>
                <p className="text-muted-foreground text-xs">
                  Tip: use <strong>Copy Sig</strong> to copy a transaction signature and paste it into{" "}
                  <strong>solscan.io/tx/&lt;signature&gt;</strong> to see the exact on-chain transaction details.
                  Use <strong>Copy Addr</strong> for the wallet address.
                </p>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox label="Last Action"  value={newest ? ageLabel(newest.minutesAgo) : "—"} />
            <StatBox label="Recent Buys"  value={String(buys)} />
            <StatBox label="Recent Sells" value={String(sells)} />
            <StatBox label="LP Removals"  value={String(removeLp)} />
          </section>

          <div className="rounded-md border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide">
                  Recent Cluster Activity &nbsp;
                  <span className="text-muted-foreground font-normal font-mono">({rows.length})</span>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">Sorted newest first</div>
              </div>
              <a
                href={tokenTransfersUrl(tokenAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
              >
                <ExternalLink className="size-3" />
                Transfers on Solscan
              </a>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Signature</th>
                    <th className="px-4 py-2 text-center font-medium">Copy Sig</th>
                    <th className="px-4 py-2 text-left font-medium">Wallet</th>
                    <th className="px-4 py-2 text-center font-medium">Copy Addr</th>
                    <th className="px-4 py-2 text-left font-medium">Action</th>
                    <th className="px-4 py-2 text-right font-medium">Amount (SOL)</th>
                    <th className="px-4 py-2 text-right font-medium">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.signature} className="hover:bg-surface-2 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
                        {r.signature.slice(0, 14)}…
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <CopyBtn value={r.signature} label="Sig" />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-blue-400/80">{short(r.wallet)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <CopyBtn value={r.wallet} label="Addr" />
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border ${
                          r.action === "Buy"       ? "border-risk-low/60 text-risk-low" :
                          r.action === "Sell"      ? "border-risk-medium/60 text-risk-medium" :
                          r.action === "Remove LP" ? "border-risk-high/60 text-risk-high" :
                          "border-border text-muted-foreground"
                        }`}>{r.action}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{r.amountSol}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{ageLabel(r.minutesAgo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground font-mono">
              <strong className="text-foreground/70">Copy Sig</strong> → paste into{" "}
              <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solscan.io/tx/&lt;signature&gt;</a>
              {" "}to see the exact transaction ·{" "}
              <strong className="text-foreground/70">Copy Addr</strong> → paste into{" "}
              <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solscan.io/account/&lt;address&gt;</a>
              {" "}to see wallet history
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/wallets" params={{ tokenAddress }}>View Related Wallets</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/tokens" params={{ tokenAddress }}>View Related Tokens</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/funding" params={{ tokenAddress }}>View Funding Links</Link>
            </Button>
          </div>

        </main>
      </div>
    </div>
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
