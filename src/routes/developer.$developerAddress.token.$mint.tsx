import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDeveloperProjectDetail } from "@/lib/developer-intel.functions";
import { formatUsd } from "@/lib/mockScan";

type DetailData = Awaited<ReturnType<typeof getDeveloperProjectDetail>>;

export const Route = createFileRoute("/developer/$developerAddress/token/$mint")({
  head: () => ({
    meta: [
      { title: "Developer Project Activity — Scam Intel" },
      {
        name: "description",
        content:
          "Developer roles, authority controls, and related Solana transactions for a token project.",
      },
      { property: "og:title", content: "Developer Project Activity — Scam Intel" },
      {
        property: "og:description",
        content: "Review a developer wallet's role and on-chain activity in a Solana token.",
      },
    ],
  }),
  component: DeveloperProjectDetailPage,
});

function DeveloperProjectDetailPage() {
  const { developerAddress, mint } = Route.useParams();
  const loadDetail = useServerFn(getDeveloperProjectDetail);
  const [data, setData] = useState<DetailData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    loadDetail({ data: { developerAddress, mint } })
      .then(setData)
      .catch(() => setFailed(true));
  }, [developerAddress, mint, loadDetail]);

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame mx-auto min-h-[calc(100vh-3rem)] max-w-7xl border border-border bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Project attribution
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">
              Developer role & transactions
            </h1>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/developer/$address" params={{ address: mint }}>
              <ArrowLeft />
              All projects
            </Link>
          </Button>
        </header>
        <main className="px-5 py-8 sm:px-8">
          {!data && !failed && (
            <p className="py-16 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Tracing on-chain activity…
            </p>
          )}
          {failed && (
            <p className="py-16 text-center text-sm text-destructive">
              Project activity could not be loaded.
            </p>
          )}
          {data && (
            <>
              <section className="flex flex-wrap items-center gap-4 border-b border-border pb-6">
                {data.imageUrl ? (
                  <img
                    src={data.imageUrl}
                    alt={`${data.name} logo`}
                    className="size-14 rounded-full"
                  />
                ) : (
                  <div className="grid size-14 place-items-center rounded-full border border-primary/40 text-primary">
                    <ShieldCheck />
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="font-display text-3xl font-semibold">
                    {data.name}{" "}
                    <span className="font-mono text-base text-primary">{data.symbol}</span>
                  </h2>
                  <p className="break-all font-mono text-[10px] text-muted-foreground">
                    {data.mint}
                  </p>
                </div>
              </section>
              <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric label="Developer role" value={data.roles.join(" · ")} />
                <Metric label="Market cap" value={formatUsd(data.marketCap)} />
                <Metric label="Liquidity" value={formatUsd(data.liquidity)} />
                <Metric label="24h volume" value={formatUsd(data.volume24h)} />
              </section>
              <section className="mt-6 grid gap-4 lg:grid-cols-2">
                <Panel title="Attribution">
                  <Row label="Developer wallet" value={data.developerAddress} />
                  <Row label="Mint authority" value={data.mintAuthority ?? "Revoked / none"} />
                  <Row label="Freeze authority" value={data.freezeAuthority ?? "Revoked / none"} />
                  <Row
                    label="Market created"
                    value={data.createdAt ? new Date(data.createdAt).toLocaleString() : "Unknown"}
                  />
                </Panel>
                <Panel title="Risk context">
                  <Row label="Provider risk score" value={String(data.riskScore)} />
                  <Row label="Identified roles" value={data.roles.join(", ")} />
                  <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                    Roles are derived from the token creator, mint-authority, and freeze-authority
                    fields. Related transactions are wallet activity where this token mint appears.
                  </p>
                </Panel>
              </section>
              <section className="mt-8 border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wide">
                    Related developer transactions
                  </h2>
                  <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    {data.relatedTransactions.length} found
                  </span>
                </div>
                {!data.activityAvailable && (
                  <p className="p-5 text-sm text-muted-foreground">
                    Transaction enrichment requires HELIUS_API_KEY on the deployed server.
                  </p>
                )}
                {data.activityAvailable && data.relatedTransactions.length === 0 && (
                  <p className="p-5 text-sm text-muted-foreground">
                    No recent developer-wallet transactions involving this token were found in the
                    latest activity window.
                  </p>
                )}
                {data.relatedTransactions.map((transaction) => (
                  <article
                    key={transaction.signature}
                    className="grid gap-2 border-b border-border p-4 last:border-0 sm:grid-cols-[140px_1fr_auto] sm:items-center"
                  >
                    <div>
                      <p className="font-mono text-xs text-primary">{transaction.type}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {transaction.timestamp
                          ? new Date(transaction.timestamp * 1000).toLocaleString()
                          : "Time unavailable"}
                      </p>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {transaction.description}
                    </p>
                    <Button asChild variant="ghost" size="sm">
                      <a
                        href={`https://solscan.io/tx/${transaction.signature}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Explorer
                        <ExternalLink />
                      </a>
                    </Button>
                  </article>
                ))}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm text-primary">{value}</p>
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border">
      <h3 className="border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide">
        {title}
      </h3>
      <div className="space-y-3 p-4">{children}</div>
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border pb-3 text-xs last:border-0 last:pb-0 sm:flex-row sm:justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all font-mono sm:max-w-[65%] sm:text-right">{value}</span>
    </div>
  );
}
