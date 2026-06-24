-- 'CPI Manipulation' Detector
--
-- Adds is_cpi_manipulated + cpi_risk_details columns to scan_history.
-- Populated by src/services/analysis/cpiValidator.ts which traverses
-- meta.innerInstructions to find every CPI invocation and flags any
-- programId not in TRUSTED_PROGRAM_LIST.
--
-- When is_cpi_manipulated = TRUE, scan-core FORCES globalRiskScore = 100
-- (CRITICAL) and appends a 🚨 red flag naming the suspicious program ID.
--
-- Run once against your Supabase project before deploying the feature.

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS is_cpi_manipulated BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS cpi_risk_details TEXT;

-- Surface manipulated transactions on dashboards.
CREATE INDEX IF NOT EXISTS scan_history_cpi_manipulated_idx
  ON public.scan_history(is_cpi_manipulated, scanned_at DESC)
  WHERE is_cpi_manipulated = TRUE;

COMMENT ON COLUMN public.scan_history.is_cpi_manipulated IS
  '''CPI Manipulation'' Detector: TRUE when any tracked transaction invoked '
  'a program via Cross-Program Invocation that is NOT in the trusted '
  'program list (SPL Token, System, Jupiter, Raydium, ...). Forces a '
  'CRITICAL risk score of 100.';

COMMENT ON COLUMN public.scan_history.cpi_risk_details IS
  'Comma-separated list of suspicious (untrusted) program IDs detected '
  'as CPI targets, plus a short human-readable summary.';
