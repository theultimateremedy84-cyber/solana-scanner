-- Phase 16 — 'Rent-Exemption & Account Eviction' Detector
--
-- Adds has_non_rent_exempt_accounts column to scan_history.
-- Populated by src/services/analysis/rentMonitor.ts / scan.functions.ts
-- which, for every account identified in the token's recent transactions,
-- fetches its current lamport balance and compares it against the result of
-- getMinimumBalanceForRentExemption(dataLength).
--
-- When has_non_rent_exempt_accounts = TRUE, scan-core flags the transaction
-- with "Critical Risk: Account is not rent-exempt. This account is
-- susceptible to eviction and state hijacking." and the UI Risk Synthesis
-- panel renders an 'Economic Security' → 'Account Vulnerability' warning
-- showing the deficit amount (Required vs. Current balance).
--
-- Run once against your Supabase project before deploying the feature.

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS has_non_rent_exempt_accounts BOOLEAN NOT NULL DEFAULT FALSE;

-- Surface non-rent-exempt tokens on dashboards quickly.
CREATE INDEX IF NOT EXISTS scan_history_rent_exempt_idx
  ON public.scan_history(has_non_rent_exempt_accounts, scanned_at DESC)
  WHERE has_non_rent_exempt_accounts = TRUE;

COMMENT ON COLUMN public.scan_history.has_non_rent_exempt_accounts IS
  '''Rent-Exemption & Account Eviction'' Detector (Phase 16): TRUE when at '
  'least one account identified in the token''s recent transactions has a '
  'lamport balance below getMinimumBalanceForRentExemption(dataLength). '
  'Such accounts are susceptible to runtime eviction and subsequent state '
  'hijacking via account resurrection. Forces a high-risk scoring penalty.';
