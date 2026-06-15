import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { AlertTriangle, ArrowLeft, ExternalLink, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { scanTokenLive } from "@/lib/scan.functions";
import type { DevRiskIssue, ScanResult } from "@/lib/mockScan";

const searchSchema = z.object({
  type: z.enum(["reported", "verified"]).catch("verified").default("verified"),
});

export const Route = createFileRoute("/scams/$address")({
  validateSearch: (search) => searchSchema.parse(search),
  head: () => ({
    meta: [
      { title: "Developer Scam History — Scam Intel" },
      {
        name: "description",
        content:
          "Detailed view of reported issues and verified scam patterns linked to a Solana developer wallet.",
      },
      { property: "og:title", content: "Developer Scam History — Scam Intel" },
      {
        property: "og:description",
        content:
          "Inspect every reported issue and verified scam pattern flagged for a Solana developer.",
      },
    ],
  }),
  component: ScamHistoryPage,
});

function ScamHistoryPage() {
  const { address } = Route.useParams();
  const { type } = Route.useSearch();
  const runLiveScan = useServerFn(scanTokenLive);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setResult(null);
    runLiveScan({ data: { address } })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [address, runLiveScan]);

  const issues = useMemo<DevRiskIssue[]>(() => {
    if (!result) return [];
    return type === "verified" ? result.devVerifiedIssues : result.devReportedIssues;
  }, [result, type]);

  const isVerified = type === "verified";
  const accent = isVerified ? "var(--risk-extreme)" : "var(--risk-medium)";
  const heading = isVerified ? "Verified Scam Patterns" : "Reported Issues";
  const blurb = isVerified
    ? "Confirmed scam patterns flagged at the highest severity by RugCheck for the developer wallet behind this token. These are well-known scam fingerprints — treat them as red flags."
    : "Community-reported and heuristic warnings raised by RugCheck for the developer wallet behind this token. They indicate suspicious patterns that warrant a closer look but are not yet classified as confirmed scams.";

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-5xl border border-border bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Developer reputation
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">{heading}</h1>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/">
              <ArrowLeft />
              Back to scanner
            </Link>
          </Button>
        </header>

        <main className="space-y-6 px-5 py-8 sm:px-8">
          <section className="grid gap-3 border border-border bg-background p-4 sm:grid-cols-2">
            <div>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Scanned token
              </p>
              <p className="mt-0.5 break-all font-mono text-sm">{address}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Category
              </p>
              <p className="mt-0.5 font-mono text-sm" style={{ color: accent }}>
                {isVerified ? "Verified scam" : "Reported issue"}
                {result ? ` · ${issues.length} finding${issues.length === 1 ? "" : "s"}` : ""}
              </p>
            </div>
          </section>

          <p className="text-sm leading-relaxed text-muted-foreground">{blurb}</p>

          {!result && !failed && (
            <p className="py-16 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Loading developer history…
            </p>
          )}

          {failed && (
            <p className="py-16 text-center text-sm text-destructive">
              Could not load scam history. Please retry from the scanner.
            </p>
          )}

          {result && issues.length === 0 && (
            <div className="border border-border bg-background p-8 text-center">
              <h2 className="font-display text-xl font-semibold">No {isVerified ? "verified scams" : "reported issues"} found</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                RugCheck does not currently list any {isVerified ? "verified scam patterns" : "reported issues"} for this token's developer.
              </p>
            </div>
          )}

          {result && issues.length > 0 && (
            <ul className="space-y-3">
              {issues.map((issue, idx) => (
                <IssueCard key={`${issue.name}-${idx}`} issue={issue} accent={accent} />
              ))}
            </ul>
          )}

          {result && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
              <span className="font-mono uppercase tracking-wider">Cross-check sources:</span>
              <ExternalLinkChip
                href={`https://rugcheck.xyz/tokens/${address}`}
                label="RugCheck report"
              />
              <ExternalLinkChip
                href={`https://solscan.io/token/${address}`}
                label="Solscan"
              />
              <ExternalLinkChip
                href={`https://dexscreener.com/solana/${address}`}
                label="DexScreener"
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function IssueCard({ issue, accent }: { issue: DevRiskIssue; accent: string }) {
  const Icon = issue.level === "danger" ? ShieldAlert : AlertTriangle;
  const scoreLabel =
    typeof issue.score === "number" && isFinite(issue.score)
      ? `Severity ${Math.round(issue.score)}`
      : null;
  return (
    <li className="border border-border bg-background p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 [&_svg]:size-4" style={{ color: accent }}>
          <Icon />
        </span>
        <div className="flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-semibold">{issue.name}</h3>
            <span
              className="rounded-sm border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
              style={{ color: accent, borderColor: accent }}
            >
              {issue.level === "danger" ? "Verified scam" : "Reported"}
              {scoreLabel ? ` · ${scoreLabel}` : ""}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {issue.description}
          </p>
          {issue.value != null && issue.value !== "" && (
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
              Evidence: {issue.value}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function ExternalLinkChip({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-foreground transition-colors hover:border-primary/60 hover:text-primary"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  );
}
