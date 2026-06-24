-- =============================================================================
-- PHASE 2 + 3: DexScreener priceNative Bug — Impact Assessment + Repair
-- Migration: 20260623000006_repair_pnl_dryrun.sql
--
-- ──────────────────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ──────────────────────────────────────────────────────────────────────────────
-- The v9 worker (before the v10 fix) sorted ALL DexScreener pairs by liquidity
-- and picked the top one, then stored priceNative as current_token_price_sol.
--
-- For tokens traded on USDC-quoted Meteora/Raydium/Orca pools, the highest-
-- liquidity pair is often a USDC pair. DexScreener's priceNative for those is
-- the price in USDC — not SOL. Example for ZINC:
--
--   Meteora USDC pair (liquidity $860):  priceNative = "14.087" → stored as SOL
--   Meteora SOL  pair (liquidity $6039): priceNative = "0.2089" → correct
--
-- This caused a 14.087 / 0.2089 = 67.43× overstatement of position values.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- DETECTION HEURISTIC
-- ──────────────────────────────────────────────────────────────────────────────
-- A corrupted row can be identified by:
--   current_token_price_sol > 1.0
--
-- Rationale: essentially no Solana meme/utility token ever legitimately costs
-- more than 1 SOL per token. Any row where the stored price exceeds 1 SOL was
-- almost certainly written with a USDC price (typically $5–$50/token).
--
-- CONSERVATIVE THRESHOLD: 0.5 SOL. Tokens priced between 0.5–1.0 SOL are
-- extremely rare; if you have such a token adjust the threshold below.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- HOW TO USE THIS SCRIPT
-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 1 (safe — read only): Run PHASE 2 SELECT blocks to see affected rows.
-- STEP 2 (destructive): Only run the PHASE 3 UPDATE after you approve the plan.
--   The UPDATE blocks are wrapped in a commented-out transaction. Uncomment
--   BEGIN/COMMIT when you are ready to apply.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- PHASE 2 — IMPACT ASSESSMENT (read-only, safe to run anytime)
-- ──────────────────────────────────────────────────────────────────────────────

-- 2A: Total affected rows by severity
SELECT
  CASE
    WHEN current_token_price_sol > 10  THEN 'CRITICAL (>10 SOL — clearly USDC price)'
    WHEN current_token_price_sol > 1   THEN 'HIGH (1–10 SOL — almost certainly wrong)'
    WHEN current_token_price_sol > 0.5 THEN 'MEDIUM (0.5–1 SOL — likely wrong)'
    WHEN current_token_price_sol > 0   THEN 'OK (<0.5 SOL — likely correct)'
    ELSE                                    'NULL / ZERO (no price stored)'
  END                          AS severity,
  COUNT(*)                     AS row_count,
  COUNT(DISTINCT token_address) AS unique_tokens
FROM public.wallet_performance_history
GROUP BY 1
ORDER BY 2 DESC;

-- 2B: Which tokens have the most corrupted rows
SELECT
  token_address,
  COUNT(*)                         AS affected_wallets,
  AVG(current_token_price_sol)     AS avg_stored_price_sol,
  MAX(current_token_price_sol)     AS max_stored_price_sol,
  SUM(current_position_value_sol)  AS total_inflated_position_value,
  MAX(last_updated)                AS most_recent_update
FROM public.wallet_performance_history
WHERE current_token_price_sol > 1.0
GROUP BY token_address
ORDER BY affected_wallets DESC
LIMIT 20;

-- 2C: Full field audit for corrupted rows (first 50 for review)
SELECT
  wallet_address,
  token_address,
  position_status,
  initial_investment,
  current_token_balance,
  current_token_price_sol          AS stored_price_sol_WRONG,
  current_position_value_sol       AS stored_position_value_WRONG,
  realized_profit,
  unrealized_profit                AS stored_unrealized_WRONG,
  roi_multiple                     AS stored_roi_WRONG,
  peak_roi,
  peak_position_value_sol,
  last_updated
FROM public.wallet_performance_history
WHERE current_token_price_sol > 1.0
ORDER BY current_token_price_sol DESC
LIMIT 50;

-- 2D: Quantify how much the peak_roi was inflated
-- (peaks may have been set from the corrupted calculation and can't be auto-corrected)
SELECT
  COUNT(*) FILTER (WHERE peak_roi > 1000)  AS wallets_with_peak_roi_over_1000x,
  COUNT(*) FILTER (WHERE peak_roi > 100)   AS wallets_with_peak_roi_over_100x,
  COUNT(*) FILTER (WHERE peak_roi > 10)    AS wallets_with_peak_roi_over_10x,
  MAX(peak_roi)                             AS max_peak_roi,
  AVG(peak_roi) FILTER (WHERE peak_roi > 0) AS avg_peak_roi
FROM public.wallet_performance_history;

-- 2E: Summary — fields corrupted per severity tier
SELECT
  COUNT(*) FILTER (WHERE current_token_price_sol > 1)   AS rows_with_wrong_price_sol,
  COUNT(*) FILTER (WHERE current_token_price_sol > 1
    AND current_position_value_sol > 0)                  AS rows_with_inflated_position_value,
  COUNT(*) FILTER (WHERE current_token_price_sol > 1
    AND unrealized_profit > 0)                           AS rows_with_inflated_unrealized,
  COUNT(*) FILTER (WHERE current_token_price_sol > 1
    AND roi_multiple IS NOT NULL)                        AS rows_with_wrong_roi,
  COUNT(*) FILTER (WHERE current_token_price_sol > 1
    AND peak_roi IS NOT NULL)                            AS rows_with_wrong_peak_roi,
  COUNT(*) FILTER (WHERE current_token_price_sol > 1
    AND peak_position_value_sol IS NOT NULL)             AS rows_with_wrong_peak_position
FROM public.wallet_performance_history;


-- ──────────────────────────────────────────────────────────────────────────────
-- PHASE 3 — REPAIR
-- ──────────────────────────────────────────────────────────────────────────────
-- ⚠  DO NOT UNCOMMENT UNTIL YOU HAVE REVIEWED THE PHASE 2 OUTPUT ABOVE ⚠
-- ──────────────────────────────────────────────────────────────────────────────
--
-- The repair zeroes out fields that are provably wrong.
-- It does NOT attempt to recalculate with the correct price (that requires a
-- live DexScreener call which must happen in the application layer).
-- After this runs, the next wallet collection job for each affected token will
-- write the correct values using the v10 worker.
--
-- Fields reset to NULL / 0:
--   current_token_price_sol      → NULL  (was USDC price, not SOL)
--   current_token_price_usd      → NULL  (was from the wrong pair; re-fetch later)
--   current_position_value_sol   → 0     (can't compute without valid price)
--   unrealized_profit            → 0     (can't compute without valid price)
--   roi_multiple                 → NULL  (can't compute without valid price)
--
-- Fields left UNCHANGED intentionally:
--   realized_profit       — derived from actual sell transactions (not price)
--   initial_investment    — derived from actual buy transactions (not price)
--   current_value         — derived from actual sell transactions (not price)
--   peak_roi              — left as-is; peaks may be genuinely high and can't
--                           be auto-corrected without full price history.
--                           A future price-history backfill will correct these.
--   position_status       — correctly derived from trade data, not price.
--
-- ── DRY RUN PREVIEW — shows what would change WITHOUT modifying data ──────────

SELECT
  wallet_address,
  token_address,
  current_token_price_sol      AS before_price_sol,
  NULL::NUMERIC                AS after_price_sol,
  current_position_value_sol   AS before_position_value,
  0::NUMERIC                   AS after_position_value,
  unrealized_profit            AS before_unrealized,
  0::NUMERIC                   AS after_unrealized,
  roi_multiple                 AS before_roi,
  NULL::NUMERIC                AS after_roi
FROM public.wallet_performance_history
WHERE current_token_price_sol > 1.0
ORDER BY current_token_price_sol DESC
LIMIT 100;


-- ── ACTUAL REPAIR — uncomment the block below after reviewing the dry-run ─────
/*

BEGIN;

UPDATE public.wallet_performance_history
SET
  current_token_price_sol    = NULL,
  current_token_price_usd    = NULL,
  current_position_value_sol = 0,
  unrealized_profit          = 0,
  roi_multiple               = NULL
WHERE
  current_token_price_sol > 1.0;

-- Verify: no corrupted rows remain
SELECT COUNT(*) AS remaining_corrupted
FROM public.wallet_performance_history
WHERE current_token_price_sol > 1.0;

COMMIT;

*/
-- ──────────────────────────────────────────────────────────────────────────────
-- After running the repair, trigger a wallet collection job for each affected
-- token. The v10 worker will re-fetch correct SOL-pair prices and recalculate
-- all position values, unrealized_profit, and roi_multiple automatically.
-- ──────────────────────────────────────────────────────────────────────────────
