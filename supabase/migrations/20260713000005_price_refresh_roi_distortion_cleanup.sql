-- =============================================================================
-- price_refresh_roi_distortion_cleanup
--
-- BACKGROUND
-- ----------
-- 20260713000004 backfilled the same distortion (small investment + extreme
-- roi_multiple/peak_roi) fixed in tx-reconstructor.ts and wallet-enricher.ts.
-- After that fix was deployed, the same 5-6 rows reappeared within one price
-- tick: wallet-price-refresh.ts recomputes roi_multiple/peak_roi on every
-- DexScreener price update for OPEN/PARTIALLY_CLOSED positions, independently
-- of computePnL/classifyWallets, and had never been guarded. It is now fixed
-- to call the same shared guardRoiMultiple() helper. This migration re-applies
-- the backfill for the handful of rows the unpatched worker re-wrote in the
-- gap between the first deploy and this fix.
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
