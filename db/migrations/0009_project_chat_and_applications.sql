SET TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS project_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  freelancer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  proposed_amount BIGINT,
  estimated_days INTEGER,
  deliverables TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_applications_unique UNIQUE (bounty_id, freelancer_id),
  CONSTRAINT project_applications_status_check CHECK (status IN ('pending', 'selected', 'rejected')),
  CONSTRAINT project_applications_amount_check CHECK (proposed_amount IS NULL OR proposed_amount > 0),
  CONSTRAINT project_applications_estimated_days_check CHECK (estimated_days IS NULL OR estimated_days > 0)
);

CREATE INDEX IF NOT EXISTS project_applications_bounty_idx
  ON project_applications (bounty_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS project_applications_freelancer_idx
  ON project_applications (freelancer_id, created_at DESC);

DROP TRIGGER IF EXISTS project_applications_set_updated_at ON project_applications;
CREATE TRIGGER project_applications_set_updated_at
BEFORE UPDATE ON project_applications
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS bounty_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bounty_messages_content_check CHECK (LENGTH(TRIM(content)) > 0)
);

CREATE INDEX IF NOT EXISTS bounty_messages_bounty_idx
  ON bounty_messages (bounty_id, created_at ASC);

CREATE INDEX IF NOT EXISTS bounty_messages_sender_idx
  ON bounty_messages (sender_id, created_at DESC);
