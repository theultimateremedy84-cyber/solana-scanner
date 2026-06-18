
-- Phase 10: Developer History Tracker
-- Adds developer_wallet column to scan_history for cross-token developer
-- reputation tracking, and saves the is_metadata_mutable / is_metadata_hijacked
-- / is_authority_transitioned / is_account_resized flags that PostLaunchWatcher writes.
--
-- Run this migration once against your Supabase project before deploying Phase 10.
--
--   Option A (Supabase Dashboard): Paste into SQL Editor and run.
--   Option B (CLI): supabase db push  (after supabase link)

-- Developer wallet address (base58 Solana pubkey).
-- Populated from rug.creator.address on every live scan.
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS developer_wallet TEXT;

-- Post-launch watcher flags (added by earlier phases — safe to re-run IF NOT EXISTS).
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS is_authority_transitioned BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS is_account_resized BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS is_metadata_mutable BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS is_metadata_hijacked BOOLEAN NOT NULL DEFAULT FALSE;

-- Phase 10 developer history risk fields (denormalised for fast reads).
-- Stored alongside each scan so we can reconstruct developer risk without
-- re-querying RugCheck for old tokens.
ALTER TABLE public.scan_history
  ADD COLUMN IF NOT EXISTS developer_classification TEXT;

-- Fast lookup index: find all tokens by a developer, newest first.
CREATE INDEX IF NOT EXISTS scan_history_dev_wallet_idx
  ON public.scan_history(developer_wallet, scanned_at DESC);

-- Partial index to quickly find high-risk past tokens by developer.
CREATE INDEX IF NOT EXISTS scan_history_dev_highrisk_idx
  ON public.scan_history(developer_wallet, risk_level)
  WHERE risk_level IN ('HIGH', 'EXTREME');

-- Comment on new columns for documentation.
COMMENT ON COLUMN public.scan_history.developer_wallet IS
  'Base58 Solana address of the token creator / deployer wallet. '
  'Source: rug.creator.address from RugCheck API. '
  'Used by Phase 10 Developer History Tracker to build cross-token reputation.';

COMMENT ON COLUMN public.scan_history.developer_classification IS
  'Phase 10 classification tier for this scan''s developer: '
  'Clean | Suspicious | Serial Offender | Confirmed Scammer.';

COMMENT ON COLUMN public.scan_history.is_authority_transitioned IS
  'Phase 7: TRUE when PostLaunchWatcher detected a post-launch SetAuthority '
  '(MintTokens or FreezeAccount) instruction on this token.';

COMMENT ON COLUMN public.scan_history.is_account_resized IS
  'Phase 8: TRUE when PostLaunchWatcher detected an unauthorized account-data '
  'resize (SystemProgram Allocate / AllocateWithSeed or realloc syscall) on '
  'an account owned by this token''s program.';

COMMENT ON COLUMN public.scan_history.is_metadata_mutable IS
  'Phase 9: TRUE when the token''s metadata update_authority is still active '
  '(not null and not burned to SystemProgram). Applies +15 risk penalty.';

COMMENT ON COLUMN public.scan_history.is_metadata_hijacked IS
  'Phase 9: TRUE when PostLaunchWatcher detected a post-launch '
  'UpdateMetadataAccount / UpdateV1 instruction on this mint.';
