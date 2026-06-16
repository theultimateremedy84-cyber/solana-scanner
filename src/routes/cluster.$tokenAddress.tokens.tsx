import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Info, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

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

/** Token page on Solscan — correct URL for a token mint address */
const tokenInfoUrl = (a: string) => `${SOLSCAN}/token/${a}`;

/** Token holders tab */
const tokenHoldersUrl = (a: string) => `${tokenInfoUrl(a)}#holders`;

/** Token transfers/transactions tab — correct path for mint addresses */
const tokenTxUrl = (a: string) => `${SOLSCAN}/token/${a}#transfers`;

/* ─────────────────────────────────────────────
   Types
───────────────────────────────────────────── */

interface RugDetails {
  rugDateDaysAgo: number;
  mechanism: string;
  solDrained: number;
  holdersAffected: number;
  devWallet: string;
  warningSigns: string[];
}

interface DormantDetails {
  lastActivityDaysAgo: number;
  peakMarketCapUsd: number;
  peakDaysAgo: number;
  reasonDormant: string;
  holdersRemaining: number;
}

interface RelatedToken {
  address: string;
  symbol: string;
  name: string;
  sharedWallets: number;
  marketCapUsd: number;
  ageDays: number;
  status: "Active" | "Rugged" | "Dormant";
  rugDetails?: RugDetails;
  dormantDetails?: DormantDetails;
}

const SYMBOLS = ["PEPE2", "DOGEX", "BONKR", "WIFER", "MOGGY", "CHAD", "FROGZ", "MEME", "SOLAI", "INU", "MOON", "RIBBIT"];
const NAMES = ["Pepe Two", "Dogex", "Bonker", "Wifer", "Moggy", "Chad Coin", "Frogz", "Memetoken", "SolAI", "Inu", "MoonLite", "Ribbit"];
const STATUSES: RelatedToken["status"][] = ["Active", "Rugged", "Dormant"];

const RUG_MECHANISMS = [
  "Liquidity pool drained by dev wallet",
  "Mint authority used to mint unlimited supply",
  "Freeze authority locked all holder accounts",
  "Dev wallet sold 100% of holdings in one transaction",
  "Smart contract upgrade redirected all fees to dev",
];

const DORMANT_REASONS = [
  "Dev wallet went silent after initial pump",
  "Trading volume dropped to zero following whale exit",
  "Community abandoned after failed roadmap promises",
  "Migrated to new contract — original token orphaned",
  "No on-chain activity detected for extended period",
];

const WARNING_SIGNS_POOL = [
  "No LP lock on launch",
  "Dev held >40% of supply",
  "Mint authority not revoked",
  "Freeze authority active",
  "No verified contract",
  "Sudden 10× price spike before dump",
  "All top holders funded from same wallet",
];

function generateRugDetails(seed: number): RugDetails {
  const r = rng(seed);
  const signs: string[] = [];
  const shuffled = WARNING_SIGNS_POOL.slice().sort(() => r() - 0.5);
  const count = 2 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) signs.push(shuffled[i]);
  return {
    rugDateDaysAgo: Math.floor(range(r, 1, 120)),
    mechanism: RUG_MECHANISMS[Math.floor(r() * RUG_MECHANISMS.length)],
    solDrained: Math.round(range(r, 50, 8000) * 10) / 10,
    holdersAffected: Math.floor(range(r, 100, 4000)),
    devWallet: genAddr(seed + 1),
    warningSigns: signs,
  };
}

function generateDormantDetails(seed: number, marketCap: number): DormantDetails {
  const r = rng(seed);
  return {
    lastActivityDaysAgo: Math.floor(range(r, 14, 180)),
    peakMarketCapUsd: Math.round(marketCap * range(r, 2, 20)),
    peakDaysAgo: Math.floor(range(r, 5, 90)),
    reasonDormant: DORMANT_REASONS[Math.floor(r() * DORMANT_REASONS.length)],
    holdersRemaining: Math.floor(range(r, 10, 500)),
  };
}

function generateRelatedTokens(tokenAddress: string): RelatedToken[] {
  const seed = hash(tokenAddress);
  const r = rng(seed);
  const count = Math.min(12, Math.max(3, Math.floor(range(r, 3, 12))));
  return Array.from({ length: count }, (_, i) => {
    const symIdx = Math.floor(r() * SYMBOLS.length);
    const status = STATUSES[Math.floor(r() * STATUSES.length)];
    const addrSeed = hash(tokenAddress + "rel-token" + i);
    const marketCapUsd = Math.round(range(r, 5_000, 5_000_000));
    const token: RelatedToken = {
      address: genAddr(addrSeed),
      symbol: SYMBOLS[symIdx],
      name: NAMES[symIdx],
      sharedWallets: Math.floor(range(r, 2, 40)),
      marketCapUsd,
      ageDays: Math.floor(range(r, 1, 240)),
      status,
    };
    if (status === "Rugged") token.rugDetails = generateRugDetails(addrSeed + 7777);
    if (status === "Dormant") token.dormantDetails = generateDormantDetails(addrSeed + 3333, marketCapUsd);
    return token;
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(address: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }

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
                  Click any <span className="font-semibold text-risk-high">Rugged</span> or <span className="font-semibold text-muted-foreground">Dormant</span> row to expand full details.
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
                    <th className="px-4 py-2 text-left font-medium w-4"></th>
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
                  {tokens.map((t) => {
                    const isExpandable = t.status === "Rugged" || t.status === "Dormant";
                    const isOpen = expanded.has(t.address);
                    return (
                      <>
                        <tr
                          key={t.address}
                          className={`transition-colors ${isExpandable ? "cursor-pointer hover:bg-surface-2" : "hover:bg-surface-2"}`}
                          onClick={() => isExpandable && toggleExpand(t.address)}
                        >
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {isExpandable ? (
                              isOpen
                                ? <ChevronUp className="size-3" />
                                : <ChevronDown className="size-3" />
                            ) : null}
                          </td>
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
                          <td className="px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-center gap-1.5">
                              <a
                                href={tokenTxUrl(t.address)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-1 rounded border border-border bg-background px-2.5 py-1 text-[10px] text-primary/80 hover:border-primary/60 hover:text-primary hover:bg-primary/5 transition-colors"
                                title="View transfers for this token on Solscan"
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

                        {isExpandable && isOpen && (
                          <tr key={t.address + "-detail"} className="bg-surface-2/50">
                            <td colSpan={9} className="px-6 py-4">
                              {t.status === "Rugged" && t.rugDetails && (
                                <RugDetailPanel details={t.rugDetails} symbol={t.symbol} />
                              )}
                              {t.status === "Dormant" && t.dormantDetails && (
                                <DormantDetailPanel details={t.dormantDetails} symbol={t.symbol} marketCapUsd={t.marketCapUsd} />
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground font-mono">
              Click a <span className="text-risk-high">Rugged</span> or <span className="text-muted-foreground">Dormant</span> row to expand details ·{" "}
              <span className="font-semibold text-primary">Txns</span> opens the transfers tab ·{" "}
              <span className="font-semibold">Info</span> opens token metadata — both open in a new tab
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

/* ─────────────────────────────────────────────
   Rug Detail Panel
───────────────────────────────────────────── */

function RugDetailPanel({ details, symbol }: { details: RugDetails; symbol: string }) {
  return (
    <div className="rounded-md border border-risk-high/30 bg-risk-high/5 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="rounded bg-risk-high/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-risk-high">
          Rug Confirmed
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {details.rugDateDaysAgo} day{details.rugDateDaysAgo !== 1 ? "s" : ""} ago
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <DetailCard label="SOL Drained" value={`◎ ${details.solDrained.toLocaleString()}`} highlight />
        <DetailCard label="Holders Affected" value={details.holdersAffected.toLocaleString()} />
        <DetailCard label="Rug Mechanism" value={details.mechanism} wide />
      </div>

      <div className="space-y-1.5">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Warning Signs That Were Present</p>
        <div className="flex flex-wrap gap-2">
          {details.warningSigns.map((s) => (
            <span
              key={s}
              className="rounded border border-risk-high/40 bg-risk-high/10 px-2 py-0.5 text-[10px] text-risk-high"
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Dev Wallet</p>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-foreground/70 break-all">{details.devWallet}</span>
          <a
            href={`https://solscan.io/account/${details.devWallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-primary/70 hover:text-primary transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="size-3" />
            View
          </a>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground">${symbol}</span> was rugged {details.rugDateDaysAgo} day{details.rugDateDaysAgo !== 1 ? "s" : ""} ago.{" "}
        The same wallet cluster behind this token operated <span className="font-semibold text-foreground">${symbol}</span> — this pattern of serial token launches ending in rugs is a major risk signal.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Dormant Detail Panel
───────────────────────────────────────────── */

function DormantDetailPanel({
  details,
  symbol,
  marketCapUsd,
}: {
  details: DormantDetails;
  symbol: string;
  marketCapUsd: number;
}) {
  return (
    <div className="rounded-md border border-muted-foreground/20 bg-muted/5 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="rounded bg-muted-foreground/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
          Dormant
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          No activity for {details.lastActivityDaysAgo} day{details.lastActivityDaysAgo !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <DetailCard label="Last Activity" value={`${details.lastActivityDaysAgo}d ago`} />
        <DetailCard label="Peak Market Cap" value={formatUsd(details.peakMarketCapUsd)} highlight />
        <DetailCard label="Peak Was" value={`${details.peakDaysAgo}d ago`} />
        <DetailCard label="Holders Remaining" value={details.holdersRemaining.toLocaleString()} />
      </div>

      <div className="space-y-1.5">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Reason for Dormancy</p>
        <p className="text-[11px] text-foreground/80 leading-relaxed">{details.reasonDormant}</p>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground">${symbol}</span> peaked at {formatUsd(details.peakMarketCapUsd)} ({details.peakDaysAgo}d ago) then went silent.
        Current market cap is {formatUsd(marketCapUsd)} — a{" "}
        <span className="font-semibold text-risk-high">
          {Math.round(((details.peakMarketCapUsd - marketCapUsd) / details.peakMarketCapUsd) * 100)}% decline
        </span>{" "}
        from peak. Dormant tokens in a cluster often precede a new token launch by the same team.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Shared sub-components
───────────────────────────────────────────── */

function DetailCard({
  label,
  value,
  highlight = false,
  wide = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`rounded border border-border bg-background px-3 py-2 ${wide ? "col-span-2" : ""}`}>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-xs font-semibold ${highlight ? "text-foreground" : "text-foreground/80"}`}>
        {value}
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
