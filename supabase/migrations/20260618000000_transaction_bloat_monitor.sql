-- 'Transaction Bloat & Re-routing' Monitor (CPI Depth)
--
-- Adds is_path_obfuscated + cpi_depth columns to scan_history. Populated by
-- the PostLaunchWatcher's CPI-depth probe and read by scan-core to apply a
-- +25 risk penalty when depth >= 3 and a Critical Risk floor when depth >= 4
-- ('Extreme Obfuscation').
--
-- Run once against your Supabase project before deploying the feature.

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS is_path_obfuscated BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS cpi_depth INTEGER NOT NULL DEFAULT 0;

-- Quickly surface obfuscated tokens on dashboards.
CREATE INDEX IF NOT EXISTS scan_history_path_obfuscated_idx
  ON public.scan_history(is_path_obfuscated, scanned_at DESC)
  WHERE is_path_obfuscated = TRUE;

CREATE INDEX IF NOT EXISTS scan_history_cpi_depth_idx
  ON public.scan_history(cpi_depth DESC, scanned_at DESC)
  WHERE cpi_depth >= 3;

COMMENT ON COLUMN public.scan_history.is_path_obfuscated IS
  '''Transaction Bloat & Re-routing'' Monitor: TRUE when a tracked tx had a '
  'Cross-Program-Invocation nesting depth >= 3. Hallmark of Programmable Rugs '
  'where malicious logic is hidden in nested program calls.';

COMMENT ON COLUMN public.scan_history.cpi_depth IS
  'Maximum CPI nesting depth observed for this mint. 0 = unknown, 1 = no CPIs, '
  '>=3 = obfuscated (+25 risk penalty), 4 = Extreme Obfuscation (Critical Risk).';
