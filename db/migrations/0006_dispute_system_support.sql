SET TIME ZONE 'UTC';

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS dispute_type TEXT NOT NULL DEFAULT 'quality_low',
  ADD COLUMN IF NOT EXISTS score_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_tx_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE disputes
  DROP CONSTRAINT IF EXISTS disputes_dispute_type_check;

ALTER TABLE disputes
  ADD CONSTRAINT disputes_dispute_type_check
  CHECK (dispute_type IN ('score_unfair', 'quality_low', 'requirement_mismatch', 'fraud', 'non_delivery'));

ALTER TABLE dispute_votes
  ALTER COLUMN vote DROP NOT NULL,
  ALTER COLUMN justification DROP NOT NULL;

ALTER TABLE dispute_votes
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS challenged_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS challenge_reason TEXT,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS disputes_status_raised_at_idx ON disputes(status, raised_at);
CREATE INDEX IF NOT EXISTS dispute_votes_dispute_active_idx ON dispute_votes(dispute_id, is_active);
CREATE INDEX IF NOT EXISTS dispute_votes_challenged_by_idx ON dispute_votes(challenged_by);

ALTER TABLE dispute_votes
  DROP CONSTRAINT IF EXISTS dispute_votes_unique_vote;

DROP INDEX IF EXISTS dispute_votes_unique_vote;
CREATE UNIQUE INDEX IF NOT EXISTS dispute_votes_unique_active_arbitrator_idx
  ON dispute_votes(dispute_id, arbitrator_id)
  WHERE is_active = TRUE;
