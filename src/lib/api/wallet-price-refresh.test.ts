// =============================================================================
// Regression tests for processSingleToken (wallet-price-refresh.ts)
//
// Guards against the bug fixed on 2026-07-03: a single DexScreener miss
// (rate limit / transient timeout / pair not yet indexed) was recorded as a
// permanent null price_usd snapshot with no retry, driving a 56.5% NULL
// price_usd rate in token_price_history.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TokenPriceData } from "./wallet-collection.types";

const fetchTokenPriceMock = vi.fn<(tokenAddress: string) => Promise<TokenPriceData>>();

vi.mock("./wallet-collection-worker", () => ({
  fetchTokenPrice: (tokenAddress: string) => fetchTokenPriceMock(tokenAddress),
  getSupabase: vi.fn(),
}));

// Import after the mock so processSingleToken picks up the mocked fetchTokenPrice.
const { processSingleToken } = await import("./wallet-price-refresh");

function priceOf(overrides: Partial<TokenPriceData> = {}): TokenPriceData {
  return {
    priceSol: null,
    priceUsd: null,
    marketCapUsd: null,
    fetchedAt: new Date().toISOString(),
    liquidityUsd: null,
    fdvUsd: null,
    volume24hUsd: null,
    pairAddress: null,
    dexId: null,
    ...overrides,
  };
}

function makeMockSupabase(rows: unknown[] = []) {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const inFn = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eq = vi.fn().mockReturnValue({ in: inFn });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ insert, upsert, select });
  return { from, insert, upsert, select, eq, in: inFn };
}

function makeResult() {
  return {
    tokensProcessed: 0,
    walletsUpdated: 0,
    snapshotsInserted: 0,
    peaksUpdated: 0,
    errors: [] as string[],
    durationMs: 0,
  };
}

const candidate = { tokenAddress: "Token1111111111111111111111111111111111", walletCount: 0, needsPnlUpdate: false };

describe("processSingleToken — retry + skip-null-snapshot logic", () => {
  beforeEach(() => {
    fetchTokenPriceMock.mockReset();
  });

  it("retries once when the first fetch has no price at all", async () => {
    fetchTokenPriceMock
      .mockResolvedValueOnce(priceOf()) // first attempt: total miss
      .mockResolvedValueOnce(priceOf({ priceSol: 0.002, priceUsd: 0.3 })); // retry succeeds

    const sb = makeMockSupabase();
    const result = makeResult();

    await processSingleToken(sb as any, candidate, result);

    expect(fetchTokenPriceMock).toHaveBeenCalledTimes(2);
    expect(sb.insert).toHaveBeenCalledTimes(1);
    expect(result.snapshotsInserted).toBe(1);
  });

  it("does not retry when the first fetch already returns a price", async () => {
    fetchTokenPriceMock.mockResolvedValueOnce(priceOf({ priceSol: 0.002, priceUsd: 0.3 }));

    const sb = makeMockSupabase();
    const result = makeResult();

    await processSingleToken(sb as any, candidate, result);

    expect(fetchTokenPriceMock).toHaveBeenCalledTimes(1);
    expect(sb.insert).toHaveBeenCalledTimes(1);
  });

  it("skips the snapshot insert entirely when both the original fetch and the retry miss", async () => {
    fetchTokenPriceMock
      .mockResolvedValueOnce(priceOf())
      .mockResolvedValueOnce(priceOf()); // still nothing after retry

    const sb = makeMockSupabase();
    const result = makeResult();

    await processSingleToken(sb as any, candidate, result);

    expect(fetchTokenPriceMock).toHaveBeenCalledTimes(2);
    expect(sb.insert).not.toHaveBeenCalled();
    expect(result.snapshotsInserted).toBe(0);
  });

  it("still records a null-priceSol snapshot when priceUsd is present but priceSol is not (no retry)", async () => {
    fetchTokenPriceMock.mockResolvedValueOnce(priceOf({ priceSol: null, priceUsd: 0.3 }));

    const sb = makeMockSupabase();
    const result = makeResult();

    await processSingleToken(sb as any, candidate, result);

    // Only the retry-condition (both priceSol AND priceUsd null) should trigger a
    // second fetch — a partial price (priceUsd present) must not retry.
    expect(fetchTokenPriceMock).toHaveBeenCalledTimes(1);
    expect(sb.insert).toHaveBeenCalledTimes(1);
    expect(result.snapshotsInserted).toBe(1);
  });
});
