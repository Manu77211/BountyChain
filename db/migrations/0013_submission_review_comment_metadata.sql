SET TIME ZONE 'UTC';

ALTER TABLE submission_review_comments
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
