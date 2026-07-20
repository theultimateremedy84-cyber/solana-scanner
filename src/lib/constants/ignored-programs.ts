// =============================================================================
// src/lib/constants/ignored-programs.ts
//
// PURPOSE (P3 #17 fix — Technical Debt):
//   IGNORED_PROGRAMS was copy-pasted across wallet-collection-worker.ts,
//   tx-reconstructor.ts, and sol-transfer-indexer.ts. The three copies had
//   already silently diverged — sol-transfer-indexer included the Pump.fun
//   program ID while the others didn't — causing transaction classification
//   inconsistencies between the collection and enrichment paths.
//
//   This file is the single source of truth. All three modules now import
//   from here.
//
// APPLY: Replace the local IGNORED_PROGRAMS Set in each of:
//   - src/lib/api/wallet-collection-worker.ts
//   - src/lib/api/tx-reconstructor.ts
//   - src/lib/api/sol-transfer-indexer.ts
// =============================================================================

/**
 * Program / AMM / system account IDs that must be excluded when attributing
 * SOL spend or token receipt to a real wallet. These are protocol accounts,
 * not counterparties.
 *
 * AUTHORITATIVE LIST — edit here, import everywhere. Do NOT create local copies.
 */
export const IGNORED_PROGRAMS = new Set<string>([
  // ── Solana system / token programs ────────────────────────────────────────
  "11111111111111111111111111111111",                    // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",       // SPL Token Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",       // Token-2022
  "ComputeBudget111111111111111111111111111111",         // Compute Budget
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS",      // Associated Token Account Program

  // ── DEX / AMM programs ────────────────────────────────────────────────────
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",       // Jupiter Aggregator v6
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",       // Orca Whirlpool
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",      // Raydium AMM v4
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",      // Raydium AMM v5

  // ── Pump.fun programs ─────────────────────────────────────────────────────
  // FIX (P3 #17): previously missing from wallet-collection-worker.ts and
  // tx-reconstructor.ts but present in sol-transfer-indexer.ts. Now unified.
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",       // Pump.fun bonding curve program
]);
