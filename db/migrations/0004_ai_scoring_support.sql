SET TIME ZONE 'UTC';

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS ai_scoring_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_scoring_status TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS ai_scoring_last_event_hash TEXT,
  ADD COLUMN IF NOT EXISTS ai_scoring_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS score_finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_rating_stars INTEGER,
  ADD COLUMN IF NOT EXISTS client_flagged_at TIMESTAMPTZ;

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_ai_scoring_status_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_ai_scoring_status_check
  CHECK (ai_scoring_status IN ('idle', 'in_progress', 'completed', 'timeout', 'parse_failed', 'manual_review'));

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_ai_scoring_attempts_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_ai_scoring_attempts_check
  CHECK (ai_scoring_attempts >= 0);

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_client_rating_stars_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_client_rating_stars_check
  CHECK (client_rating_stars IS NULL OR (client_rating_stars >= 1 AND client_rating_stars <= 5));

CREATE INDEX IF NOT EXISTS submissions_ai_scoring_status_idx ON submissions(ai_scoring_status);
CREATE INDEX IF NOT EXISTS submissions_ai_scoring_event_hash_idx ON submissions(ai_scoring_last_event_hash);
CREATE INDEX IF NOT EXISTS submissions_score_finalized_at_idx ON submissions(score_finalized_at DESC);
