import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Wallet,
  Coins,
  Link2,
  Activity,
  Network,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";

// ---------- search params ----------
const searchSchema = z.object({
  address: fallback(z.string(), "").default(""),
  wallets: fallback(z.number().int().min(0), 0).default(0),
  tokens: fallback(z.number().int().min(0), 0).default(0),
  funding: fallback(z.number().int().min(0), 0).default(0),
  activity: fallback(z.string(), "").default(""),
  focus: fallback(z.enum(["wallets", "tokens", "funding", "activity", "all"]), "all").default("all"),
});

export const Route = createFileRoute("/cluster/$clusterId")({
  validateSearch: zodValidator(searchSchema),
  head: ({ params }) => ({
    meta: [
      { title: `Cluster ${params.clusterId} — Hierarchy` },
      {
        name: "description",
        content: `Interactive hierarchy of wallet cluster ${params.clusterId}: related wallets, tokens, funding links, and activity.`,
      },
    ],
  }),
  component: ClusterDetail,
});

// ---------- deterministic seeded RNG (FNV-1a) ----------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
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
function shortAddr(seed: number, prefix = ""): string {
  const r = rng(seed);
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789";
  let out = prefix;
  for (let i = 0; i < 44 - prefix.length; i++) out += chars[Math.floor(r() * chars.length)];
  return out;
}
function shorten(a: string): string {
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

// ---------- node detail payload ----------
type NodeKind = "root" | "group" | "wallet" | "token" | "funding" | "activity";
type NodeDetail = {
  kind: NodeKind;
  title: string;
  subtitle?: string;
  address?: string;
  source?: string;
  rows: { label: string; value: string }[];
};


// ---------- custom node ----------
const KIND_STYLE: Record<NodeKind, { color: string; icon: React.ComponentType<{ className?: string }> }> = {
  root: { color: "var(--color-primary)", icon: Network },
  group: { color: "var(--color-primary)", icon: Network },
  wallet: { color: "var(--color-primary)", icon: Wallet },
  token: { color: "var(--risk-medium, oklch(0.78 0.16 75))", icon: Coins },
  funding: { color: "var(--risk-low, oklch(0.72 0.16 145))", icon: Link2 },
  activity: { color: "var(--foreground)", icon: Activity },
};

type ClusterNodeData = { label: string; sub?: string; kind: NodeKind; detail: NodeDetail };

function ClusterNode({ data }: NodeProps) {
  const d = data as unknown as ClusterNodeData;
  const style = KIND_STYLE[d.kind];
  const Icon = style.icon;
  const isRoot = d.kind === "root";
  return (
    <div
      className="group rounded-md border bg-surface px-3 py-2 text-xs shadow-[0_0_0_1px_rgba(255,255,255,0.02)] transition-colors hover:border-primary/70 cursor-pointer"
      style={{
        borderColor: isRoot ? "var(--color-primary)" : "var(--border)",
        boxShadow: isRoot ? "0 0 24px -6px var(--color-primary)" : undefined,
        minWidth: isRoot ? 200 : 160,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-primary/60 !border-0 !w-1.5 !h-1.5" />
      <div className="flex items-center gap-2">
        <span
          className="grid place-items-center rounded-sm size-6 shrink-0"
          style={{ background: `color-mix(in oklab, ${style.color} 18%, transparent)`, color: style.color }}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono truncate" style={{ color: isRoot ? "var(--color-primary)" : "var(--foreground)" }}>
            {d.label}
          </div>
          {d.sub && (
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground truncate">{d.sub}</div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-primary/60 !border-0 !w-1.5 !h-1.5" />
    </div>
  );
}

const nodeTypes = { cluster: ClusterNode };

// ---------- tree build ----------
const CAP = { wallets: 6, tokens: 5, funding: 4, activity: 4 } as const;
const COL = 220;
const ROW = 110;

function buildGraph(
  clusterId: string,
  args: { address: string; wallets: number; tokens: number; funding: number; activity: string }
): { nodes: Node[]; edges: Edge[] } {
  const seed = hash(clusterId + "|" + args.address);
  const r = rng(seed);
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // root
  nodes.push({
    id: "root",
    type: "cluster",
    position: { x: 0, y: 0 },
    data: {
      label: clusterId,
      sub: "Cluster",
      kind: "root",
      detail: {
        kind: "root",
        title: clusterId,
        subtitle: "Wallet cluster root",
        address: args.address,
        rows: [
          { label: "Cluster ID", value: clusterId },
          { label: "Seed token", value: args.address || "—" },
          { label: "Related wallets", value: String(args.wallets) },
          { label: "Related tokens", value: String(args.tokens) },
          { label: "Funding links", value: String(args.funding) },
          { label: "Last activity", value: args.activity || "—" },
        ],
      } satisfies NodeDetail,
    },
  });

  const groups: Array<{
    id: string;
    label: string;
    count: number;
    kind: NodeKind;
    leafKind: NodeKind;
    leaf: (i: number, rr: () => number) => { label: string; sub?: string; detail: NodeDetail };
  }> = [
    {
      id: "g-wallets",
      label: "Related Wallets",
      count: Math.min(args.wallets, CAP.wallets),
      kind: "group",
      leafKind: "wallet",
      leaf: (i, rr) => {
        const addr = shortAddr(hash(clusterId + ":w:" + i));
        const bal = (rr() * 12).toFixed(2);
        const txs = Math.floor(rr() * 800);
        return {
          label: shorten(addr),
          sub: `${bal} SOL · ${txs} tx`,
          detail: {
            kind: "wallet",
            title: "Related Wallet",
            address: addr,
            source: "Co-spending heuristic · Helius RPC",
            rows: [
              { label: "Address", value: addr },
              { label: "Balance", value: `${bal} SOL` },
              { label: "Transactions", value: String(txs) },
              { label: "Cluster", value: clusterId },
              { label: "Source", value: "Co-spending heuristic · Helius RPC" },
            ],
          },
        };
      },
    },
    {
      id: "g-tokens",
      label: "Related Tokens",
      count: Math.min(args.tokens, CAP.tokens),
      kind: "group",
      leafKind: "token",
      leaf: (i, rr) => {
        const mint = shortAddr(hash(clusterId + ":t:" + i));
        const mcap = Math.floor(rr() * 9000) + 50;
        return {
          label: `TKN${(i + 1).toString().padStart(2, "0")}`,
          sub: `${shorten(mint)} · $${mcap}k`,
          detail: {
            kind: "token",
            title: `Token #${i + 1}`,
            address: mint,
            source: "SPL token program · Jupiter price feed",
            rows: [
              { label: "Mint", value: mint },
              { label: "Market cap", value: `$${mcap}k` },
              { label: "Launched by", value: "cluster wallet" },
              { label: "Cluster", value: clusterId },
              { label: "Source", value: "SPL token program · Jupiter" },
            ],
          },
        };
      },
    },
    {
      id: "g-funding",
      label: "Funding Links",
      count: Math.min(args.funding, CAP.funding),
      kind: "group",
      leafKind: "funding",
      leaf: (i, rr) => {
        const src = shortAddr(hash(clusterId + ":f:" + i), i % 2 ? "C" : "B");
        const amt = (rr() * 60).toFixed(2);
        const src_label = i % 2 ? "CEX deposit" : "Bridge inflow";
        return {
          label: src_label,
          sub: `${amt} SOL · ${shorten(src)}`,
          detail: {
            kind: "funding",
            title: src_label,
            address: src,
            source: `${src_label} trace · on-chain transfers`,
            rows: [
              { label: "From", value: src },
              { label: "Amount", value: `${amt} SOL` },
              { label: "Type", value: src_label },
              { label: "Cluster", value: clusterId },
              { label: "Source", value: `${src_label} trace` },
            ],
          },
        };
      },
    },
    {
      id: "g-activity",
      label: "Last Activity",
      count: Math.min(Math.max(1, args.activity ? CAP.activity : 0), CAP.activity),
      kind: "group",
      leafKind: "activity",
      leaf: (i, rr) => {
        const ago = `${Math.floor(rr() * 48) + i}h ago`;
        const kind = ["Swap", "Transfer", "Mint", "LP add"][i % 4];
        const sig = shortAddr(hash(clusterId + ":a:" + i));
        return {
          label: kind,
          sub: ago,
          detail: {
            kind: "activity",
            title: `${kind} · ${ago}`,
            address: sig,
            source: "Signature index · Solscan",
            rows: [
              { label: "Signature", value: sig },
              { label: "Type", value: kind },
              { label: "When", value: ago },
              { label: "Cluster", value: clusterId },
              { label: "Source", value: "Signature index · Solscan" },
            ],
          },
        };
      },
    },
  ];

  const totalWidth = (groups.length - 1) * (COL * 1.4);
  groups.forEach((g, gi) => {
    const gx = -totalWidth / 2 + gi * (COL * 1.4);
    const gy = ROW * 1.6;
    nodes.push({
      id: g.id,
      type: "cluster",
      position: { x: gx, y: gy },
      data: {
        label: g.label,
        sub: `${g.count} nodes`,
        kind: "group",
        detail: {
          kind: "group",
          title: g.label,
          rows: [{ label: "Count", value: String(g.count) }],
        },
      },
    });
    edges.push({
      id: `e-root-${g.id}`,
      source: "root",
      target: g.id,
      type: "smoothstep",
      animated: true,
      style: { stroke: "var(--color-primary)", strokeOpacity: 0.55 },
    });

    const childWidth = (g.count - 1) * (COL * 0.55);
    for (let i = 0; i < g.count; i++) {
      const leafId = `${g.id}-${i}`;
      const lx = gx - childWidth / 2 + i * (COL * 0.55);
      const ly = gy + ROW * 1.5;
      const leafData = g.leaf(i, r);
      nodes.push({
        id: leafId,
        type: "cluster",
        position: { x: lx, y: ly },
        data: {
          label: leafData.label,
          sub: leafData.sub,
          kind: g.leafKind,
          detail: leafData.detail,
        },
      });
      edges.push({
        id: `e-${g.id}-${i}`,
        source: g.id,
        target: leafId,
        type: "smoothstep",
        style: { stroke: "var(--border)", strokeOpacity: 0.7 },
      });
    }
  });

  return { nodes, edges };
}

// ---------- page ----------
function ClusterDetail() {
  const { clusterId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<NodeDetail | null>(null);

  const { nodes, edges } = useMemo(
    () =>
      buildGraph(clusterId, {
        address: search.address,
        wallets: search.wallets || 8,
        tokens: search.tokens || 6,
        funding: search.funding || 4,
        activity: search.activity || "—",
      }),
    [clusterId, search.address, search.wallets, search.tokens, search.funding, search.activity]
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const d = node.data as unknown as ClusterNodeData;
    if (d?.detail) setSelected(d.detail);
  }, []);

  const copy = (v: string) => navigator.clipboard?.writeText(v);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border bg-surface/40 backdrop-blur">
        <div className="max-w-[1400px] mx-auto px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate({ to: "/" })}
              className="gap-1.5"
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <div className="h-5 w-px bg-border" />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Wallet Cluster
              </div>
              <h1 className="font-mono text-lg text-primary truncate">{clusterId}</h1>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Badge variant="outline">{search.wallets || 0} wallets</Badge>
            <Badge variant="outline">{search.tokens || 0} tokens</Badge>
            <Badge variant="outline">{search.funding || 0} funding</Badge>
            <Badge variant="outline">{search.activity || "—"} activity</Badge>
          </div>
        </div>
      </header>

      <div className="relative h-[65vh] min-h-[420px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background gap={24} size={1} color="color-mix(in oklab, var(--foreground) 8%, transparent)" />
          <MiniMap
            pannable
            zoomable
            maskColor="color-mix(in oklab, var(--background) 70%, transparent)"
            style={{ background: "var(--color-surface, var(--background))", border: "1px solid var(--border)" }}
            nodeColor={(n) => {
              const k = (n.data as unknown as ClusterNodeData)?.kind ?? "root";
              return KIND_STYLE[k].color;
            }}
          />
          <Controls
            className="!bg-surface !border-border [&>button]:!bg-surface [&>button]:!border-border [&>button]:!text-foreground"
            showInteractive={false}
          />
        </ReactFlow>

        <div className="pointer-events-none absolute bottom-3 left-3 text-[10px] uppercase tracking-wider text-muted-foreground">
          Click a node for details · drag to pan · scroll to zoom
        </div>
      </div>

      <ClusterDetailLists nodes={nodes} onSelect={setSelected} />


      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-md bg-surface border-l border-border">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {(() => {
                    const Icon = KIND_STYLE[selected.kind].icon;
                    return (
                      <span
                        className="grid place-items-center rounded-sm size-7"
                        style={{
                          background: `color-mix(in oklab, ${KIND_STYLE[selected.kind].color} 18%, transparent)`,
                          color: KIND_STYLE[selected.kind].color,
                        }}
                      >
                        <Icon className="size-4" />
                      </span>
                    );
                  })()}
                  <span>{selected.title}</span>
                </SheetTitle>
                {selected.subtitle && (
                  <SheetDescription>{selected.subtitle}</SheetDescription>
                )}
              </SheetHeader>

              <div className="mt-5 space-y-2">
                {selected.rows.map((row) => (
                  <div
                    key={row.label}
                    className="rounded-sm border border-border bg-background px-3 py-2 flex items-start justify-between gap-3"
                  >
                    <div>
                      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                        {row.label}
                      </div>
                      <div className="font-mono text-xs mt-0.5 break-all">{row.value}</div>
                    </div>
                    {row.value.length > 16 && (
                      <button
                        type="button"
                        aria-label={`Copy ${row.label}`}
                        onClick={() => copy(row.value)}
                        className="text-muted-foreground hover:text-primary transition-colors shrink-0"
                      >
                        <Copy className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {selected.address && selected.kind === "token" && (
                <div className="mt-5">
                  <Link
                    to="/token/$address"
                    params={{ address: selected.address }}
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    Open token scan
                    <ExternalLink className="size-3.5" />
                  </Link>
                </div>
              )}

              {selected.address && selected.kind === "activity" && (
                <div className="mt-5">
                  <Link
                    to="/tx/$signature"
                    params={{ signature: selected.address }}
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    Open transaction details
                    <ExternalLink className="size-3.5" />
                  </Link>
                </div>
              )}


              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close details"
                className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---------- detailed lists below the diagram ----------
const LIST_GROUPS: Array<{ kind: NodeKind; title: string; source: string }> = [
  { kind: "wallet", title: "Related Wallets", source: "Co-spending heuristic · Helius RPC" },
  { kind: "token", title: "Related Tokens", source: "SPL token program · Jupiter" },
  { kind: "funding", title: "Funding Links", source: "Bridge / CEX deposit trace" },
  { kind: "activity", title: "Last Activity", source: "Signature index · Solscan" },
];

function ClusterDetailLists({
  nodes,
  onSelect,
}: {
  nodes: Node[];
  onSelect: (d: NodeDetail) => void;
}) {
  const byKind = useMemo(() => {
    const m: Record<NodeKind, ClusterNodeData[]> = {
      root: [], group: [], wallet: [], token: [], funding: [], activity: [],
    };
    for (const n of nodes) {
      const d = n.data as unknown as ClusterNodeData;
      if (d?.kind) m[d.kind].push(d);
    }
    return m;
  }, [nodes]);

  return (
    <section className="border-t border-border bg-background">
      <div className="max-w-[1400px] mx-auto px-5 py-8">
        <h2 className="text-sm uppercase tracking-wider text-muted-foreground mb-4">
          Detailed breakdown
        </h2>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {LIST_GROUPS.map((g) => {
            const items = byKind[g.kind];
            const Icon = KIND_STYLE[g.kind].icon;
            return (
              <div key={g.kind} className="rounded-md border border-border bg-surface overflow-hidden">
                <header className="flex items-center gap-2 px-3 py-2 border-b border-border">
                  <span
                    className="grid place-items-center rounded-sm size-6"
                    style={{
                      background: `color-mix(in oklab, ${KIND_STYLE[g.kind].color} 18%, transparent)`,
                      color: KIND_STYLE[g.kind].color,
                    }}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{g.title}</div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground truncate">
                      Source: {g.source}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{items.length}</Badge>
                </header>
                <ul className="divide-y divide-border">
                  {items.length === 0 && (
                    <li className="px-3 py-4 text-xs text-muted-foreground">No entries.</li>
                  )}
                  {items.map((d, i) => (
                    <li
                      key={i}
                      className="px-3 py-2 hover:bg-background/60 transition-colors cursor-pointer"
                      onClick={() => onSelect(d.detail)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-mono truncate">{d.label}</div>
                          {d.sub && (
                            <div className="text-[10px] text-muted-foreground truncate">{d.sub}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {d.detail.address && (
                            <a
                              href={
                                g.kind === "activity"
                                  ? `https://solscan.io/tx/${d.detail.address}`
                                  : `https://solscan.io/account/${d.detail.address}`
                              }
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-muted-foreground hover:text-primary"
                              aria-label="Open on Solscan"
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          )}
                          {g.kind === "activity" && d.detail.address && (
                            <Link
                              to="/tx/$signature"
                              params={{ signature: d.detail.address }}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[10px] uppercase tracking-wider text-primary hover:underline"
                            >
                              Details
                            </Link>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

