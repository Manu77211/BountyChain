SET TIME ZONE 'UTC';

INSERT INTO users (
  id,
  email,
  wallet_address,
  role,
  reputation_score,
  is_sanctions_flagged,
  is_banned
)
VALUES
  (
    '11111111-1111-1111-1111-111111111111',
    'client@bountyescrow.ai',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'client',
    120,
    FALSE,
    FALSE
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'freelancer@bountyescrow.ai',
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'freelancer',
    110,
    FALSE,
    FALSE
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    'arbitrator@bountyescrow.ai',
    'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    'arbitrator',
    130,
    FALSE,
    FALSE
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO bounties (
  id,
  creator_id,
  title,
  description,
  acceptance_criteria,
  repo_url,
  target_branch,
  allowed_languages,
  total_amount,
  escrow_contract_address,
  escrow_locked,
  status,
  scoring_mode,
  ai_score_threshold,
  max_freelancers,
  deadline,
  grace_period_minutes,
  extension_count,
  idempotency_key
)
VALUES (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  'Implement Wallet Session Guard',
  'Add wallet session isolation and replay-safe nonce checks for payout flows.',
  'CI must pass, AI score >= 70, and no skipped abuse checks.',
  'https://github.com/example/bountyescrow-core',
  'main',
  ARRAY['typescript', 'python', 'solidity'],
  8000000,
  NULL,
  FALSE,
  'open',
  'hybrid',
  70,
  1,
  NOW() + INTERVAL '14 days',
  60,
  0,
  'seed-bounty-4444'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO milestones (
  id,
  bounty_id,
  title,
  description,
  payout_amount,
  order_index,
  status,
  payout_tx_id
)
VALUES (
  '55555555-5555-5555-5555-555555555555',
  '44444444-4444-4444-4444-444444444444',
  'Wallet Guard Implementation',
  'Implement nonce and signature replay protection with unit coverage.',
  8000000,
  0,
  'pending',
  NULL
)
ON CONFLICT (id) DO NOTHING;

