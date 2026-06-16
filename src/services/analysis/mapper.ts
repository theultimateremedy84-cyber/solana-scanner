import { Trade } from "./types";

/**
 * ---------------------------------------------------------------------------
 * Data Enrichment Layer — Entity Tagging + Trade Origin Classification
 * ---------------------------------------------------------------------------
 *
 * This mapper has been upgraded from a thin field-renamer into the first
 * enrichment stage of the detection pipeline. It now:
 *
 *   1. Tags wallet addresses against a curated registry of known entities
 *      (CEX hot/deposit wallets, prolific contract/program deployers, and
 *      privacy-mixer style addresses).
 *   2. Classifies each transaction as `user_initiated` or `programmatic`
 *      (bot / aggregator / MEV / sandwich) based on signer composition,
 *      compute usage, instruction layout, and program routing.
 *   3. Surfaces enrichment fields on the `Trade` object so downstream
 *      layers (wallet cluster, cadence, txMetadata) can consume them
 *      without re-deriving the same heuristics.
 *
 * The registries below are intentionally small + extensible. In production
 * you would back these with a maintained dataset (Helius / Solscan labels,
 * Arkham, Chainabuse, etc.) and refresh them on a schedule.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Entity Tagging Registry
// ---------------------------------------------------------------------------

export type EntityTag =
  | "cex_hot_wallet"
  | "cex_deposit_wallet"
  | "contract_deployer"
  | "mixer"
  | "bridge"
  | "dex_program"
  | "aggregator"
  | "mev_bot"
  | "unknown";

export interface EntityLabel {
  tag: EntityTag;
  name: string;
  /** 0–1 confidence — manual registry entries are 1, heuristic guesses < 1 */
  confidence: number;
  /** Optional source attribution */
  source?: string;
}

/**
 * Curated registry. Extend / replace at runtime via `registerEntity()`.
 * Keys are base58 Solana addresses (case-sensitive).
 */
const ENTITY_REGISTRY: Record<string, EntityLabel> = {
  // ---- Major CEX hot wallets (Solana) ----
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": { tag: "cex_hot_wallet", name: "Binance Hot Wallet 1", confidence: 1, source: "registry" },
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": { tag: "cex_hot_wallet", name: "Binance Hot Wallet 2", confidence: 1, source: "registry" },
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": { tag: "cex_hot_wallet", name: "Coinbase Hot Wallet", confidence: 1, source: "registry" },
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS": { tag: "cex_hot_wallet", name: "Coinbase 2", confidence: 1, source: "registry" },
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2": { tag: "cex_hot_wallet", name: "Bybit", confidence: 1, source: "registry" },
  "FxteHmLwG9nk1eL4pjNve3Eub2goGkkz6g6TbvdmW46a": { tag: "cex_deposit_wallet", name: "Kraken Deposit", confidence: 1, source: "registry" },

  // ---- Privacy / mixer style protocols on Solana ----
  // (Solana has no Tornado Cash equivalent at scale; these are placeholders for
  //  known privacy frontends / coin-join routers — extend with real data.)
  "ELFkqMkN5GHL9YkSf9SgQq8VqzjAt3JzVe1k6yQK6f4u": { tag: "mixer", name: "Privacy Router (suspected)", confidence: 0.7, source: "heuristic" },

  // ---- Common bridges (often a funding origin worth flagging) ----
  "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb": { tag: "bridge", name: "Wormhole Bridge", confidence: 1, source: "registry" },
  "AxakFhB6tT9rkbgL93Nhe9srPzZbF7XnZQ8r5j9F2eEy": { tag: "bridge", name: "Allbridge", confidence: 1, source: "registry" },

  // ---- DEX / aggregator programs (treated as programmatic counterparties) ----
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": { tag: "aggregator", name: "Jupiter Aggregator v6", confidence: 1, source: "registry" },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { tag: "dex_program", name: "Raydium AMM v4", confidence: 1, source: "registry" },
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc":  { tag: "dex_program", name: "Orca Whirlpool", confidence: 1, source: "registry" },
};

/** Allow external code (tests, hot-loaders) to add labels at runtime. */
export function registerEntity(address: string, label: EntityLabel): void {
  ENTITY_REGISTRY[address] = label;
}

/**
 * Resolve an address against the registry, then fall back to heuristics for
 * unlabeled addresses. Heuristics use lightweight hints supplied by the
 * caller (deployedPrograms count, age, txCount) and never block.
 */
export function tagEntity(
  address: string,
  hints?: {
    deployedPrograms?: number;       // # of programs this wallet has deployed
    accountAgeDays?: number;
    txCount?: number;
    knownMixerRouted?: boolean;      // funded through a labelled mixer
  },
): EntityLabel {
  const direct = ENTITY_REGISTRY[address];
  if (direct) return direct;

  if (hints?.knownMixerRouted) {
    return { tag: "mixer", name: "Mixer-routed (heuristic)", confidence: 0.6, source: "heuristic" };
  }
  if ((hints?.deployedPrograms ?? 0) >= 1) {
    return {
      tag: "contract_deployer",
      name: "Contract Deployer",
      confidence: Math.min(1, 0.5 + 0.1 * (hints?.deployedPrograms ?? 0)),
      source: "heuristic",
    };
  }
  return { tag: "unknown", name: "Unknown", confidence: 0, source: "heuristic" };
}

// ---------------------------------------------------------------------------
// User-Initiated vs Programmatic classification
// ---------------------------------------------------------------------------

export type TradeOrigin = "user_initiated" | "programmatic" | "unknown";

export interface OriginClassification {
  origin: TradeOrigin;
  /** 0–1 confidence */
  confidence: number;
  reasons: string[];
}

/**
 * Heuristic signals — any single strong hit flips the trade to
 * `programmatic`; otherwise we weigh several weak signals.
 */
export function classifyTradeOrigin(rawTx: any): OriginClassification {
  const reasons: string[] = [];
  let programmaticScore = 0;
  let userScore = 0;

  const programIds: string[] = rawTx.programIds ?? rawTx.meta?.loadedAddresses?.programIds ?? [];
  const computeUnits: number | undefined = rawTx.meta?.computeUnitsConsumed ?? rawTx.computeUnits;
  const priorityFee: number | undefined  = rawTx.meta?.priorityFee ?? rawTx.priorityFee;
  const innerIxCount: number | undefined = rawTx.meta?.innerInstructions?.length;
  const signers: string[] = rawTx.signers ?? (rawTx.signer ? [rawTx.signer] : []);
  const feePayer: string | undefined = rawTx.feePayer ?? signers[0];

  // 1. Aggregator / MEV programs invoked => programmatic
  const programmaticProgramTags = new Set<EntityTag>(["aggregator", "mev_bot"]);
  for (const pid of programIds) {
    const tag = tagEntity(pid).tag;
    if (programmaticProgramTags.has(tag)) {
      programmaticScore += 2;
      reasons.push(`invokes ${tag} program ${pid.slice(0, 6)}…`);
      break;
    }
  }

  // 2. Fee payer differs from signer (relayer / bot pattern)
  if (feePayer && signers.length > 0 && feePayer !== signers[0]) {
    programmaticScore += 2;
    reasons.push("fee payer ≠ user signer (relayer pattern)");
  }

  // 3. Very high priority fee — sandwich / sniper bots
  if (typeof priorityFee === "number" && priorityFee > 1_000_000) {
    programmaticScore += 1;
    reasons.push(`elevated priority fee (${priorityFee})`);
  }

  // 4. Many inner instructions (multi-hop route built off-chain)
  if (typeof innerIxCount === "number" && innerIxCount >= 6) {
    programmaticScore += 1;
    reasons.push(`${innerIxCount} inner instructions (multi-hop route)`);
  }

  // 5. Uniform / extremely tight compute usage tends to be bot-built
  if (typeof computeUnits === "number" && computeUnits > 0 && computeUnits % 1000 === 0) {
    programmaticScore += 1;
    reasons.push("round compute-unit budget");
  }

  // 6. Source app metadata if present (Phantom / Backpack / Jupiter UI etc.)
  const source: string | undefined = rawTx.source ?? rawTx.meta?.source;
  if (source) {
    if (/phantom|backpack|solflare|magiceden/i.test(source)) {
      userScore += 2;
      reasons.push(`signed via end-user wallet (${source})`);
    } else if (/bot|sniper|mev|jito/i.test(source)) {
      programmaticScore += 2;
      reasons.push(`source app suggests bot (${source})`);
    }
  }

  const total = programmaticScore + userScore;
  if (total === 0) {
    return { origin: "unknown", confidence: 0, reasons };
  }

  if (programmaticScore > userScore) {
    return {
      origin: "programmatic",
      confidence: Math.min(1, programmaticScore / (total + 1)),
      reasons,
    };
  }
  return {
    origin: "user_initiated",
    confidence: Math.min(1, userScore / (total + 1)),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

export function mapToEngineTrade(rawTx: any): Trade {
  const wallet: string = rawTx.signer ?? rawTx.feePayer;
  const walletEntity = tagEntity(wallet, {
    deployedPrograms: rawTx.walletHints?.deployedPrograms,
    accountAgeDays:   rawTx.walletHints?.accountAgeDays,
    txCount:          rawTx.walletHints?.txCount,
    knownMixerRouted: rawTx.walletHints?.knownMixerRouted,
  });

  const origin = classifyTradeOrigin(rawTx);

  return {
    signature: rawTx.signature,
    timestamp: rawTx.blockTime * 1000,
    wallet,
    side: rawTx.type,                 // "buy" | "sell"
    amount: rawTx.amount,
    quoteAmount: rawTx.quoteAmount,

    // existing optional metadata
    computeUnits: rawTx.meta?.computeUnitsConsumed ?? rawTx.computeUnits,
    instructionFingerprint: rawTx.instructionFingerprint,
    programIds: rawTx.programIds,
    funderWallet: rawTx.funderWallet,

    // NEW enrichment
    walletEntity,
    origin: origin.origin,
    originConfidence: origin.confidence,
    originReasons: origin.reasons,
  };
}

/**
 * Convenience: bulk-map an array, preserving order. Useful in workers /
 * background enrichment jobs where you want a single call site.
 */
export function mapManyToEngineTrades(rawTxs: any[]): Trade[] {
  return rawTxs.map(mapToEngineTrade);
}
