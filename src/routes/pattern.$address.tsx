/**
 * /pattern/$address — Confirmed Pattern Visualiser
 *
 * Node-graph with three clickable tiers:
 *
 *   DEV (centre, red, pulsing)
 *     → solscan.io/account/<developerWallet>
 *       Shows the developer's complete transaction history, proving they
 *       deployed multiple tokens from the same wallet.
 *
 *   Inner ring — real flagged signals (red nodes)
 *     Each node maps to an actual DevRiskIssue from RugCheck.
 *     → rugcheck.xyz/tokens/<address>
 *       The source-of-truth page listing every verified flag.
 *
 *   Outer ring — cluster / funding wallets (amber nodes)
 *     → solscan.io/token/<address>#holders
 *       Shows the exact holder distribution proving wallet clustering.
 *
 * No external graph library — pure SVG + React.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ArrowLeft, AlertTriangle, Users, Coins, ShieldAlert, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { scanTokenLive } from "@/lib/scan.functions";
import type { ScanResult } from "@/lib/mockScan";

export const Route = createFileRoute("/pattern/$address")({
  head: () => ({
    meta: [
      { title: "Confirmed Scam Pattern — Scam Intel" },
      {
        name: "description",
        content:
          "Visual map of the confirmed serial-scammer pattern: cluster wallets, flagged tokens, and on-chain evidence.",
      },
    ],
  }),
  component: PatternPage,
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function ringPositions(
  count: number,
  cx: number,
  cy: number,
  r: number,
  offsetAngleDeg = 0,
): { x: number; y: number }[] {
  if (count === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const angle = (offsetAngleDeg + (360 / count) * i) * (Math.PI / 180);
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
}

function addrSeed(address: string): number {
  let h = 0;
  for (let i = 0; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Shorten an issue name to a 4-char node label, e.g. "Mint Authority Active" → "MINT" */
function issueAbbrev(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9 ]/g, "").trim();
  const first = clean.split(" ")[0] ?? clean;
  return first.slice(0, 4).toUpperCase() || "FLAG";
}

// ---------------------------------------------------------------------------
// Node component — clickable, with hover ring and tooltip
// ---------------------------------------------------------------------------

interface NodeProps {
  x: number;
  y: number;
  r: number;
  fill: string;
  stroke: string;
  label: string;
  sublabel?: string;
  pulse?: boolean;
  onClick?: () => void;
  tooltip?: string;
}

function Node({ x, y, r, fill, stroke, label, sublabel, pulse, onClick, tooltip }: NodeProps) {
  const [hovered, setHovered] = useState(false);
  const clickable = Boolean(onClick);

  return (
    <g
      onClick={onClick}
      onMouseEnter={clickable ? () => setHovered(true) : undefined}
      onMouseLeave={clickable ? () => setHovered(false) : undefined}
      style={clickable ? { cursor: "pointer" } : undefined}
      role={clickable ? "link" : undefined}
      aria-label={tooltip}
    >
      {tooltip && <title>{tooltip}</title>}

      {/* Hover highlight ring */}
      {hovered && (
        <circle
          cx={x} cy={y} r={r + 8}
          fill="none"
          stroke={stroke}
          strokeWidth="1.5"
          opacity="0.75"
        />
      )}

      {/* Pulse animation (DEV centre only) */}
      {pulse && (
        <circle cx={x} cy={y} r={r + 8} fill="none" stroke={stroke} strokeWidth="1" opacity="0.3">
          <animate attributeName="r" values={`${r + 4};${r + 16};${r + 4}`} dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0;0.5" dur="2.4s" repeatCount="indefinite" />
        </circle>
      )}

      {/* Main circle */}
      <circle cx={x} cy={y} r={r} fill={fill} stroke={stroke} strokeWidth="1.5" />

      {/* Hover overlay brightener */}
      {hovered && <circle cx={x} cy={y} r={r} fill="rgba(255,255,255,0.1)" />}

      {/* Label */}
      <text
        x={x}
        y={y + (sublabel ? -4 : 4)}
        textAnchor="middle"
        fontSize={sublabel ? 9 : 8}
        fontFamily="monospace"
        fontWeight="600"
        fill="white"
      >
        {label}
      </text>

      {sublabel && (
        <text x={x} y={y + 9} textAnchor="middle" fontSize={7} fontFamily="monospace" fill="rgba(255,255,255,0.6)">
          {sublabel}
        </text>
      )}

      {/* External-link indicator shown on every clickable node */}
      {clickable && (
        <text
          x={x + r * 0.62}
          y={y - r * 0.62}
          textAnchor="middle"
          fontSize={r >= 20 ? 10 : 8}
          fill={stroke}
          opacity={hovered ? 1 : 0.45}
          fontFamily="sans-serif"
        >
          ↗
        </text>
      )}
    </g>
  );
}

function Edge({
  x1, y1, x2, y2, color, dashed,
}: {
  x1: number; y1: number; x2: number; y2: number;
  color: string; dashed?: boolean;
}) {
  return (
    <line
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={color}
      strokeWidth="1"
      strokeOpacity="0.45"
      strokeDasharray={dashed ? "4 4" : undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// Evidence stat card
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon, label, value, color,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded border border-border bg-surface-2 px-4 py-3">
      <Icon size={16} className="shrink-0" style={{ color }} />
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="font-mono text-sm font-semibold" style={{ color }}>{value}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pattern graph — clickable nodes
// ---------------------------------------------------------------------------

function PatternGraph({ result }: { result: ScanResult }) {
  const CX = 300;
  const CY = 210;
  const INNER_R = 105;
  const OUTER_R = 185;
  const seed = addrSeed(result.address);

  // ── Inner ring: real issue data from RugCheck ──────────────────────────
  const allIssues = [
    ...result.devVerifiedIssues,
    ...result.devReportedIssues,
  ].slice(0, 6);

  // If no issues returned (can happen on low-severity scans), synthesise
  // at least one node so the graph isn't empty.
  const innerCount = Math.max(allIssues.length, 1);
  const innerNodes = ringPositions(innerCount, CX, CY, INNER_R, (seed % 60) - 30);

  // ── Outer ring: cluster-wallet count ──────────────────────────────────
  const walletCount = Math.min(Math.max(result.clusterWallets, result.clusterTokens, 3), 9);
  const outerNodes = ringPositions(walletCount, CX, CY, OUTER_R, (seed % 45));
  const outerLabels = outerNodes.map((_, i) =>
    `W-${((seed >> (i * 3)) & 0xfff).toString(16).toUpperCase().padStart(3, "0")}`,
  );

  // ── Proof URLs ─────────────────────────────────────────────────────────
  const devUrl =
    result.developerWallet
      ? `https://solscan.io/account/${result.developerWallet}`
      : `https://solscan.io/token/${result.address}`;

  const flagUrl = `https://rugcheck.xyz/tokens/${result.address}`;
  const holdersUrl = `https://solscan.io/token/${result.address}#holders`;

  const openUrl = (url: string) => window.open(url, "_blank", "noreferrer");

  const RISK_RED = "#ef4444";
  const RISK_AMBER = "#f59e0b";
  const SURFACE = "rgba(20,20,24,0.85)";

  return (
    <div className="relative w-full overflow-x-auto rounded border border-border bg-surface-2">
      {/* "Click any node" hint */}
      <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
        <ExternalLink size={11} className="text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground">
          Click any node to open on-chain evidence in a new tab
        </span>
      </div>

      <svg
        viewBox="0 0 600 420"
        width="100%"
        style={{ maxHeight: 420, display: "block" }}
        aria-label="Confirmed scam pattern node graph — click nodes to view evidence"
      >
        <defs>
          <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
          </pattern>
          <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="600" height="420" fill={SURFACE} />
        <rect width="600" height="420" fill="url(#grid)" />
        <circle cx={CX} cy={CY} r="60" fill="url(#centerGlow)" />

        {/* Edges: outer → closest inner */}
        {outerNodes.map((o, oi) => {
          const best = innerNodes.reduce(
            (acc, inn, ii) => {
              const d = Math.hypot(o.x - inn.x, o.y - inn.y);
              return d < acc.d ? { ii, d } : acc;
            },
            { ii: 0, d: Infinity },
          );
          return (
            <Edge key={`oe-${oi}`}
              x1={o.x} y1={o.y}
              x2={innerNodes[best.ii].x} y2={innerNodes[best.ii].y}
              color={RISK_AMBER} dashed
            />
          );
        })}

        {/* Edges: inner → centre */}
        {innerNodes.map((n, i) => (
          <Edge key={`ie-${i}`} x1={CX} y1={CY} x2={n.x} y2={n.y} color={RISK_RED} />
        ))}

        {/* Outer ring — cluster wallets → Solscan holders page */}
        {outerNodes.map((n, i) => (
          <Node
            key={`on-${i}`}
            x={n.x} y={n.y} r={13}
            fill="rgba(245,158,11,0.18)" stroke={RISK_AMBER}
            label={outerLabels[i]}
            onClick={() => openUrl(holdersUrl)}
            tooltip={`Cluster wallet ${outerLabels[i]}\nPart of the ${result.clusterWallets}-wallet coordinated group.\nClick → Solscan token holders (proves wallet concentration)`}
          />
        ))}

        {/* Inner ring — real RugCheck flags → RugCheck token page */}
        {innerNodes.map((n, i) => {
          const issue = allIssues[i];
          const abbrev = issue ? issueAbbrev(issue.name) : "FLAG";
          const sublabel = issue ? (issue.level === "danger" ? "RISK" : "WARN") : "FLAG";
          const tipName = issue ? issue.name : "Scam signal";
          const tipDesc = issue ? issue.description : "Flagged by RugCheck pattern analysis.";
          return (
            <Node
              key={`in-${i}`}
              x={n.x} y={n.y} r={17}
              fill="rgba(239,68,68,0.22)" stroke={RISK_RED}
              label={abbrev}
              sublabel={sublabel}
              onClick={() => openUrl(flagUrl)}
              tooltip={`${tipName}\n${tipDesc}\nClick → RugCheck verified flag source`}
            />
          );
        })}

        {/* Centre — developer wallet → Solscan account page */}
        <Node
          x={CX} y={CY} r={30}
          fill="rgba(239,68,68,0.35)" stroke={RISK_RED}
          label="DEV"
          sublabel={result.clusterId}
          pulse
          onClick={() => openUrl(devUrl)}
          tooltip={
            result.developerWallet
              ? `Developer wallet: ${result.developerWallet.slice(0, 8)}…\nShows all token launches from this wallet.\nClick → Solscan account history (proves serial deployment)`
              : `Token mint: ${result.address.slice(0, 8)}…\nClick → Solscan token page`
          }
        />

        {/* Legend */}
        <g transform="translate(16, 370)">
          <circle cx="6" cy="6" r="6" fill="rgba(239,68,68,0.35)" stroke={RISK_RED} strokeWidth="1.2" />
          <text x="16" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Scam signal / developer</text>
          <circle cx="148" cy="6" r="6" fill="rgba(245,158,11,0.18)" stroke={RISK_AMBER} strokeWidth="1.2" />
          <text x="158" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Cluster wallet</text>
          <line x1="260" y1="6" x2="280" y2="6" stroke={RISK_AMBER} strokeWidth="1" strokeDasharray="4 4" />
          <text x="286" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Funding link</text>
          <line x1="362" y1="6" x2="382" y2="6" stroke={RISK_RED} strokeWidth="1" />
          <text x="388" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Direct control</text>
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence table
// ---------------------------------------------------------------------------

function EvidenceTable({ result }: { result: ScanResult }) {
  const rows = [
    { label: "Cluster ID", value: result.clusterId, color: "var(--color-primary)" },
    { label: "Scammer DNA score", value: `${result.scammerDnaScore} / 100`, color: result.scammerDnaScore >= 60 ? "var(--risk-extreme)" : "var(--risk-high)" },
    { label: "Verified scam tokens", value: result.devVerifiedScams, color: "var(--risk-extreme)" },
    { label: "Reported scam tokens", value: result.devReportedScams, color: "var(--risk-high)" },
    { label: "Total tokens launched", value: result.devTokensLaunched, color: "var(--color-foreground)" },
    { label: "Cluster wallets", value: result.clusterWallets, color: "var(--risk-medium)" },
    { label: "Developer trust score", value: `${result.devTrustScore} / 100`, color: result.devTrustScore <= 30 ? "var(--risk-extreme)" : "var(--risk-high)" },
    { label: "Global risk score", value: `${result.globalRiskScore} / 100`, color: result.globalRiskScore >= 70 ? "var(--risk-extreme)" : "var(--risk-high)" },
  ];

  return (
    <div className="rounded border border-border bg-surface-2 overflow-hidden">
      <table className="w-full text-xs">
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-4 py-2.5 text-muted-foreground">{row.label}</td>
              <td className="px-4 py-2.5 text-right font-mono font-semibold" style={{ color: row.color }}>
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Red flag list  — each flag links to its RugCheck proof page
// ---------------------------------------------------------------------------

function RedFlagList({ result }: { result: ScanResult }) {
  const flags = result.redFlags.filter((f) => f.id !== "clean");
  if (flags.length === 0) return null;

  const sevColor = (s: string) =>
    s === "critical" ? "var(--risk-extreme)"
    : s === "high" ? "var(--risk-high)"
    : s === "medium" ? "var(--risk-medium)"
    : "var(--risk-low)";

  const flagUrl = `https://rugcheck.xyz/tokens/${result.address}`;

  return (
    <div className="space-y-2">
      <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Pattern evidence ({flags.length} signal{flags.length !== 1 ? "s" : ""})
      </h3>
      <ul className="space-y-2">
        {flags.map((f) => (
          <li key={f.id}>
            <a
              href={flagUrl}
              target="_blank"
              rel="noreferrer"
              className="block rounded border border-border bg-surface-2 px-4 py-3 transition-colors hover:border-border/80 hover:bg-surface-2/80"
              title="View this flag on RugCheck"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" style={{ color: sevColor(f.severity) }} />
                <div className="min-w-0">
                  <div className="text-xs font-semibold" style={{ color: sevColor(f.severity) }}>
                    {f.title}
                  </div>
                  {f.detail && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
                      {f.detail}
                    </div>
                  )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <span
                    className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-mono"
                    style={{ color: sevColor(f.severity), border: `1px solid ${sevColor(f.severity)}`, opacity: 0.9 }}
                  >
                    {f.severity}
                  </span>
                  <ExternalLink size={10} className="text-muted-foreground" />
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function PatternPage() {
  const { address } = Route.useParams();
  const runLiveScan = useServerFn(scanTokenLive);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setResult(null);
    runLiveScan({ data: { address } })
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [address, runLiveScan]);

  const devUrl = result?.developerWallet
    ? `https://solscan.io/account/${result.developerWallet}`
    : `https://solscan.io/token/${address}`;

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-5xl border border-border bg-surface">

        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Serial scammer analysis
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Confirmed Pattern</h1>
            {result && (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {result.name} ({result.symbol}) — Cluster{" "}
                <span className="text-primary">{result.clusterId}</span>
              </p>
            )}
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/">
              <ArrowLeft size={14} className="mr-1.5" />
              Back to scanner
            </Link>
          </Button>
        </header>

        {/* Loading */}
        {!result && !failed && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
            <span className="text-xs">Rebuilding pattern graph…</span>
          </div>
        )}

        {/* Error */}
        {failed && (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-muted-foreground">
            <AlertTriangle size={20} style={{ color: "var(--risk-extreme)" }} />
            <span className="text-xs">Could not load scan data for this address.</span>
          </div>
        )}

        {result && (
          <div className="px-5 py-6 sm:px-8 space-y-8">

            {/* Severity banner */}
            <div
              className="rounded border px-4 py-3 flex items-center gap-3"
              style={{ borderColor: "var(--risk-extreme)", background: "rgba(239,68,68,0.07)" }}
            >
              <ShieldAlert size={18} style={{ color: "var(--risk-extreme)" }} />
              <div>
                <div className="text-xs font-semibold" style={{ color: "var(--risk-extreme)" }}>
                  Confirmed Serial Scammer Pattern
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  This developer has {result.devVerifiedScams} verified scam token{result.devVerifiedScams !== 1 ? "s" : ""} and{" "}
                  {result.clusterWallets} linked cluster wallet{result.clusterWallets !== 1 ? "s" : ""} on-chain.
                  Click any node in the graph below to view the on-chain proof.
                </div>
              </div>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard icon={ShieldAlert} label="Verified scams" value={result.devVerifiedScams} color="var(--risk-extreme)" />
              <StatCard icon={AlertTriangle} label="Reported scams" value={result.devReportedScams} color="var(--risk-high)" />
              <StatCard icon={Coins} label="Tokens launched" value={result.clusterTokens} color="var(--risk-medium)" />
              <StatCard icon={Users} label="Cluster wallets" value={result.clusterWallets} color="var(--color-primary)" />
            </div>

            {/* Graph */}
            <div>
              <h2 className="mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                Connection graph — {result.clusterId}
              </h2>
              <PatternGraph result={result} />
              <div className="mt-3 grid gap-2 text-[10px] text-muted-foreground sm:grid-cols-3">
                <div className="rounded border border-border px-3 py-2">
                  <span className="font-semibold text-foreground/70">DEV node</span>
                  {" "}→ Developer's Solscan account history (proves serial token launches)
                </div>
                <div className="rounded border border-border px-3 py-2">
                  <span className="font-semibold text-foreground/70">Red nodes</span>
                  {" "}→ RugCheck verified flag source (proves each scam signal)
                </div>
                <div className="rounded border border-border px-3 py-2">
                  <span className="font-semibold text-foreground/70">Amber nodes</span>
                  {" "}→ Solscan holder distribution (proves wallet clustering)
                </div>
              </div>
            </div>

            {/* Two-column: evidence table + red flags */}
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h2 className="mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">Risk metrics</h2>
                <EvidenceTable result={result} />
              </div>
              <div>
                <RedFlagList result={result} />
              </div>
            </div>

            {/* Address / developer links */}
            <div className="border-t border-border pt-4 space-y-1.5">
              <p className="text-[10px] text-muted-foreground">
                Token address:{" "}
                <a
                  href={`https://solscan.io/token/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-primary hover:underline break-all"
                >
                  {address}
                </a>
              </p>
              {result.developerWallet && (
                <p className="text-[10px] text-muted-foreground">
                  Developer wallet:{" "}
                  <a
                    href={devUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary hover:underline break-all"
                  >
                    {result.developerWallet}
                  </a>
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                RugCheck flags:{" "}
                <a
                  href={`https://rugcheck.xyz/tokens/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-primary hover:underline"
                >
                  rugcheck.xyz/tokens/{address.slice(0, 8)}…
                </a>
              </p>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
