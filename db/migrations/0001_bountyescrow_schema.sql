SET TIME ZONE 'UTC';
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('client', 'freelancer', 'arbitrator', 'admin');
CREATE TYPE bounty_status AS ENUM (
  'draft',
  'open',
  'in_progress',
  'completed',
  'expired',
  'cancelled',
  'disputed'
);
CREATE TYPE scoring_mode AS ENUM ('ai_only', 'ci_only', 'hybrid');
CREATE TYPE milestone_status AS ENUM ('pending', 'unlocked', 'paid', 'failed');
CREATE TYPE ci_status AS ENUM (
  'pending',
  'running',
  'passed',
  'failed',
  'skipped_abuse',
  'timeout'
);
CREATE TYPE submission_status AS ENUM (
  'draft',
  'submitted',
  'validating',
  'passed',
  'failed',
  'disputed',
  'expired',
  'abandoned'
);
CREATE TYPE payout_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed',
  'quarantined'
);
CREATE TYPE dispute_status AS ENUM (
  'open',
  'under_review',
  'resolved',
  'escalated',
  'expired'
);
CREATE TYPE dispute_outcome AS ENUM ('freelancer_wins', 'client_wins', 'split');
CREATE TYPE notification_type AS ENUM ('email', 'in_app', 'both');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  wallet_address TEXT NOT NULL UNIQUE,
  role user_role NOT NULL,
  reputation_score INTEGER NOT NULL DEFAULT 100,
  is_sanctions_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT users_reputation_score_check CHECK (reputation_score >= 0),
  CONSTRAINT users_wallet_address_check CHECK (wallet_address ~ '^[A-Z2-7]{58}$')
);

CREATE TABLE bounties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  allowed_languages TEXT[] NOT NULL DEFAULT '{}',
  total_amount BIGINT NOT NULL,
  escrow_contract_address BIGINT,
  escrow_locked BOOLEAN NOT NULL DEFAULT FALSE,
  status bounty_status NOT NULL DEFAULT 'draft',
  scoring_mode scoring_mode NOT NULL DEFAULT 'hybrid',
  ai_score_threshold INTEGER NOT NULL DEFAULT 60,
  max_freelancers INTEGER NOT NULL DEFAULT 1,
  deadline TIMESTAMPTZ NOT NULL,
  grace_period_minutes INTEGER NOT NULL DEFAULT 60,
  extension_count INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT bounties_total_amount_check CHECK (total_amount > 0),
  CONSTRAINT bounties_repo_url_check CHECK (repo_url ~ '^https://github.com/.+/.+$'),
  CONSTRAINT bounties_ai_score_threshold_check CHECK (ai_score_threshold BETWEEN 0 AND 100),
  CONSTRAINT bounties_max_freelancers_check CHECK (max_freelancers >= 1),
  CONSTRAINT bounties_grace_period_minutes_check CHECK (grace_period_minutes >= 0),
  CONSTRAINT bounties_extension_count_check CHECK (extension_count BETWEEN 0 AND 2)
);

CREATE TABLE milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  payout_amount BIGINT NOT NULL,
  order_index INTEGER NOT NULL,
  status milestone_status NOT NULL DEFAULT 'pending',
  payout_tx_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT milestones_payout_amount_check CHECK (payout_amount > 0),
  CONSTRAINT milestones_order_index_check CHECK (order_index >= 0),
  CONSTRAINT milestones_bounty_order_unique UNIQUE (bounty_id, order_index)
);

CREATE TABLE submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  freelancer_id UUID NOT NULL REFERENCES users(id),
  github_pr_url TEXT NOT NULL,
  github_branch TEXT NOT NULL,
  github_repo_id BIGINT NOT NULL,
  ci_status ci_status NOT NULL DEFAULT 'pending',
  ci_run_id BIGINT,
  skipped_test_count INTEGER NOT NULL DEFAULT 0,
  total_test_count INTEGER NOT NULL DEFAULT 0,
  ai_score INTEGER,
  ai_score_raw JSONB,
  ai_integrity_flag BOOLEAN NOT NULL DEFAULT FALSE,
  ai_language_mismatch_flag BOOLEAN NOT NULL DEFAULT FALSE,
  final_score INTEGER,
  status submission_status NOT NULL DEFAULT 'draft',
  scoring_idempotency_key TEXT NOT NULL UNIQUE,
  submission_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT submissions_skipped_test_count_check CHECK (skipped_test_count >= 0),
  CONSTRAINT submissions_total_test_count_check CHECK (total_test_count >= 0),
  CONSTRAINT submissions_ai_score_check CHECK (ai_score IS NULL OR ai_score BETWEEN 0 AND 100),
  CONSTRAINT submissions_final_score_check CHECK (final_score IS NULL OR final_score BETWEEN 0 AND 100)
);

CREATE TABLE payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  freelancer_id UUID NOT NULL REFERENCES users(id),
  milestone_id UUID REFERENCES milestones(id),
  expected_amount BIGINT NOT NULL,
  actual_amount BIGINT,
  tx_id TEXT,
  status payout_status NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  mismatch_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payouts_expected_amount_check CHECK (expected_amount > 0),
  CONSTRAINT payouts_actual_amount_check CHECK (actual_amount IS NULL OR actual_amount > 0),
  CONSTRAINT payouts_retry_count_check CHECK (retry_count >= 0)
);

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  raised_by UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status dispute_status NOT NULL DEFAULT 'open',
  outcome dispute_outcome,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT disputes_resolved_after_raised_check CHECK (resolved_at IS NULL OR resolved_at >= raised_at),
  CONSTRAINT disputes_escalated_after_raised_check CHECK (escalated_at IS NULL OR escalated_at >= raised_at)
);

CREATE TABLE dispute_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  arbitrator_id UUID NOT NULL REFERENCES users(id),
  vote dispute_outcome NOT NULL,
  justification TEXT NOT NULL,
  is_challenged BOOLEAN NOT NULL DEFAULT FALSE,
  voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dispute_votes_unique_vote UNIQUE (dispute_id, arbitrator_id)
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type notification_type NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_failed_attempts_check CHECK (failed_attempts >= 0)
);

CREATE TABLE platform_downtime (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  CONSTRAINT platform_downtime_window_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE banned_wallets (
  wallet_address TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  banned_by UUID NOT NULL REFERENCES users(id),
  CONSTRAINT banned_wallets_wallet_address_check CHECK (wallet_address ~ '^[A-Z2-7]{58}$')
);

CREATE INDEX users_role_idx ON users(role);
CREATE INDEX users_banned_idx ON users(is_banned);
CREATE INDEX users_sanctions_idx ON users(is_sanctions_flagged);
CREATE INDEX users_not_deleted_idx ON users(id) WHERE deleted_at IS NULL;

CREATE INDEX bounties_creator_id_idx ON bounties(creator_id);
CREATE INDEX bounties_status_idx ON bounties(status);
CREATE INDEX bounties_deadline_idx ON bounties(deadline);
CREATE INDEX bounties_escrow_locked_idx ON bounties(escrow_locked);
CREATE INDEX bounties_not_deleted_idx ON bounties(id) WHERE deleted_at IS NULL;

CREATE INDEX milestones_bounty_id_idx ON milestones(bounty_id);
CREATE INDEX milestones_status_idx ON milestones(status);

CREATE INDEX submissions_bounty_id_idx ON submissions(bounty_id);
CREATE INDEX submissions_freelancer_id_idx ON submissions(freelancer_id);
CREATE INDEX submissions_status_idx ON submissions(status);
CREATE INDEX submissions_ci_status_idx ON submissions(ci_status);
CREATE INDEX submissions_received_at_idx ON submissions(submission_received_at);

CREATE UNIQUE INDEX submissions_active_one_per_bounty_idx
  ON submissions (bounty_id, freelancer_id)
  WHERE status IN ('draft', 'submitted', 'validating', 'passed', 'disputed');

CREATE INDEX payouts_submission_id_idx ON payouts(submission_id);
CREATE INDEX payouts_freelancer_id_idx ON payouts(freelancer_id);
CREATE INDEX payouts_milestone_id_idx ON payouts(milestone_id);
CREATE INDEX payouts_status_idx ON payouts(status);
CREATE INDEX payouts_tx_id_idx ON payouts(tx_id);

CREATE INDEX disputes_submission_id_idx ON disputes(submission_id);
CREATE INDEX disputes_raised_by_idx ON disputes(raised_by);
CREATE INDEX disputes_status_idx ON disputes(status);
CREATE INDEX disputes_outcome_idx ON disputes(outcome);

CREATE INDEX dispute_votes_dispute_id_idx ON dispute_votes(dispute_id);
CREATE INDEX dispute_votes_arbitrator_id_idx ON dispute_votes(arbitrator_id);

CREATE INDEX notifications_user_id_idx ON notifications(user_id);
CREATE INDEX notifications_delivered_idx ON notifications(delivered);
CREATE INDEX notifications_event_type_idx ON notifications(event_type);
CREATE INDEX notifications_created_at_idx ON notifications(created_at DESC);

CREATE INDEX platform_downtime_started_at_idx ON platform_downtime(started_at DESC);
CREATE INDEX banned_wallets_banned_by_idx ON banned_wallets(banned_by);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER bounties_set_updated_at
BEFORE UPDATE ON bounties
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER milestones_set_updated_at
BEFORE UPDATE ON milestones
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER submissions_set_updated_at
BEFORE UPDATE ON submissions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER payouts_set_updated_at
BEFORE UPDATE ON payouts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER disputes_set_updated_at
BEFORE UPDATE ON disputes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_milestone_payout_total()
RETURNS TRIGGER AS $$
DECLARE
  bounty_total BIGINT;
  payout_sum BIGINT;
BEGIN
  SELECT total_amount
  INTO bounty_total
  FROM bounties
  WHERE id = NEW.bounty_id
  FOR UPDATE;

  SELECT COALESCE(SUM(payout_amount), 0)
  INTO payout_sum
  FROM milestones
  WHERE bounty_id = NEW.bounty_id
    AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  payout_sum := payout_sum + NEW.payout_amount;

  IF payout_sum > bounty_total THEN
    RAISE EXCEPTION 'Milestone payouts exceed bounty total_amount';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER milestones_validate_payout_total
BEFORE INSERT OR UPDATE OF payout_amount, bounty_id ON milestones
FOR EACH ROW EXECUTE FUNCTION validate_milestone_payout_total();

CREATE OR REPLACE FUNCTION prevent_creator_active_submission()
RETURNS TRIGGER AS $$
DECLARE
  bounty_creator UUID;
BEGIN
  IF NEW.status NOT IN ('draft', 'submitted', 'validating', 'passed', 'disputed') THEN
    RETURN NEW;
  END IF;

  SELECT creator_id
  INTO bounty_creator
  FROM bounties
  WHERE id = NEW.bounty_id;

  IF bounty_creator = NEW.freelancer_id THEN
    RAISE EXCEPTION 'XC-001: bounty creator cannot create an active submission for own bounty';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER submissions_prevent_creator_active
BEFORE INSERT OR UPDATE OF bounty_id, freelancer_id, status ON submissions
FOR EACH ROW EXECUTE FUNCTION prevent_creator_active_submission();

