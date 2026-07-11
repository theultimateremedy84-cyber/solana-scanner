-- =============================================================================
-- wph_dust_balance_cleanup
--
-- Cleans up CLOSED positions in wallet_performance_history that have a tiny
-- non-zero current_token_balance caused by floating-point rounding when
-- subtracting totalTokensSold from totalTokensBought.
--
-- BACKGROUND
-- ----------
-- The audit found 48 CLOSED positions with current_token_balance > 0.
-- From sampling, 46 of these are floating-point dust residuals (values like
-- 1e-9 or 9e-13 tokens). Two rows have real residual balances and are
-- deliberately excluded by the predicate below.
--
-- FIX
-- ---
-- Zero out current_token_balance for CLOSED positions where the balance is
-- less than 0.1% of total_tokens_bought (the same proportional dust threshold
-- already used in the classifyWallets() scorer in wallet-enricher.ts, line 989).
-- Rows where total_tokens_bought = 0 are also zeroed (balance with no buy
-- evidence is always dust). Genuine residual balances (>= 0.1% of bought)
-- are left untouched.
-- =============================================================================

UPDATE public.wallet_performance_history
SET
  current_token_balance = 0
WHERE
  position_status = 'CLOSED'
  AND current_token_balance > 0
  AND (
    total_tokens_bought = 0
    OR current_token_balance < total_tokens_bought * 0.001
  );
