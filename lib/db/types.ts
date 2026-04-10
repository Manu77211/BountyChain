export type UserRole = "client" | "freelancer" | "arbitrator" | "admin";

export type BountyStatus =
  | "draft"
  | "open"
  | "in_progress"
  | "accepted"
  | "completed"
  | "expired"
  | "expired_no_submission"
  | "expired_all_failed"
  | "cancelled"
  | "disputed"
  | "pending_escrow"
  | "error_escrow_corrupt";

export type ScoringMode = "ai_only" | "ci_only" | "hybrid";
export type MilestoneStatus = "pending" | "unlocked" | "paid" | "failed";

export type CiStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped_abuse"
  | "timeout"
  | "ci_not_found";

export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "in_progress"
  | "validating"
  | "awaiting_ci"
  | "passed"
  | "failed"
  | "expired_incomplete"
  | "disputed"
  | "expired"
  | "abandoned";

export type PayoutStatus = "pending" | "processing" | "completed" | "failed" | "quarantined";

export type DisputeStatus = "open" | "under_review" | "resolved" | "escalated" | "expired";
export type DisputeOutcome = "freelancer_wins" | "client_wins" | "split";
export type DisputeType =
  | "score_unfair"
  | "quality_low"
  | "requirement_mismatch"
  | "fraud"
  | "non_delivery";
export type NotificationType = "email" | "in_app" | "both";

export interface UserRow {
  id: string;
  email: string | null;
  wallet_address: string;
  role: UserRole;
  reputation_score: number;
  is_sanctions_flagged: boolean;
  is_banned: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface BountyRow {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  repo_url: string;
  target_branch: string;
  allowed_languages: string[];
  total_amount: string;
  escrow_contract_address: string | null;
  payout_asset_id?: string | null;
  payout_asset_code?: string;
  contributor_splits?: Array<Record<string, unknown>>;
  escrow_locked: boolean;
  status: BountyStatus;
  scoring_mode: ScoringMode;
  ai_score_threshold: number;
  max_freelancers: number;
  deadline: Date;
  grace_period_minutes: number;
  extension_count: number;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface MilestoneRow {
  id: string;
  bounty_id: string;
  title: string;
  description: string;
  payout_amount: string;
  order_index: number;
  status: MilestoneStatus;
  payout_tx_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SubmissionRow {
  id: string;
  bounty_id: string;
  freelancer_id: string;
  github_pr_url: string;
  github_branch: string;
  github_repo_id: string;
  head_sha: string | null;
  ci_status: CiStatus;
  ci_run_id: string | null;
  ci_retrigger_count: number;
  skipped_test_count: number;
  total_test_count: number;
  ai_score: number | null;
  ai_score_raw: Record<string, unknown> | null;
  ai_integrity_flag: boolean;
  ai_language_mismatch_flag: boolean;
  final_score: number | null;
  evidence_source: "live" | "cache";
  status: SubmissionStatus;
  scoring_idempotency_key: string;
  ai_scoring_in_progress?: boolean;
  ai_scoring_status?: "idle" | "in_progress" | "completed" | "timeout" | "parse_failed" | "manual_review";
  ai_scoring_last_event_hash?: string | null;
  ai_scoring_attempts?: number;
  score_finalized_at?: Date | null;
  client_rating_stars?: number | null;
  client_flagged_at?: Date | null;
  submission_received_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface PayoutRow {
  id: string;
  submission_id: string;
  freelancer_id: string;
  milestone_id: string | null;
  expected_amount: string;
  actual_amount: string | null;
  tx_id: string | null;
  status: PayoutStatus;
  retry_count: number;
  mismatch_flagged: boolean;
  hold_reason?: string | null;
  split_share_key?: string | null;
  payout_group_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DisputeRow {
  id: string;
  submission_id: string;
  raised_by: string;
  reason: string;
  dispute_type: DisputeType;
  status: DisputeStatus;
  outcome: DisputeOutcome | null;
  score_published_at?: Date | null;
  settlement_tx_id?: string | null;
  settlement_payload?: Record<string, unknown>;
  raised_at: Date;
  resolved_at: Date | null;
  escalated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DisputeVoteRow {
  id: string;
  dispute_id: string;
  arbitrator_id: string;
  vote: DisputeOutcome | null;
  justification: string | null;
  is_challenged: boolean;
  is_active?: boolean;
  challenged_by?: string | null;
  challenge_reason?: string | null;
  assigned_at?: Date;
  replaced_at?: Date | null;
  voted_at: Date;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  event_type: string;
  payload: Record<string, unknown>;
  delivered: boolean;
  failed_attempts: number;
  created_at: Date;
}

export interface PlatformDowntimeRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  reason: string;
}

export interface BannedWalletRow {
  wallet_address: string;
  reason: string;
  banned_at: Date;
  banned_by: string;
}

export interface EscrowConsistencyIssueRow {
  bounty_id: string;
  title: string;
  escrow_locked: boolean;
  escrow_contract_address: string | null;
  created_at: Date;
}
