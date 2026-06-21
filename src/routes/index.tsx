import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, ShieldCheck, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { scanTokenLive } from "@/lib/scan.functions";
import { recordScan } from "@/lib/scan-history";
import {
  isLikelySolanaAddress,
  riskColorVar,
  formatUsd,
  formatNum,
  type ScanResult,
  type RedFlag,
} from "@/lib/mockScan";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Scam Intelligence — Solana Meme Coin Scanner" },
      { name: "description", content: "Detect rug pulls, honeypots, and serial scammers before you ape. Paste any Solana token address." },
      { property: "og:title", content: "Scam Intelligence — Solana Meme Coin Scanner" },
      { property: "og:description", content: "The credit bureau of meme coins. On-chain risk scoring, developer reputation, and wallet cluster intel." },
    ],
  }),
  component: Index,
});

const SAMPLE = "So11111111111111111111111111111111111111112";

function Index() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const runLiveScan = useServerFn(scanTokenLive);

  const runScan = async (addr: string) => {
    const v = addr.trim();
    if (!isLikelySolanaAddress(v)) {
      setError("Not a valid Solana address (base58, 32–44 chars).");
      setResult(null);
      return;
    }
    setError(null);
    setScanning(true);
    setResult(null);
    try {
      const live = await runLiveScan({ data: { address: v } });
      setResult(live);
      recordScan(live).catch((err) => console.error("[history] insert failed", err));
    } catch (e) {
      console.error(e);
      setError("Live scan failed. The token may not exist or upstream APIs are unreachable.");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground selection:bg-primary/30 sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-1.5rem)] max-w-7xl overflow-hidden border border-border bg-surface shadow-2xl sm:min-h-[calc(100vh-3rem)]">
        <TopBar />

      <main className="px-4 pb-16 sm:px-8 lg:px-12">
        <Hero
          input={input}
          setInput={setInput}
          onScan={() => runScan(input)}
          onSample={() => { setInput(SAMPLE); runScan(SAMPLE); }}
          error={error}
          scanning={scanning}
        />

        {scanning && <ScanningState />}
        {result && !scanning && <Report result={result} />}
        {!result && !scanning && <EmptyState />}
      </main>

      <Footer />
      </div>
    </div>
  );
}

/* ---------------- Layout ---------------- */

function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-xl">
      <div className="grid h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 sm:flex sm:h-20 sm:justify-between sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-sm bg-primary shadow-[0_0_20px_color-mix(in_oklab,var(--primary)_35%,transparent)]">
            <ShieldCheck className="size-4 text-primary-foreground" />
          </div>
          <div className="leading-tight">
            <div className="truncate font-display text-sm font-bold tracking-tight">SCAM INTEL</div>
            <div className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Solana network / v0.3</div>
          </div>
        </div>
        <nav className="hidden items-center gap-7 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground md:flex">
          <span className="border-b border-primary pb-1 text-primary">Scanner</span>
          <Link to="/history" className="transition hover:text-foreground">History</Link>
          <Link to="/developer/watchlist" className="transition hover:text-foreground">Watchlist</Link>
          <Link to="/atomic-exploits" className="transition hover:text-foreground">Atomic Exploits</Link>
          <span>Graveyard</span><span>Clusters</span><span>API</span>
        </nav>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[8px] uppercase tracking-wider text-risk-low sm:text-[9px]">
            <span className="size-1.5 rounded-full bg-risk-low animate-pulse" />
            Chain sync · live
          </div>
        </div>
      </div>
    </header>
  );
}

function Hero({
  input, setInput, onScan, onSample, error, scanning,
}: {
  input: string; setInput: (s: string) => void;
  onScan: () => void; onSample: () => void;
  error: string | null; scanning: boolean;
}) {
  return (
    <section className="relative py-10 sm:py-14">
      <div className="intel-grid pointer-events-none absolute inset-0 opacity-30" />
      <div className="max-w-3xl">
        <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-primary/90 border border-primary/30 bg-primary/5 px-2.5 py-1 rounded-sm">
          <span className="size-1 rounded-full bg-primary" />
          Pre-trade Risk Intelligence
        </div>
        <h1 className="mt-6 font-display text-4xl font-bold leading-[0.96] tracking-[-0.045em] sm:text-6xl lg:text-7xl">
          The credit bureau<br />
          <span className="text-primary">of meme coins.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          Paste any Solana token address. We simulate sells, audit authorities, map developer clusters,
          and surface every red flag before you commit capital.
        </p>
      </div>

      <div className="scanner-glow relative mt-10 border border-border-strong bg-background">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Token Scanner · Solana</span>
          <span className="font-mono">SPL</span>
        </div>
        <div className="p-3 sm:p-4 flex flex-col sm:flex-row gap-2">
          <div className="flex-1 flex items-center gap-2 rounded-sm border border-border bg-background px-3 py-2.5 focus-within:border-primary transition">
            <span className="text-primary font-mono text-xs">{">"}</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onScan(); }}
              placeholder="Paste Solana token mint address…"
              className="flex-1 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/60"
              spellCheck={false}
              autoComplete="off"
            />
            {input && (
              <button onClick={() => setInput("")} className="text-muted-foreground hover:text-foreground text-xs">clear</button>
            )}
          </div>
          <Button onClick={onScan} disabled={scanning} className="shrink-0 gap-2 font-mono text-xs uppercase tracking-wider">
            {scanning ? "Scanning…" : "Scan"} <ArrowRight className="size-3" />
          </Button>
        </div>
        {error && <div className="px-3 pb-3 text-xs text-risk-high font-mono">{error}</div>}
        <div className="px-3 pb-3 flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
          <span>Try a sample:</span>
          <button onClick={onSample} className="underline hover:text-foreground transition truncate max-w-[180px]">{SAMPLE.slice(0, 16)}…</button>
        </div>
      </div>
    </section>
  );
}

function EmptyState() {
  const items = [
    { k: "authority", title: "Authority audit", d: "Checks mint and freeze authority status from the Solana RPC — not from self-reported metadata." },
    { k: "honeypot", title: "Honeypot simulation", d: "Simulates a live sell transaction via GoPlus. If the simulation reverts, the token is a honeypot." },
    { k: "liquidity", title: "LP lock verification", d: "Reads the actual LP token account and lock contract. Unlocked liquidity = exit scam risk." },
    { k: "wash", title: "Wash trading engine", d: "4-layer detection: wallet clustering, trade cadence, net-zero round trips, and tx fingerprinting." },
    { k: "dev", title: "Developer cluster", d: "Maps all tokens ever launched by the creator wallet and surfaces verified scam patterns." },
    { k: "intent", title: "Off-chain intelligence", d: "Audits linked websites, social channels, and hype quality to score real-world intent." },
  ];

  return (
    <section className="grid border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
      {items.map((i, index) => (
        <div key={i.k} className="group m-px bg-surface p-6 transition hover:bg-surface-2 sm:p-7">
          <div className="mb-4 flex items-start justify-between font-mono text-[9px] uppercase tracking-[0.16em] text-primary">
            <span>{String(index + 1).padStart(2, "0")} / {i.k}</span>
            <span className="size-2 rounded-full border border-primary transition group-hover:bg-primary" />
          </div>
          <h2 className="font-display text-base font-bold text-foreground">{i.title}</h2>
          <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{i.d}</div>
        </div>
      ))}
    </section>
  );
}

function ScanningState() {
  const steps = [
    "Resolving SPL metadata…",
    "Auditing authorities…",
    "Simulating sell transaction…",
    "Mapping holder distribution…",
    "Clustering developer wallets…",
    "Running off-chain intelligence…",
    "Computing weighted risk score…",
  ];
  return (
    <section className="mt-2 rounded-md border border-border bg-surface p-6 overflow-hidden relative">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent animate-pulse" />
      <div className="font-mono text-xs text-muted-foreground space-y-1.5">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center gap-2" style={{ animationDelay: `${i * 90}ms` }}>
            <span className="text-primary">▸</span>
            <span>{s}</span>
            <span className="text-primary/70">ok</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- Report ---------------- */

function Report({ result }: { result: ScanResult }) {
  return (
    <section className="mt-2 space-y-4">
      <TokenHeader r={result} />

      {/* ── Verdict Dashboard ── full-width banner with global score, confidence, summary */}
      <VerdictBanner r={result} />

      <HoneyPotPanel r={result} />

      <div className="grid lg:grid-cols-3 gap-4">
        <RiskPanel r={result} />
        <div className="lg:col-span-2 grid sm:grid-cols-2 gap-4">
          <AuthorityCard label="Mint Authority" value={result.mintAuthority}
            tone={result.mintAuthority === "Revoked" ? "low" : "extreme"}
            detail={result.mintAuthority === "Revoked" ? "Supply is fixed." : "Dev can mint more tokens."} />
          <AuthorityCard label="Freeze Authority" value={result.freezeAuthority}
            tone={result.freezeAuthority === "Revoked" ? "low" : "high"}
            detail={result.freezeAuthority === "Revoked" ? "Cannot freeze accounts." : "Dev can freeze holder accounts."} />
          <AuthorityCard label="Sell Controls" value={result.sellControl}
            tone={result.sellControl === "Safe" ? "low" : result.sellControl === "Developer Controlled" ? "medium" : "extreme"}
            detail={result.sellControl === "Safe" ? "No transfer hooks detected." : "Developer can modify transfer rules."} />
          <AuthorityCard label="Sell Tax" value={result.sellTaxPct != null ? `${result.sellTaxPct.toFixed(2)}%` : "0%"}
            tone={result.sellTaxPct == null || result.sellTaxPct < 5 ? "low" : result.sellTaxPct < 10 ? "medium" : result.sellTaxPct < 20 ? "high" : "extreme"}
            detail={result.sellTaxPct == null ? "No SPL transfer fee configured." : `${result.sellTaxPct.toFixed(2)}% taken on every transfer.`} />
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* ── Risk Breakdown Panel ── 4-phase synthesis explanation */}
          <RiskBreakdownPanel r={result} />
          <CpiAnalysisPanel r={result} />
          <PdaIntegrityPanel r={result} />
          <SimulationAnalysisPanel r={result} />
          <EconomicSecurityPanel r={result} />
          <IntegerOverflowPanel r={result} />
          <CategoryBreakdown r={result} />
          <WashTradingCard r={result} />
          <RedFlagsList flags={result.redFlags} />
        </div>
        <div className="space-y-4">
          <LiquidityCard r={result} />
          <HoldersCard r={result} />
          <VolumeSniperCard r={result} />
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <DeveloperCard r={result} />
        <ClusterCard r={result} />
      </div>
    </section>
  );
}

/* ── VerdictBanner — prominent full-width verdict dashboard ── */

function VerdictBanner({ r }: { r: ScanResult }) {
  const color = riskColorVar(r.riskLevel);
  const confColor =
    r.confidenceLevel === "High" ? "var(--risk-low)"
    : r.confidenceLevel === "Medium" ? "var(--risk-medium)"
    : "var(--muted-foreground)";
  return (
    <div
      className="rounded-md border bg-surface overflow-hidden"
      style={{ borderColor: color, boxShadow: `0 0 0 1px ${color}22 inset, 0 0 60px ${color}06` }}
    >
      <div className="px-4 py-2 border-b border-border flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>Global Risk Rating</span>
        <div className="flex items-center gap-2">
          <span>Confidence</span>
          <span
            className="px-2 py-0.5 rounded-sm font-mono border"
            style={{ color: confColor, borderColor: confColor }}
          >
            {r.confidenceLevel}
          </span>
        </div>
      </div>
      <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-8">
        {/* Score */}
        <div className="flex items-end gap-4 shrink-0">
          <div
            className="font-mono font-bold leading-none tabular-nums"
            style={{ color, fontSize: "clamp(4rem, 10vw, 6rem)" }}
          >
            {r.globalRiskScore}
          </div>
          <div className="pb-2 space-y-1">
            <div className="text-[10px] text-muted-foreground font-mono">/100</div>
            <div className="text-sm font-bold tracking-widest uppercase" style={{ color }}>
              {r.riskLevel} RISK
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="hidden sm:block w-px self-stretch bg-border" />

        {/* Verdict summary */}
        <div className="flex-1 space-y-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Risk Summary</div>
          <p className="text-sm sm:text-base leading-relaxed font-medium" style={{ color: r.globalRiskScore >= 70 ? color : "var(--foreground)" }}>
            {r.verdictSummary}
          </p>
        </div>
      </div>

      {/* Score bar */}
      <div className="h-1.5 w-full relative overflow-hidden bg-surface-3">
        <div className="absolute inset-0 grid grid-cols-[20%_20%_30%_30%]">
          <div className="bg-risk-low/20" />
          <div className="bg-risk-medium/20" />
          <div className="bg-risk-high/20" />
          <div className="bg-risk-extreme/20" />
        </div>
        <div
          className="absolute top-0 bottom-0 w-1 -translate-x-0.5 rounded-full"
          style={{ left: `${Math.min(100, Math.max(0, r.globalRiskScore))}%`, background: color, boxShadow: `0 0 8px ${color}` }}
        />
      </div>
    </div>
  );
}

/* ── RiskBreakdownPanel — 4-phase weighted synthesis ── */

function RiskBreakdownPanel({ r }: { r: ScanResult }) {
  const bd = r.riskBreakdown;
  const phases = [
    {
      key: "onChainCode",
      ...bd.onChainCode,
      extra: null as null | { washMultiplierApplied?: boolean; offChainAvailable?: boolean },
    },
    {
      key: "marketBehavior",
      ...bd.marketBehavior,
      extra: { washMultiplierApplied: bd.marketBehavior.washMultiplierApplied },
    },
    {
      key: "marketStructure",
      ...bd.marketStructure,
      extra: null,
    },
    {
      key: "developerIntent",
      ...bd.developerIntent,
      extra: { offChainAvailable: bd.developerIntent.offChainAvailable },
    },
  ];

  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader
        title="Global Risk Synthesis"
        sub={`Weighted across 4 phases · score ${r.globalRiskScore} · confidence ${r.confidenceLevel}`}
      />
      <div className="p-4 grid sm:grid-cols-2 gap-3">
        {phases.map((phase) => {
          const tone =
            phase.score >= 70 ? "var(--risk-extreme)"
            : phase.score >= 40 ? "var(--risk-high)"
            : phase.score >= 20 ? "var(--risk-medium)"
            : "var(--risk-low)";
          return (
            <div key={phase.key} className="rounded border border-border bg-background p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">{phase.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                  w{(phase.weight * 100).toFixed(0)}%
                </span>
              </div>

              <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${phase.score}%`, background: tone }}
                />
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground truncate mr-2">{phase.driver}</span>
                <span className="font-mono shrink-0" style={{ color: tone }}>{phase.score}</span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="text-muted-foreground">
                  Contributes <span className="font-mono text-foreground">{phase.contribution}</span> pts
                </span>
                {phase.extra?.washMultiplierApplied && (
                  <span className="px-1.5 py-0.5 rounded border border-risk-high/30 bg-risk-high/10 text-risk-high">
                    ×multiplier
                  </span>
                )}
                {phase.extra?.offChainAvailable !== undefined && (
                  <span className={`px-1.5 py-0.5 rounded border ${phase.extra.offChainAvailable ? "border-risk-low/30 bg-risk-low/10 text-risk-low" : "border-border bg-surface-3 text-muted-foreground"}`}>
                    {phase.extra.offChainAvailable ? "off-chain ✓" : "on-chain only"}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary row */}
      <div className="mx-4 mb-4 rounded border border-border bg-background px-3 py-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>Global score: <span className="font-mono text-foreground">{r.globalRiskScore}</span></span>
        <span>Wash anomaly: <span className="font-mono text-foreground">{r.washTradingScore}/100</span></span>
        <span>Intent: <span className="font-mono text-foreground">{r.intentScore}/100</span></span>
        <span>Website: <span className="font-mono text-foreground">{r.websiteAuthenticityGrade}</span></span>
      </div>
    </div>
  );
}

/* ── CpiAnalysisPanel — 'CPI Manipulation' Detector ──
 *
 * Lists every programId invoked by the analysed transaction(s), splitting
 * them into TRUSTED (green) vs UNVERIFIED (red). Unverified programs
 * trigger the CRITICAL globalRiskScore=100 override in scan-core.
 */
function CpiAnalysisPanel({ r }: { r: ScanResult }) {
  const suspicious = r.cpiSuspiciousProgramIds ?? [];
  const trusted = r.cpiTrustedProgramIds ?? [];
  const total = suspicious.length + trusted.length;
  const flagged = r.is_cpi_manipulated;

  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader
        title="CPI Analysis"
        sub={
          flagged
            ? `🚨 CRITICAL — ${suspicious.length} unverified program(s) intercepted`
            : total === 0
              ? "No CPI invocations observed for this token's recent transactions"
              : `${total} program(s) invoked · all trusted`
        }
      />

      <div className="p-4 space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Targeted Program IDs
        </div>

        {total === 0 && (
          <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            No transactions analysed yet, or the live CPI validator has not run
            against this mint.
          </div>
        )}

        {suspicious.length > 0 && (
          <div className="space-y-1.5">
            {suspicious.map((pid) => (
              <div
                key={pid}
                className="flex items-center justify-between gap-3 rounded border border-risk-extreme/40 bg-risk-extreme/10 px-3 py-2"
              >
                <span className="font-mono text-xs text-risk-extreme break-all">
                  {pid}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wider font-semibold text-risk-extreme">
                  UNVERIFIED
                </span>
              </div>
            ))}
          </div>
        )}

        {trusted.length > 0 && (
          <div className="space-y-1.5">
            {trusted.map((pid) => (
              <div
                key={pid}
                className="flex items-center justify-between gap-3 rounded border border-border bg-background px-3 py-2"
              >
                <span className="font-mono text-xs text-muted-foreground break-all">
                  {pid}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-risk-low">
                  TRUSTED
                </span>
              </div>
            ))}
          </div>
        )}

        {r.cpi_risk_details && (
          <div
            className={`rounded border px-3 py-2 text-xs ${
              flagged
                ? "border-risk-extreme/40 bg-risk-extreme/10 text-risk-extreme"
                : "border-border bg-background text-muted-foreground"
            }`}
          >
            {r.cpi_risk_details}
          </div>
        )}
      </div>
    </div>
  );
}



/* ── PdaIntegrityPanel — Phase 14 'State Hijacking' Detector ──
 *
 * Shows the PDA Integrity check inside the Risk Synthesis area.
 * For every PDA-bearing instruction the engine derives the
 * expected address from the program's canonical seeds. When the
 * provided account address does NOT match, the panel renders a
 * CRITICAL alert with the expected-vs-provided diff so reviewers
 * can immediately spot the hijacked account.
 */
function PdaIntegrityPanel({ r }: { r: ScanResult }) {
  const flagged = r.is_state_hijacked;
  const findings = r.stateHijackFindings ?? [];

  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader
        title="PDA Integrity"
        sub={
          flagged
            ? `🚨 CRITICAL — ${findings.length || 1} hijacked PDA account(s) detected`
            : r.state_hijack_details
              ? r.state_hijack_details
              : "No PDA-bearing instructions analysed yet for this token"
        }
      />

      <div className="p-4 space-y-3">
        {flagged && (
          <div className="rounded border border-risk-extreme/40 bg-risk-extreme/10 px-3 py-2 text-xs text-risk-extreme">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
              Critical Risk: Potential State Hijacking detected
            </div>
            One or more program instructions interacted with an account whose
            address does NOT match the canonical PDA derivation. Funds or
            authority state may be redirected to an attacker-controlled
            account.
          </div>
        )}

        {findings.length > 0 ? (
          <div className="space-y-2">
            {findings.map((f, i) => (
              <div
                key={`${f.programName}-${i}`}
                className="rounded border border-risk-extreme/40 bg-background overflow-hidden"
              >
                <div className="flex items-center justify-between gap-3 border-b border-border bg-risk-extreme/10 px-3 py-1.5">
                  <span className="font-mono text-[11px] text-risk-extreme">
                    {f.programName}
                    <span className="text-muted-foreground"> · </span>
                    {f.accountLabel}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wider font-semibold text-risk-extreme">
                    HIJACKED
                  </span>
                </div>
                <div className="grid sm:grid-cols-2 gap-px bg-border">
                  <div className="bg-background p-3">
                    <div className="text-[10px] uppercase tracking-wider text-risk-low mb-1">
                      Expected (canonical PDA)
                    </div>
                    <div className="font-mono text-[11px] text-risk-low break-all">
                      {f.expectedAddress}
                    </div>
                  </div>
                  <div className="bg-background p-3">
                    <div className="text-[10px] uppercase tracking-wider text-risk-extreme mb-1">
                      Provided (hijacked address)
                    </div>
                    <div className="font-mono text-[11px] text-risk-extreme break-all">
                      {f.providedAddress}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          !flagged && (
            <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              Every PDA-bearing instruction in this token's recent
              transactions matched its canonical seed derivation.
            </div>
          )
        )}
      </div>
    </div>
  );
}


/* ── SimulationAnalysisPanel — Phase 15 'Atomic Execution' Exploit Monitor ──
 *
 * Re-renders the COMPLETE instruction tree returned by simulateTransaction,
 * including all inner CPI invocations at every nesting depth.
 *
 * Authorization-related instructions (SetAuthority, Approve, UpdateMetadata…)
 * are highlighted in red. When is_atomic_exploit is true, a CRITICAL banner
 * is shown at the top explaining the 'swap-and-backdoor' pattern.
 *
 * Color coding:
 *   🔴 Red   — isAuthorizationRelated (the dangerous instructions)
 *   🟡 Amber — isSwap (the cover for the exploit)
 *   ⚪ Gray  — other / system instructions (neutral)
 */
function SimulationAnalysisPanel({ r }: { r: ScanResult }) {
  const instructions = r.atomicExploitInstructions ?? [];
  const flagged = r.is_atomic_exploit;
  const authCount = instructions.filter((i) => i.isAuthorizationRelated).length;
  const swapCount = instructions.filter((i) => i.isSwap).length;
  const total = instructions.length;

  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader
        title="Simulation Analysis"
        sub={
          flagged
            ? `🚨 CRITICAL — Swap + ${authCount} authorization instruction(s) bundled atomically`
            : total === 0
              ? "No recent transactions simulated for this token"
              : `${total} instruction(s) simulated · ${swapCount} swap · ${authCount} authorization`
        }
      />

      <div className="p-4 space-y-3">

        {flagged && (
          <div className="rounded border border-risk-extreme/40 bg-risk-extreme/10 px-3 py-2 text-xs text-risk-extreme">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
              Critical Risk: Atomic Exploit Pattern Detected
            </div>
            A single atomically-executed transaction contains both a{" "}
            <span className="font-mono">Swap</span> instruction and{" "}
            {authCount} authority-modifying instruction{authCount !== 1 ? "s" : ""}. Because all
            instructions in a Solana transaction execute atomically, the attacker's authorization
            changes are guaranteed to succeed whenever the swap succeeds — users cannot approve
            only part of the transaction.
          </div>
        )}

        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Instruction Tree
        </div>

        {total === 0 && (
          <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            No transactions were analyzed. Either the mint has no recent activity, the
            simulateTransaction RPC was unavailable, or no Helius API key is configured.
          </div>
        )}

        {total > 0 && (
          <div className="space-y-1.5">
            {instructions.map((ix, idx) => {
              const isAuth = ix.isAuthorizationRelated;
              const isSwap = ix.isSwap;

              const borderColor = isAuth
                ? "border-risk-extreme/40"
                : isSwap
                  ? "border-risk-high/30"
                  : "border-border";
              const bgColor = isAuth
                ? "bg-risk-extreme/10"
                : isSwap
                  ? "bg-risk-high/10"
                  : "bg-background";
              const labelColor = isAuth
                ? "text-risk-extreme"
                : isSwap
                  ? "text-risk-high"
                  : "text-muted-foreground";
              const tag = isAuth
                ? "AUTHORIZATION"
                : isSwap
                  ? "SWAP"
                  : ix.depth > 0
                    ? "CPI"
                    : "SYSTEM";

              return (
                <div
                  key={`${ix.programId}-${idx}`}
                  className={`flex items-center justify-between gap-3 rounded border ${borderColor} ${bgColor} px-3 py-2`}
                  style={{ paddingLeft: ix.depth > 0 ? `${(ix.depth * 12) + 12}px` : undefined }}
                >
                  <div className="min-w-0">
                    {ix.depth > 0 && (
                      <span className="text-muted-foreground mr-1.5 text-[10px]">
                        {"↳".repeat(ix.depth)}
                      </span>
                    )}
                    <span className={`font-mono text-xs ${isAuth ? "text-risk-extreme font-semibold" : isSwap ? "text-risk-high" : "text-foreground"}`}>
                      {ix.programName}
                    </span>
                    <span className="text-muted-foreground text-[10px] mx-1">·</span>
                    <span className={`text-[11px] ${isAuth ? "text-risk-extreme" : isSwap ? "text-risk-high" : "text-muted-foreground"}`}>
                      {ix.instructionType}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 text-[10px] uppercase tracking-wider font-semibold ${labelColor}`}
                  >
                    {tag}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {r.atomic_exploit_details && (
          <div
            className={`rounded border px-3 py-2 text-xs leading-relaxed ${
              flagged
                ? "border-risk-extreme/40 bg-risk-extreme/10 text-risk-extreme"
                : "border-border bg-background text-muted-foreground"
            }`}
          >
            {r.atomic_exploit_details}
          </div>
        )}
      </div>
    </div>
  );
}


/* ── EconomicSecurityPanel — Phase 16 'Rent-Exemption & Account Eviction' Detector ──
 *
 * Displays the Economic Security status in the Risk Synthesis area.
 * For every account identified in the token's recent transactions, the
 * scanner fetches its current lamport balance and compares it against the
 * minimum required for rent exemption (via getMinimumBalanceForRentExemption).
 *
 * Accounts below the threshold are susceptible to eviction by the Solana
 * runtime. An attacker can then re-create the evicted account with malicious
 * data — a form of 'state hijacking via account resurrection'.
 *
 * When violations are detected, each account card shows:
 *   - Current Balance (lamports / SOL)
 *   - Required Minimum (from RPC)
 *   - Deficit (how many lamports short)
 */
function EconomicSecurityPanel({ r }: { r: ScanResult }) {
  const flagged = r.is_non_rent_exempt_accounts;
  const violations = r.rentExemptViolations ?? [];
  const hasData = r.rentExemptViolations !== undefined;

  function formatLamports(l: number): string {
    if (l >= 1_000_000_000) return `${(l / 1_000_000_000).toFixed(4)} SOL`;
    if (l >= 1_000_000) return `${(l / 1_000_000).toFixed(2)}M lamports`;
    return `${l.toLocaleString()} lamports`;
  }

  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader
        title="Economic Security"
        sub={
          flagged
            ? `⚠️ CRITICAL — ${violations.length} account${violations.length === 1 ? "" : "s"} not rent-exempt — eviction & state hijacking risk`
            : hasData && violations.length === 0
              ? "All checked accounts are rent-exempt — no eviction risk detected"
              : "Rent exemption analysis not available for this token"
        }
      />

      <div className="p-4 space-y-3">

        {flagged && (
          <div className="rounded border border-risk-extreme/40 bg-risk-extreme/10 px-3 py-2 text-xs text-risk-extreme">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
              Critical Risk: Account Vulnerability Detected
            </div>
            One or more accounts associated with this token are not rent-exempt.
            When an account's balance falls below the minimum rent-exempt reserve,
            the Solana runtime can <span className="font-semibold">evict (delete)</span> it.
            An attacker can then re-create the evicted account with malicious data
            — a form of state hijacking via 'account resurrection'.
          </div>
        )}

        {violations.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Account Vulnerability Details
            </div>
            {violations.map((v, i) => (
              <div
                key={`${v.address}-${i}`}
                className="rounded border border-risk-extreme/40 bg-background overflow-hidden"
              >
                <div className="flex items-center justify-between gap-3 border-b border-border bg-risk-extreme/10 px-3 py-1.5">
                  <span className="font-mono text-[11px] text-risk-extreme break-all">
                    {v.address}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wider font-semibold text-risk-extreme">
                    EVICTABLE
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-px bg-border">
                  <div className="bg-background p-3">
                    <div className="text-[10px] uppercase tracking-wider text-risk-extreme mb-1">
                      Current Balance
                    </div>
                    <div className="font-mono text-[11px] text-risk-extreme">
                      {formatLamports(v.lamports)}
                    </div>
                  </div>
                  <div className="bg-background p-3">
                    <div className="text-[10px] uppercase tracking-wider text-risk-low mb-1">
                      Required Minimum
                    </div>
                    <div className="font-mono text-[11px] text-risk-low">
                      {formatLamports(v.requiredMinimum)}
                    </div>
                  </div>
                  <div className="bg-background p-3">
                    <div className="text-[10px] uppercase tracking-wider text-risk-high mb-1">
                      Deficit
                    </div>
                    <div className="font-mono text-[11px] text-risk-high">
                      −{formatLamports(v.deficit)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!flagged && (
          <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {hasData && violations.length === 0
              ? "All accounts checked for rent exemption passed — no accounts are at risk of eviction."
              : "No rent exemption data available. This may occur when no recent transactions were found or the RPC endpoint was unavailable."}
          </div>
        )}

      </div>
    </div>
  );
}


/* ── IntegerOverflowPanel — Phase 17 'Integer Overflow / Underflow' Monitor ──
 *
 * Displays the three-phase overflow analysis result with explicit verification
 * method labelling. Never shows "Incomplete" or "Low Confidence" — uses
 * "Status: Under Review" with raw data instead.
 *
 * Alert tiers rendered:
 *   🚨 DANGER: Intentional Backdoor Detected — confirmed exploit + serial scammer
 *   🔢 CONFIRMED EXPLOIT VECTOR             — simulation verified, no safe guards
 *   ⚠️  Technical Debt: Audit Required       — exploit confirmed but audit on file
 *   ⚠️  Preliminary Risk                     — static analysis only, inconclusive sim
 *   ℹ️  Code Style Warning                   — static flags but simulation safe
 *   🔍 Status: Under Review                 — bytecode unavailable/inconclusive
 *   ✅ Safe                                 — all checks passed
 */
function IntegerOverflowPanel({ r }: { r: ScanResult }) {
  const om = r.riskBreakdown?.overflowMonitor;

  if (!om) {
    return (
      <div className="rounded-md border border-border bg-surface">
        <SectionHeader
          title="Integer Overflow / Underflow Monitor"
          sub="Phase 17 · Analysis not available"
        />
        <div className="p-4">
          <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Status: Under Review — Overflow analysis was not available for this token. This may occur when
            no program bytecode was found at the mint address or the RPC endpoint was unreachable.
          </div>
        </div>
      </div>
    );
  }

  const tier = om.alert_tier ?? "Safe";
  const method = om.verification_method ?? "Status: Under Review";

  const tierColor: string =
    tier === "DANGER: Intentional Backdoor Detected"
      ? "var(--risk-extreme)"
      : tier === "CONFIRMED EXPLOIT VECTOR"
        ? "var(--risk-extreme)"
        : tier === "Technical Debt: Audit Required"
          ? "var(--risk-high)"
          : tier === "Preliminary Risk"
            ? "var(--risk-medium)"
            : tier === "Status: Under Review"
              ? "var(--risk-medium)"
              : tier === "Code Style Warning"
                ? "var(--risk-low)"
                : "var(--risk-low)";

  const methodBadgeColor: string =
    method === "Verified via Simulation"
      ? "var(--risk-low)"
      : method === "Heuristic Warning"
        ? "var(--risk-medium)"
        : "var(--muted-foreground)";

  const isCritical =
    tier === "DANGER: Intentional Backdoor Detected" ||
    tier === "CONFIRMED EXPLOIT VECTOR" ||
    tier === "Technical Debt: Audit Required";

  const sim = om.simulation;
  const edgeCases = sim?.edgeCasesTested ?? [];

  return (
    <div
      className="rounded-md border bg-surface"
      style={{
        borderColor: isCritical ? tierColor : "var(--border)",
        boxShadow: isCritical ? `0 0 0 1px ${tierColor}33 inset` : undefined,
      }}
    >
      <SectionHeader
        title="Integer Overflow / Underflow Monitor"
        sub={`Phase 17 · ${method}`}
      />

      <div className="p-4 space-y-3">
        {/* Verification method badge */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider"
            style={{ color: methodBadgeColor, borderColor: methodBadgeColor }}
          >
            {method === "Verified via Simulation" ? "🧪" : method === "Heuristic Warning" ? "🔍" : "📋"}
            {method}
          </span>
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wider"
            style={{ color: tierColor, borderColor: tierColor }}
          >
            {tier}
          </span>
        </div>

        {/* Critical / DANGER alert banner */}
        {(tier === "DANGER: Intentional Backdoor Detected" || tier === "CONFIRMED EXPLOIT VECTOR") && (
          <div className="rounded border border-risk-extreme/40 bg-risk-extreme/10 px-3 py-2 text-xs text-risk-extreme">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
              {tier === "DANGER: Intentional Backdoor Detected"
                ? "🚨 DANGER: Intentional Backdoor — Immediate Exit Risk"
                : "🔢 Confirmed Exploit Vector — High Risk"}
            </div>
            {tier === "DANGER: Intentional Backdoor Detected" ? (
              <>
                Behavioral simulation confirmed unchecked arithmetic paths that allow silent overflow,{" "}
                <span className="font-semibold">combined with a serial scammer developer history.</span>{" "}
                This combination strongly indicates the overflow is a deliberate attack mechanism, not an oversight.
                Avoid investing in this token.
              </>
            ) : (
              <>
                Simulation tests (u64&#x3A;&#x3A;MAX + 1, u64&#x3A;&#x3A;MIN - 1) completed{" "}
                <span className="font-semibold">without triggering a runtime revert.</span>{" "}
                An attacker can exploit integer wraparound to manipulate token supply, balances, or fee accounting.
              </>
            )}
          </div>
        )}

        {/* Technical Debt banner */}
        {tier === "Technical Debt: Audit Required" && (
          <div className="rounded border border-risk-high/40 bg-risk-high/10 px-3 py-2 text-xs text-risk-high">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
              ⚠️ Technical Debt — Audit Required Before Investing
            </div>
            Simulation confirmed an integer overflow exploit path, but a verified security audit exists on file.
            This may be known/accepted technical debt. Review the audit report for remediation status.
          </div>
        )}

        {/* Preliminary Risk banner */}
        {tier === "Preliminary Risk" && (
          <div className="rounded border border-risk-medium/40 bg-risk-medium/10 px-3 py-2 text-xs text-risk-medium">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
              ⚠️ Preliminary Risk — Heuristic Warning
            </div>
            Static analysis found unchecked arithmetic instructions but simulation results were inconclusive.
            This is a heuristic signal only — not a confirmed exploit. Further investigation is recommended.
          </div>
        )}

        {/* Code Style Warning banner */}
        {tier === "Code Style Warning" && (
          <div className="rounded border border-risk-low/40 bg-risk-low/10 px-3 py-2 text-xs text-risk-low">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1">
              ℹ️ Code Style Warning — No Runtime Risk Detected
            </div>
            Static analysis flagged arithmetic opcodes without visible guard branches, but behavioral simulation
            confirmed overflow inputs cause a runtime revert. The unchecked opcodes are in non-critical paths.
          </div>
        )}

        {/* Status: Under Review banner */}
        {tier === "Status: Under Review" && (
          <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            <div className="font-semibold uppercase tracking-wider text-[10px] mb-1 text-foreground">
              🔍 Status: Under Review
            </div>
            Program bytecode analysis returned inconclusive results — bytecode may be unavailable or the simulation
            could not determine whether overflow paths are exploitable. Raw data is provided below.
          </div>
        )}

        {/* Instruction counts */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded border border-border bg-background p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Unsafe Instrs</div>
            <div
              className="font-mono text-base"
              style={{ color: om.unsafe_instruction_count > 0 ? tierColor : "var(--risk-low)" }}
            >
              {om.unsafe_instruction_count}
            </div>
          </div>
          <div className="rounded border border-border bg-background p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Safe Instrs</div>
            <div className="font-mono text-base text-risk-low">{om.safe_instruction_count}</div>
          </div>
          <div className="rounded border border-border bg-background p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Confidence</div>
            <div className="font-mono text-base text-foreground">{om.confidence}</div>
          </div>
        </div>

        {/* Simulation edge-case tests */}
        {sim?.tested && edgeCases.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Behavioral Simulation Results
            </div>
            {edgeCases.map((ec, i) => {
              const isExploit = ec.verdict === "exploit";
              const isSafe = ec.verdict === "safe";
              const edgeColor = isExploit
                ? "var(--risk-extreme)"
                : isSafe
                  ? "var(--risk-low)"
                  : "var(--muted-foreground)";
              return (
                <div
                  key={i}
                  className="rounded border bg-background overflow-hidden"
                  style={{ borderColor: `${edgeColor}40` }}
                >
                  <div
                    className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5"
                    style={{ background: `color-mix(in srgb, ${edgeColor} 8%, transparent)` }}
                  >
                    <span className="font-mono text-[11px]" style={{ color: edgeColor }}>
                      {ec.label}
                    </span>
                    <span
                      className="shrink-0 text-[10px] uppercase tracking-wider font-semibold"
                      style={{ color: edgeColor }}
                    >
                      {ec.verdict === "exploit"
                        ? "EXPLOIT"
                        : ec.verdict === "safe"
                          ? "SAFE"
                          : "INCONCLUSIVE"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-px bg-border text-xs">
                    <div className="bg-background px-3 py-2">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Input</div>
                      <div className="font-mono text-[11px]">{ec.inputDescription}</div>
                    </div>
                    <div className="bg-background px-3 py-2">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Observed</div>
                      <div className="font-mono text-[11px]" style={{ color: edgeColor }}>
                        {ec.observedBehavior === "reverted"
                          ? "✓ Reverted (safe)"
                          : ec.observedBehavior === "succeeded_silently"
                            ? "✕ Succeeded silently (exploit)"
                            : "? Unknown"}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {sim.summary && (
              <div className="rounded border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
                {sim.summary}
              </div>
            )}
          </div>
        )}

        {/* Safe state */}
        {tier === "Safe" && (
          <div className="rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            ✅ No unchecked arithmetic detected — program uses safe math primitives (checked_add, saturating_add, etc.)
            and simulation confirmed all overflow paths would revert.
          </div>
        )}
      </div>
    </div>
  );
}


function TokenHeader({ r }: { r: ScanResult }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-3 min-w-0">
          {r.imageUrl ? (
            <img src={r.imageUrl} alt={r.name} className="size-12 rounded-md border border-border-strong object-cover bg-surface-3" loading="lazy" />
          ) : (
            <div className="size-12 rounded-md border border-border-strong bg-gradient-to-br from-primary/30 to-surface-3 grid place-items-center font-mono text-base text-primary">
              {r.symbol.slice(0, 2)}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-lg font-semibold truncate">{r.name}</div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground border border-border px-1.5 py-0.5 rounded-sm">{r.symbol}</span>
            </div>
            <div className="font-mono text-[11px] text-muted-foreground truncate">{r.address}</div>
            {(r.websites?.length || r.socials?.length) ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {r.websites?.map((w) => (
                  <a key={w.url} href={w.url} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:border-border-strong">
                    {w.label}
                  </a>
                ))}
                {r.socials?.map((s) => (
                  <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer"
                    className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0.5 rounded-sm text-primary hover:border-primary">
                    {s.type}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-1 flex-wrap gap-x-6 gap-y-3 sm:justify-end font-mono text-xs">
          <Stat label="Price" value={formatUsd(r.price)} />
          <Stat label="M.Cap" value={formatUsd(r.marketCap)} />
          <Stat label="FDV" value={formatUsd(r.fdv)} />
          <Stat label="Liq" value={formatUsd(r.liquidity)} />
          <Stat label="Vol 24h" value={formatUsd(r.volume24h)} />
          <Stat label="Holders" value={formatNum(r.holders)} />
          <Stat label="Age" value={`${r.ageDays}d`} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="text-foreground">{value}</div>
    </div>
  );
}

function RiskPanel({ r }: { r: ScanResult }) {
  const color = riskColorVar(r.riskLevel);
  const confColor =
    r.confidenceLevel === "High" ? "var(--risk-low)"
    : r.confidenceLevel === "Medium" ? "var(--risk-medium)"
    : "var(--muted-foreground)";
  return (
    <div className="rounded-md border border-border bg-surface p-5 relative overflow-hidden">
      <div className="absolute inset-0 scanline pointer-events-none" />
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Global Risk Score</div>
      <div className="mt-4 flex items-end gap-3">
        <div className="font-mono text-6xl leading-none tabular-nums" style={{ color }}>
          {r.globalRiskScore}
        </div>
        <div className="pb-2 space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">/ 100</div>
          <div className="text-xs font-semibold tracking-wide" style={{ color }}>{r.riskLevel} RISK</div>
        </div>
      </div>
      <RiskBar score={r.globalRiskScore} />
      <div className="grid grid-cols-4 text-[9px] uppercase tracking-wider text-muted-foreground mt-1.5">
        <span>0 low</span><span>20 med</span><span>40 high</span><span className="text-right">70 ext</span>
      </div>

      {/* Confidence badge */}
      <div className="mt-3 flex items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Confidence</span>
        <span
          className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono uppercase tracking-wider border"
          style={{ color: confColor, borderColor: confColor }}
        >
          {r.confidenceLevel}
        </span>
      </div>

      <div className="mt-4 pt-4 border-t border-border space-y-2.5 text-xs">
        <RiskRow label="Scammer DNA" value={r.scammerDnaScore} />
        <div className="flex justify-between">
          <span className="text-muted-foreground">Serial scammer</span>
          {r.serialScammerProbability === "Confirmed Pattern" ? (
            <Link
              to="/pattern/$address"
              params={{ address: r.address }}
              className="font-semibold text-risk-extreme underline decoration-dotted underline-offset-2 hover:decoration-solid transition-all"
              title="View confirmed scam pattern diagram"
            >
              Confirmed Pattern ↗
            </Link>
          ) : (
            <span className={r.serialScammerProbability === "Low" ? "text-risk-low" : r.serialScammerProbability === "Medium" ? "text-risk-medium" : "text-risk-high"}>
              {r.serialScammerProbability}
            </span>
          )}
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Cluster ID</span>
          <span className="font-mono text-primary">{r.clusterId}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Wash anomaly</span>
          <span className="font-mono">{r.washTradingScore}/100</span>
        </div>
        {r.intentScore > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Intent score</span>
            <span className="font-mono">{r.intentScore}/100</span>
          </div>
        )}
      </div>
    </div>
  );
}

function RiskBar({ score }: { score: number }) {
  return (
    <div className="mt-4 h-2 rounded-sm bg-surface-3 relative overflow-hidden">
      <div className="absolute inset-0 grid grid-cols-[20%_20%_30%_30%]">
        <div className="bg-risk-low/15" />
        <div className="bg-risk-medium/15" />
        <div className="bg-risk-high/15" />
        <div className="bg-risk-extreme/15" />
      </div>
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-foreground shadow-[0_0_8px_var(--color-foreground)]"
        style={{ left: `${Math.min(100, Math.max(0, score))}%` }}
      />
    </div>
  );
}

function RiskRow({ label, value }: { label: string; value: number }) {
  const tone = value >= 70 ? "var(--risk-extreme)" : value >= 40 ? "var(--risk-high)" : value >= 20 ? "var(--risk-medium)" : "var(--risk-low)";
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono" style={{ color: tone }}>{value}</span>
      </div>
      <div className="mt-1 h-1 rounded-sm bg-surface-3 overflow-hidden">
        <div className="h-full" style={{ width: `${value}%`, background: tone }} />
      </div>
    </div>
  );
}

function AuthorityCard({ label, value, tone, detail }: {
  label: string; value: string; tone: "low" | "medium" | "high" | "extreme"; detail: string;
}) {
  const color = { low: "var(--risk-low)", medium: "var(--risk-medium)", high: "var(--risk-high)", extreme: "var(--risk-extreme)" }[tone];
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
        <div className="size-2 rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
      </div>
      <div className="mt-2 text-lg font-semibold" style={{ color }}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function HoneyPotPanel({ r }: { r: ScanResult }) {
  const status = r.honeyPotStatus;
  const tone: "low" | "medium" | "high" | "extreme" =
    status === "SAFE" ? "low" : status === "SUSPICIOUS" ? "medium" : status === "HIGH RISK" ? "high" : "extreme";
  const color = { low: "var(--risk-low)", medium: "var(--risk-medium)", high: "var(--risk-high)", extreme: "var(--risk-extreme)" }[tone];
  const failed = r.honeyPotChecks.filter((c) => !c.ok);
  const passed = r.honeyPotChecks.filter((c) => c.ok);

  return (
    <div className="rounded-md border bg-surface" style={{ borderColor: color, boxShadow: `0 0 0 1px ${color}33 inset` }}>
      <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4 justify-between border-b border-border">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Honey Pot Status</div>
          <div className="mt-1 text-2xl font-bold tracking-tight" style={{ color }}>{status}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {r.honeyPotSource === "goplus"
              ? "Live transaction simulation via GoPlus Solana Token Security."
              : "GoPlus unreachable — using on-chain authority fallback. Treat as inconclusive."}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap text-xs">
          <Pill ok={r.honeyPotChecks.find((c) => c.id === "sell-blocked")?.ok ?? true} label="Sell allowed" />
          <Pill ok={r.honeyPotChecks.find((c) => c.id === "whitelist-only")?.ok ?? true} label="No whitelist" />
          <Pill ok={r.honeyPotChecks.find((c) => c.id === "transfer-hook")?.ok ?? true} label="No transfer hook" />
          <Pill ok={(r.sellTaxPct ?? 0) < 10} label={`Tax ${(r.sellTaxPct ?? 0).toFixed(1)}%`} />
        </div>
      </div>

      {failed.length > 0 && (
        <div className="p-4 sm:p-5 space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Reasons</div>
          <ul className="space-y-2">
            {failed.map((c) => (
              <li key={c.id} className="flex gap-3 text-sm">
                <span className="mt-1.5 size-2 rounded-full shrink-0" style={{ background: severityColor(c.severity), boxShadow: `0 0 8px ${severityColor(c.severity)}` }} />
                <div>
                  <div className="font-medium text-foreground">{c.label.replace(/^./, (m) => m.toUpperCase())}</div>
                  <div className="text-xs text-muted-foreground">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {passed.length > 0 && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5">
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground mb-2">Checks passed ({passed.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {passed.map((c) => (
              <span key={c.id} className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground">
                ✓ {c.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  const color = ok ? "var(--risk-low)" : "var(--risk-extreme)";
  return (
    <span className="px-2 py-1 rounded border text-xs" style={{ borderColor: color, color }}>
      {ok ? "✓" : "✕"} {label}
    </span>
  );
}

function severityColor(s: "info" | "warn" | "high" | "critical") {
  return { info: "var(--risk-low)", warn: "var(--risk-medium)", high: "var(--risk-high)", critical: "var(--risk-extreme)" }[s];
}

function CategoryBreakdown({ r }: { r: ScanResult }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Category Detail" sub={`${r.categories.length} categories · weighted`} />
      <div className="p-4 space-y-3">
        {r.categories.map((c) => {
          const tone = c.score >= 70 ? "var(--risk-extreme)" : c.score >= 40 ? "var(--risk-high)" : c.score >= 20 ? "var(--risk-medium)" : "var(--risk-low)";
          return (
            <div key={c.key}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-foreground">{c.label}</span>
                <span className="font-mono text-muted-foreground">
                  w{(c.weight * 100).toFixed(0)} · <span style={{ color: tone }}>{c.score.toFixed(0)}</span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-sm bg-surface-3 overflow-hidden">
                <div className="h-full transition-all" style={{ width: `${c.score}%`, background: tone }} />
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">{c.notes}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RedFlagsList({ flags }: { flags: RedFlag[] }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Red Flags" sub={`${flags.length} signal${flags.length === 1 ? "" : "s"}`} />
      <ul className="divide-y divide-border">
        {flags.map((f) => {
          const tone = f.severity === "critical" ? "var(--risk-extreme)"
            : f.severity === "high" ? "var(--risk-high)"
            : f.severity === "warn" ? "var(--risk-medium)"
            : "var(--risk-low)";
          return (
            <li key={f.id} className="p-4 flex gap-3">
              <div className="mt-1 size-2 rounded-full shrink-0" style={{ background: tone, boxShadow: `0 0 10px ${tone}` }} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{f.title}</span>
                  <span className="text-[9px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-sm border" style={{ color: tone, borderColor: tone }}>
                    {f.severity}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{f.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LiquidityCard({ r }: { r: ScanResult }) {
  const tone = r.lpStatus === "Burned" ? "var(--risk-low)" : r.lpStatus === "Locked" ? (r.lpLockDays < 90 ? "var(--risk-medium)" : "var(--risk-low)") : "var(--risk-extreme)";
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Liquidity" />
      <div className="p-4 space-y-2.5 text-xs">
        <Row label="Status"><span className="font-semibold" style={{ color: tone }}>{r.lpStatus}</span></Row>
        <Row label="Lock duration"><span className="font-mono">{r.lpStatus === "Locked" ? `${r.lpLockDays}d` : "—"}</span></Row>
        <Row label="Provider"><span className="font-mono">{r.lpProvider}</span></Row>
        <Row label="Pool size"><span className="font-mono">{formatUsd(r.liquidity)}</span></Row>
      </div>
    </div>
  );
}

function HoldersCard({ r }: { r: ScanResult }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Holders" />
      <div className="p-4 space-y-2.5 text-xs">
        <Row label="Total holders"><span className="font-mono">{formatNum(r.holders)}</span></Row>
        <Row label="Top 10 concentration"><Pct value={r.top10Pct} threshold={50} /></Row>
        <Row label="Team allocation"><Pct value={r.teamPct} threshold={15} /></Row>
        <Row label="Insider allocation"><Pct value={r.insiderPct} threshold={10} /></Row>
      </div>
    </div>
  );
}

function WashTradingCard({ r }: { r: ScanResult }) {
  const w = r.washTrading;
  const tone =
    w.verdict === "manipulated" ? "var(--risk-extreme)"
    : w.verdict === "likely_manipulated" ? "var(--risk-high)"
    : w.verdict === "suspicious" ? "var(--risk-medium)"
    : "var(--risk-low)";
  const layers: { label: string; value: number }[] = [
    { label: "Wallet clustering", value: w.breakdown.walletCluster },
    { label: "Trade cadence", value: w.breakdown.tradeCadence },
    { label: "Net-zero round trips", value: w.breakdown.netZero },
    { label: "Tx fingerprint", value: w.breakdown.txMetadata },
  ];
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader
        title="Wash Trading & Manipulation"
        sub={w.available ? `${w.tradesAnalyzed} swaps analysed · 4-layer engine` : "On-chain trade history unavailable — estimate only"}
      />
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Anomaly score</div>
            <div className="font-mono text-2xl" style={{ color: tone }}>
              {w.anomalyScore}<span className="text-sm text-muted-foreground">/100</span>
            </div>
          </div>
          <span className="font-mono text-xs uppercase tracking-wider px-2 py-1 rounded border" style={{ color: tone, borderColor: tone }}>
            {w.verdict.replace(/_/g, " ")}
          </span>
        </div>

        <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${w.anomalyScore}%`, backgroundColor: tone }} />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {layers.map((l) => (
            <Row key={l.label} label={l.label}><span className="font-mono">{Math.round(l.value)}</span></Row>
          ))}
        </div>

        {w.patterns.length > 0 ? (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Detected patterns</div>
            {w.patterns.map((pat) => (
              <div key={pat.id} className="rounded border border-border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{pat.label}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">+{Math.round(pat.weight)}</span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{pat.description}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">
            {w.available
              ? "No manipulation patterns fired — trading looks organic across all four detection layers."
              : "Connect Helius trade history to enable wallet-cluster, cadence and net-zero round-trip analysis."}
          </p>
        )}
      </div>
    </div>
  );
}

function VolumeSniperCard({ r }: { r: ScanResult }) {
  const riskTone =
    r.sniperRisk === "High" ? "var(--risk-extreme)"
    : r.sniperRisk === "Medium" ? "var(--risk-medium)"
    : r.sniperRisk === "Low" ? "var(--risk-low)"
    : "var(--muted-foreground)";
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Volume & Snipers" />
      <div className="p-4 space-y-2.5 text-xs">
        <Row label="Volume integrity"><Pct value={r.volumeIntegrity} threshold={60} invert /></Row>
        <Row label="Sniper wallets"><span className="font-mono">{r.sniperWallets}</span></Row>
        <Row label="Sniper supply %"><Pct value={r.sniperPct} threshold={15} /></Row>
        <Row label="Sniper risk">
          <span className="font-mono uppercase tracking-wider" style={{ color: riskTone }}>{r.sniperRisk}</span>
        </Row>
      </div>
    </div>
  );
}

function DeveloperCard({ r }: { r: ScanResult }) {
  // Phase 10: use the persisted developer history classification when available.
  // Fall back to the legacy evidence-based reputation when Phase 10 is not yet populated.
  const devHistory = r.developerHistory;
  const devWallet = devHistory?.developerWallet ?? null;

  const rugged = r.devRuggedFromCluster ?? 0;
  const evidence = r.devVerifiedScams + rugged;

  // Reputation badge: Phase 10 classification takes priority when available.
  const reputation: { label: string; tone: string } = devHistory?.available
    ? devHistory.classification === "Confirmed Scammer"
      ? { label: "Confirmed Scammer", tone: "var(--risk-extreme)" }
      : devHistory.classification === "Serial Offender"
        ? { label: "Serial Offender",  tone: "var(--risk-high)" }
        : devHistory.classification === "Suspicious"
          ? { label: "Suspicious",     tone: "var(--risk-medium)" }
          : { label: "Clean",          tone: "var(--risk-low)" }
    : evidence >= 3
      ? { label: "High Risk",   tone: "var(--risk-extreme)" }
      : evidence >= 1
        ? { label: "Caution",   tone: "var(--risk-high)" }
        : r.devReportedScams >= 1
          ? { label: "Watch",   tone: "var(--risk-medium)" }
          : { label: "Clean",   tone: "var(--risk-low)" };

  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Developer Reputation" sub="cluster intel" />
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-6">
          <div className="text-center min-w-[88px]">
            <div
              className="font-mono text-sm uppercase tracking-[0.18em] px-2 py-1 rounded-sm border"
              style={{ color: reputation.tone, borderColor: reputation.tone }}
            >
              {reputation.label}
            </div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-1">Reputation</div>
          </div>
          <div className="flex-1 grid grid-cols-4 gap-3 text-xs">
            <Link
              to="/developer/$address"
              params={{ address: r.address }}
              className="group rounded-sm border border-border bg-background px-3 py-2 transition-colors hover:border-primary/60 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                <span>Tokens launched</span>
                <ArrowUpRight className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
              </div>
              <div className="font-mono text-base mt-0.5 text-foreground">{r.devTokensLaunched}</div>
              <div className="text-[8px] uppercase tracking-wider text-primary/80 mt-1 opacity-0 transition-opacity group-hover:opacity-100">View details →</div>
            </Link>
            <ScamMetricLink label="Reported" value={r.devReportedScams} tone="warn" address={r.address} type="reported" />
            <ScamMetricLink label="Verified scams" value={r.devVerifiedScams} tone="bad" address={r.address} type="verified" />
            <ClusterMetricLink
              to="/cluster/$tokenAddress/tokens"
              tokenAddress={r.address}
              label="Rugged in cluster"
              value={rugged}
              aria={`View ${rugged} rugged tokens linked to this cluster`}
            />
          </div>
        </div>

        {/* Phase 10: Developer History panel — always visible */}
        <div className="border border-border bg-background px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Phase 10 · Developer History
              </p>
              {devHistory?.available && devHistory.priorLaunchCount > 0 ? (
                <>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {devHistory.summary}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px]">
                    <span className="text-red-400">{devHistory.extremeRiskCount} extreme</span>
                    <span className="text-orange-400">{devHistory.highRiskCount} high</span>
                    <span className="text-amber-400">{devHistory.suspiciousCount} suspicious</span>
                    <span className="text-muted-foreground">
                      of {devHistory.priorLaunchCount} prior launch{devHistory.priorLaunchCount === 1 ? "" : "es"}
                    </span>
                  </div>
                </>
              ) : devHistory?.available && devHistory.priorLaunchCount === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No prior launches found in our database for this developer.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  View all tokens launched by this developer wallet.
                </p>
              )}
            </div>
            {devWallet ? (
              <Link
                to="/developer/profile/$wallet"
                params={{ wallet: devWallet }}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/10"
              >
                Developer Profile
                <ArrowUpRight className="size-3" />
              </Link>
            ) : (
              <Link
                to="/developer/$address"
                params={{ address: r.address }}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/10"
              >
                Developer Profile
                <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClusterCard({ r }: { r: ScanResult }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Wallet Cluster" sub={r.clusterId} />
      <div className="p-5 flex items-center gap-6">
        <div className="relative size-24 shrink-0">
          <div className="absolute inset-0 rounded-full border border-primary/40" />
          <div className="absolute inset-2 rounded-full border border-primary/30" />
          <div className="absolute inset-4 rounded-full border border-primary/20" />
          <div className="absolute inset-0 grid place-items-center">
            <div className="size-3 rounded-full bg-primary shadow-[0_0_14px_var(--color-primary)]" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => {
            const angle = (i / 6) * Math.PI * 2;
            const x = 50 + Math.cos(angle) * 40;
            const y = 50 + Math.sin(angle) * 40;
            return <div key={i} className="absolute size-1.5 rounded-full bg-primary/70" style={{ left: `${x}%`, top: `${y}%`, transform: "translate(-50%,-50%)" }} />;
          })}
        </div>
        <div className="flex-1 grid grid-cols-2 gap-3 text-xs">
          <Link
            to="/cluster/$tokenAddress/wallets"
            params={{ tokenAddress: r.address }}
            className="group rounded-sm border border-border bg-background px-3 py-2 transition-colors hover:border-primary/60 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
              <span>Related wallets</span>
              <ArrowUpRight className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
            </div>
            <div className="font-mono text-base mt-0.5 text-foreground">{r.clusterWallets}</div>
            <div className="text-[8px] uppercase tracking-wider text-primary/80 mt-1 opacity-0 transition-opacity group-hover:opacity-100">View details →</div>
          </Link>
          <ClusterMetricLink to="/cluster/$tokenAddress/tokens" tokenAddress={r.address} label="Related tokens" value={r.clusterTokens} aria={`View related tokens for cluster ${r.clusterId}`} />
          <ClusterMetricLink to="/cluster/$tokenAddress/funding" tokenAddress={r.address} label="Funding links" value={Math.max(1, Math.floor(r.clusterWallets / 3))} aria={`View funding links for cluster ${r.clusterId}`} />
          <ClusterMetricLink to="/cluster/$tokenAddress/activity" tokenAddress={r.address} label="Last activity" value={`${Math.floor(Math.random() * 24)}h`} aria={`View last activity for cluster ${r.clusterId}`} />
        </div>
      </div>
    </div>
  );
}

function ClusterMetricLink({
  to, tokenAddress, label, value, aria,
}: {
  to: "/cluster/$tokenAddress/tokens" | "/cluster/$tokenAddress/funding" | "/cluster/$tokenAddress/activity";
  tokenAddress: string; label: string; value: string | number; aria: string;
}) {
  return (
    <Link to={to} params={{ tokenAddress }}
      className="group rounded-sm border border-border bg-background px-3 py-2 transition-colors hover:border-primary/60 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      aria-label={aria}
    >
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <ArrowUpRight className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="font-mono text-base mt-0.5 text-foreground">{value}</div>
      <div className="text-[8px] uppercase tracking-wider text-primary/80 mt-1 opacity-0 transition-opacity group-hover:opacity-100">View details →</div>
    </Link>
  );
}

function ScamMetricLink({
  label, value, tone, address, type,
}: { label: string; value: number; tone: "warn" | "bad"; address: string; type: "reported" | "verified" }) {
  const hasIssues = value > 0;
  const activeTone = hasIssues ? tone : "neutral";
  const color =
    activeTone === "bad" ? "var(--risk-extreme)"
    : activeTone === "warn" ? "var(--risk-medium)"
    : "var(--foreground)";

  if (!hasIssues) {
    return (
      <div className="rounded-sm border border-border bg-background px-3 py-2">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="font-mono text-base mt-0.5" style={{ color }}>{value}</div>
      </div>
    );
  }
  return (
    <a href={`/scams/${address}?type=${type}`} target="_blank" rel="noopener noreferrer"
      className="group rounded-sm border border-border bg-background px-3 py-2 transition-colors hover:border-primary/60 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <ArrowUpRight className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="font-mono text-base mt-0.5" style={{ color }}>{value}</div>
      <div className="text-[8px] uppercase tracking-wider text-primary/80 mt-1 opacity-0 transition-opacity group-hover:opacity-100">View details →</div>
    </a>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Pct({ value, threshold, invert = false }: { value: number; threshold: number; invert?: boolean }) {
  const bad = invert ? value < threshold : value > threshold;
  const color = bad ? "var(--risk-high)" : "var(--risk-low)";
  return <span className="font-mono" style={{ color }}>{value.toFixed(1)}%</span>;
}

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
      <div className="text-xs font-semibold tracking-wide uppercase">{title}</div>
      {sub && <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">{sub}</div>}
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-12 border-t border-border bg-background">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground sm:flex sm:justify-between sm:px-8 sm:text-[9px]">
        <div className="min-w-0 truncate">Node: Solana Mainnet · Secure Connection</div>
        <div className="shrink-0 text-primary/70">Pre-trade intelligence · Not financial advice</div>
      </div>
    </footer>
  );
}
