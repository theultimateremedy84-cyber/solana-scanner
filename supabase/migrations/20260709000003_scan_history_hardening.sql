-- =============================================================================
-- scan_history hardening (audit finding #4)
--
-- scan_history is the only table that allows open INSERT from anon/authenticated
-- (documented as intentional: "frontend writes scan results"). That means
-- anyone with the anon key can insert arbitrary rows — fake risk_score, fake
-- is_*_exploit flags, fake token names — with no CHECK constraints to bound
-- the values. If this table feeds any public-facing risk display, that's
-- spoofable.
--
-- This migration does two things:
--   1. Adds CHECK constraints so even a direct anon insert can't write
--      nonsensical/out-of-range values (defense in depth).
--   2. Moves the actual write path behind a server-validated API route
--      (POST /api/scan-history — see src/lib/api/scan-history-handler.ts)
--      and revokes direct INSERT from anon/authenticated, so all scan_history
--      writes now go through server-side validation before hitting the DB.
--
-- NOTE: after this migration ships, deploy the accompanying code change
-- (src/lib/scan-history.ts calling POST /api/scan-history instead of
-- inserting directly) in the SAME release — otherwise the frontend's direct
-- insert calls will start failing with an RLS violation.
-- =============================================================================

-- ── 1. Bound the values on direct inserts (defense in depth even under the
--       new server-only write path — also protects any future direct DB
--       clients).
--
-- SAFETY (code review, 2026-07-08): this table has been open to
-- unvalidated INSERT since launch, so it may already contain rows that
-- violate these ranges (e.g. a stray out-of-range risk_score). Adding a
-- CHECK constraint the normal way validates ALL existing rows immediately
-- and the whole migration FAILS if even one existing row violates it —
-- that would block this deployment on bad historical data.
--
-- Instead: add each constraint NOT VALID (enforced on all NEW inserts/
-- updates immediately, zero cost, cannot fail), then attempt to VALIDATE
-- it against existing rows in a separate statement that is allowed to fail
-- without rolling back the constraint itself. If validation fails, the
-- constraint stays live for new data and a NOTICE explains what to do:
-- inspect/clean the offending historical rows, then re-run
-- `ALTER TABLE scan_history VALIDATE CONSTRAINT <name>;` manually once
-- clean.
DO $
BEGIN
  ALTER TABLE public.scan_history
    DROP CONSTRAINT IF EXISTS scan_history_risk_score_range,
    ADD  CONSTRAINT scan_history_risk_score_range
      CHECK (risk_score >= 0 AND risk_score <= 100) NOT VALID;
  BEGIN
    ALTER TABLE public.scan_history VALIDATE CONSTRAINT scan_history_risk_score_range;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'scan_history_risk_score_range: existing rows violate this constraint — '
      'it is enforced for new/updated rows only until you clean the data and run '
      'ALTER TABLE scan_history VALIDATE CONSTRAINT scan_history_risk_score_range;';
  END;
END $;

DO $
BEGIN
  ALTER TABLE public.scan_history
    DROP CONSTRAINT IF EXISTS scan_history_risk_level_enum,
    ADD  CONSTRAINT scan_history_risk_level_enum
      CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'EXTREME')) NOT VALID;
  BEGIN
    ALTER TABLE public.scan_history VALIDATE CONSTRAINT scan_history_risk_level_enum;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'scan_history_risk_level_enum: existing rows violate this constraint — '
      'enforced for new/updated rows only until cleaned + manually validated.';
  END;
END $;

DO $
BEGIN
  ALTER TABLE public.scan_history
    DROP CONSTRAINT IF EXISTS scan_history_honey_pot_status_enum,
    ADD  CONSTRAINT scan_history_honey_pot_status_enum
      CHECK (honey_pot_status IN ('SAFE', 'SUSPICIOUS', 'HIGH RISK', 'CONFIRMED HONEYPOT')) NOT VALID;
  BEGIN
    ALTER TABLE public.scan_history VALIDATE CONSTRAINT scan_history_honey_pot_status_enum;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'scan_history_honey_pot_status_enum: existing rows violate this constraint — '
      'enforced for new/updated rows only until cleaned + manually validated.';
  END;
END $;

DO $
BEGIN
  ALTER TABLE public.scan_history
    DROP CONSTRAINT IF EXISTS scan_history_top_holder_pct_range,
    ADD  CONSTRAINT scan_history_top_holder_pct_range
      CHECK (top_holder_pct IS NULL OR (top_holder_pct >= 0 AND top_holder_pct <= 100)) NOT VALID;
  BEGIN
    ALTER TABLE public.scan_history VALIDATE CONSTRAINT scan_history_top_holder_pct_range;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'scan_history_top_holder_pct_range: existing rows violate this constraint — '
      'enforced for new/updated rows only until cleaned + manually validated.';
  END;
END $;

DO $
BEGIN
  ALTER TABLE public.scan_history
    DROP CONSTRAINT IF EXISTS scan_history_sniper_pct_range,
    ADD  CONSTRAINT scan_history_sniper_pct_range
      CHECK (sniper_pct IS NULL OR (sniper_pct >= 0 AND sniper_pct <= 100)) NOT VALID;
  BEGIN
    ALTER TABLE public.scan_history VALIDATE CONSTRAINT scan_history_sniper_pct_range;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'scan_history_sniper_pct_range: existing rows violate this constraint — '
      'enforced for new/updated rows only until cleaned + manually validated.';
  END;
END $;

DO $
BEGIN
  ALTER TABLE public.scan_history
    DROP CONSTRAINT IF EXISTS scan_history_non_negative_counts,
    ADD  CONSTRAINT scan_history_non_negative_counts
      CHECK (
        (holder_count   IS NULL OR holder_count   >= 0) AND
        (sniper_wallets IS NULL OR sniper_wallets >= 0) AND
        (lp_lock_days   IS NULL OR lp_lock_days   >= 0) AND
        (liquidity      IS NULL OR liquidity      >= 0) AND
        (market_cap     IS NULL OR market_cap     >= 0) AND
        (fdv            IS NULL OR fdv            >= 0) AND
        (volume_24h     IS NULL OR volume_24h     >= 0) AND
        (cpi_depth      IS NULL OR cpi_depth      >= 0)
      ) NOT VALID;
  BEGIN
    ALTER TABLE public.scan_history VALIDATE CONSTRAINT scan_history_non_negative_counts;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'scan_history_non_negative_counts: existing rows violate this constraint — '
      'enforced for new/updated rows only until cleaned + manually validated.';
  END;
END $;

-- ── 2. Lock down direct writes — INSERT/UPDATE now require service_role.
--       SELECT stays open to anon/authenticated (public risk display is the
--       whole point of this table).
REVOKE INSERT, UPDATE ON public.scan_history FROM anon;
REVOKE INSERT, UPDATE ON public.scan_history FROM authenticated;

DROP POLICY IF EXISTS "Anyone can append scans" ON public.scan_history;

-- service_role bypasses RLS entirely, so no INSERT policy is needed for it —
-- but we add an explicit one for clarity/auditability, matching every other
-- table's convention in this project.
DROP POLICY IF EXISTS "Service role can append scans" ON public.scan_history;
CREATE POLICY "Service role can append scans"
  ON public.scan_history FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can update scans" ON public.scan_history;
CREATE POLICY "Service role can update scans"
  ON public.scan_history FOR UPDATE
  TO service_role
  USING (true);
