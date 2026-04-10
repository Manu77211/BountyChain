SET TIME ZONE 'UTC';

DO $$
BEGIN
  ALTER TYPE bounty_status ADD VALUE IF NOT EXISTS 'pending_escrow';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_sessions_wallet_address_check CHECK (wallet_address ~ '^[A-Z2-7]{58}$')
);

CREATE TABLE IF NOT EXISTS sanctions_screenings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  route_name TEXT NOT NULL,
  is_flagged BOOLEAN NOT NULL,
  source TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sanctions_screenings_wallet_address_check CHECK (wallet_address ~ '^[A-Z2-7]{58}$')
);

CREATE TABLE IF NOT EXISTS bounty_deadline_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  freelancer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bounty_deadline_acknowledgments_unique UNIQUE (bounty_id, freelancer_id)
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_wallet_address_idx ON auth_sessions(wallet_address);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_revoked_at_idx ON auth_sessions(revoked_at);

CREATE INDEX IF NOT EXISTS sanctions_screenings_wallet_address_idx ON sanctions_screenings(wallet_address);
CREATE INDEX IF NOT EXISTS sanctions_screenings_user_id_idx ON sanctions_screenings(user_id);
CREATE INDEX IF NOT EXISTS sanctions_screenings_route_name_idx ON sanctions_screenings(route_name);
CREATE INDEX IF NOT EXISTS sanctions_screenings_created_at_idx ON sanctions_screenings(created_at DESC);

CREATE INDEX IF NOT EXISTS bounty_deadline_ack_bounty_id_idx ON bounty_deadline_acknowledgments(bounty_id);
CREATE INDEX IF NOT EXISTS bounty_deadline_ack_freelancer_id_idx ON bounty_deadline_acknowledgments(freelancer_id);

CREATE TRIGGER auth_sessions_set_updated_at
BEFORE UPDATE ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
