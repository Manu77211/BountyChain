SET TIME ZONE 'UTC';

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS submission_stage TEXT NOT NULL DEFAULT 'final',
  ADD COLUMN IF NOT EXISTS review_gate_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS review_window_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_for_payout_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_for_payout_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS last_client_comment TEXT;

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_submission_stage_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_submission_stage_check
  CHECK (submission_stage IN ('draft', 'final'));

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_review_gate_status_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_review_gate_status_check
  CHECK (review_gate_status IN ('none', 'awaiting_client_review', 'changes_requested', 'approved', 'auto_released'));

CREATE INDEX IF NOT EXISTS submissions_review_gate_idx ON submissions(review_gate_status, review_window_ends_at);

CREATE TABLE IF NOT EXISTS submission_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  freelancer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  stage TEXT NOT NULL,
  artifact_url TEXT NOT NULL,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submission_revisions_unique UNIQUE (submission_id, revision_no),
  CONSTRAINT submission_revisions_stage_check CHECK (stage IN ('draft', 'final')),
  CONSTRAINT submission_revisions_revision_no_check CHECK (revision_no >= 1)
);

CREATE INDEX IF NOT EXISTS submission_revisions_submission_idx ON submission_revisions(submission_id, revision_no DESC);
CREATE INDEX IF NOT EXISTS submission_revisions_bounty_idx ON submission_revisions(bounty_id, created_at DESC);

CREATE TABLE IF NOT EXISTS submission_review_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  revision_id UUID REFERENCES submission_revisions(id) ON DELETE SET NULL,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_comment_id UUID REFERENCES submission_review_comments(id) ON DELETE SET NULL,
  comment_type TEXT NOT NULL DEFAULT 'note',
  visibility TEXT NOT NULL DEFAULT 'both',
  content TEXT NOT NULL,
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submission_review_comments_type_check CHECK (comment_type IN ('note', 'suggestion', 'issue', 'approve', 'reject', 'request_changes')),
  CONSTRAINT submission_review_comments_visibility_check CHECK (visibility IN ('both', 'client_only', 'freelancer_only')),
  CONSTRAINT submission_review_comments_content_check CHECK (LENGTH(TRIM(content)) >= 2)
);

CREATE INDEX IF NOT EXISTS submission_review_comments_submission_idx ON submission_review_comments(submission_id, created_at ASC);
CREATE INDEX IF NOT EXISTS submission_review_comments_parent_idx ON submission_review_comments(parent_comment_id);

DROP TRIGGER IF EXISTS submission_review_comments_set_updated_at ON submission_review_comments;
CREATE TRIGGER submission_review_comments_set_updated_at
BEFORE UPDATE ON submission_review_comments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS submission_review_rubrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  revision_id UUID REFERENCES submission_revisions(id) ON DELETE SET NULL,
  reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completeness_score INTEGER NOT NULL,
  quality_score INTEGER NOT NULL,
  communication_score INTEGER NOT NULL,
  requirement_alignment_score INTEGER NOT NULL,
  overall_score INTEGER NOT NULL,
  decision TEXT NOT NULL,
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submission_review_rubrics_decision_check CHECK (decision IN ('approve', 'request_changes', 'reject')),
  CONSTRAINT submission_review_rubrics_completeness_check CHECK (completeness_score BETWEEN 0 AND 100),
  CONSTRAINT submission_review_rubrics_quality_check CHECK (quality_score BETWEEN 0 AND 100),
  CONSTRAINT submission_review_rubrics_communication_check CHECK (communication_score BETWEEN 0 AND 100),
  CONSTRAINT submission_review_rubrics_alignment_check CHECK (requirement_alignment_score BETWEEN 0 AND 100),
  CONSTRAINT submission_review_rubrics_overall_check CHECK (overall_score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS submission_review_rubrics_submission_idx ON submission_review_rubrics(submission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS submission_feedback_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  revision_id UUID REFERENCES submission_revisions(id) ON DELETE SET NULL,
  generated_by TEXT NOT NULL DEFAULT 'hybrid',
  ai_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  checklist_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  implemented_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_summary TEXT NOT NULL,
  freelancer_summary TEXT NOT NULL,
  freelancer_suggestions JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submission_feedback_reports_generated_by_check CHECK (generated_by IN ('ai', 'system', 'hybrid'))
);

CREATE INDEX IF NOT EXISTS submission_feedback_reports_submission_idx ON submission_feedback_reports(submission_id, created_at DESC);

UPDATE submissions
SET submission_stage = CASE
      WHEN status = 'draft' THEN 'draft'
      ELSE 'final'
    END,
    review_gate_status = CASE
      WHEN final_score IS NOT NULL AND status IN ('submitted', 'validating', 'passed', 'failed') THEN 'awaiting_client_review'
      ELSE 'none'
    END
WHERE submission_stage IS NULL OR review_gate_status IS NULL;
