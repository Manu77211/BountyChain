SET TIME ZONE 'UTC';

DO $$
BEGIN
  ALTER TYPE bounty_status ADD VALUE IF NOT EXISTS 'accepted';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TYPE bounty_status ADD VALUE IF NOT EXISTS 'expired_no_submission';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TYPE bounty_status ADD VALUE IF NOT EXISTS 'expired_all_failed';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TYPE submission_status ADD VALUE IF NOT EXISTS 'expired_incomplete';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TYPE submission_status ADD VALUE IF NOT EXISTS 'in_progress';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE bounties
  ADD COLUMN IF NOT EXISTS payout_asset_id BIGINT,
  ADD COLUMN IF NOT EXISTS payout_asset_code TEXT NOT NULL DEFAULT 'ALGO',
  ADD COLUMN IF NOT EXISTS contributor_splits JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE bounties
  DROP CONSTRAINT IF EXISTS bounties_payout_asset_code_check;

ALTER TABLE bounties
  ADD CONSTRAINT bounties_payout_asset_code_check
  CHECK (char_length(trim(payout_asset_code)) > 0);

ALTER TABLE bounties
  DROP CONSTRAINT IF EXISTS bounties_extension_count_guard_check;

ALTER TABLE bounties
  ADD CONSTRAINT bounties_extension_count_guard_check
  CHECK (extension_count >= 0 AND extension_count <= 2);

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS split_share_key TEXT,
  ADD COLUMN IF NOT EXISTS payout_group_id UUID;

CREATE INDEX IF NOT EXISTS bounties_payout_asset_idx ON bounties(payout_asset_code, payout_asset_id);
CREATE INDEX IF NOT EXISTS payouts_group_id_idx ON payouts(payout_group_id);
CREATE INDEX IF NOT EXISTS payouts_split_share_key_idx ON payouts(split_share_key);
