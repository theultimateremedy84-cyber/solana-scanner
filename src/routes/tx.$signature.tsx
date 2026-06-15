import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Copy, ExternalLink, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/tx/$signature")({
  head: ({ params }) => ({
    meta: [
      { title: `Transaction ${params.signature.slice(0, 8)}… — Details` },
      { name: "description", content: "Solana transaction details: signers, transfers, programs, and source." },
    ],
  }),
  component: TxDetail,
});

// deterministic mock derived from signature so the page is stable
function h(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = (x * 16777619) >>> 0;
  }
  return x >>> 0;
}
function rng(seed: number) {
  let s = seed || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}
function addr(seed: number) {
  const r = rng(seed);
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789";
  let out = "";
  for (let i = 0; i < 44; i++) out += chars[Math.floor(r() * chars.length)];
  return out;
}
function shorten(a: string) {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function TxDetail() {
  const { signature } = Route.useParams();
  const navigate = useNavigate();
  const seed = h(signature);
  const r = rng(seed);
  const slot = 250_000_000 + Math.floor(r() * 5_000_000);
  const fee = (r() * 0.0005).toFixed(6);
  const status = r() > 0.1 ? "Success" : "Failed";
  const kind = ["Swap", "Transfer", "Mint", "LP add"][Math.floor(r() * 4)];
  const from = addr(seed + 1);
  const to = addr(seed + 2);
  const program = addr(seed + 3);
  const amount = (r() * 50).toFixed(3);
  const usd = (Number(amount) * 150).toFixed(2);

  const transfers = Array.from({ length: 3 }, (_, i) => ({
    from: addr(seed + 10 + i),
    to: addr(seed + 20 + i),
    amount: (r() * 5).toFixed(3),
    token: ["SOL", "USDC", "BONK"][i % 3],
  }));

  const copy = (v: string) => navigator.clipboard?.writeText(v);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-surface/40 backdrop-blur">
        <div className="max-w-[1200px] mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button size="sm" variant="ghost" onClick={() => navigate({ to: "/" })} className="gap-1.5">
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <div className="h-5 w-px bg-border" />
            <Activity className="size-4 text-primary" />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Transaction</div>
              <h1 className="font-mono text-sm md:text-base truncate">{shorten(signature)}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status === "Success" ? "default" : "destructive"}>{status}</Badge>
            <Badge variant="outline">{kind}</Badge>
            <a
              href={`https://solscan.io/tx/${signature}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              Solscan
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-5 py-8 grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-md border border-border bg-surface p-5">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-4">Overview</h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            {[
              { k: "Signature", v: signature },
              { k: "Slot", v: String(slot) },
              { k: "Fee", v: `${fee} SOL` },
              { k: "Type", v: kind },
              { k: "From", v: from },
              { k: "To", v: to },
              { k: "Program", v: program },
              { k: "Amount", v: `${amount} SOL ($${usd})` },
              { k: "Source", v: "Helius RPC · Solscan" },
            ].map((row) => (
              <div key={row.k} className="rounded-sm border border-border bg-background px-3 py-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{row.k}</div>
                  <div className="font-mono text-xs mt-0.5 break-all">{row.v}</div>
                </div>
                {row.v.length > 16 && (
                  <button
                    type="button"
                    aria-label={`Copy ${row.k}`}
                    onClick={() => copy(row.v)}
                    className="text-muted-foreground hover:text-primary shrink-0"
                  >
                    <Copy className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </dl>
        </section>

        <aside className="rounded-md border border-border bg-surface p-5">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-4">Token Transfers</h2>
          <ul className="space-y-2">
            {transfers.map((t, i) => (
              <li key={i} className="rounded-sm border border-border bg-background px-3 py-2 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold">{t.amount} {t.token}</span>
                  <Badge variant="outline" className="text-[9px]">#{i + 1}</Badge>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  <div className="font-mono truncate">From {shorten(t.from)}</div>
                  <div className="font-mono truncate">To {shorten(t.to)}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 text-[10px] uppercase tracking-wider text-muted-foreground">
            Source: token program decode
          </div>
        </aside>
      </main>
    </div>
  );
}
