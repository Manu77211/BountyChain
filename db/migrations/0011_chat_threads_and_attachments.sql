SET TIME ZONE 'UTC';

ALTER TABLE bounty_messages
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'bounty';

ALTER TABLE bounty_messages
  ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES project_applications(id) ON DELETE CASCADE;

ALTER TABLE bounty_messages
  ADD COLUMN IF NOT EXISTS file_name TEXT;

ALTER TABLE bounty_messages
  ADD COLUMN IF NOT EXISTS file_size BIGINT;

ALTER TABLE bounty_messages
  ADD COLUMN IF NOT EXISTS file_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bounty_messages_scope_check'
  ) THEN
    ALTER TABLE bounty_messages
      ADD CONSTRAINT bounty_messages_scope_check
      CHECK (scope IN ('bounty', 'application'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bounty_messages_application_scope_check'
  ) THEN
    ALTER TABLE bounty_messages
      ADD CONSTRAINT bounty_messages_application_scope_check
      CHECK ((scope = 'application' AND application_id IS NOT NULL) OR (scope = 'bounty' AND application_id IS NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bounty_messages_file_size_check'
  ) THEN
    ALTER TABLE bounty_messages
      ADD CONSTRAINT bounty_messages_file_size_check
      CHECK (file_size IS NULL OR file_size >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bounty_messages_conversation_idx
  ON bounty_messages (bounty_id, scope, application_id, created_at ASC);

CREATE INDEX IF NOT EXISTS bounty_messages_application_idx
  ON bounty_messages (application_id, created_at DESC)
  WHERE application_id IS NOT NULL;
