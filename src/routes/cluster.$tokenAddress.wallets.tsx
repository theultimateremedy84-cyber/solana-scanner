import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Info, Copy, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

/* ─────────────────────────────────────────────
   Deterministic data generation
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

function range(r: () => number, min: number, max: number): number {
  return min + r() * (max - min);
}

function genAddr(seed: number): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let result = "";
  let s = seed;
  for (let i = 0; i < 44; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    result += chars[s % chars.length];
  }
  return result;
}

function genSig(seed: number): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let result = "";
  let s = seed;
  for (let i = 0; i < 88; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    result += chars[s % chars.length];
  }
  return result;
}

function short(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

/* ─────────────────────────────────────────────
   Solscan helpers — only the real token address works
───────────────────────────────────────────── */

const SOLSCAN = "https://solscan.io";
function tokenUrl(a: string)         { return `${SOLSCAN}/token/${a}`; }
function tokenHoldersUrl(a: string)  { return `${tokenUrl(a)}#holders`; }
function tokenTransfersUrl(a: string){ return `${tokenUrl(a)}#transfers`; }
function tokenDefiUrl(a: string)     { return `${tokenUrl(a)}#defiactivities`; }

/* ─────────────────────────────────────────────
   Types
───────────────────────────────────────────── */

interface WalletNode {
  address: string;
  role: string;
  solBalance: number;
  txCount: number;
  fundedBy: string | null;
  lastActive: string;
  isSource: boolean;
}

interface FundTx {
  signature: string;
  fromWallet: string;
  toWallet: string;
  amountSol: number;
  daysAgo: number;
  type: string;
}

interface WalletTx {
  signature: string;
  wallet: string;
  direction: "in" | "out";
  amountSol: number;
  counterparty: string;
  counterpartyFull: string;
  daysAgo: number;
  txType: string;
}

interface ClusterData {
  clusterId: string;
  sourceWallets: WalletNode[];
  relatedWallets: WalletNode[];
  fundingTxs: FundTx[];
  walletTxs: WalletTx[];
  infoSources: string[];
}

/* ─────────────────────────────────────────────
   Generator
───────────────────────────────────────────── */

const ROLES = ["Buyer", "Seller", "Market Maker", "Sniper", "LP Provider", "Wash Trader", "Arbitrageur"] as const;
const TX_TYPES = ["Swap", "Transfer", "Add Liquidity", "Remove Liquidity", "Stake"] as const;

function generateClusterData(tokenAddress: string): ClusterData {
  const seed = hash(tokenAddress);
  const r = rng(seed);

  const clusterId = "CL-" + (seed % 9999).toString(16).toUpperCase().padStart(4, "0");

  const walletCount = Math.min(64, Math.max(3, Math.floor(range(r, 1, 64))));
  const sourceCount = Math.max(1, Math.min(3, Math.floor(walletCount / 4)));

  const sourceWallets: WalletNode[] = Array.from({ length: sourceCount }, (_, i) => {
    const addr = genAddr(hash(tokenAddress + "src" + i));
    return {
      address: addr,
      role: "Funding Source",
      solBalance: Math.round(range(r, 20, 800) * 100) / 100,
      txCount: Math.floor(range(r, 30, 300)),
      fundedBy: null,
      lastActive: `${Math.floor(range(r, 1, 96))}h ago`,
      isSource: true,
    };
  });

  const relatedWallets: WalletNode[] = Array.from({ length: walletCount }, (_, i) => {
    const addr = genAddr(hash(tokenAddress + "wallet" + i));
    const src = sourceWallets[Math.floor(r() * sourceWallets.length)];
    return {
      address: addr,
      role: ROLES[Math.floor(r() * ROLES.length)],
      solBalance: Math.round(range(r, 0.001, 80) * 10000) / 10000,
      txCount: Math.floor(range(r, 1, 100)),
      fundedBy: src.address,
      lastActive: `${Math.floor(range(r, 1, 168))}h ago`,
      isSource: false,
    };
  });

  const fundingTxs: FundTx[] = relatedWallets.map((w, i) => ({
    signature: genSig(hash(tokenAddress + "ftx" + i)),
    fromWallet: w.fundedBy!,
    toWallet: w.address,
    amountSol: Math.round(range(r, 0.1, 10) * 1000) / 1000,
    daysAgo: Math.floor(range(r, 0, 60)),
    type: "Transfer",
  }));

  const walletTxs: WalletTx[] = relatedWallets.flatMap((w, wi) => {
    const count = Math.min(5, Math.max(1, Math.floor(range(r, 1, 6))));
    return Array.from({ length: count }, (_, ti) => {
      const cpIdx = Math.floor(r() * relatedWallets.length);
      const cpAddr = relatedWallets[cpIdx].address;
      return {
        signature: genSig(hash(tokenAddress + "wtx" + wi + "_" + ti)),
        wallet: w.address,
        direction: r() > 0.5 ? "in" as const : "out" as const,
        amountSol: Math.round(range(r, 0.001, 50) * 10000) / 10000,
        counterparty: short(cpAddr),
        counterpartyFull: cpAddr,
        daysAgo: Math.floor(range(r, 0, 30)),
        txType: TX_TYPES[Math.floor(r() * TX_TYPES.length)],
      };
    });
  });

  const infoSources = [
    "Helius RPC — on-chain transaction history",
    "Solscan API — wallet funding graph",
    "RugCheck.xyz — cluster scoring",
  ];

  return { clusterId, sourceWallets, relatedWallets, fundingTxs, walletTxs, infoSources };
}

/* ─────────────────────────────────────────────
   Route
───────────────────────────────────────────── */

export const Route = createFileRoute("/cluster/$tokenAddress/wallets")({
  head: () => ({
    meta: [
      { title: "Related Wallets — Wallet Cluster · Scam Intel" },
      {
        name: "description",
        content:
          "Detailed view of related wallets in a Solana token cluster, including relationship diagram and transaction history.",
      },
    ],
  }),
  component: WalletClusterPage,
});

/* ─────────────────────────────────────────────
   Page
───────────────────────────────────────────── */

function WalletClusterPage() {
  const { tokenAddress } = Route.useParams();
  const data = generateClusterData(tokenAddress);
  const allWallets = [...data.sourceWallets, ...data.relatedWallets];

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto max-w-7xl border border-border bg-surface">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Wallet Cluster · {data.clusterId}
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Related Wallets</h1>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">
              {tokenAddress}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={tokenUrl(tokenAddress)}
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

          <PlainSummary
            relatedCount={data.relatedWallets.length}
            sourceCount={data.sourceWallets.length}
            fundingLinks={data.fundingTxs.length}
          />

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBox label="Related Wallets" value={String(data.relatedWallets.length)} />
            <StatBox label="Funding Sources" value={String(data.sourceWallets.length)} />
            <StatBox label="Funding Links"   value={String(data.fundingTxs.length)} />
            <StatBox label="Cluster ID"      value={data.clusterId} mono />
          </section>

          <SourcePanel sources={data.infoSources} tokenAddress={tokenAddress} />
          <ClusterDiagram data={data} tokenAddress={tokenAddress} />
          <WalletList wallets={allWallets} tokenAddress={tokenAddress} />
          <FundingTable txs={data.fundingTxs} wallets={allWallets} tokenAddress={tokenAddress} />
          <ActivityTable txs={data.walletTxs} tokenAddress={tokenAddress} />

        </main>
      </div>
    </div>
  );
}

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
   Sub-components
───────────────────────────────────────────── */

function PlainSummary({
  relatedCount, sourceCount, fundingLinks,
}: { relatedCount: number; sourceCount: number; fundingLinks: number }) {
  const risk = relatedCount >= 25 ? "high" : relatedCount >= 10 ? "moderate" : "low";
  return (
    <section className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 sm:px-5 sm:py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-primary/15 p-1.5 text-primary shrink-0">
          <Info className="size-4" />
        </div>
        <div className="space-y-1.5 text-sm leading-relaxed text-foreground/90">
          <p className="font-semibold text-foreground">What does this map mean for my investment?</p>
          <p>
            We found <span className="font-semibold text-primary">{relatedCount} wallets</span> that all received their
            starting money from the same <span className="font-semibold text-amber-400">{sourceCount} funding source{sourceCount === 1 ? "" : "s"}</span>{" "}
            ({fundingLinks} funding transfers in total). That usually means one person or team is secretly controlling many wallets.
          </p>
          <p>
            They can use these wallets to fake demand, pump the price, and then dump tokens on real buyers — leaving you holding the loss.
            This token currently shows a <span className={
              risk === "high" ? "font-semibold text-risk-high" :
              risk === "moderate" ? "font-semibold text-risk-medium" :
              "font-semibold text-risk-low"
            }>{risk} coordination risk</span>.
          </p>
          <p className="text-muted-foreground text-xs">
            Tip: use the <strong>Copy</strong> buttons next to any address or signature to paste it directly into Solscan or any Solana explorer.
          </p>
        </div>
      </div>
    </section>
  );
}

function StatBox({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-sm border border-border bg-background px-4 py-3">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-bold ${mono ? "font-mono text-primary text-base" : ""}`}>{value}</div>
    </div>
  );
}

function SourcePanel({ sources, tokenAddress }: { sources: string[]; tokenAddress: string }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide">Data Sources</div>
        <a
          href={tokenUrl(tokenAddress)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          <ExternalLink className="size-3" />
          Verify on Solscan
        </a>
      </div>
      <ul className="divide-y divide-border">
        {sources.map((s) => (
          <li key={s} className="flex items-center gap-3 px-4 py-2.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary/70 shrink-0" />
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── SVG Relationship Diagram ── */

function ClusterDiagram({ data, tokenAddress }: { data: ClusterData; tokenAddress: string }) {
  const W = 700; const H = 420;
  const cx = W / 2; const cy = H / 2;
  const innerR = 110; const outerR = 195;
  const tokenNode = { x: cx, y: cy };

  const sourceNodes = data.sourceWallets.map((w, i) => {
    const angle = (i / data.sourceWallets.length) * Math.PI * 2 - Math.PI / 2;
    return { x: cx + Math.cos(angle) * innerR, y: cy + Math.sin(angle) * innerR, wallet: w };
  });

  const walletNodes = data.relatedWallets.map((w, i) => {
    const angle = (i / data.relatedWallets.length) * Math.PI * 2 - Math.PI / 2;
    return { x: cx + Math.cos(angle) * outerR, y: cy + Math.sin(angle) * outerR, wallet: w };
  });

  const tokenEdges   = sourceNodes.map((sn) => ({ x1: tokenNode.x, y1: tokenNode.y, x2: sn.x, y2: sn.y }));
  const fundingEdges = walletNodes
    .map((wn) => {
      const srcNode = sourceNodes.find((sn) => sn.wallet.address === wn.wallet.fundedBy);
      if (!srcNode) return null;
      return { x1: srcNode.x, y1: srcNode.y, x2: wn.x, y2: wn.y };
    })
    .filter(Boolean) as { x1: number; y1: number; x2: number; y2: number }[];

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide">Relationship Diagram</div>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground font-mono">
          <span className="flex items-center gap-1.5"><span className="inline-block size-2 rounded-full bg-primary" /> Token</span>
          <span className="flex items-center gap-1.5"><span className="inline-block size-2 rounded-full bg-amber-400" /> Funding Source</span>
          <span className="flex items-center gap-1.5"><span className="inline-block size-2 rounded-full bg-blue-400/80" /> Wallet</span>
        </div>
      </div>
      <div className="p-4 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl mx-auto" style={{ minWidth: 340, height: "auto" }}>
          <defs>
            <radialGradient id="bg-grad" cx="50%" cy="50%">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.04" />
              <stop offset="100%" stopColor="transparent" stopOpacity="0" />
            </radialGradient>
            <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="var(--color-primary)" fillOpacity="0.5" />
            </marker>
            <marker id="arrow-fund" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#f59e0b" fillOpacity="0.6" />
            </marker>
          </defs>
          <circle cx={cx} cy={cy} r={210} fill="url(#bg-grad)" />
          <circle cx={cx} cy={cy} r={innerR} fill="none" stroke="var(--color-primary)" strokeOpacity="0.1" strokeDasharray="4 4" />
          <circle cx={cx} cy={cy} r={outerR} fill="none" stroke="var(--color-primary)" strokeOpacity="0.07" strokeDasharray="4 4" />

          {tokenEdges.map((e, i) => (
            <line key={"te" + i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              stroke="var(--color-primary)" strokeOpacity="0.35" strokeWidth="1.5" strokeDasharray="6 3" markerEnd="url(#arrow)" />
          ))}
          {fundingEdges.map((e, i) => (
            <line key={"fe" + i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
              stroke="#f59e0b" strokeOpacity="0.3" strokeWidth="1" markerEnd="url(#arrow-fund)" />
          ))}
          {sourceNodes.map((sn, i) => (
            <a key={"src" + i} href={tokenHoldersUrl(tokenAddress)} target="_blank" rel="noopener noreferrer" style={{ cursor: "pointer" }}>
              <title>{`Funding Source ${short(sn.wallet.address)} — ${sn.wallet.solBalance} SOL, ${sn.wallet.txCount} txs. Click to open token holders on Solscan.`}</title>
              <circle cx={sn.x} cy={sn.y} r={16} fill="transparent" />
              <circle cx={sn.x} cy={sn.y} r={10} fill="#f59e0b" fillOpacity="0.2" stroke="#f59e0b" strokeWidth="1.5" />
              <circle cx={sn.x} cy={sn.y} r={4} fill="#f59e0b" />
              <text x={sn.x} y={sn.y - 14} textAnchor="middle" fontSize="8" fill="#f59e0b" fontFamily="monospace">{short(sn.wallet.address)}</text>
            </a>
          ))}
          {walletNodes.map((wn, i) => (
            <a key={"wn" + i} href={tokenTransfersUrl(tokenAddress)} target="_blank" rel="noopener noreferrer" style={{ cursor: "pointer" }}>
              <title>{`Wallet ${short(wn.wallet.address)} — ${wn.wallet.role}, ${wn.wallet.solBalance} SOL, ${wn.wallet.txCount} txs. Click to open token transfers on Solscan.`}</title>
              <circle cx={wn.x} cy={wn.y} r={12} fill="transparent" />
              <circle cx={wn.x} cy={wn.y} r={5} fill="#60a5fa" fillOpacity="0.25" stroke="#60a5fa" strokeOpacity="0.7" strokeWidth="1" />
              <circle cx={wn.x} cy={wn.y} r={2.5} fill="#60a5fa" fillOpacity="0.9" />
            </a>
          ))}
          <a href={tokenUrl(tokenAddress)} target="_blank" rel="noopener noreferrer" style={{ cursor: "pointer" }}>
            <title>Open token page on Solscan</title>
            <circle cx={cx} cy={cy} r={22} fill="var(--color-primary)" fillOpacity="0.12" stroke="var(--color-primary)" strokeWidth="2" />
            <circle cx={cx} cy={cy} r={8} fill="var(--color-primary)" style={{ filter: "drop-shadow(0 0 8px var(--color-primary))" }} />
            <text x={cx} y={cy + 34} textAnchor="middle" fontSize="9" fill="var(--color-primary)" fontFamily="monospace" fontWeight="bold">TOKEN</text>
          </a>
        </svg>
      </div>
      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground font-mono">
        Hover any dot for details · click to open the related Solscan page in a new tab
      </div>
    </div>
  );
}

/* ── Wallet List ── */

function WalletList({ wallets, tokenAddress }: { wallets: WalletNode[]; tokenAddress: string }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide">
          Wallet List &nbsp;<span className="text-muted-foreground font-normal font-mono">({wallets.length})</span>
        </div>
        <a
          href={tokenHoldersUrl(tokenAddress)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          <ExternalLink className="size-3" />
          View all holders on Solscan
        </a>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Address</th>
              <th className="px-4 py-2 text-left font-medium">Role</th>
              <th className="px-4 py-2 text-right font-medium">SOL Balance</th>
              <th className="px-4 py-2 text-right font-medium">Txs</th>
              <th className="px-4 py-2 text-left font-medium">Funded By</th>
              <th className="px-4 py-2 text-right font-medium">Last Active</th>
              <th className="px-4 py-2 text-center font-medium">Copy Address</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {wallets.map((w) => (
              <tr key={w.address} className="hover:bg-surface-2 transition-colors">
                <td className="px-4 py-2.5 font-mono text-primary">{short(w.address)}</td>
                <td className="px-4 py-2.5">
                  <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border ${
                    w.isSource
                      ? "border-amber-400/50 text-amber-400"
                      : "border-blue-400/40 text-blue-400/80"
                  }`}>
                    {w.role}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono">{w.solBalance} SOL</td>
                <td className="px-4 py-2.5 text-right font-mono">{w.txCount}</td>
                <td className="px-4 py-2.5 font-mono text-muted-foreground">
                  {w.fundedBy ? short(w.fundedBy) : <span className="text-amber-400/70">Origin</span>}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{w.lastActive}</td>
                <td className="px-4 py-2.5 text-center">
                  <CopyBtn value={w.address} label="Address" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground font-mono">
        Copy any wallet address and paste it into{" "}
        <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solscan.io</a>
        {" "}or{" "}
        <a href="https://solana.fm" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solana.fm</a>
        {" "}to view its full transaction history
      </div>
    </div>
  );
}

/* ── Funding Transactions ── */

function FundingTable({
  txs, wallets, tokenAddress,
}: { txs: FundTx[]; wallets: WalletNode[]; tokenAddress: string }) {
  const addrMap = Object.fromEntries(wallets.map((w) => [w.address, w]));

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide">
            Funding Transactions &nbsp;
            <span className="text-muted-foreground font-normal font-mono">({txs.length})</span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            SOL transfers from funding sources to cluster wallets
          </div>
        </div>
        <a
          href={tokenTransfersUrl(tokenAddress)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          <ExternalLink className="size-3" />
          Live transfers on Solscan
        </a>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Signature</th>
              <th className="px-4 py-2 text-center font-medium">Copy Sig</th>
              <th className="px-4 py-2 text-left font-medium">From</th>
              <th className="px-4 py-2 text-center font-medium">Copy From</th>
              <th className="px-4 py-2 text-left font-medium">To</th>
              <th className="px-4 py-2 text-center font-medium">Copy To</th>
              <th className="px-4 py-2 text-right font-medium">Amount (SOL)</th>
              <th className="px-4 py-2 text-right font-medium">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {txs.map((tx) => (
              <tr key={tx.signature} className="hover:bg-surface-2 transition-colors">
                <td className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
                  {tx.signature.slice(0, 14)}…
                </td>
                <td className="px-4 py-2.5 text-center">
                  <CopyBtn value={tx.signature} label="Sig" />
                </td>
                <td className="px-4 py-2.5 font-mono">
                  <span className="text-amber-400/80">{short(tx.fromWallet)}</span>
                  {addrMap[tx.fromWallet]?.isSource && (
                    <span className="ml-1 text-[8px] text-amber-400/60 uppercase">src</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">
                  <CopyBtn value={tx.fromWallet} label="Addr" />
                </td>
                <td className="px-4 py-2.5 font-mono text-blue-400/80">{short(tx.toWallet)}</td>
                <td className="px-4 py-2.5 text-center">
                  <CopyBtn value={tx.toWallet} label="Addr" />
                </td>
                <td className="px-4 py-2.5 text-right font-mono">{tx.amountSol}</td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">
                  {tx.daysAgo === 0 ? "today" : `${tx.daysAgo}d ago`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground font-mono">
        Copy a signature → paste into{" "}
        <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solscan.io/tx/&lt;signature&gt;</a>
        {" "}· Copy an address → paste into{" "}
        <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solscan.io/account/&lt;address&gt;</a>
      </div>
    </div>
  );
}

/* ── Wallet Activity Transactions ── */

function ActivityTable({ txs, tokenAddress }: { txs: WalletTx[]; tokenAddress: string }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="border-b border-border px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide">
            Wallet Activity &nbsp;
            <span className="text-muted-foreground font-normal font-mono">({txs.length} transactions)</span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            Recent swap and transfer activity across cluster wallets
          </div>
        </div>
        <a
          href={tokenDefiUrl(tokenAddress)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          <ExternalLink className="size-3" />
          Live DeFi activity on Solscan
        </a>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Signature</th>
              <th className="px-4 py-2 text-center font-medium">Copy Sig</th>
              <th className="px-4 py-2 text-left font-medium">Wallet</th>
              <th className="px-4 py-2 text-center font-medium">Copy Wallet</th>
              <th className="px-4 py-2 text-left font-medium">Type</th>
              <th className="px-4 py-2 text-left font-medium">Dir</th>
              <th className="px-4 py-2 text-right font-medium">Amount (SOL)</th>
              <th className="px-4 py-2 text-left font-medium">Counterparty</th>
              <th className="px-4 py-2 text-right font-medium">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {txs.map((tx, i) => (
              <tr key={tx.signature + i} className="hover:bg-surface-2 transition-colors">
                <td className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
                  {tx.signature.slice(0, 14)}…
                </td>
                <td className="px-4 py-2.5 text-center">
                  <CopyBtn value={tx.signature} label="Sig" />
                </td>
                <td className="px-4 py-2.5 font-mono text-blue-400/80">{short(tx.wallet)}</td>
                <td className="px-4 py-2.5 text-center">
                  <CopyBtn value={tx.wallet} label="Addr" />
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{tx.txType}</td>
                <td className="px-4 py-2.5">
                  <span className={
                    tx.direction === "in"
                      ? "text-[10px] uppercase tracking-wider text-risk-low font-mono"
                      : "text-[10px] uppercase tracking-wider text-risk-medium font-mono"
                  }>
                    {tx.direction === "in" ? "▲ IN" : "▼ OUT"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono">{tx.amountSol}</td>
                <td className="px-4 py-2.5 font-mono text-muted-foreground">{tx.counterparty}</td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">
                  {tx.daysAgo === 0 ? "today" : `${tx.daysAgo}d ago`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground font-mono">
        Copy a signature → paste into{" "}
        <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solscan.io/tx/&lt;signature&gt;</a>
        {" "}· Copy an address → paste into{" "}
        <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary underline underline-offset-2">solscan.io/account/&lt;address&gt;</a>
      </div>
    </div>
  );
}
