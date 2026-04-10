SET TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS project_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  scheduled_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  agenda TEXT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  meeting_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_meetings_title_check CHECK (LENGTH(TRIM(title)) > 0)
);

CREATE INDEX IF NOT EXISTS project_meetings_bounty_idx
  ON project_meetings (bounty_id, scheduled_for ASC);

CREATE INDEX IF NOT EXISTS project_meetings_scheduled_by_idx
  ON project_meetings (scheduled_by, created_at DESC);

DROP TRIGGER IF EXISTS project_meetings_set_updated_at ON project_meetings;
CREATE TRIGGER project_meetings_set_updated_at
BEFORE UPDATE ON project_meetings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
