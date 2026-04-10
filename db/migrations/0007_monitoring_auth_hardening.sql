SET TIME ZONE 'UTC';

DO $$
BEGIN
  ALTER TYPE bounty_status ADD VALUE IF NOT EXISTS 'error_escrow_corrupt';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE submissions
  DROP CONSTRAINT IF EXISTS submissions_ci_retrigger_count_check;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_ci_retrigger_count_check
  CHECK (ci_retrigger_count >= 0 AND ci_retrigger_count <= 10);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE INDEX IF NOT EXISTS users_email_active_idx
  ON users (email)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_submission_reminder_idx
  ON notifications ((payload->>'submission_id'), event_type, user_id);
