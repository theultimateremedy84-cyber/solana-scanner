import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Info, Copy, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

/* Deterministic helpers (self-contained) */
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
const tokenTransfersUrl = (a: string) => `${tokenUrl(a)}#transfers`;
const tokenHoldersUrl   = (a: string) => `${tokenUrl(a)}#holders`;

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

interface FundingLink {
  signature: string;
  fromWallet: string;
  toWallet: string;
  amountSol: number;
  hopDepth: number;
  daysAgo: number;
  exchange: string | null;
}

const EXCHANGES = ["Binance Hot Wallet", "Coinbase", "Kraken", "Kucoin", "OKX", "Bybit", "Direct P2P", null];

function generateFundingLinks(tokenAddress: string): FundingLink[] {
  const seed = hash(tokenAddress);
  const r = rng(seed);
  const count = Math.min(20, Math.max(3, Math.floor(range(r, 4, 18))));
  return Array.from({ length: count }, (_, i) => ({
    signature:  genSig(hash(tokenAddress + "fl" + i)),
    fromWallet: genAddr(hash(tokenAddress + "fl-from" + i)),
    toWallet:   genAddr(hash(tokenAddress + "fl-to" + i)),
    amountSol:  Math.round(range(r, 0.5, 200) * 100) / 100,
    hopDepth:   1 + Math.floor(r() * 4),
    daysAgo:    Math.floor(range(r, 0, 90)),
    exchange:   EXCHANGES[Math.floor(r() * EXCHANGES.length)],
  }));
}

export const Route = createFileRoute("/cluster/$tokenAddress/funding")({
  head: () => ({
    meta: [
      { title: "Funding Links — Wallet Cluster · Scam Intel" },
      {
        name: "description",
        content:
          "Trace where the SOL that funded this cluster came from — exchange hot wallets, hop depth, amounts, and timing.",
      },
    ],
  }),
  component: FundingLinksPage,
});

function FundingLinksPage() {
  const { tokenAddress } = Route.useParams();
  const links = generateFundingLinks(tokenAddress);
  const fromExchange = links.filter((l) => l.exchange).length;
  const totalSol = Math.round(links.reduce((s, l) => s + l.amountSol, 0));

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto max-w-7xl border border-border bg-surface">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">Wallet Cluster</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Funding Links</h1>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">{tokenAddress}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={tokenTransfersUrl(tokenAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/5 px-3 py-1.5 font-mono text-[10px] text-primary hover:bg-primary/10 transition-colors"
            >
              <ExternalLink className="size-3" />
              Live Transfers on Solscan
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
                <p className="font-semibold text-foreground">What are Funding Links?</p>
                <p>
                  This is a money trail: every SOL transfer that put the cluster wallets in business.
                  We trace it back through up to a few hops to see if the funds came from a known
                  centralized exchange (a hint about the operator&apos;s identity) or from another
                  anonymous wallet (a hint that they&apos;re trying to hide).
                </p>
                <p>
                  We found <span className="font-semibold text-primary">{links.length} funding transfers</span>{" "}
                  totalling <span className="font-semibold text-primary">~{totalSol} SOL</span>,
                  of which <span className="font-semibold text-amber-400">{fromExchange}</span> came directly
                  from an exchange hot wallet. Heavy direct-exchange funding usually means the operator is
                  topping up wallets in real time — a common sign of a coordinated launch.
                </p>
                <p className="text-muted-foreground text-xs">
                  Tip: use <strong>Copy Sig</strong> to copy a transaction signature and paste it into{" "}
                  <strong>solscan.io/tx/&lt;signature&gt;</strong> to view the exact transaction.
                  Use <strong>Copy Addr</strong> to look up a wallet at <strong>solscan.io/account/&lt;address&gt;</strong>.
                </p>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBox label="Total Funding Links" value={String(links.length)} />
            <StatBox label="Total SOL Routed"    value={`${totalSol} SOL`} />
            <StatBox label="From Exchanges"       value={String(fromExchange)} />
          </section>

          <div className="rounded-md border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide">Funding Transfer Trail</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">Source → cluster wallet, with hop depth and origin hint</div>
              </div>
              <a
                href={tokenHoldersUrl(tokenAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
              >
                <ExternalLink className="size-3" />
                Holders on Solscan
              </a>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Signature</th>
                    <th className="px-4 py-2 text-center font-medium">Copy Sig</th>
                    <th className="px-4 py-2 text-left font-medium">From</th>
                    <th className="px-4 py-2 text-center font-medium">Copy Addr</th>
                    <th className="px-4 py-2 text-left font-medium">To</th>
                    <th className="px-4 py-2 text-center font-medium">Copy Addr</th>
                    <th className="px-4 py-2 text-right font-medium">Amount (SOL)</th>
                    <th className="px-4 py-2 text-center font-medium">Hops</th>
                    <th className="px-4 py-2 text-left font-medium">Origin</th>
                    <th className="px-4 py-2 text-right font-medium">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {links.map((l) => (
                    <tr key={l.signature} className="hover:bg-surface-2 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
                        {l.signature.slice(0, 14)}…
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <CopyBtn value={l.signature} label="Sig" />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-amber-400/80">{short(l.fromWallet)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <CopyBtn value={l.fromWallet} label="Addr" />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-blue-400/80">{short(l.toWallet)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <CopyBtn value={l.toWallet} label="Addr" />
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{l.amountSol}</td>
                      <td className="px-4 py-2.5 text-center font-mono">{l.hopDepth}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {l.exchange
                          ? <span className="text-amber-400/80">{l.exchange}</span>
                          : <span className="text-muted-foreground/70 italic">Unknown wallet</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {l.daysAgo === 0 ? "today" : `${l.daysAgo}d ago`}
                      </td>
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
              {" "}to see the wallet
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
              <Link to="/cluster/$tokenAddress/activity" params={{ tokenAddress }}>View Last Activity</Link>
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
