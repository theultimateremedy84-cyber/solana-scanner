-- Phase 14 — 'State Hijacking' Detector
--
-- Adds is_state_hijacked + state_hijack_details columns to scan_history.
-- Populated by src/services/analysis/stateMonitor.ts which derives every
-- expected PDA from the canonical seeds in KNOWN_SEED_MAPPINGS and
-- compares it against the actual account address used in each program
-- instruction.
--
-- When is_state_hijacked = TRUE, scan-core FORCES globalRiskScore = 100
-- (CRITICAL) and appends a 🚨 red flag listing the expected vs provided
-- PDA addresses.
--
-- Run once against your Supabase project before deploying the feature.

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS is_state_hijacked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS state_hijack_details TEXT;

-- Surface hijacked transactions on dashboards.
CREATE INDEX IF NOT EXISTS scan_history_state_hijacked_idx
  ON public.scan_history(is_state_hijacked, scanned_at DESC)
  WHERE is_state_hijacked = TRUE;

COMMENT ON COLUMN public.scan_history.is_state_hijacked IS
  '''State Hijacking'' Detector: TRUE when a tracked transaction interacted '
  'with a PDA whose address does not match the canonical derivation seeds '
  'from the program''s IDL / seed mapping. Forces a CRITICAL risk score of 100.';

COMMENT ON COLUMN public.scan_history.state_hijack_details IS
  'Pipe-delimited list of <program> <slot>: expected <pda> but got <addr> '
  'entries describing every hijacked PDA observed.';
