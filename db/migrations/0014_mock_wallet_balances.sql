SET TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS mock_wallet_balances (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  balance_microalgo BIGINT NOT NULL DEFAULT 0 CHECK (balance_microalgo >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mock_wallet_balances_wallet_address_check CHECK (wallet_address ~ '^[A-Z2-7]{58}$')
);

CREATE INDEX IF NOT EXISTS mock_wallet_balances_wallet_address_idx
  ON mock_wallet_balances(wallet_address);

DROP TRIGGER IF EXISTS mock_wallet_balances_set_updated_at ON mock_wallet_balances;
CREATE TRIGGER mock_wallet_balances_set_updated_at
BEFORE UPDATE ON mock_wallet_balances
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
