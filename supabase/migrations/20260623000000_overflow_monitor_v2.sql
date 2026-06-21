-- Phase 17 v2 — Integer Overflow / Underflow Monitor (Context-Aware Upgrade)
--
-- Adds three new columns to scan_history for the three-phase overflow analysis:
--
--   is_overflow_confirmed_exploit  — TRUE only when Phase B behavioral simulation
--                                    confirmed the exploit (succeeds silently).
--                                    Differs from the legacy is_overflow_vulnerable
--                                    which was set by heuristic static analysis only.
--
--   overflow_alert_tier            — Final alert classification string after all 3 phases.
--                                    One of: "DANGER: Intentional Backdoor Detected",
--                                    "CONFIRMED EXPLOIT VECTOR", "Technical Debt: Audit Required",
--                                    "Preliminary Risk", "Code Style Warning",
--                                    "Status: Under Review", "Safe".
--
--   overflow_verification_method   — How the verdict was reached, always surfaced in UI.
--                                    One of: "Verified via Simulation", "Heuristic Warning",
--                                    "Status: Under Review".

alter table scan_history
  add column if not exists is_overflow_confirmed_exploit boolean not null default false,
  add column if not exists overflow_alert_tier           text    not null default 'Status: Under Review',
  add column if not exists overflow_verification_method  text    not null default 'Status: Under Review';

-- Back-fill from legacy is_overflow_vulnerable where applicable.
-- Any scan previously marked vulnerable gets classified as CONFIRMED EXPLOIT VECTOR
-- (conservative: this was the only output before Phase B existed).
update scan_history
set
  is_overflow_confirmed_exploit = is_overflow_vulnerable,
  overflow_alert_tier           = case
    when is_overflow_vulnerable then 'CONFIRMED EXPLOIT VECTOR'
    else 'Safe'
  end,
  overflow_verification_method  = case
    when is_overflow_vulnerable then 'Heuristic Warning'
    else 'Verified via Simulation'
  end
where
  is_overflow_confirmed_exploit = false
  and overflow_alert_tier       = 'Status: Under Review';

-- Index for quick lookups of confirmed exploits across scan history.
create index if not exists idx_scan_history_overflow_confirmed
  on scan_history (is_overflow_confirmed_exploit)
  where is_overflow_confirmed_exploit = true;

-- Comment on columns for documentation.
comment on column scan_history.is_overflow_confirmed_exploit is
  'Phase 17 v2: TRUE only when behavioral simulation (u64::MAX+1, u64::MIN-1) confirmed the overflow exploit.';
comment on column scan_history.overflow_alert_tier is
  'Phase 17 v2: Final alert tier after 3-phase analysis (Static + Simulation + Reputation).';
comment on column scan_history.overflow_verification_method is
  'Phase 17 v2: How the overflow verdict was reached — always shown in UI.';
