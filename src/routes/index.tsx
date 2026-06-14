import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, ShieldCheck } from "lucide-react";
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

/* --- Layout Components --- */
function TopBar() { /* ... unchanged ... */ return <header>...</header>; }
function Hero({ input, setInput, onScan, onSample, error, scanning }: any) { /* ... unchanged ... */ return <section>...</section>; }
function EmptyState() { /* ... unchanged ... */ return <section>...</section>; }
function ScanningState() { /* ... unchanged ... */ return <section>...</section>; }

/* ---------------- Report ---------------- */
function Report({ result }: { result: ScanResult }) {
  return (
    <section className="mt-2 space-y-4">
      <TokenHeader r={result} />
      <HoneyPotPanel r={result} />
      <div className="grid lg:grid-cols-3 gap-4">
        <RiskPanel r={result} />
        <div className="lg:col-span-2 grid sm:grid-cols-2 gap-4">
          <AuthorityCard label="Mint Authority" value={result.mintAuthority} tone={result.mintAuthority === "Revoked" ? "low" : "extreme"} detail={result.mintAuthority === "Revoked" ? "Supply is fixed." : "Dev can mint more tokens."} />
          <AuthorityCard label="Freeze Authority" value={result.freezeAuthority} tone={result.freezeAuthority === "Revoked" ? "low" : "high"} detail={result.freezeAuthority === "Revoked" ? "Cannot freeze accounts." : "Dev can freeze holder accounts."} />
          <AuthorityCard label="Sell Controls" value={result.sellControl} tone={result.sellControl === "Safe" ? "low" : result.sellControl === "Developer Controlled" ? "medium" : "extreme"} detail={result.sellControl === "Safe" ? "No transfer hooks detected." : "Developer can modify transfer rules."} />
          <AuthorityCard label="Sell Tax" value={result.sellTaxPct != null ? `${result.sellTaxPct.toFixed(2)}%` : "0%"} tone={result.sellTaxPct == null || result.sellTaxPct < 5 ? "low" : result.sellTaxPct < 10 ? "medium" : result.sellTaxPct < 20 ? "high" : "extreme"} detail={result.sellTaxPct == null ? "No SPL transfer fee configured." : `${result.sellTaxPct.toFixed(2)}% taken on every transfer.`} />
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

// ... TokenHeader, RiskPanel, etc. (keep your existing implementations) ...

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
          {/* AMENDED: Wrapped in Link for navigation */}
          <Link 
            to="/developer/$address/token/$mint" 
            params={{ 
              address: r.address, 
              mint: "all" 
            }}
            className="hover:opacity-80 transition-opacity"
          >
            <MetricBox label="Tokens launched" value={r.devTokensLaunched} />
          </Link>
          <MetricBox label="Reported" value={r.devReportedScams} tone={r.devReportedScams > 0 ? "warn" : "neutral"} />
          <MetricBox label="Verified scams" value={r.devVerifiedScams} tone={r.devVerifiedScams > 0 ? "bad" : "neutral"} />
        </div>
      </div>
    </div>
  );
}

// ... rest of file (ClusterCard, MetricBox, etc.) ...
