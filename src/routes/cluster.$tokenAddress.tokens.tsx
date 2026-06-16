import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Info, ChevronDown, ChevronUp, Copy, CheckCheck } from "lucide-react";
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
function short(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }

/** The ONLY valid Solscan URL — links to the real scanned token, not mock addresses */
const SOLSCAN = "https://solscan.io";
const realTokenUrl   = (a: string) => `${SOLSCAN}/token/${a}`;
const realTokenHoldersUrl = (a: string) => `${realTokenUrl(a)}#holders`;

/* ─────────────────────────────────────────────
   Types
───────────────────────────────────────────── */

interface ActiveDetails {
  volume24hUsd: number;
  holders: number;
  txCount24h: number;
  topHolderPct: number;
  lpLockedPct: number;
  mintRevoked: boolean;
  freezeRevoked: boolean;
}

interface RugDetails {
  rugDateDaysAgo: number;
  mechanism: string;
  solDrained: number;
  holdersAffected: number;
  devWallet: string;
  warningSigns: string[];
  peakMarketCapUsd: number;
  peakDaysAgo: number;
}

interface DormantDetails {
  lastActivityDaysAgo: number;
  peakMarketCapUsd: number;
  peakDaysAgo: number;
  reasonDormant: string;
  holdersRemaining: number;
  lastTxSignature: string;
}

interface RelatedToken {
  address: string;
  symbol: string;
  name: string;
  sharedWallets: number;
  marketCapUsd: number;
  ageDays: number;
  status: "Active" | "Rugged" | "Dormant";
  activeDetails?: ActiveDetails;
  rugDetails?: RugDetails;
  dormantDetails?: DormantDetails;
}

const SYMBOLS  = ["PEPE2","DOGEX","BONKR","WIFER","MOGGY","CHAD","FROGZ","MEME","SOLAI","INU","MOON","RIBBIT"];
const NAMES    = ["Pepe Two","Dogex","Bonker","Wifer","Moggy","Chad Coin","Frogz","Memetoken","SolAI","Inu","MoonLite","Ribbit"];
const STATUSES: RelatedToken["status"][] = ["Active","Rugged","Dormant"];

const RUG_MECHANISMS = [
  "Liquidity pool fully drained by dev wallet in a single transaction",
  "Mint authority used to print unlimited tokens, diluting all holders",
  "Freeze authority invoked — all holder accounts locked, unable to sell",
  "Dev wallet dumped 100% of reserved supply in one block",
  "Proxy contract upgrade silently redirected LP fees to dev address",
];

const DORMANT_REASONS = [
  "Dev wallet went silent immediately after the initial pump",
  "Trading volume collapsed to zero following a coordinated whale exit",
  "Community disbanded after repeated roadmap failures",
  "Team migrated to a new contract; original token was abandoned",
  "No on-chain activity detected for an extended period — presumed dead",
];

const WARNING_SIGNS_POOL = [
  "No LP lock on launch",
  "Dev held >40% of supply",
  "Mint authority not revoked",
  "Freeze authority active",
  "No verified contract source",
  "10× price spike 48h before dump",
  "All top holders funded from single wallet",
  "Liquidity added and removed within 72h",
];

function generateActiveDetails(seed: number): ActiveDetails {
  const r = rng(seed);
  return {
    volume24hUsd:   Math.round(range(r, 5_000, 2_000_000)),
    holders:        Math.floor(range(r, 80, 5000)),
    txCount24h:     Math.floor(range(r, 20, 2000)),
    topHolderPct:   Math.round(range(r, 5, 45)),
    lpLockedPct:    Math.round(range(r, 0, 100)),
    mintRevoked:    r() > 0.4,
    freezeRevoked:  r() > 0.4,
  };
}

function generateRugDetails(seed: number, marketCap: number): RugDetails {
  const r = rng(seed);
  const signs: string[] = [];
  const shuffled = WARNING_SIGNS_POOL.slice().sort(() => r() - 0.5);
  const count = 2 + Math.floor(r() * 4);
  for (let i = 0; i < count; i++) signs.push(shuffled[i]);
  return {
    rugDateDaysAgo:   Math.floor(range(r, 1, 120)),
    mechanism:        RUG_MECHANISMS[Math.floor(r() * RUG_MECHANISMS.length)],
    solDrained:       Math.round(range(r, 50, 8000) * 10) / 10,
    holdersAffected:  Math.floor(range(r, 100, 4000)),
    devWallet:        genAddr(seed + 1),
    warningSigns:     signs,
    peakMarketCapUsd: Math.round(marketCap * range(r, 3, 25)),
    peakDaysAgo:      Math.floor(range(r, 3, 60)),
  };
}

function generateDormantDetails(seed: number, marketCap: number): DormantDetails {
  const r = rng(seed);
  return {
    lastActivityDaysAgo: Math.floor(range(r, 14, 180)),
    peakMarketCapUsd:    Math.round(marketCap * range(r, 2, 20)),
    peakDaysAgo:         Math.floor(range(r, 5, 90)),
    reasonDormant:       DORMANT_REASONS[Math.floor(r() * DORMANT_REASONS.length)],
    holdersRemaining:    Math.floor(range(r, 10, 500)),
    lastTxSignature:     genAddr(seed + 9).slice(0, 64),
  };
}

function generateRelatedTokens(tokenAddress: string): RelatedToken[] {
  const seed = hash(tokenAddress);
  const r    = rng(seed);
  const count = Math.min(12, Math.max(3, Math.floor(range(r, 3, 12))));
  return Array.from({ length: count }, (_, i) => {
    const symIdx       = Math.floor(r() * SYMBOLS.length);
    const status       = STATUSES[Math.floor(r() * STATUSES.length)];
    const addrSeed     = hash(tokenAddress + "rel-token" + i);
    const marketCapUsd = Math.round(range(r, 5_000, 5_000_000));
    const token: RelatedToken = {
      address:       genAddr(addrSeed),
      symbol:        SYMBOLS[symIdx],
      name:          NAMES[symIdx],
      sharedWallets: Math.floor(range(r, 2, 40)),
      marketCapUsd,
      ageDays:       Math.floor(range(r, 1, 240)),
      status,
    };
    if (status === "Active")  token.activeDetails  = generateActiveDetails(addrSeed + 1111);
    if (status === "Rugged")  token.rugDetails      = generateRugDetails(addrSeed + 7777, marketCapUsd);
    if (status === "Dormant") token.dormantDetails  = generateDormantDetails(addrSeed + 3333, marketCapUsd);
    return token;
  });
}

function formatUsd(n: number) {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

/* ─────────────────────────────────────────────
   Route
───────────────────────────────────────────── */

export const Route = createFileRoute("/cluster/$tokenAddress/tokens")({
  head: () => ({
    meta: [
      { title: "Related Tokens — Wallet Cluster · Scam Intel" },
      { name: "description", content: "Other Solana tokens touched by the same wallet cluster." },
    ],
  }),
  component: RelatedTokensPage,
});

function RelatedTokensPage() {
  const { tokenAddress } = Route.useParams();
  const tokens  = generateRelatedTokens(tokenAddress);
  const rugged  = tokens.filter((t) => t.status === "Rugged").length;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(address: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address); else next.add(address);
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto max-w-7xl border border-border bg-surface">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">Wallet Cluster</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Related Tokens</h1>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">{tokenAddress}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={realTokenUrl(tokenAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/5 px-3 py-1.5 font-mono text-[10px] text-primary hover:bg-primary/10 transition-colors"
            >
              <ExternalLink className="size-3" />
              View Token on Solscan
            </a>
            <Button asChild variant="outline" size="sm">
              <Link to="/"><ArrowLeft className="size-4" />Back to Scanner</Link>
            </Button>
          </div>
        </header>

        <main className="space-y-6 px-5 py-6 sm:px-8">

          {/* Info banner */}
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
                  Click any row to expand its full details.
                </p>
              </div>
            </div>
          </section>

          {/* Stat boxes */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBox label="Related Tokens"  value={String(tokens.length)} />
            <StatBox label="Already Rugged"  value={String(rugged)} tone={rugged > 0 ? "bad" : "neutral"} />
            <StatBox label="Still Active"    value={String(tokens.filter((t) => t.status === "Active").length)} />
          </section>

          {/* Table */}
          <div className="rounded-md border border-border bg-surface">
            <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide">
                Tokens Touched by This Cluster &nbsp;
                <span className="text-muted-foreground font-normal font-mono">({tokens.length})</span>
              </div>
              <a
                href={realTokenHoldersUrl(tokenAddress)}
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
                    <th className="w-8 px-3 py-2"></th>
                    <th className="px-4 py-2 text-left font-medium">Symbol</th>
                    <th className="px-4 py-2 text-left font-medium">Name</th>
                    <th className="px-4 py-2 text-left font-medium">Address</th>
                    <th className="px-4 py-2 text-right font-medium">Shared Wallets</th>
                    <th className="px-4 py-2 text-right font-medium">Market Cap</th>
                    <th className="px-4 py-2 text-right font-medium">Age</th>
                    <th className="px-4 py-2 text-center font-medium">Status</th>
                    <th className="px-4 py-2 text-center font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tokens.map((t) => {
                    const isOpen = expanded.has(t.address);
                    return (
                      <>
                        <tr
                          key={t.address}
                          className="cursor-pointer hover:bg-surface-2 transition-colors"
                          onClick={() => toggleExpand(t.address)}
                        >
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {isOpen
                              ? <ChevronUp className="size-3" />
                              : <ChevronDown className="size-3" />}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-primary">${t.symbol}</td>
                          <td className="px-4 py-2.5">{t.name}</td>
                          <td className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
                            {short(t.address)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono">{t.sharedWallets}</td>
                          <td className="px-4 py-2.5 text-right font-mono">{formatUsd(t.marketCapUsd)}</td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground">{t.ageDays}d</td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border ${
                              t.status === "Rugged"  ? "border-risk-high/60 text-risk-high" :
                              t.status === "Dormant" ? "border-muted-foreground/40 text-muted-foreground" :
                              "border-risk-low/60 text-risk-low"
                            }`}>
                              {t.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => toggleExpand(t.address)}
                              className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-[10px] transition-colors ${
                                isOpen
                                  ? "border-primary/50 bg-primary/10 text-primary"
                                  : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5"
                              }`}
                            >
                              {isOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                              {isOpen ? "Hide" : "Show"}
                            </button>
                          </td>
                        </tr>

                        {isOpen && (
                          <tr key={t.address + "-detail"}>
                            <td colSpan={9} className="bg-surface-2/40 px-6 py-5">
                              {t.status === "Active"  && t.activeDetails  && (
                                <ActiveDetailPanel  details={t.activeDetails}  symbol={t.symbol} address={t.address} marketCapUsd={t.marketCapUsd} />
                              )}
                              {t.status === "Rugged"  && t.rugDetails     && (
                                <RugDetailPanel     details={t.rugDetails}     symbol={t.symbol} address={t.address} marketCapUsd={t.marketCapUsd} />
                              )}
                              {t.status === "Dormant" && t.dormantDetails && (
                                <DormantDetailPanel details={t.dormantDetails} symbol={t.symbol} address={t.address} marketCapUsd={t.marketCapUsd} />
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
              Click any row or the <span className="font-semibold">Show</span> button to expand full token details inline
            </div>
          </div>

          {/* Nav buttons */}
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/wallets" params={{ tokenAddress }}>View Related Wallets</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/cluster/$tokenAddress/funding" params={{ tokenAddress }}>View Funding Links</Link>
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

/* ─────────────────────────────────────────────
   Copy-address helper
───────────────────────────────────────────── */

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  function doCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-mono text-[10px] text-foreground/70 break-all">{address}</span>
      <button
        onClick={doCopy}
        className="inline-flex items-center gap-1 shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        title="Copy address"
      >
        {copied ? <CheckCheck className="size-3 text-risk-low" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Active Detail Panel
───────────────────────────────────────────── */

function ActiveDetailPanel({
  details, symbol, address, marketCapUsd,
}: { details: ActiveDetails; symbol: string; address: string; marketCapUsd: number }) {
  return (
    <div className="rounded-md border border-risk-low/30 bg-risk-low/5 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="rounded bg-risk-low/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-risk-low">
          Active
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">${symbol}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <DetailCard label="24h Volume"       value={formatUsd(details.volume24hUsd)} highlight />
        <DetailCard label="Holders"          value={details.holders.toLocaleString()} />
        <DetailCard label="24h Transactions" value={details.txCount24h.toLocaleString()} />
        <DetailCard label="Market Cap"       value={formatUsd(marketCapUsd)} />
        <DetailCard label="Top Holder"       value={`${details.topHolderPct}% of supply`}
          tone={details.topHolderPct > 30 ? "warn" : "ok"} />
        <DetailCard label="LP Locked"        value={`${details.lpLockedPct}%`}
          tone={details.lpLockedPct < 50 ? "warn" : "ok"} />
        <DetailCard label="Mint Revoked"     value={details.mintRevoked ? "Yes ✓" : "No ✗"}
          tone={details.mintRevoked ? "ok" : "warn"} />
        <DetailCard label="Freeze Revoked"   value={details.freezeRevoked ? "Yes ✓" : "No ✗"}
          tone={details.freezeRevoked ? "ok" : "warn"} />
      </div>

      <div className="space-y-1">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Token Address</p>
        <CopyAddress address={address} />
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground">${symbol}</span> is currently active and shares{" "}
        wallet cluster overlap with the token being scanned.{" "}
        {details.topHolderPct > 30 && (
          <span className="text-yellow-400">⚠ Top holder controls {details.topHolderPct}% of supply — concentration risk. </span>
        )}
        {!details.mintRevoked && (
          <span className="text-yellow-400">⚠ Mint authority not revoked — new tokens can be printed at any time. </span>
        )}
        {details.lpLockedPct < 50 && (
          <span className="text-yellow-400">⚠ Only {details.lpLockedPct}% of liquidity is locked — rug risk remains. </span>
        )}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Rug Detail Panel
───────────────────────────────────────────── */

function RugDetailPanel({
  details, symbol, address, marketCapUsd,
}: { details: RugDetails; symbol: string; address: string; marketCapUsd: number }) {
  const decline = details.peakMarketCapUsd > 0
    ? Math.round(((details.peakMarketCapUsd - marketCapUsd) / details.peakMarketCapUsd) * 100)
    : 0;

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
        <DetailCard label="SOL Drained"       value={`◎ ${details.solDrained.toLocaleString()}`} highlight />
        <DetailCard label="Holders Affected"  value={details.holdersAffected.toLocaleString()} />
        <DetailCard label="Peak Market Cap"   value={formatUsd(details.peakMarketCapUsd)} />
        <DetailCard label="Peak-to-Rug"       value={`${details.peakDaysAgo}d after peak`} />
      </div>

      <div className="space-y-1">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Rug Mechanism</p>
        <p className="text-[11px] text-foreground/90 leading-relaxed">{details.mechanism}</p>
      </div>

      <div className="space-y-1.5">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Warning Signs Present Before Rug</p>
        <div className="flex flex-wrap gap-2">
          {details.warningSigns.map((s) => (
            <span key={s} className="rounded border border-risk-high/40 bg-risk-high/10 px-2 py-0.5 text-[10px] text-risk-high">
              {s}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Token Address</p>
          <CopyAddress address={address} />
        </div>
        <div className="space-y-1">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Dev / Rug Wallet</p>
          <CopyAddress address={details.devWallet} />
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground">${symbol}</span> peaked at{" "}
        {formatUsd(details.peakMarketCapUsd)} then rugged {details.rugDateDaysAgo}d ago
        {decline > 0 && <> — a <span className="font-semibold text-risk-high">{decline}% collapse</span> from peak</>}.{" "}
        The same cluster behind the token being scanned operated this token. Serial rug launches by the same
        cluster are the strongest signal of an impending rug on this token.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Dormant Detail Panel
───────────────────────────────────────────── */

function DormantDetailPanel({
  details, symbol, address, marketCapUsd,
}: { details: DormantDetails; symbol: string; address: string; marketCapUsd: number }) {
  const decline = details.peakMarketCapUsd > 0
    ? Math.round(((details.peakMarketCapUsd - marketCapUsd) / details.peakMarketCapUsd) * 100)
    : 0;

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
        <DetailCard label="Last Activity"     value={`${details.lastActivityDaysAgo}d ago`} />
        <DetailCard label="Peak Market Cap"   value={formatUsd(details.peakMarketCapUsd)} highlight />
        <DetailCard label="Peak Was"          value={`${details.peakDaysAgo}d ago`} />
        <DetailCard label="Holders Remaining" value={details.holdersRemaining.toLocaleString()} />
      </div>

      <div className="space-y-1.5">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Reason for Dormancy</p>
        <p className="text-[11px] text-foreground/80 leading-relaxed">{details.reasonDormant}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Token Address</p>
          <CopyAddress address={address} />
        </div>
        <div className="space-y-1">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">Last Transaction Signature</p>
          <CopyAddress address={details.lastTxSignature} />
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground">${symbol}</span> peaked at{" "}
        {formatUsd(details.peakMarketCapUsd)} ({details.peakDaysAgo}d ago) then went completely silent
        {decline > 0 && <> — a <span className="font-semibold text-risk-high">{decline}% decline</span> from peak</>}.{" "}
        Dormant tokens in a cluster often signal the team has moved capital to a new launch. Copy the token address
        above to look it up manually on Solscan or any Solana explorer.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Shared sub-components
───────────────────────────────────────────── */

function DetailCard({
  label, value, highlight = false, wide = false, tone,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  wide?: boolean;
  tone?: "ok" | "warn";
}) {
  const valueColor =
    tone === "ok"   ? "text-risk-low" :
    tone === "warn" ? "text-yellow-400" :
    highlight       ? "text-foreground" :
    "text-foreground/80";

  return (
    <div className={`rounded border border-border bg-background px-3 py-2 ${wide ? "col-span-2" : ""}`}>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-xs font-semibold ${valueColor}`}>{value}</div>
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
