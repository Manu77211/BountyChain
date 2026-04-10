SET TIME ZONE 'UTC';

DO $$
BEGIN
  ALTER TYPE ci_status ADD VALUE IF NOT EXISTS 'ci_not_found';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TYPE submission_status ADD VALUE IF NOT EXISTS 'awaiting_ci';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS head_sha TEXT,
  ADD COLUMN IF NOT EXISTS evidence_source TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS ci_retrigger_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_ci_retrigger_count_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_ci_retrigger_count_check CHECK (ci_retrigger_count >= 0 AND ci_retrigger_count <= 1);

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_evidence_source_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_evidence_source_check CHECK (evidence_source IN ('live', 'cache'));

CREATE INDEX IF NOT EXISTS submissions_head_sha_idx ON submissions(head_sha);

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  action TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  payload_sha256 TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT github_webhook_deliveries_status_check CHECK (status IN ('processing', 'processed', 'ignored', 'failed'))
);

CREATE INDEX IF NOT EXISTS github_webhook_deliveries_event_type_idx ON github_webhook_deliveries(event_type);
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_status_idx ON github_webhook_deliveries(status);

CREATE TRIGGER github_webhook_deliveries_set_updated_at
BEFORE UPDATE ON github_webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION lock_bounty_repo_branch_on_acceptance()
RETURNS TRIGGER AS $$
DECLARE
  has_submissions BOOLEAN;
  existing_repo_url TEXT;
  existing_target_branch TEXT;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  SELECT repo_url, target_branch
  INTO existing_repo_url, existing_target_branch
  FROM bounties
  WHERE id = NEW.id;

  IF NEW.repo_url = existing_repo_url AND NEW.target_branch = existing_target_branch THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM submissions s
    WHERE s.bounty_id = NEW.id
  )
  INTO has_submissions;

  IF has_submissions THEN
    RAISE EXCEPTION 'GH-C-002: repo_url and target_branch are locked after first acceptance';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bounties_lock_repo_branch_on_acceptance ON bounties;
CREATE TRIGGER bounties_lock_repo_branch_on_acceptance
BEFORE UPDATE OF repo_url, target_branch ON bounties
FOR EACH ROW EXECUTE FUNCTION lock_bounty_repo_branch_on_acceptance();
