SET TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS hackathon_review_configs (
  action TEXT PRIMARY KEY,
  fallback_base_score INTEGER NOT NULL DEFAULT 80,
  approved_min_score INTEGER NOT NULL DEFAULT 88,
  request_changes_max_score INTEGER NOT NULL DEFAULT 64,
  reject_max_score INTEGER NOT NULL DEFAULT 52,
  default_client_rating INTEGER NOT NULL DEFAULT 90,
  transfer_basis_points INTEGER NOT NULL DEFAULT 100,
  lock_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  summary_template TEXT NOT NULL,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hackathon_review_configs_action_check CHECK (action IN ('rate_decide', 'approve_review')),
  CONSTRAINT hackathon_review_configs_fallback_score_check CHECK (fallback_base_score BETWEEN 0 AND 100),
  CONSTRAINT hackathon_review_configs_approved_score_check CHECK (approved_min_score BETWEEN 0 AND 100),
  CONSTRAINT hackathon_review_configs_request_changes_score_check CHECK (request_changes_max_score BETWEEN 0 AND 100),
  CONSTRAINT hackathon_review_configs_reject_score_check CHECK (reject_max_score BETWEEN 0 AND 100),
  CONSTRAINT hackathon_review_configs_default_rating_check CHECK (default_client_rating BETWEEN 0 AND 100),
  CONSTRAINT hackathon_review_configs_transfer_bps_check CHECK (transfer_basis_points BETWEEN 1 AND 10000)
);

DROP TRIGGER IF EXISTS hackathon_review_configs_set_updated_at ON hackathon_review_configs;
CREATE TRIGGER hackathon_review_configs_set_updated_at
BEFORE UPDATE ON hackathon_review_configs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO hackathon_review_configs (
  action,
  fallback_base_score,
  approved_min_score,
  request_changes_max_score,
  reject_max_score,
  default_client_rating,
  transfer_basis_points,
  lock_enabled,
  summary_template,
  recommendations
)
VALUES
  (
    'rate_decide',
    80,
    88,
    64,
    52,
    90,
    100,
    TRUE,
    'Hackathon review {decision}. Artifact: {artifact_url}. Criteria focus: {criteria_preview}. Score={score}.',
    '["Keep CI checks green and attach proof in notes.","Map each deliverable to acceptance criteria bullets.","Include before/after screenshots or logs for judging."]'::jsonb
  ),
  (
    'approve_review',
    82,
    90,
    65,
    55,
    92,
    150,
    TRUE,
    'Approval pipeline {decision}. Artifact: {artifact_url}. Criteria snapshot: {criteria_preview}. Score={score}.',
    '["Attach final run logs and acceptance checklist.","Document known limitations and mitigations.","Provide clear handoff notes for judges."]'::jsonb
  )
ON CONFLICT (action)
DO UPDATE SET
  fallback_base_score = EXCLUDED.fallback_base_score,
  approved_min_score = EXCLUDED.approved_min_score,
  request_changes_max_score = EXCLUDED.request_changes_max_score,
  reject_max_score = EXCLUDED.reject_max_score,
  default_client_rating = EXCLUDED.default_client_rating,
  transfer_basis_points = EXCLUDED.transfer_basis_points,
  lock_enabled = EXCLUDED.lock_enabled,
  summary_template = EXCLUDED.summary_template,
  recommendations = EXCLUDED.recommendations,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS hackathon_review_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  score INTEGER NOT NULL,
  code_review_source TEXT NOT NULL,
  lock_tx_id TEXT,
  transfer_tx_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hackathon_review_runs_action_check CHECK (action IN ('rate_decide', 'approve_review')),
  CONSTRAINT hackathon_review_runs_decision_check CHECK (decision IN ('approve', 'request_changes', 'reject')),
  CONSTRAINT hackathon_review_runs_score_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT hackathon_review_runs_source_check CHECK (code_review_source IN ('groq', 'db_template'))
);

CREATE INDEX IF NOT EXISTS hackathon_review_runs_submission_idx
  ON hackathon_review_runs(submission_id, created_at DESC);

CREATE INDEX IF NOT EXISTS hackathon_review_runs_bounty_idx
  ON hackathon_review_runs(bounty_id, created_at DESC);
