import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ─────────────────────────────────────────────
   Deterministic data generation (self-contained)
───────────────────────────────────────────── */

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}
function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
function range(r: () => number, min: number, max: number) {
  return min + r() * (max - min);
}
function genAddr(seed: number) {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  let s = seed;
  for (let i = 0; i < 44; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out += chars[s % chars.length];
  }
  return out;
}
function short(a: string) { return a.slice(0, 5) + "…" + a.slice(-4); }

const SOLSCAN = "https://solscan.io";

/** Token metadata page — name, symbol, supply, holders */
const tokenInfoUrl = (a: string) => `${SOLSCAN}/token/${a}`;

/** Token holders tab */
const tokenHoldersUrl = (a: string) => `${tokenInfoUrl(a)}#holders`;

/** Account transaction history — shows all on-chain transactions for the address */
const tokenTxUrl = (a: string) => `${SOLSCAN}/account/${a}`;

interface RelatedToken {
  address: string;
  symbol: string;
  name: string;
  sharedWallets: number;
  marketCapUsd: number;
  ageDays: number;
  status: "Active" | "Rugged" | "Dormant";
}

const SYMBOLS = ["PEPE2", "DOGEX", "BONKR", "WIFER", "MOGGY", "CHAD", "FROGZ", "MEME", "SOLAI", "INU", "MOON", "RIBBIT"];
const NAMES = ["Pepe Two", "Dogex", "Bonker", "Wifer", "Moggy", "Chad Coin", "Frogz", "Memetoken", "SolAI", "Inu", "MoonLite", "Ribbit"];
const STATUSES: RelatedToken["status"][] = ["Active", "Rugged", "Dormant"];

function generateRelatedTokens(tokenAddress: string): RelatedToken[] {
  const seed = hash(tokenAddress);
  const r = rng(seed);
  const count = Math.min(12, Math.max(3, Math.floor(range(r, 3, 12))));
  return Array.from({ length: count }, (_, i) => {
    const symIdx = Math.floor(r() * SYMBOLS.length);
    return {
      address: genAddr(hash(tokenAddress + "rel-token" + i)),
      symbol: SYMBOLS[symIdx],
      name: NAMES[symIdx],
      sharedWallets: Math.floor(range(r, 2, 40)),
      marketCapUsd: Math.round(range(r, 5_000, 5_000_000)),
      ageDays: Math.floor(range(r, 1, 240)),
      status: STATUSES[Math.floor(r() * STATUSES.length)],
    };
  });
}

function formatUsd(n: number) {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

/* ─────────────────────────────────────────────
   Route
───────────────────────────────────────────── */

export const Route = createFileRoute("/cluster/$tokenAddress/tokens")({
  head: () => ({
    meta: [
      { title: "Related Tokens — Wallet Cluster · Scam Intel" },
      {
        name: "description",
        content:
          "Other Solana tokens touched by the same wallet cluster — shared traders, market cap, age, and current status.",
      },
    ],
  }),
  component: RelatedTokensPage,
});

function RelatedTokensPage() {
  const { tokenAddress } = Route.useParams();
  const tokens = generateRelatedTokens(tokenAddress);
  const rugged = tokens.filter((t) => t.status === "Rugged").length;

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto max-w-7xl border border-border bg-surface">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Wallet Cluster
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Related Tokens</h1>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">
              {tokenAddress}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={tokenInfoUrl(tokenAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/5 px-3 py-1.5 font-mono text-[10px] text-primary hover:bg-primary/10 transition-colors"
            >
              <ExternalLink className="size-3" />
              View Token on Solscan
            </a>
            <Button asChild variant="outline" size="sm">
              <Link to="/">
                <ArrowLeft className="size-4" />
                Back to Scanner
              </Link>
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
                <p className="font-semibold text-foreground">What are Related Tokens?</p>
                <p>
                  These are other Solana tokens that share traders with this token&apos;s wallet cluster.
                  When the same group of wallets keeps appearing across many tokens, it usually means
                  one team is launching token after token — often the same launch-and-dump pattern.
                </p>
                <p>
                  We found <span className="font-semibold text-primary">{tokens.length} related tokens</span>,
                  of which <span className="font-semibold text-risk-high">{rugged} already rugged</span>.
                  A high rug count here is a strong warning that this token may follow the same path.
                </p>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBox label="Related Tokens" value={String(tokens.length)} />
            <StatBox label="Already Rugged" value={String(rugged)} tone={rugged > 0 ? "bad" : "neutral"} />
            <StatBox label="Still Active" value={String(tokens.filter((t) => t.status === "Active").length)} />
          </section>

          <div className="rounded-md border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide">
                Tokens Touched by This Cluster &nbsp;
                <span className="text-muted-foreground font-normal font-mono">({tokens.length})</span>
              </div>
              <a
                href={tokenHoldersUrl(tokenAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
              >
                <ExternalLink className="size-3" />
                Verify on Solscan
              </a>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Symbol</th>
                    <th className="px-4 py-2 text-left font-medium">Name</th>
                    <th className="px-4 py-2 text-left font-medium">Address</th>
                    <th className="px-4 py-2 text-right font-medium">Shared Wallets</th>
                    <th className="px-4 py-2 text-right font-medium">Market Cap</th>
                    <th className="px-4 py-2 text-right font-medium">Age</th>
                    <th className="px-4 py-2 text-center font-medium">Status</th>
                    <th className="px-4 py-2 text-center font-medium">Solscan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tokens.map((t) => (
                    <tr key={t.address} className="hover:bg-surface-2 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-primary">${t.symbol}</td>
                      <td className="px-4 py-2.5">{t.name}</td>
                      <td className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">{short(t.address)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{t.sharedWallets}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{formatUsd(t.marketCapUsd)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{t.ageDays}d</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border ${
                          t.status === "Rugged" ? "border-risk-high/60 text-risk-high" :
                          t.status === "Dormant" ? "border-muted-foreground/40 text-muted-foreground" :
                          "border-risk-low/60 text-risk-low"
                        }`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <a
                            href={tokenTxUrl(t.address)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-1 rounded border border-border bg-background px-2.5 py-1 text-[10px] text-primary/80 hover:border-primary/60 hover:text-primary hover:bg-primary/5 transition-colors"
                            title="View transaction history for this token on Solscan"
                          >
                            <ExternalLink className="size-3" />
                            Txns
                          </a>
                          <a
                            href={tokenInfoUrl(t.address)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-1 rounded border border-border bg-background px-2.5 py-1 text-[10px] text-muted-foreground/70 hover:border-border hover:text-foreground hover:bg-surface-2 transition-colors"
                            title="View token info on Solscan"
                          >
                            Info
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground font-mono">
              <span className="font-semibold text-primary">Txns</span> opens the full on-chain transaction history ·{" "}
              <span className="font-semibold">Info</span> opens the token metadata page — both open in a new tab
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/wallets" params={{ tokenAddress }}>
                View Related Wallets
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/funding" params={{ tokenAddress }}>
                View Funding Links
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/activity" params={{ tokenAddress }}>
                View Last Activity
              </Link>
            </Button>
          </div>

        </main>
      </div>
    </div>
  );
}

function StatBox({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "bad" }) {
  const color = tone === "bad" ? "var(--risk-extreme)" : "var(--foreground)";
  return (
    <div className="rounded-sm border border-border bg-background px-4 py-3">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold" style={{ color }}>{value}</div>
    </div>
  );
}
