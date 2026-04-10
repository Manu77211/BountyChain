import type { PoolClient } from "pg";
import { dbQuery, withTransaction } from "./client";
import type {
  BountyRow,
  DisputeRow,
  EscrowConsistencyIssueRow,
  MilestoneRow,
  NotificationType,
  SubmissionRow,
  UserRow,
} from "./types";

const NOT_DELETED_BOUNTY = "deleted_at IS NULL";
const NOT_DELETED_USER = "deleted_at IS NULL";

export interface NewMilestoneInput {
  title: string;
  description: string;
  payoutAmount: string;
  orderIndex: number;
}

export interface NewBountyInput {
  creatorId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  repoUrl: string;
  allowedLanguages: string[];
  totalAmount: string;
  scoringMode: "ai_only" | "ci_only" | "hybrid";
  deadline: Date;
  idempotencyKey: string;
  milestones: NewMilestoneInput[];
}

export async function listOpenBounties(limit = 50): Promise<BountyRow[]> {
  const sql = `
    SELECT *
    FROM bounties
    WHERE ${NOT_DELETED_BOUNTY}
      AND status = 'open'
    ORDER BY created_at DESC
    LIMIT $1
  `;
  const result = await dbQuery<BountyRow>(sql, [limit]);
  return result.rows;
}

export async function getBountyById(id: string): Promise<BountyRow | null> {
  const sql = `
    SELECT *
    FROM bounties
    WHERE id = $1
      AND ${NOT_DELETED_BOUNTY}
    LIMIT 1
  `;
  const result = await dbQuery<BountyRow>(sql, [id]);
  return result.rows[0] ?? null;
}

export async function getActiveUserById(id: string): Promise<UserRow | null> {
  const sql = `
    SELECT *
    FROM users
    WHERE id = $1
      AND ${NOT_DELETED_USER}
    LIMIT 1
  `;
  const result = await dbQuery<UserRow>(sql, [id]);
  return result.rows[0] ?? null;
}

export async function getActiveUserByWallet(walletAddress: string) {
  const sql = `
    SELECT *
    FROM users
    WHERE wallet_address = $1
      AND ${NOT_DELETED_USER}
    LIMIT 1
  `;
  const result = await dbQuery<UserRow>(sql, [walletAddress]);
  return result.rows[0] ?? null;
}

export async function createBountyWithMilestones(input: NewBountyInput) {
  return withTransaction(async (client) => {
    const bounty = await insertBounty(client, input);
    const milestones = await insertMilestones(client, bounty.id, input.milestones);
    return { bounty, milestones };
  });
}

export interface AcceptBountyInput {
  bountyId: string;
  freelancerId: string;
  githubPrUrl: string;
  githubBranch: string;
  githubRepoId: string;
  scoringIdempotencyKey: string;
}

export async function acceptBountyWithRowLock(input: AcceptBountyInput) {
  return withTransaction(async (client) => {
    await lockBountyForAcceptance(client, input.bountyId);
    await client.query(
      "UPDATE bounties SET status = 'in_progress' WHERE id = $1 AND deleted_at IS NULL",
      [input.bountyId],
    );

    const sql = `
      INSERT INTO submissions (
        bounty_id,
        freelancer_id,
        github_pr_url,
        github_branch,
        github_repo_id,
        scoring_idempotency_key,
        status,
        submission_received_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'submitted', NOW())
      RETURNING *
    `;

    const params = [
      input.bountyId,
      input.freelancerId,
      input.githubPrUrl,
      input.githubBranch,
      input.githubRepoId,
      input.scoringIdempotencyKey,
    ];

    const result = await client.query<SubmissionRow>(sql, params);
    return result.rows[0];
  });
}

export async function findEscrowConsistencyIssues() {
  const sql = `
    SELECT id AS bounty_id, title, escrow_locked, escrow_contract_address, created_at
    FROM bounties
    WHERE ${NOT_DELETED_BOUNTY}
      AND escrow_locked = TRUE
      AND escrow_contract_address IS NULL
    ORDER BY created_at DESC
  `;
  const result = await dbQuery<EscrowConsistencyIssueRow>(sql);
  return result.rows;
}

export interface CreateDisputeInput {
  submissionId: string;
  raisedBy: string;
  reason: string;
  notifyUserIds: string[];
}

export async function createDisputeAndNotify(input: CreateDisputeInput) {
  return withTransaction(async (client) => {
    const dispute = await insertDispute(client, input);
    await insertDisputeNotifications(client, input.notifyUserIds, dispute.id);
    return dispute;
  });
}

async function insertBounty(client: PoolClient, input: NewBountyInput) {
  const sql = `
    INSERT INTO bounties (
      creator_id,
      title,
      description,
      acceptance_criteria,
      repo_url,
      allowed_languages,
      total_amount,
      scoring_mode,
      deadline,
      idempotency_key,
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')
    RETURNING *
  `;

  const params = [
    input.creatorId,
    input.title,
    input.description,
    input.acceptanceCriteria,
    input.repoUrl,
    input.allowedLanguages,
    input.totalAmount,
    input.scoringMode,
    input.deadline,
    input.idempotencyKey,
  ];

  const result = await client.query<BountyRow>(sql, params);
  return result.rows[0];
}

async function insertMilestones(
  client: PoolClient,
  bountyId: string,
  milestones: NewMilestoneInput[],
) {
  const created: MilestoneRow[] = [];
  for (const milestone of milestones) {
    const sql = `
      INSERT INTO milestones (
        bounty_id,
        title,
        description,
        payout_amount,
        order_index,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
    `;

    const params = [
      bountyId,
      milestone.title,
      milestone.description,
      milestone.payoutAmount,
      milestone.orderIndex,
    ];

    const row = await client.query<MilestoneRow>(sql, params);
    created.push(row.rows[0]);
  }
  return created;
}

async function lockBountyForAcceptance(client: PoolClient, bountyId: string) {
  const sql = `
    SELECT id
    FROM bounties
    WHERE id = $1
      AND deleted_at IS NULL
      AND status IN ('open', 'in_progress')
    FOR UPDATE
  `;

  const result = await client.query<{ id: string }>(sql, [bountyId]);
  if (result.rowCount === 0) {
    throw new Error("DB-001: Bounty cannot be accepted in current state.");
  }
}

async function insertDispute(client: PoolClient, input: CreateDisputeInput) {
  const sql = `
    INSERT INTO disputes (submission_id, raised_by, reason, status, raised_at)
    VALUES ($1, $2, $3, 'open', NOW())
    RETURNING *
  `;
  const params = [input.submissionId, input.raisedBy, input.reason];
  const result = await client.query<DisputeRow>(sql, params);
  return result.rows[0];
}

async function insertDisputeNotifications(
  client: PoolClient,
  userIds: string[],
  disputeId: string,
) {
  for (const userId of userIds) {
    const type: NotificationType = "in_app";
    const sql = `
      INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
      VALUES ($1, $2, 'dispute_raised', jsonb_build_object('dispute_id', $3), FALSE, 0)
    `;
    await client.query(sql, [userId, type, disputeId]);
  }
}
