// =============================================================================
// funding-clusters-handler.ts — GET /api/funding-clusters
//
// Exposes Signal 1 (Common Funding Source detection) from
// sol-transfer-indexer.ts as a real HTTP endpoint.
//
// WHAT THIS ANSWERS
//   "Which of my whale/smart_money wallets were funded by the same source?"
//   Wallets sharing a first-funder within a tight time window are strong
//   candidates for being controlled by the same entity — e.g. a whale
//   distributing profit across 10-15 fresh wallets before/after a CEX hop.
//
// QUERY PARAMS (all optional)
//   classifications   comma-separated list, default "whale,smart_money"
//   maxSpreadMinutes  time window for "funded within window", default 60
//   limit             max wallets considered, default 500 (safety cap)
//
// EXAMPLE
//   GET /api/funding-clusters
//   GET /api/funding-clusters?classifications=whale&maxSpreadMinutes=120
//
// NOTE
//   Depends on wallet_sol_transfers being populated by
//   indexWalletSolTransfers() (wired into wallet-enricher.ts, gated to
//   whale/smart_money wallets). Until enrichment has processed a wallet, it
//   simply won't appear in any cluster — that is expected, not a bug.
// =============================================================================

import { getSupabase } from "./wallet-collection-worker";
import { detectCommonFundingSource } from "./sol-transfer-indexer";

const LOG = "[FundingClustersHandler]";
const DEFAULT_CLASSIFICATIONS = ["whale", "smart_money"];
const DEFAULT_MAX_SPREAD_MINUTES = 60;
const DEFAULT_LIMIT = 500;

export async function handleFundingClustersGet(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const classificationsParam = url.searchParams.get("classifications");
    const classifications = classificationsParam
      ? classificationsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_CLASSIFICATIONS;

    const maxSpreadMinutes = Number(url.searchParams.get("maxSpreadMinutes")) || DEFAULT_MAX_SPREAD_MINUTES;
    const limit = Math.min(Number(url.searchParams.get("limit")) || DEFAULT_LIMIT, 2000);

    const sb = getSupabase();
    if (!sb) {
      return json({ ok: false, error: "Supabase unavailable" }, 503);
    }

    const { data: wallets, error } = await sb
      .from("wallets")
      .select("wallet_address, wallet_classification")
      .in("wallet_classification", classifications)
      .limit(limit);

    if (error) {
      console.error(`${LOG} wallets query failed: ${error.message}`);
      return json({ ok: false, error: error.message }, 500);
    }

    const walletAddresses = (wallets ?? []).map((w) => w.wallet_address as string);

    if (walletAddresses.length === 0) {
      return json({
        ok: true,
        classifications,
        walletsConsidered: 0,
        clusters: [],
        note: `No wallets found matching classifications: ${classifications.join(", ")}`,
      });
    }

    const clusters = await detectCommonFundingSource(
      walletAddresses,
      maxSpreadMinutes * 60 * 1000,
    );

    // Attach classification to each wallet in the cluster for UI convenience.
    const classificationByWallet = new Map(
      (wallets ?? []).map((w) => [w.wallet_address as string, w.wallet_classification as string]),
    );

    const enrichedClusters = clusters.map((c) => ({
      firstFunder:        c.firstFunder,
      wallets: c.wallets.map((w) => ({
        address:        w,
        classification: classificationByWallet.get(w) ?? "unknown",
      })),
      walletCount:         c.wallets.length,
      fundedWithinWindow:  c.fundedWithinWindow,
      earliestFundedAt:    c.earliestFundedAt,
      latestFundedAt:      c.latestFundedAt,
    }));

    return json({
      ok: true,
      classifications,
      maxSpreadMinutes,
      walletsConsidered: walletAddresses.length,
      clustersFound:     enrichedClusters.length,
      clusters:          enrichedClusters,
      note: enrichedClusters.length === 0
        ? "No shared-funding-source clusters found yet. This grows as more " +
          "whale/smart_money wallets go through enrichment (indexWalletSolTransfers " +
          "populates wallet_sol_transfers)."
        : undefined,
    });
  } catch (err) {
    console.error(`${LOG} unhandled error:`, err);
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
