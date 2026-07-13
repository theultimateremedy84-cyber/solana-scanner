-- =============================================================================
-- closed_positions_balance_cleanup_v2
--
-- ISSUE (#4, medium priority)
-- ---------------------------
-- 4 CLOSED positions still have current_token_balance > 0 in live data:
--
--   wallet 4andt7R… / token Dm61h…   balance=41,030   / bought=8,206,117  (0.50%)
--   wallet 6ZCPmqH… / token AzdSZ…   balance=491,896  / bought=36,124,878 (1.36%)
--   wallet AcqHi1… / token 4EKEh…    balance=31,986   / bought=5,702,917  (0.56%)
--   wallet 6FjTo4… / token SPCX…     balance=0.91     / bought=304.22     (0.30%)
--
-- These rows were DELIBERATELY EXCLUDED from the previous migration
-- (20260713000002_wph_dust_balance_cleanup.sql), which only zeroed balances
-- < 0.1% of total_tokens_bought. All 4 fall above that 0.1% threshold.
--
-- ROOT CAUSE
-- ----------
-- The position_status = 'CLOSED' was set because tokensSold >= tokensBought
-- × 0.95 (the 95% sell threshold in wallet-enricher.ts classifyWallets()).
-- However current_token_balance — computed as tokensBought − tokensSold from
-- raw tx metrics — remains > 0 because:
--   (a) A small fraction of tokens were transferred out rather than sold
--       (transfer transactions not captured as sell events by Helius).
--   (b) Rounding accumulation across multiple transactions leaves a tiny
--       residual that exceeds the 0.001× dust floor.
--
-- These positions are semantically CLOSED (wallet exited 98%+ of its tokens)
-- but the balance column disagrees. This is the "second time this exact symptom
-- has shown up" referenced in the validation report: 2 were left by the first
-- cleanup, 2 more appeared since (from new enrichment or corrected raw metrics).
--
-- FIX
-- ---
-- Zero out current_token_balance for CLOSED positions where the remaining
-- balance is < 2% of total_tokens_bought. The threshold is expanded from 0.1%
-- to 2% because all 4 affected rows fall in the 0.3%–1.4% range — they are
-- genuine dust-level remnants of nearly fully-exited positions, not meaningful
-- holdings.
--
-- This change is consistent with the scoring intent: a wallet that sold 98–99%
-- of its tokens has effectively closed the position and the current_token_balance
-- should reflect that.
--
-- SAFETY
-- ------
-- Only affects CLOSED positions (never OPEN, PARTIALLY_CLOSED, UNKNOWN).
-- Only zeroes balances < 2% of total bought — meaningful residual holdings
-- (≥ 2% of total_tokens_bought, i.e. sold < 98% of tokens) are untouched.
-- Rows with total_tokens_bought = 0 are also zeroed (balance without a
-- buy record is always a data artifact; these were already covered by the
-- previous migration but the condition is kept here for completeness).
-- Idempotent: rows already at 0 are unaffected by the WHERE predicate.
-- =============================================================================

UPDATE public.wallet_performance_history
SET
  current_token_balance = 0,
  updated_at            = now()
WHERE
  position_status = 'CLOSED'
  AND current_token_balance > 0
  AND (
    total_tokens_bought = 0
    OR current_token_balance < total_tokens_bought * 0.02   -- expanded: 2% vs original 0.1%
  );

DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'closed_positions_balance_cleanup_v2: zeroed current_token_balance on % CLOSED positions', affected_count;
END $$;
