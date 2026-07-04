-- =============================================================================
-- Migration: 20260704000001_fix_unknown_positions
--
-- Fix 1: Re-evaluate UNKNOWN positions where total_sol_received > 0.
--   These wallets demonstrably sold tokens and received SOL, but position_status
--   was never updated because the enrichment pass ran before total_sol_received
--   was backfilled. realized_profit was 0 for all of them.
--
-- Fix 6: Mark stale UNKNOWN positions as CLOSED (total loss).
--   Positions idle > 45 days, initial_investment > 0, zero SOL received —
--   these are rug-pulls / dead tokens. Treating them as UNKNOWN indefinitely
--   inflates the UNKNOWN count and suppresses win_rate for affected wallets.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Fix 1A: CLOSED — wallet received SOL back and token balance is fully gone
-- Criteria:
--   • position_status = 'UNKNOWN'
--   • total_sol_received > 0  (confirmed SOL returned to wallet)
--   • Token counts confirm full exit: sold >= 95% of bought (consistent with app)
--     OR both counts are zero/null (holder_scan gap — SOL received is the only signal)
-- Note: 95% threshold is used consistently with the app-level classifier.
-- Note: COALESCE used for null-safe peak_roi comparison (GREATEST(a,NULL)=NULL in Postgres).
-- ---------------------------------------------------------------------------
UPDATE wallet_performance_history
SET
  position_status = 'CLOSED',
  realized_profit = total_sol_received - COALESCE(initial_investment, 0),
  roi_multiple    = CASE
                      WHEN COALESCE(initial_investment, 0) > 0.001
                      THEN total_sol_received / initial_investment
                      ELSE NULL
                    END,
  peak_roi        = CASE
                      WHEN COALESCE(initial_investment, 0) > 0.001
                        AND total_sol_received / initial_investment
                            > COALESCE(peak_roi, 0)           -- null-safe: COALESCE, not GREATEST
                      THEN total_sol_received / initial_investment
                      ELSE peak_roi                           -- keep existing value (or NULL)
                    END,
  last_updated    = NOW()
WHERE
  position_status     = 'UNKNOWN'
  AND total_sol_received > 0
  AND (
    -- Token counts confirm full exit (95% threshold — matches app-level classifier)
    (total_tokens_bought > 0 AND total_tokens_sold >= total_tokens_bought * 0.95)
    -- OR both token counts are absent/zero (holder_scan gap with no tx detail)
    OR (COALESCE(total_tokens_bought, 0) = 0 AND COALESCE(total_tokens_sold, 0) = 0)
  );

-- ---------------------------------------------------------------------------
-- Fix 1B: PARTIALLY_CLOSED — wallet received some SOL but still holds tokens
-- Criteria:
--   • Still UNKNOWN after Fix 1A (not touched above)
--   • total_sol_received > 0
--   • Token counts confirm partial exit: sold > 0 but < 95% of bought
-- realized_profit = received - (invested × fraction_sold)
-- ---------------------------------------------------------------------------
UPDATE wallet_performance_history
SET
  position_status = 'PARTIALLY_CLOSED',
  realized_profit = total_sol_received
                    - COALESCE(initial_investment, 0)
                      * (total_tokens_sold::numeric / NULLIF(total_tokens_bought, 0)),
  last_updated    = NOW()
WHERE
  position_status     = 'UNKNOWN'          -- not yet reclassified by Fix 1A
  AND total_sol_received > 0
  AND total_tokens_bought > 0
  AND total_tokens_sold   > 0
  AND total_tokens_sold < total_tokens_bought * 0.95;  -- consistent 95% threshold

-- ---------------------------------------------------------------------------
-- Fix 6: Stale UNKNOWN → CLOSED (total loss)
-- Criteria:
--   • Still UNKNOWN (not reclassified above)
--   • total_sol_received = 0  (never got SOL back)
--   • initial_investment > 0.001 SOL  (a real purchase, not a dust/airdrop entry)
--   • last_updated < 45 days ago  (stale — no enrichment activity in 6+ weeks)
-- These are rug-pulled / zero-value tokens. Full loss assumed.
-- ---------------------------------------------------------------------------
UPDATE wallet_performance_history
SET
  position_status = 'CLOSED',
  realized_profit = -COALESCE(initial_investment, 0),
  roi_multiple    = 0,
  last_updated    = NOW()
WHERE
  position_status          = 'UNKNOWN'
  AND COALESCE(total_sol_received, 0) = 0
  AND COALESCE(initial_investment, 0)  > 0.001
  AND last_updated < NOW() - INTERVAL '45 days';

-- ---------------------------------------------------------------------------
-- Verification queries (run manually after applying)
-- ---------------------------------------------------------------------------
-- SELECT position_status, COUNT(*), ROUND(SUM(realized_profit)::numeric,4) AS total_realized
--   FROM wallet_performance_history GROUP BY 1 ORDER BY 1;
-- SELECT COUNT(*) FROM wallet_performance_history
--   WHERE position_status = 'UNKNOWN' AND total_sol_received > 0;  -- should be 0
-- SELECT COUNT(*) FROM wallet_performance_history
--   WHERE realized_profit = 0 AND position_status = 'CLOSED'
--   AND total_sol_received > 0;  -- should be much lower than before
