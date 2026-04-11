SET TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS mock_escrow_holds (
  bounty_id UUID PRIMARY KEY REFERENCES bounties(id) ON DELETE CASCADE,
  creator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_wallet_address TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  amount_microalgo BIGINT NOT NULL CHECK (amount_microalgo > 0),
  remaining_microalgo BIGINT NOT NULL CHECK (remaining_microalgo >= 0),
  status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'partial', 'released', 'refunded')),
  lock_tx_id TEXT NOT NULL,
  release_tx_id TEXT,
  refund_tx_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mock_escrow_holds_wallet_address_check CHECK (creator_wallet_address ~ '^[A-Z2-7]{58}$')
);

CREATE INDEX IF NOT EXISTS mock_escrow_holds_creator_user_idx
  ON mock_escrow_holds(creator_user_id);

CREATE INDEX IF NOT EXISTS mock_escrow_holds_status_idx
  ON mock_escrow_holds(status);

DROP TRIGGER IF EXISTS mock_escrow_holds_set_updated_at ON mock_escrow_holds;
CREATE TRIGGER mock_escrow_holds_set_updated_at
BEFORE UPDATE ON mock_escrow_holds
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS mock_escrow_transfers (
  id BIGSERIAL PRIMARY KEY,
  transfer_key TEXT NOT NULL UNIQUE,
  bounty_id UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  tx_id TEXT NOT NULL,
  total_amount_microalgo BIGINT NOT NULL CHECK (total_amount_microalgo > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mock_escrow_transfers_bounty_idx
  ON mock_escrow_transfers(bounty_id);
