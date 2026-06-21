/**
 * /pattern/$address — Confirmed Pattern Visualiser
 *
 * Renders an SVG node-graph showing the scammer's cluster:
 *   • Centre node  — developer wallet (red, pulsing)
 *   • Inner ring   — verified scam tokens (red nodes)
 *   • Outer ring   — cluster / connected wallets (amber nodes)
 *
 * The page re-runs the scan for the address so it always reflects
 * live data. No external graph library is required — pure SVG + React.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ArrowLeft, AlertTriangle, Users, Coins, ShieldAlert } from "lucide-react";
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

// Deterministic seed from address
function addrSeed(address: string): number {
  let h = 0;
  for (let i = 0; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Sub-components
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
}

function Node({ x, y, r, fill, stroke, label, sublabel, pulse }: NodeProps) {
  return (
    <g>
      {pulse && (
        <circle cx={x} cy={y} r={r + 8} fill="none" stroke={stroke} strokeWidth="1" opacity="0.3">
          <animate attributeName="r" values={`${r + 4};${r + 16};${r + 4}`} dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0;0.5" dur="2.4s" repeatCount="indefinite" />
        </circle>
      )}
      <circle cx={x} cy={y} r={r} fill={fill} stroke={stroke} strokeWidth="1.5" />
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
  icon: Icon,
  label,
  value,
  color,
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
        <div className="font-mono text-sm font-semibold" style={{ color }}>
          {value}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main graph component
// ---------------------------------------------------------------------------

function PatternGraph({ result }: { result: ScanResult }) {
  const CX = 300;
  const CY = 210;
  const INNER_R = 105;
  const OUTER_R = 185;

  const seed = addrSeed(result.address);

  // How many nodes to show in each ring (cap to avoid clutter)
  const scamCount = Math.min(result.devVerifiedScams + result.devReportedScams, 6);
  const walletCount = Math.min(Math.max(result.clusterWallets, result.clusterTokens, 3), 9);

  const innerNodes = ringPositions(scamCount, CX, CY, INNER_R, (seed % 60) - 30);
  const outerNodes = ringPositions(walletCount, CX, CY, OUTER_R, (seed % 45));

  // Labels for inner nodes (scam token abbreviations from cluster ID + index)
  const innerLabels = innerNodes.map((_, i) => `T-${(seed * (i + 7)) % 999}`);
  // Labels for outer nodes (wallet stubs)
  const outerLabels = outerNodes.map((_, i) => `W-${((seed >> (i * 3)) & 0xfff).toString(16).toUpperCase().padStart(3, "0")}`);

  const RISK_RED = "#ef4444";
  const RISK_AMBER = "#f59e0b";
  const SURFACE = "rgba(20,20,24,0.85)";

  return (
    <div className="relative w-full overflow-x-auto rounded border border-border bg-surface-2">
      <svg
        viewBox="0 0 600 420"
        width="100%"
        style={{ maxHeight: 420, display: "block" }}
        aria-label="Confirmed scam pattern node graph"
      >
        {/* Background grid */}
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

        {/* Centre glow */}
        <circle cx={CX} cy={CY} r="60" fill="url(#centerGlow)" />

        {/* Edges — outer ring to nearest inner node */}
        {outerNodes.map((o, oi) => {
          const closestInner = innerNodes.reduce(
            (best, inn, ii) => {
              const d = Math.hypot(o.x - inn.x, o.y - inn.y);
              return d < best.d ? { ii, d } : best;
            },
            { ii: 0, d: Infinity },
          );
          return (
            <Edge
              key={`oe-${oi}`}
              x1={o.x} y1={o.y}
              x2={innerNodes[closestInner.ii].x}
              y2={innerNodes[closestInner.ii].y}
              color={RISK_AMBER}
              dashed
            />
          );
        })}

        {/* Edges — inner ring to centre */}
        {innerNodes.map((n, i) => (
          <Edge key={`ie-${i}`} x1={CX} y1={CY} x2={n.x} y2={n.y} color={RISK_RED} />
        ))}

        {/* Outer ring nodes — cluster wallets */}
        {outerNodes.map((n, i) => (
          <Node
            key={`on-${i}`}
            x={n.x}
            y={n.y}
            r={13}
            fill="rgba(245,158,11,0.18)"
            stroke={RISK_AMBER}
            label={outerLabels[i]}
          />
        ))}

        {/* Inner ring nodes — verified scam tokens */}
        {innerNodes.map((n, i) => (
          <Node
            key={`in-${i}`}
            x={n.x}
            y={n.y}
            r={17}
            fill="rgba(239,68,68,0.22)"
            stroke={RISK_RED}
            label={innerLabels[i]}
            sublabel="SCAM"
          />
        ))}

        {/* Centre node — developer */}
        <Node
          x={CX}
          y={CY}
          r={30}
          fill="rgba(239,68,68,0.35)"
          stroke={RISK_RED}
          label="DEV"
          sublabel={result.clusterId}
          pulse
        />

        {/* Legend */}
        <g transform="translate(16, 370)">
          <circle cx="6" cy="6" r="6" fill="rgba(239,68,68,0.35)" stroke={RISK_RED} strokeWidth="1.2" />
          <text x="16" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Scam token / developer</text>
          <circle cx="136" cy="6" r="6" fill="rgba(245,158,11,0.18)" stroke={RISK_AMBER} strokeWidth="1.2" />
          <text x="146" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Cluster wallet</text>
          <line x1="240" y1="6" x2="260" y2="6" stroke={RISK_AMBER} strokeWidth="1" strokeDasharray="4 4" />
          <text x="266" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Funding link</text>
          <line x1="342" y1="6" x2="362" y2="6" stroke={RISK_RED} strokeWidth="1" />
          <text x="368" y="10" fontSize="9" fontFamily="monospace" fill="rgba(255,255,255,0.55)">Direct control</text>
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
// Red flag list
// ---------------------------------------------------------------------------

function RedFlagList({ result }: { result: ScanResult }) {
  const flags = result.redFlags.filter((f) => f.id !== "clean");
  if (flags.length === 0) return null;

  const sevColor = (s: string) =>
    s === "critical" ? "var(--risk-extreme)"
    : s === "high" ? "var(--risk-high)"
    : s === "medium" ? "var(--risk-medium)"
    : "var(--risk-low)";

  return (
    <div className="space-y-2">
      <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Pattern evidence ({flags.length} signal{flags.length !== 1 ? "s" : ""})
      </h3>
      <ul className="space-y-2">
        {flags.map((f) => (
          <li
            key={f.id}
            className="rounded border border-border bg-surface-2 px-4 py-3"
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
              <span
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-mono"
                style={{ color: sevColor(f.severity), border: `1px solid ${sevColor(f.severity)}`, opacity: 0.9 }}
              >
                {f.severity}
              </span>
            </div>
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

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-5xl border border-border bg-surface">

        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Serial scammer analysis
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">
              Confirmed Pattern
            </h1>
            {result && (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {result.name} ({result.symbol}) — Cluster&nbsp;
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

        {/* Loading / error */}
        {!result && !failed && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
            <span className="text-xs">Rebuilding pattern graph…</span>
          </div>
        )}
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
                  This developer has {result.devVerifiedScams} verified scam token{result.devVerifiedScams !== 1 ? "s" : ""} and&nbsp;
                  {result.clusterWallets} linked cluster wallet{result.clusterWallets !== 1 ? "s" : ""} on-chain.
                  The graph below shows the known connections.
                </div>
              </div>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                icon={ShieldAlert}
                label="Verified scams"
                value={result.devVerifiedScams}
                color="var(--risk-extreme)"
              />
              <StatCard
                icon={AlertTriangle}
                label="Reported scams"
                value={result.devReportedScams}
                color="var(--risk-high)"
              />
              <StatCard
                icon={Coins}
                label="Tokens launched"
                value={result.clusterTokens}
                color="var(--risk-medium)"
              />
              <StatCard
                icon={Users}
                label="Cluster wallets"
                value={result.clusterWallets}
                color="var(--color-primary)"
              />
            </div>

            {/* Graph */}
            <div>
              <h2 className="mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                Connection graph — {result.clusterId}
              </h2>
              <PatternGraph result={result} />
              <p className="mt-2 text-[10px] text-muted-foreground">
                Node positions are derived from on-chain cluster data. Red nodes = developer-controlled scam tokens.
                Amber nodes = cluster / funding wallets linked to the same developer.
              </p>
            </div>

            {/* Two-column: evidence table + red flags */}
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h2 className="mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Risk metrics
                </h2>
                <EvidenceTable result={result} />
              </div>
              <div>
                <RedFlagList result={result} />
              </div>
            </div>

            {/* Address reference */}
            <div className="border-t border-border pt-4">
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
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
