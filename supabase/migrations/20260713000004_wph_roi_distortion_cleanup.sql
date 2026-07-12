-- =============================================================================
-- wph_roi_distortion_cleanup
--
-- BACKGROUND
-- ----------
-- The existing dust guard in tx-reconstructor.ts (computePnL) only nulled
-- roi_multiple below 0.001 SOL of initial investment. A 2026-07-12 audit
-- found positions around 0.006 SOL — well above that bar — still produced
-- 16,000-20,000x multiples off early pump.fun bonding-curve buys. Worse,
-- wallet-enricher.ts's classifyWallets() recomputes roi_multiple independently
-- from raw invested/received for CLOSED positions (to avoid trusting the
-- stored column) WITHOUT any guard at all, and that raw value feeds
-- determineClassification()'s smart_money gate uncapped — unlike the
-- intelligence score, which caps ROI contribution at 10x. So a single lucky
-- dust-adjacent trade could wrongly promote a wallet to "smart_money".
--
-- The guard is now shared (tx-reconstructor.ts exports `guardRoiMultiple`,
-- used by both computePnL and wallet-enricher.ts's classifier input) and
-- extended: any position with < 0.02 SOL invested AND roi_multiple > 500x
-- is treated as distortion, not signal. This migration backfills existing
-- wallet_performance_history rows to match what the new code would have
-- produced, and resets peak_roi for the same rows (peak_roi is "never
-- decreases", so it would otherwise keep the inflated figure forever).
--
-- Wallets whose average_roi / classification were derived from these rows
-- will self-correct on the next scheduled rescore pass (classifyWallets
-- recomputes from raw wallet_raw_tx_metrics / wallet_performance_history,
-- it does not read a cached score), so no separate wallets-table backfill
-- is required here.
-- =============================================================================

UPDATE public.wallet_performance_history
SET
  peak_roi = NULL
WHERE
  initial_investment > 0
  AND initial_investment < 0.02
  AND peak_roi > 500;

UPDATE public.wallet_performance_history
SET
  roi_multiple = NULL
WHERE
  initial_investment > 0
  AND initial_investment < 0.02
  AND roi_multiple > 500;
