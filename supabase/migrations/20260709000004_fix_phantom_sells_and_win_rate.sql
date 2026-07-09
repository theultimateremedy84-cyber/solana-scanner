-- =============================================================================
-- Migration: 20260709000004_fix_phantom_sells_and_win_rate.sql
--
-- PURPOSE
--   Cleans up data corrupted by two confirmed bugs:
--
--   BUG-FIX #2 — Phantom sell records (38.5% of all sells)
--     Root cause: extractSellers() v4 did not verify that token transfers
--     went TO the pool address. Any wallet that sent the tracked token to
--     ANY destination in a tx where the pool paid out SOL was mis-classified
--     as a seller. This inflated wallet_token_activity and wallet_raw_tx_metrics
--     with phantom sell rows that had no corresponding buy.
--
--   BUG-FIX #1 — win_rate always 1.0
--     Root cause: classifyWallets() computed realizedProfit = received - invested
--     even when invested = 0 (zero-cost-basis positions). With invested = 0,
--     any received > 0 made the position appear profitable, causing every wallet
--     with a closed position to show win_rate = 1.0.
--
-- WHAT THIS MIGRATION DOES
--
--   STEP 1: Delete zombie wallet_collection_jobs
--     Jobs that have failed 100+ times and are permanently stuck. These will
--     never succeed and add noise to the job queue. Safe to delete outright.
--
--   STEP 2: Clear phantom sells from wallet_token_activity
--     Deletes sell records for wallets that have 0 buy records for the same
--     token. These represent the phantom sells: a wallet that "sold" a token
--     it never bought — impossible in practice on a bonding curve, confirming
--     the data is invalid.
--
--     NOTE on legitimacy: there is a theoretical edge case where a wallet
--     receives tokens via transfer/airdrop (not captured as a buy) then sells
--     them legitimately. In that case the wallet would have sells but no buys.
--     However: (a) our scanner only tracks pump.fun swap buys, and transfers-in
--     are already excluded from buy counts; (b) the phantom sell audit confirmed
--     these wallets had no on-chain interaction with the bonding curve as buyers;
--     (c) retaining phantom sell rows has the more severe downstream effect of
--     corrupting win_rate, ROI, and total_sells for all wallets. The tradeoff
--     favours deletion.
--
--   STEP 3a: Recompute wallet_raw_tx_metrics from wallet_token_activity
--     After deleting phantom sell rows, recompute the sell-side aggregates
--     (total_sell_txs, total_tokens_sold, total_sol_received) for rows that
--     still have SOME remaining sell activity.
--
--   STEP 3b: Zero out sell-side metrics for rows with no remaining sells
--     wallet_raw_tx_metrics rows whose phantom sell rows were all deleted now
--     have no sell activity in wallet_token_activity. Their sell-side columns
--     must be explicitly set to 0; STEP 3a's join-based UPDATE won't touch
--     them (no source row exists to join on).
--
--   STEP 4: Null out win_rate for all wallets
--     Forces a full win_rate recompute on next rescore run. Since win_rate
--     was universally wrong (all = 1.0), clearing it triggers correct values
--     to be recomputed from the now-clean raw metrics.
--
--   STEP 5: Reset misclassified wallets to trigger reclassification
--     Clears wallet_classification back to 'unknown' for wallets whose win_rate
--     was used in classification so the next rescore produces correct classes.
--
-- SAFETY
--   All DELETEs are targeted with explicit WHERE conditions.
--   UPDATEs only touch affected rows.
--   Idempotent: safe to run multiple times (second run is a no-op).
--
-- AFTER RUNNING
--   Trigger a full rescore: POST /api/rescore-wallets
--   This recomputes win_rate, average_roi, intelligence_score, and
--   wallet_classification from the cleaned wallet_raw_tx_metrics data.
--
-- APPLY
--   Supabase Dashboard → SQL Editor: paste and run.
--   Estimated runtime: < 30s on typical dataset sizes.
-- =============================================================================


-- =============================================================================
-- STEP 1 — Delete zombie wallet_collection_jobs
-- Jobs with ≥ 100 failed attempts are permanently stuck and will never succeed.
-- =============================================================================

DELETE FROM public.wallet_collection_jobs
WHERE attempts >= 100
  AND status IN ('failed', 'pending');


-- =============================================================================
-- STEP 2 — Delete phantom sell records from wallet_token_activity
--
-- A phantom sell is a sell record for a (wallet, token) pair that has NO
-- corresponding buy record in wallet_token_activity. We first aggregate counts
-- across ALL action types (not just sells — that would make buy_count always 0),
-- then delete sell rows for pairs where buy_count = 0.
-- =============================================================================

WITH all_activity_counts AS (
  -- Aggregate ALL activity rows per (wallet, token) so buy_count is accurate.
  -- Do NOT filter to action_type='sell' here — that would make buy_count always 0.
  SELECT
    wallet_address,
    token_address,
    COUNT(*) FILTER (WHERE action_type = 'buy')  AS buy_count,
    COUNT(*) FILTER (WHERE action_type = 'sell') AS sell_count
  FROM public.wallet_token_activity
  GROUP BY wallet_address, token_address
),
phantom_seller_pairs AS (
  -- A phantom seller is a wallet × token that has sells but absolutely zero buys.
  SELECT wallet_address, token_address
  FROM all_activity_counts
  WHERE sell_count > 0
    AND buy_count  = 0
)
DELETE FROM public.wallet_token_activity wta
USING phantom_seller_pairs psp
WHERE wta.wallet_address = psp.wallet_address
  AND wta.token_address  = psp.token_address
  AND wta.action_type    = 'sell';
-- Expected rows affected: ~17,351 (38.5% of all sell records based on audit)


-- =============================================================================
-- STEP 3a — Recompute sell-side aggregates in wallet_raw_tx_metrics
--           for wallet × token pairs that STILL have remaining sell activity.
--
-- Uses the now-clean wallet_token_activity to recalculate sell-side columns.
-- Only updates rows where the recomputed values differ from what is stored.
-- Does NOT touch rows whose sell activity was entirely deleted (Step 3b does).
-- =============================================================================

WITH recomputed_sells AS (
  SELECT
    wallet_address,
    token_address,
    COUNT(*)                FILTER (WHERE action_type = 'sell')::int        AS total_sell_txs,
    COALESCE(SUM(token_amount) FILTER (WHERE action_type = 'sell'), 0)      AS total_tokens_sold,
    COALESCE(SUM(amount_sol)   FILTER (WHERE action_type = 'sell'), 0)      AS total_sol_received
  FROM public.wallet_token_activity
  WHERE action_type = 'sell'  -- safe here: we only need sell aggregates, buy_count isn't needed
  GROUP BY wallet_address, token_address
)
UPDATE public.wallet_raw_tx_metrics wrm
SET
  total_sell_txs        = r.total_sell_txs,
  total_tokens_sold     = r.total_tokens_sold,
  total_sol_received    = r.total_sol_received,
  current_token_balance = GREATEST(0, wrm.total_tokens_bought - r.total_tokens_sold),
  last_scanned_at       = NOW()
FROM recomputed_sells r
WHERE wrm.wallet_address = r.wallet_address
  AND wrm.token_address  = r.token_address
  AND (
    wrm.total_sell_txs     IS DISTINCT FROM r.total_sell_txs    OR
    wrm.total_tokens_sold  IS DISTINCT FROM r.total_tokens_sold OR
    wrm.total_sol_received IS DISTINCT FROM r.total_sol_received
  );


-- =============================================================================
-- STEP 3b — Zero out sell-side metrics for wallet_raw_tx_metrics rows that
--           now have NO remaining sell activity at all.
--
-- These rows had ALL their sell records deleted in Step 2 (pure phantom sellers).
-- Step 3a's recomputed_sells CTE produces no row for them (no sell rows left to
-- aggregate from), so the JOIN in Step 3a won't touch them — stale nonzero
-- sell counts would remain without this explicit zero-out.
-- =============================================================================

UPDATE public.wallet_raw_tx_metrics wrm
SET
  total_sell_txs        = 0,
  total_tokens_sold     = 0,
  total_sol_received    = 0,
  current_token_balance = GREATEST(0, wrm.total_tokens_bought),
  last_scanned_at       = NOW()
WHERE wrm.total_sell_txs > 0  -- only rows that had sells (avoid touching clean rows)
  AND NOT EXISTS (
    SELECT 1
    FROM public.wallet_token_activity wta
    WHERE wta.wallet_address = wrm.wallet_address
      AND wta.token_address  = wrm.token_address
      AND wta.action_type    = 'sell'
  );


-- =============================================================================
-- STEP 4 — Null out win_rate (was universally wrong = 1.0)
--
-- Forces win_rate to recompute correctly on the next rescore run.
-- win_rate = 1.0 for every wallet was caused by zero-cost-basis CLOSED
-- positions incorrectly counting as profitable (realizedProfit = received - 0).
-- The code fix in wallet-enricher.ts addresses the root cause; this clears
-- the stale wrong values from the wallets table so the next rescore writes
-- correct values.
-- =============================================================================

UPDATE public.wallets
SET
  win_rate    = NULL,
  average_roi = NULL,
  updated_at  = NOW()
WHERE win_rate IS NOT NULL;
-- Expected rows affected: ~4,920 (26.6% of wallets that had a computed win_rate)


-- =============================================================================
-- STEP 5 — Reset wallet_classification for wallets that were misclassified
--
-- Wallets promoted to smart_money based on the bogus win_rate = 1.0 should be
-- reset to 'unknown' so the next rescore reclassifies them from clean data.
-- Retail wallets are reset too — their intelligence_score was inflated by the
-- false win_rate contribution to the scoring formula.
--
-- Does NOT touch: whale, bot, sniper — these classifications are based on
-- volume/frequency signals that did not depend on win_rate being correct.
-- =============================================================================

UPDATE public.wallets
SET
  wallet_classification = 'unknown',
  intelligence_score    = NULL,
  updated_at            = NOW()
WHERE wallet_classification IN ('smart_money', 'retail');


-- =============================================================================
-- VERIFY — Run these after applying the migration to confirm the expected state.
-- =============================================================================

-- Should be 0 after cleanup:
SELECT COUNT(*) AS remaining_phantom_sellers
FROM public.wallet_token_activity wta
WHERE wta.action_type = 'sell'
  AND NOT EXISTS (
    SELECT 1 FROM public.wallet_token_activity b
    WHERE b.wallet_address = wta.wallet_address
      AND b.token_address  = wta.token_address
      AND b.action_type    = 'buy'
  );

-- Should be 0 (all sell-side metrics nulled out / zeroed):
SELECT COUNT(*) AS metrics_with_stale_sells
FROM public.wallet_raw_tx_metrics wrm
WHERE wrm.total_sell_txs > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.wallet_token_activity wta
    WHERE wta.wallet_address = wrm.wallet_address
      AND wta.token_address  = wrm.token_address
      AND wta.action_type    = 'sell'
  );

-- Should be NULL for all wallets (will be repopulated by next rescore):
SELECT COUNT(*) AS wallets_with_stale_win_rate
FROM public.wallets
WHERE win_rate IS NOT NULL;

-- Sell / buy ratio should now be ≤ 1.0 across all tokens:
SELECT
  COUNT(*) FILTER (WHERE action_type = 'buy')  AS total_buys,
  COUNT(*) FILTER (WHERE action_type = 'sell') AS total_sells,
  ROUND(
    COUNT(*) FILTER (WHERE action_type = 'sell')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE action_type = 'buy'), 0),
    3
  ) AS sell_buy_ratio
FROM public.wallet_token_activity;
