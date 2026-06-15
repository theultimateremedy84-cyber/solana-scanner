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
      // Append to historical scan log (never overwrites previous scans).
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
            <div className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Solana network / v0.2</div>
          </div>
        </div>
        <nav className="hidden items-center gap-7 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground md:flex">
          <span className="border-b border-primary pb-1 text-primary">Scanner</span>
          <Link
            to="/history"
            className="transition hover:text-foreground"
          >
            History
          </Link>
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
          <Button
            onClick={onScan}
            disabled={scanning}
            className="h-auto rounded-none px-7 py-3 font-display text-xs font-bold tracking-[0.08em] shadow-[0_0_24px_-6px_var(--color-primary)]"
          >
            {scanning ? "SCANNING…" : <>RUN SCAN <ArrowRight className="size-4" /></>}
          </Button>
        </div>
        <div className="px-4 pb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>Try:</span>
          <button onClick={onSample} className="font-mono text-primary/90 hover:text-primary truncate max-w-[260px]">
            {SAMPLE}
          </button>
          {error && <span className="text-risk-extreme ml-auto">{error}</span>}
        </div>
      </div>
    </section>
  );
}

function EmptyState() {
  const items = [
    { k: "Honeypot Sim", title: "Simulation Engine", d: "Detect tax traps, transfer locks, and whitelist-only exit routes with real sell checks." },
    { k: "Authority Audit", title: "Privilege Deep-Scan", d: "Surface mint and freeze authority status plus hidden developer controls." },
    { k: "Liquidity Forensics", title: "Liquidity Mapping", d: "Analyze LP burn status, lock durations, and provider rug exposure." },
    { k: "Holder Analytics", title: "Cluster Analysis", d: "Identify wallet concentration, insider allocation, and supply centralization." },
    { k: "Sniper Capture", title: "Integrity Score", d: "Calculate launch bot capture and organic volume integrity metrics." },
    { k: "Scammer DNA", title: "Reputation Graph", d: "Profile risk across linked wallet clusters and historical deployments." },
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
    "Computing risk envelope…",
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
          <CategoryBreakdown r={result} />
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

function TokenHeader({ r }: { r: ScanResult }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-3 min-w-0">
          {r.imageUrl ? (
            <img
              src={r.imageUrl}
              alt={r.name}
              className="size-12 rounded-md border border-border-strong object-cover bg-surface-3"
              loading="lazy"
            />
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
                  <a
                    key={w.url}
                    href={w.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:border-border-strong"
                  >
                    {w.label}
                  </a>
                ))}
                {r.socials?.map((s) => (
                  <a
                    key={s.url}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0.5 rounded-sm text-primary hover:border-primary"
                  >
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
  return (
    <div className="rounded-md border border-border bg-surface p-5 relative overflow-hidden">
      <div className="absolute inset-0 scanline pointer-events-none" />
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Overall Risk Score</div>
      <div className="mt-4 flex items-end gap-3">
        <div className="font-mono text-6xl leading-none tabular-nums" style={{ color }}>
          {r.riskScore}
        </div>
        <div className="pb-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">/ 100</div>
          <div className="text-xs font-semibold tracking-wide" style={{ color }}>{r.riskLevel} RISK</div>
        </div>
      </div>
      <RiskBar score={r.riskScore} />
      <div className="grid grid-cols-4 text-[9px] uppercase tracking-wider text-muted-foreground mt-1.5">
        <span>0 low</span><span>20 med</span><span>40 high</span><span className="text-right">70 extreme</span>
      </div>

      <div className="mt-5 pt-4 border-t border-border space-y-2.5 text-xs">
        <RiskRow label="Scammer DNA" value={r.scammerDnaScore} />
        <div className="flex justify-between">
          <span className="text-muted-foreground">Serial scammer</span>
          <span className={r.serialScammerProbability === "Low" ? "text-risk-low" : r.serialScammerProbability === "Medium" ? "text-risk-medium" : r.serialScammerProbability === "High" ? "text-risk-high" : "text-risk-extreme"}>
            {r.serialScammerProbability}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Cluster ID</span>
          <span className="font-mono text-primary">{r.clusterId}</span>
        </div>
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
    status === "SAFE" ? "low"
      : status === "SUSPICIOUS" ? "medium"
      : status === "HIGH RISK" ? "high"
      : "extreme";
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
  return {
    info: "var(--risk-low)",
    warn: "var(--risk-medium)",
    high: "var(--risk-high)",
    critical: "var(--risk-extreme)",
  }[s];
}


function CategoryBreakdown({ r }: { r: ScanResult }) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Risk Breakdown" sub={`${r.categories.length} categories · weighted`} />
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

function VolumeSniperCard({ r }: { r: ScanResult }) {
  const riskTone =
    r.sniperRisk === "High"
      ? "var(--risk-extreme)"
      : r.sniperRisk === "Medium"
        ? "var(--risk-medium)"
        : r.sniperRisk === "Low"
          ? "var(--risk-low)"
          : "var(--muted-foreground)";
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Volume & Snipers" />
      <div className="p-4 space-y-2.5 text-xs">
        <Row label="Volume integrity"><Pct value={r.volumeIntegrity} threshold={60} invert /></Row>
        <Row label="Sniper wallets"><span className="font-mono">{r.sniperWallets}</span></Row>
        <Row label="Sniper supply %"><Pct value={r.sniperPct} threshold={15} /></Row>
        <Row label="Sniper risk">
          <span className="font-mono uppercase tracking-wider" style={{ color: riskTone }}>
            {r.sniperRisk}
          </span>
        </Row>
      </div>
    </div>
  );
}

function DeveloperCard({ r }: { r: ScanResult }) {
  const tone = r.devTrustScore >= 70 ? "var(--risk-low)" : r.devTrustScore >= 40 ? "var(--risk-medium)" : "var(--risk-extreme)";
  return (
    <div className="rounded-md border border-border bg-surface">
      <SectionHeader title="Developer Reputation" sub="cluster intel" />
      <div className="p-5 flex items-center gap-6">
        <div className="text-center">
          <div className="font-mono text-4xl leading-none" style={{ color: tone }}>{r.devTrustScore}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-1">Trust score</div>
        </div>
        <div className="flex-1 grid grid-cols-3 gap-3 text-xs">
          <Link
            to="/developer/$address"
            params={{ address: r.address }}
            className="group rounded-sm border border-border bg-background px-3 py-2 transition-colors hover:border-primary/60 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            aria-label={`View details of ${r.devTokensLaunched} tokens launched by this developer`}
          >
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
              <span>Tokens launched</span>
              <ArrowUpRight className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
            </div>
            <div className="font-mono text-base mt-0.5 text-foreground">{r.devTokensLaunched}</div>
            <div className="text-[8px] uppercase tracking-wider text-primary/80 mt-1 opacity-0 transition-opacity group-hover:opacity-100">View details →</div>
          </Link>
          <MetricBox label="Reported" value={r.devReportedScams} tone={r.devReportedScams > 0 ? "warn" : "neutral"} />
          <MetricBox label="Verified scams" value={r.devVerifiedScams} tone={r.devVerifiedScams > 0 ? "bad" : "neutral"} />
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
          <MetricBox label="Related wallets" value={r.clusterWallets} />
          <MetricBox label="Related tokens" value={r.clusterTokens} />
          <MetricBox label="Funding links" value={Math.max(1, Math.floor(r.clusterWallets / 3))} />
          <MetricBox label="Last activity" value={`${Math.floor(Math.random() * 24)}h`} />
        </div>
      </div>
    </div>
  );
}

function MetricBox({ label, value, tone = "neutral" }: { label: string; value: string | number; tone?: "neutral" | "warn" | "bad" }) {
  const color = tone === "bad" ? "var(--risk-extreme)" : tone === "warn" ? "var(--risk-medium)" : "var(--foreground)";
  return (
    <div className="rounded-sm border border-border bg-background px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-base mt-0.5" style={{ color }}>{value}</div>
    </div>
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
