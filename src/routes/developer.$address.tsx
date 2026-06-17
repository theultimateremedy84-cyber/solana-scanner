import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Coins, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getDeveloperProjects } from "@/lib/developer-intel.functions";
import { formatUsd } from "@/lib/mockScan";

type ProjectData = Awaited<ReturnType<typeof getDeveloperProjects>>;

export const Route = createFileRoute("/developer/$address")({
  head: () => ({
    meta: [
      { title: "Developer Projects — Scam Intel" },
      {
        name: "description",
        content:
          "Tokens launched by a Solana developer wallet, with live project and market details.",
      },
      { property: "og:title", content: "Developer Projects — Scam Intel" },
      {
        property: "og:description",
        content: "Inspect every token linked to a Solana developer wallet.",
      },
    ],
  }),
  component: DeveloperProjectsPage,
});

function DeveloperProjectsPage() {
  const { address } = Route.useParams();
  const loadProjects = useServerFn(getDeveloperProjects);
  const [data, setData] = useState<ProjectData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    loadProjects({ data: { tokenAddress: address } })
      .then(setData)
      .catch(() => setFailed(true));
  }, [address, loadProjects]);

  return (
    <div className="min-h-screen bg-background px-3 py-3 text-foreground sm:px-6 sm:py-6 lg:px-8">
      <div className="hud-frame relative mx-auto min-h-[calc(100vh-3rem)] max-w-7xl border border-border bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-primary">
              Developer intelligence
            </p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Launched token projects</h1>
          </div>
          <nav className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/developer/watchlist">Watchlist</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/">
                <ArrowLeft />
                Scanner
              </Link>
            </Button>
          </nav>
        </header>

        <main className="px-5 py-8 sm:px-8">
          <section className="grid gap-3 border-y border-border py-4 sm:grid-cols-3">
            <Intel label="Source token" value={short(address)} icon={<Coins />} />
            <Intel
              label="Developer wallet"
              value={data?.developerAddress ? short(data.developerAddress) : "Resolving…"}
              icon={<Wallet />}
            />
            <Intel
              label="Known launches"
              value={data ? String(data.totalProjects) : "—"}
              icon={<ArrowUpRight />}
            />
          </section>

          {!data && !failed && (
            <p className="py-16 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Mapping creator projects…
            </p>
          )}
          {failed && (
            <p className="py-16 text-center text-sm text-destructive">
              Developer data could not be loaded. Please retry.
            </p>
          )}
          {data && data.projects.length === 0 && (
            <div className="my-10 border border-border bg-background p-8 text-center">
              <h2 className="font-display text-xl font-semibold">No linked launches returned</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                The security data provider does not currently expose prior projects for this
                creator.
              </p>
            </div>
          )}

          {data && data.projects.length > 0 && (
            <section className="mt-8 overflow-x-auto border border-border">
              <table className="w-full min-w-[850px] text-left text-xs">
                <thead className="border-b border-border bg-background font-mono uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Project</th>
                    <th className="px-4 py-3">Mint</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Market cap</th>
                    <th className="px-4 py-3">Liquidity</th>
                    <th className="px-4 py-3">24h volume</th>
                    <th className="px-4 py-3">Intel</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => (
                    <tr
                      key={project.mint}
                      className="border-b border-border last:border-0 hover:bg-accent/30"
                    >
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-3">
                          {project.imageUrl ? (
                            <img
                              src={project.imageUrl}
                              alt={`${project.name} logo`}
                              className="size-8 rounded-full"
                              loading="lazy"
                            />
                          ) : (
                            <div className="grid size-8 place-items-center rounded-full border border-primary/40 font-mono text-primary">
                              {project.symbol.slice(0, 1)}
                            </div>
                          )}
                          <div>
                            <div className="font-semibold">{project.name}</div>
                            <div className="font-mono text-muted-foreground">{project.symbol}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4 font-mono text-muted-foreground">
                        {short(project.mint)}
                      </td>
                      <td className="px-4 py-4 font-mono">{formatDate(project.createdAt)}</td>
                      <td className="px-4 py-4 font-mono">{formatUsd(project.marketCap)}</td>
                      <td className="px-4 py-4 font-mono">{formatUsd(project.liquidity)}</td>
                      <td className="px-4 py-4 font-mono">{formatUsd(project.volume24h)}</td>
                      <td className="px-4 py-4">
                        <Button asChild variant="link" size="sm">
                          <Link
                            to="/developer/$developerAddress/token/$mint"
                            params={{ developerAddress: data.developerAddress, mint: project.mint }}
                          >
                            View role & transactions
                            <ArrowUpRight />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function Intel({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 bg-background px-4 py-3">
      <span className="text-primary [&_svg]:size-4">{icon}</span>
      <div>
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-0.5 font-mono text-sm">{value}</p>
      </div>
    </div>
  );
}

const short = (value: string) => `${value.slice(0, 7)}…${value.slice(-6)}`;
const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString() : "Unknown";
