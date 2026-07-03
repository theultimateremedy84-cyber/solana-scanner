// =============================================================================
// Regression tests for upsertPerformanceRow (wallet-enricher.ts)
//
// Guards against the bug fixed on 2026-07-03: total_sol_received was
// computed correctly (from position.totalSolReceived) but never included
// in the upsert payload sent to wallet_performance_history, so the column
// stayed at its table default (0) for every wallet this path touched.
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import { upsertPerformanceRow, type ExistingPerfRow } from "./wallet-enricher";
import type { ReconstructedPosition } from "./tx-reconstructor";
import type { TokenPriceData } from "./wallet-collection.types";

function makePosition(overrides: Partial<ReconstructedPosition> = {}): ReconstructedPosition {
  return {
    walletAddress: "WalletAddr1111111111111111111111111111111",
    tokenAddress: "TokenAddr1111111111111111111111111111111",
    trades: [],
    firstTradeTs: null,
    lastTradeTs: null,
    totalTokensBought: 1000,
    totalTokensSold: 400,
    initialInvestment: 2.5,
    totalSolReceived: 1.8,
    currentTokenBalance: 600,
    positionStatus: "PARTIALLY_CLOSED",
    realizedProfit: 0.3,
    unrealizedProfit: 0.5,
    roiMultiple: 1.2,
    currentPositionValueSol: 3,
    peakRoi: 1.5,
    peakPositionValueSol: 4,
    ...overrides,
  } as ReconstructedPosition;
}

const priceData: TokenPriceData = {
  priceSol: 0.001,
  priceUsd: 0.15,
  marketCapUsd: 150_000,
  fetchedAt: new Date().toISOString(),
  liquidityUsd: null,
  fdvUsd: null,
  volume24hUsd: null,
  pairAddress: null,
  dexId: null,
};

/** Minimal mock of the Supabase client surface upsertPerformanceRow touches. */
function makeMockSupabase() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn().mockReturnValue({ upsert });
  return { from, upsert } as unknown as { from: typeof from; upsert: typeof upsert };
}

describe("upsertPerformanceRow", () => {
  it("includes total_sol_received in the upsert payload, matching current_value", async () => {
    const sb = makeMockSupabase();
    const position = makePosition({ totalSolReceived: 1.8 });
    const errors: string[] = [];

    await upsertPerformanceRow(sb as any, position, priceData, undefined, errors);

    expect(sb.from).toHaveBeenCalledWith("wallet_performance_history");
    expect(sb.upsert).toHaveBeenCalledTimes(1);

    const [row] = sb.upsert.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(row).toHaveProperty("total_sol_received", 1.8);
    expect(row.total_sol_received).toBe(row.current_value);
  });

  it("never writes total_sol_received as 0 when the wallet actually received SOL", async () => {
    const sb = makeMockSupabase();
    const position = makePosition({ totalSolReceived: 42.7 });
    const errors: string[] = [];

    await upsertPerformanceRow(sb as any, position, priceData, undefined, errors);

    const [row] = sb.upsert.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(row.total_sol_received).toBe(42.7);
    expect(row.total_sol_received).not.toBe(0);
  });

  it("still writes 0 for a wallet that genuinely received no SOL (no false positive)", async () => {
    const sb = makeMockSupabase();
    const position = makePosition({ totalSolReceived: 0 });
    const errors: string[] = [];

    await upsertPerformanceRow(sb as any, position, priceData, undefined, errors);

    const [row] = sb.upsert.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(row.total_sol_received).toBe(0);
  });

  it("upserts onConflict wallet_address,token_address so re-runs update, not duplicate, rows", async () => {
    const sb = makeMockSupabase();
    const position = makePosition();
    const errors: string[] = [];

    await upsertPerformanceRow(sb as any, position, priceData, undefined, errors);

    const [, opts] = sb.upsert.mock.calls[0] as [unknown, { onConflict: string }];
    expect(opts.onConflict).toBe("wallet_address,token_address");
  });

  it("records an error message (without throwing) when the upsert fails", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: "constraint violation" } });
    const from = vi.fn().mockReturnValue({ upsert });
    const sb = { from } as any;

    const position = makePosition();
    const errors: string[] = [];

    await expect(
      upsertPerformanceRow(sb, position, priceData, undefined, errors),
    ).resolves.not.toThrow();

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("constraint violation");
  });

  it("preserves a higher-ranked existing position_status instead of downgrading it", async () => {
    const sb = makeMockSupabase();
    const position = makePosition({ positionStatus: "OPEN" });
    const existing: ExistingPerfRow = {
      position_status: "CLOSED",
      initial_investment: 5,
      current_token_balance: 0,
      roi_multiple: 2,
      realized_profit: 3,
      peak_roi: 2.5,
      peak_position_value_sol: 6,
      reached_100k_mc_at: null,
      reached_500k_mc_at: null,
      reached_1m_mc_at: null,
      reached_5m_mc_at: null,
      reached_10m_mc_at: null,
      reached_50m_mc_at: null,
    };
    const errors: string[] = [];

    await upsertPerformanceRow(sb as any, position, priceData, existing, errors);

    const [row] = sb.upsert.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(row.position_status).toBe("CLOSED");
    // total_sol_received must still be written even when status is preserved.
    expect(row.total_sol_received).toBe(position.totalSolReceived);
  });
});
