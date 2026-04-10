import { randomUUID } from "node:crypto";
import { dbQuery, withTransaction } from "../../lib/db/client";
import type { DisputeOutcome, DisputeType, DisputeVoteRow, SubmissionStatus } from "../../lib/db/types";
import { emitToArbitration, emitToBounty } from "../realtime/socket";
import { AlgorandService } from "./algorand";
import { isValidAlgorandAddress, normalizeWalletAddress } from "./wallet";

const MAX_SCORE_DISPUTE_HOURS = 72;
const POST_PAYOUT_DISPUTE_BLOCK_HOURS = 24;
const STALE_DISPUTE_DAYS = 7;

const algorandService = new AlgorandService();

export interface DisputeDispatcher {
  send: (eventName: string, data: Record<string, unknown>) => Promise<void>;
}

export interface DisputeSocket {
  emitToUsers: (userIds: string[], eventName: string, payload: Record<string, unknown>) => Promise<void>;
}

interface DisputeContext {
  submission: {
    id: string;
    bounty_id: string;
    freelancer_id: string;
    status: SubmissionStatus;
    score_finalized_at: Date | null;
    ai_score_raw: Record<string, unknown> | null;
    final_score: number | null;
    ci_status: string;
    github_pr_url: string;
    github_branch: string;
  };
  bounty: {
    id: string;
    creator_id: string;
    status: string;
    acceptance_criteria: string;
    repo_url: string;
    target_branch: string;
  };
  freelancer_wallet: string;
}

export async function openDispute(
  input: {
    submission_id: string;
    reason: string;
    dispute_type: DisputeType;
  },
  actorUserId: string,
  dispatcher: DisputeDispatcher,
  socket: DisputeSocket,
) {
  const context = await getDisputeContext(input.submission_id);
  verifyDisputeActor(context, actorUserId);
  verifySubmissionStateForDispute(context.submission.status);
  await verifyDisputeWindow(context, input.dispute_type);
  await verifyPostPayoutDisputeRule(context.submission.id, context.bounty.status);

  const arbitrators = await selectArbitrators({
    excludeUserIds: [context.bounty.creator_id, context.submission.freelancer_id],
    count: 3,
  });

  if (arbitrators.length < 3) {
    throw new Error("DS-003: not enough eligible arbitrators available");
  }

  const disputeId = randomUUID();
  const onChainDispute = await algorandService.openDisputeWithRetry({
    disputeId,
    submissionId: context.submission.id,
    bountyId: context.bounty.id,
  });
  const disputeConfirmation = await algorandService.waitForTransactionConfirmation(onChainDispute.txId, 1);
  if (!disputeConfirmation.confirmed) {
    throw new Error("SC-C-003: dispute open transaction not confirmed");
  }

  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO disputes (
          id,
          submission_id,
          raised_by,
          reason,
          dispute_type,
          status,
          score_published_at,
          raised_at
        )
        VALUES ($1, $2, $3, $4, $5, 'under_review', $6, NOW())
      `,
      [
        disputeId,
        context.submission.id,
        actorUserId,
        input.reason,
        input.dispute_type,
        context.submission.score_finalized_at,
      ],
    );

    await client.query("UPDATE submissions SET status = 'disputed', updated_at = NOW() WHERE id = $1", [
      context.submission.id,
    ]);

    await client.query("UPDATE bounties SET status = 'disputed', updated_at = NOW() WHERE id = $1", [
      context.bounty.id,
    ]);

    for (const arbitratorId of arbitrators) {
      await client.query(
        `
          INSERT INTO dispute_votes (
            dispute_id,
            arbitrator_id,
            vote,
            justification,
            is_challenged,
            is_active,
            assigned_at,
            voted_at
          )
          VALUES ($1, $2, NULL, NULL, FALSE, TRUE, NOW(), NOW())
        `,
        [disputeId, arbitratorId],
      );
    }
  });

  const participantIds = [
    context.bounty.creator_id,
    context.submission.freelancer_id,
    ...arbitrators,
  ];

  await notifyUsers(
    arbitrators,
    "dispute_assigned",
    {
      dispute_id: disputeId,
      submission_id: context.submission.id,
      bounty_id: context.bounty.id,
      reason_preview: input.reason.slice(0, 120),
    },
    "both",
  );

  await socket.emitToUsers(participantIds, "dispute:opened", {
    dispute_id: disputeId,
    submission_id: context.submission.id,
    bounty_id: context.bounty.id,
    reconnect_hint: "RT-001: rejoin dispute room on reconnect",
  });

  emitToBounty(context.bounty.id, "bounty:disputed", {
    bounty_id: context.bounty.id,
    dispute_id: disputeId,
    submission_id: context.submission.id,
  });

  await dispatcher.send("notification/send", {
    channel: "email+in_app",
    event_type: "dispute_opened",
    dispute_id: disputeId,
    recipients: participantIds,
  });

  return {
    dispute_id: disputeId,
    arbitrators,
  };
}

export async function getDisputeDetails(disputeId: string, actorUserId: string, actorRole: string) {
  const detail = await dbQuery<{
    dispute_id: string;
    submission_id: string;
    raised_by: string;
    reason: string;
    dispute_type: DisputeType;
    dispute_status: string;
    outcome: DisputeOutcome | null;
    raised_at: Date;
    resolved_at: Date | null;
    escalated_at: Date | null;
    settlement_tx_id: string | null;
    settlement_payload: Record<string, unknown>;
    bounty_id: string;
    bounty_title: string;
    bounty_creator_id: string;
    bounty_acceptance_criteria: string;
    bounty_repo_url: string;
    bounty_target_branch: string;
    freelancer_id: string;
    submission_status: string;
    ai_score_raw: Record<string, unknown> | null;
    final_score: number | null;
    ci_status: string;
    ci_run_id: string | null;
    skipped_test_count: number;
    total_test_count: number;
    evidence_source: "live" | "cache";
    github_pr_url: string;
    github_branch: string;
    head_sha: string | null;
  }>(
    `
      SELECT d.id AS dispute_id,
             d.submission_id,
             d.raised_by,
             d.reason,
             d.dispute_type,
             d.status AS dispute_status,
             d.outcome,
             d.raised_at,
             d.resolved_at,
             d.escalated_at,
             d.settlement_tx_id,
             d.settlement_payload,
             b.id AS bounty_id,
                  b.title AS bounty_title,
             b.creator_id AS bounty_creator_id,
             b.acceptance_criteria AS bounty_acceptance_criteria,
             b.repo_url AS bounty_repo_url,
             b.target_branch AS bounty_target_branch,
             s.freelancer_id,
             s.status AS submission_status,
             s.ai_score_raw,
             s.final_score,
             s.ci_status,
                  s.ci_run_id,
                  s.skipped_test_count,
                  s.total_test_count,
                  s.evidence_source,
             s.github_pr_url,
                  s.github_branch,
                  s.head_sha
      FROM disputes d
      JOIN submissions s ON s.id = d.submission_id
      JOIN bounties b ON b.id = s.bounty_id
      WHERE d.id = $1
      LIMIT 1
    `,
    [disputeId],
  );

  if ((detail.rowCount ?? 0) === 0) {
    throw new Error("Dispute not found");
  }

  const row = detail.rows[0];
  const assigned = await isAssignedArbitrator(disputeId, actorUserId);
  const canView =
    actorRole === "admin" ||
    actorUserId === row.bounty_creator_id ||
    actorUserId === row.freelancer_id ||
    assigned;

  if (!canView) {
    throw new Error("Forbidden: dispute access denied");
  }

  const votes = await getVotesForDispute(disputeId);
  const allVoted = hasAllActiveVotes(votes);

  return {
    dispute: {
      id: row.dispute_id,
      submission_id: row.submission_id,
      raised_by: row.raised_by,
      reason: row.reason,
      dispute_type: row.dispute_type,
      status: row.dispute_status,
      outcome: row.outcome,
      raised_at: row.raised_at,
      resolved_at: row.resolved_at,
      escalated_at: row.escalated_at,
      settlement_tx_id: row.settlement_tx_id,
      settlement_payload: row.settlement_payload,
    },
    submission: {
      id: row.submission_id,
      status: row.submission_status,
      cached_pr_diff: row.ai_score_raw?.cached_diff ?? null,
      ai_score_raw: row.ai_score_raw,
      final_score: row.final_score,
      ci_status: row.ci_status,
      ci_run_id: row.ci_run_id,
      skipped_test_count: row.skipped_test_count,
      total_test_count: row.total_test_count,
      evidence_source: row.evidence_source,
      github_pr_url: row.github_pr_url,
      github_branch: row.github_branch,
      head_sha: row.head_sha,
    },
    bounty: {
      id: row.bounty_id,
      title: row.bounty_title,
      requirements: row.bounty_acceptance_criteria,
      repo_url: row.bounty_repo_url,
      target_branch: row.bounty_target_branch,
    },
    votes: allVoted
      ? votes
      : votes.map((vote) => ({
          arbitrator_id: vote.arbitrator_id,
          is_challenged: vote.is_challenged,
          has_voted: Boolean(vote.vote),
        })),
  };
}

export async function castDisputeVote(
  input: {
    dispute_id: string;
    vote: DisputeOutcome;
    justification: string;
  },
  arbitratorId: string,
  dispatcher: DisputeDispatcher,
) {
  const dispute = await dbQuery<{ id: string; status: string }>(
    "SELECT id, status FROM disputes WHERE id = $1 LIMIT 1",
    [input.dispute_id],
  );

  if ((dispute.rowCount ?? 0) === 0) {
    throw new Error("Dispute not found");
  }

  if (dispute.rows[0].status !== "under_review") {
    throw new Error("Dispute is not under review");
  }

  const assignment = await dbQuery<{ id: string; vote: DisputeOutcome | null }>(
    `
      SELECT id, vote
      FROM dispute_votes
      WHERE dispute_id = $1
        AND arbitrator_id = $2
        AND is_active = TRUE
      LIMIT 1
    `,
    [input.dispute_id, arbitratorId],
  );

  if ((assignment.rowCount ?? 0) === 0) {
    throw new Error("Only assigned arbitrators can vote on this dispute");
  }

  if (assignment.rows[0].vote) {
    throw new Error("Arbitrator vote already submitted");
  }

  await dbQuery(
    `
      UPDATE dispute_votes
      SET vote = $1,
          justification = $2,
          voted_at = NOW()
      WHERE id = $3
    `,
    [input.vote, input.justification, assignment.rows[0].id],
  );

  const votes = await getVotesForDispute(input.dispute_id);

  emitToArbitration(input.dispute_id, "dispute:vote_cast", {
    dispute_id: input.dispute_id,
    arbitrator_id: arbitratorId,
    vote: input.vote,
  });

  if (hasAllActiveVotes(votes)) {
    await dispatcher.send("dispute_resolution/requested", {
      dispute_id: input.dispute_id,
    });
  }

  return {
    dispute_id: input.dispute_id,
    all_votes_in: hasAllActiveVotes(votes),
  };
}

export async function challengeArbitrator(
  input: {
    dispute_id: string;
    arbitrator_id: string;
    justification: string;
  },
  actorUserId: string,
  dispatcher: DisputeDispatcher,
  socket: DisputeSocket,
) {
  const context = await dbQuery<{
    dispute_id: string;
    dispute_status: string;
    bounty_creator_id: string;
    freelancer_id: string;
  }>(
    `
      SELECT d.id AS dispute_id,
             d.status AS dispute_status,
             b.creator_id AS bounty_creator_id,
             s.freelancer_id
      FROM disputes d
      JOIN submissions s ON s.id = d.submission_id
      JOIN bounties b ON b.id = s.bounty_id
      WHERE d.id = $1
      LIMIT 1
    `,
    [input.dispute_id],
  );

  if ((context.rowCount ?? 0) === 0) {
    throw new Error("Dispute not found");
  }

  const row = context.rows[0];
  const isParty = actorUserId === row.bounty_creator_id || actorUserId === row.freelancer_id;
  if (!isParty) {
    throw new Error("Only the dispute parties can challenge arbitrators");
  }

  if (row.dispute_status !== "under_review") {
    throw new Error("Only under_review disputes can challenge arbitrators");
  }

  const priorChallenge = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM dispute_votes
      WHERE dispute_id = $1
        AND challenged_by = $2
        AND is_challenged = TRUE
      LIMIT 1
    `,
    [input.dispute_id, actorUserId],
  );

  if ((priorChallenge.rowCount ?? 0) > 0) {
    throw new Error("DS-003: each party can challenge only once");
  }

  const target = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM dispute_votes
      WHERE dispute_id = $1
        AND arbitrator_id = $2
        AND is_active = TRUE
      LIMIT 1
    `,
    [input.dispute_id, input.arbitrator_id],
  );

  if ((target.rowCount ?? 0) === 0) {
    throw new Error("Target arbitrator is not actively assigned");
  }

  const activeArbitrators = await dbQuery<{ arbitrator_id: string }>(
    `
      SELECT arbitrator_id
      FROM dispute_votes
      WHERE dispute_id = $1
        AND is_active = TRUE
    `,
    [input.dispute_id],
  );

  const replacement = await selectArbitrators({
    excludeUserIds: [
      row.bounty_creator_id,
      row.freelancer_id,
      input.arbitrator_id,
      ...activeArbitrators.rows.map((item) => item.arbitrator_id),
    ],
    count: 1,
  });

  if (replacement.length === 0) {
    throw new Error("DS-003: no replacement arbitrator available");
  }

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE dispute_votes
        SET is_challenged = TRUE,
            challenged_by = $1,
            challenge_reason = $2,
            is_active = FALSE,
            replaced_at = NOW()
        WHERE id = $3
      `,
      [actorUserId, input.justification, target.rows[0].id],
    );

    await client.query(
      `
        INSERT INTO dispute_votes (
          dispute_id,
          arbitrator_id,
          vote,
          justification,
          is_challenged,
          is_active,
          assigned_at,
          voted_at
        )
        VALUES ($1, $2, NULL, NULL, FALSE, TRUE, NOW(), NOW())
      `,
      [input.dispute_id, replacement[0]],
    );
  });

  await notifyUsers(
    [replacement[0]],
    "dispute_assigned_replacement",
    {
      dispute_id: input.dispute_id,
      challenged_arbitrator_id: input.arbitrator_id,
      code: "DS-003",
    },
    "both",
  );

  await socket.emitToUsers([row.bounty_creator_id, row.freelancer_id, replacement[0]], "dispute:opened", {
    dispute_id: input.dispute_id,
    reconnect_hint: "RT-001: rejoin dispute room on reconnect",
    challenged: true,
  });

  await dispatcher.send("notification/send", {
    channel: "email+in_app",
    event_type: "dispute_arbitrator_replaced",
    dispute_id: input.dispute_id,
    recipients: [row.bounty_creator_id, row.freelancer_id, replacement[0]],
  });

  return {
    dispute_id: input.dispute_id,
    replaced_arbitrator_id: input.arbitrator_id,
    new_arbitrator_id: replacement[0],
  };
}

export async function resolveDispute(
  input: { dispute_id: string },
  dispatcher: DisputeDispatcher,
  socket: DisputeSocket,
) {
  const context = await getResolutionContext(input.dispute_id);
  const voteTally = tallyVotes(context.votes);

  if (voteTally.isThreeWaySplit) {
    await escalateToSeniorArbitrators(context.dispute.id, context.parties, dispatcher, socket, "DS-004");
    return {
      dispute_id: input.dispute_id,
      state: "escalated",
    };
  }

  const settlement = calculateSettlementPayload(context, voteTally.majorityOutcome);

  const chain = await algorandService.resolveDisputeWithRetry({
    disputeId: context.dispute.id,
    outcome: settlement.outcome,
    freelancerShareBps: settlement.freelancer_share_bps,
  });

  const confirmation = await algorandService.waitForTransactionConfirmation(chain.txId, 1);
  if (!confirmation.confirmed) {
    throw new Error("SC-C-003: dispute settlement tx not confirmed");
  }

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE disputes
        SET status = 'resolved',
            outcome = $1,
            resolved_at = NOW(),
            settlement_tx_id = $2,
            settlement_payload = $3::jsonb,
            updated_at = NOW()
        WHERE id = $4
      `,
      [settlement.outcome, chain.txId, JSON.stringify(settlement), context.dispute.id],
    );

    await client.query(
      `
        UPDATE submissions
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
      `,
      [mapSubmissionStatusFromOutcome(settlement.outcome), context.submission.id],
    );

    await client.query(
      `
        UPDATE bounties
        SET status = $1,
            updated_at = NOW()
        WHERE id = $2
      `,
      [mapBountyStatusFromOutcome(settlement.outcome), context.bounty.id],
    );

    if (settlement.outcome === "freelancer_wins") {
      await client.query(
        "UPDATE users SET reputation_score = GREATEST(0, reputation_score - 3), updated_at = NOW() WHERE id = $1",
        [context.bounty.creator_id],
      );
    }

    if (settlement.outcome === "client_wins") {
      await client.query(
        "UPDATE users SET reputation_score = GREATEST(0, reputation_score - 5), updated_at = NOW() WHERE id = $1",
        [context.submission.freelancer_id],
      );
    }
  });

  if (context.dispute.dispute_type === "fraud" && settlement.outcome === "client_wins") {
    await banWalletAndFlagPayouts(
      {
        wallet_address: context.submission.freelancer_wallet,
        reason: "DS-005: fraud confirmed after dispute resolution",
      },
      context.bounty.creator_id,
      dispatcher,
      false,
    );
  }

  const recipientIds = [
    context.bounty.creator_id,
    context.submission.freelancer_id,
    ...context.votes.map((vote) => vote.arbitrator_id),
  ];

  await notifyUsers(
    recipientIds,
    "dispute_resolved",
    {
      dispute_id: context.dispute.id,
      outcome: settlement.outcome,
      freelancer_share_bps: settlement.freelancer_share_bps,
      tx_id: chain.txId,
      code: "RT-002",
    },
    "both",
  );

  await socket.emitToUsers(recipientIds, "dispute:resolved", {
    dispute_id: context.dispute.id,
    outcome: settlement.outcome,
    reconnect_hint: "RT-001: rejoin dispute room on reconnect",
  });

  emitToArbitration(context.dispute.id, "dispute:resolved", {
    dispute_id: context.dispute.id,
    outcome: settlement.outcome,
    tx_id: chain.txId,
  });

  emitToBounty(context.bounty.id, "dispute:resolved", {
    bounty_id: context.bounty.id,
    dispute_id: context.dispute.id,
    outcome: settlement.outcome,
  });

  await dispatcher.send("notification/send", {
    channel: "email+in_app",
    event_type: "dispute_resolved",
    dispute_id: context.dispute.id,
    recipients: recipientIds,
  });

  return {
    dispute_id: context.dispute.id,
    outcome: settlement.outcome,
    tx_id: chain.txId,
  };
}

export async function runDisputeEscalationCycle(
  dispatcher: DisputeDispatcher,
  socket: DisputeSocket,
) {
  const stale = await dbQuery<{ id: string; submission_id: string; bounty_id: string; creator_id: string; freelancer_id: string }>(
    `
      SELECT d.id,
             d.submission_id,
             s.bounty_id,
             b.creator_id,
             s.freelancer_id
      FROM disputes d
      JOIN submissions s ON s.id = d.submission_id
      JOIN bounties b ON b.id = s.bounty_id
      WHERE d.status = 'under_review'
        AND d.raised_at < NOW() - make_interval(days => $1)
    `,
    [STALE_DISPUTE_DAYS],
  );

  const processed: string[] = [];

  for (const dispute of stale.rows) {
    await escalateToSeniorArbitrators(
      dispute.id,
      {
        client_id: dispute.creator_id,
        freelancer_id: dispute.freelancer_id,
      },
      dispatcher,
      socket,
      "DS-004",
    );
    processed.push(dispute.id);
  }

  return {
    processed_count: processed.length,
    dispute_ids: processed,
  };
}

export async function adminBanWallet(
  input: { wallet_address: string; reason: string; mfa_token: string },
  actor: { user_id: string; role: string },
  dispatcher: DisputeDispatcher,
) {
  if (actor.role !== "admin") {
    throw new Error("Admin role required");
  }

  const expectedToken = process.env.ADMIN_MFA_TOKEN;
  if (!expectedToken || input.mfa_token !== expectedToken) {
    throw new Error("DS-005: invalid MFA token");
  }

  const normalizedWallet = normalizeWalletAddress(input.wallet_address);
  if (!isValidAlgorandAddress(normalizedWallet)) {
    throw new Error("DS-005: invalid wallet address");
  }

  const result = await banWalletAndFlagPayouts(
    {
      wallet_address: normalizedWallet,
      reason: input.reason,
    },
    actor.user_id,
    dispatcher,
    true,
  );

  return {
    wallet_address: normalizedWallet,
    ...result,
  };
}

async function getDisputeContext(submissionId: string): Promise<DisputeContext> {
  const context = await dbQuery<{
    submission_id: string;
    bounty_id: string;
    freelancer_id: string;
    submission_status: SubmissionStatus;
    score_finalized_at: Date | null;
    ai_score_raw: Record<string, unknown> | null;
    final_score: number | null;
    ci_status: string;
    github_pr_url: string;
    github_branch: string;
    bounty_creator_id: string;
    bounty_status: string;
    acceptance_criteria: string;
    repo_url: string;
    target_branch: string;
    freelancer_wallet: string;
  }>(
    `
      SELECT s.id AS submission_id,
             s.bounty_id,
             s.freelancer_id,
             s.status AS submission_status,
             s.score_finalized_at,
             s.ai_score_raw,
             s.final_score,
             s.ci_status,
             s.github_pr_url,
             s.github_branch,
             b.creator_id AS bounty_creator_id,
             b.status AS bounty_status,
             b.acceptance_criteria,
             b.repo_url,
             b.target_branch,
             u.wallet_address AS freelancer_wallet
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      JOIN users u ON u.id = s.freelancer_id
      WHERE s.id = $1
      LIMIT 1
    `,
    [submissionId],
  );

  if ((context.rowCount ?? 0) === 0) {
    throw new Error("Submission not found");
  }

  const row = context.rows[0];
  return {
    submission: {
      id: row.submission_id,
      bounty_id: row.bounty_id,
      freelancer_id: row.freelancer_id,
      status: row.submission_status,
      score_finalized_at: row.score_finalized_at,
      ai_score_raw: row.ai_score_raw,
      final_score: row.final_score,
      ci_status: row.ci_status,
      github_pr_url: row.github_pr_url,
      github_branch: row.github_branch,
    },
    bounty: {
      id: row.bounty_id,
      creator_id: row.bounty_creator_id,
      status: row.bounty_status,
      acceptance_criteria: row.acceptance_criteria,
      repo_url: row.repo_url,
      target_branch: row.target_branch,
    },
    freelancer_wallet: row.freelancer_wallet,
  };
}

function verifyDisputeActor(context: DisputeContext, actorUserId: string) {
  const isClient = actorUserId === context.bounty.creator_id;
  const isFreelancer = actorUserId === context.submission.freelancer_id;
  if (!isClient && !isFreelancer) {
    throw new Error("Only the client or accepted freelancer can open this dispute");
  }
}

function verifySubmissionStateForDispute(status: SubmissionStatus) {
  const allowed: SubmissionStatus[] = ["validating", "passed", "failed"];
  if (!allowed.includes(status)) {
    throw new Error("Submission status cannot be disputed in current state");
  }
}

async function verifyDisputeWindow(context: DisputeContext, disputeType: DisputeType) {
  if (disputeType !== "score_unfair") {
    return;
  }

  const scorePublishedAt = context.submission.score_finalized_at;
  if (!scorePublishedAt) {
    throw new Error("DS-001: score publication timestamp missing");
  }

  const maxWindowMs = MAX_SCORE_DISPUTE_HOURS * 60 * 60 * 1000;
  if (Date.now() - scorePublishedAt.getTime() > maxWindowMs) {
    throw new Error("DS-001: score dispute window exceeded (72h)");
  }
}

async function verifyPostPayoutDisputeRule(submissionId: string, bountyStatus: string) {
  if (bountyStatus !== "completed") {
    return;
  }

  const payout = await dbQuery<{ updated_at: Date }>(
    `
      SELECT updated_at
      FROM payouts
      WHERE submission_id = $1
        AND status = 'completed'
        AND tx_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [submissionId],
  );

  if ((payout.rowCount ?? 0) === 0) {
    return;
  }

  const finalized = payout.rows[0].updated_at;
  const cutoffMs = POST_PAYOUT_DISPUTE_BLOCK_HOURS * 60 * 60 * 1000;
  if (Date.now() - finalized.getTime() > cutoffMs) {
    throw new Error("DS-002: payout already confirmed beyond 24h; redirect to complaint flow");
  }
}

async function selectArbitrators(input: { excludeUserIds: string[]; count: number }) {
  const result = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM users
      WHERE role = 'arbitrator'
        AND is_banned = FALSE
        AND deleted_at IS NULL
        AND id <> ALL($1::uuid[])
      ORDER BY random()
      LIMIT $2
    `,
    [input.excludeUserIds, input.count],
  );

  return result.rows.map((row) => row.id);
}

async function isAssignedArbitrator(disputeId: string, userId: string) {
  const result = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM dispute_votes
      WHERE dispute_id = $1
        AND arbitrator_id = $2
        AND is_active = TRUE
      LIMIT 1
    `,
    [disputeId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function getVotesForDispute(disputeId: string) {
  const result = await dbQuery<DisputeVoteRow>(
    `
      SELECT id,
             dispute_id,
             arbitrator_id,
             vote,
             justification,
             is_challenged,
             is_active,
             challenged_by,
             challenge_reason,
             assigned_at,
             replaced_at,
             voted_at
      FROM dispute_votes
      WHERE dispute_id = $1
        AND is_active = TRUE
      ORDER BY assigned_at ASC
    `,
    [disputeId],
  );

  return result.rows;
}

function hasAllActiveVotes(votes: DisputeVoteRow[]) {
  if (votes.length === 0) {
    return false;
  }

  return votes.every((vote) => Boolean(vote.vote));
}

async function getResolutionContext(disputeId: string) {
  const dispute = await dbQuery<{
    id: string;
    submission_id: string;
    dispute_type: DisputeType;
    status: string;
  }>(
    `
      SELECT id, submission_id, dispute_type, status
      FROM disputes
      WHERE id = $1
      LIMIT 1
    `,
    [disputeId],
  );

  if ((dispute.rowCount ?? 0) === 0) {
    throw new Error("Dispute not found");
  }

  const disputeRow = dispute.rows[0];
  if (disputeRow.status !== "under_review") {
    throw new Error("Dispute is not in under_review state");
  }

  const votes = await getVotesForDispute(disputeId);
  if (!hasAllActiveVotes(votes)) {
    throw new Error("Dispute does not have all active votes yet");
  }

  const entities = await dbQuery<{
    submission_id: string;
    freelancer_id: string;
    freelancer_wallet: string;
    bounty_id: string;
    creator_id: string;
  }>(
    `
      SELECT s.id AS submission_id,
             s.freelancer_id,
             u.wallet_address AS freelancer_wallet,
             b.id AS bounty_id,
             b.creator_id
      FROM submissions s
      JOIN users u ON u.id = s.freelancer_id
      JOIN bounties b ON b.id = s.bounty_id
      WHERE s.id = $1
      LIMIT 1
    `,
    [disputeRow.submission_id],
  );

  if ((entities.rowCount ?? 0) === 0) {
    throw new Error("Related submission context not found");
  }

  return {
    dispute: disputeRow,
    votes,
    submission: {
      id: entities.rows[0].submission_id,
      freelancer_id: entities.rows[0].freelancer_id,
      freelancer_wallet: entities.rows[0].freelancer_wallet,
    },
    bounty: {
      id: entities.rows[0].bounty_id,
      creator_id: entities.rows[0].creator_id,
    },
    parties: {
      client_id: entities.rows[0].creator_id,
      freelancer_id: entities.rows[0].freelancer_id,
    },
  };
}

function tallyVotes(votes: DisputeVoteRow[]) {
  const counts: Record<DisputeOutcome, number> = {
    freelancer_wins: 0,
    client_wins: 0,
    split: 0,
  };

  for (const vote of votes) {
    if (vote.vote) {
      counts[vote.vote] += 1;
    }
  }

  const majorityOutcome = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] ??
    "split") as DisputeOutcome;

  const isThreeWaySplit =
    counts.freelancer_wins === 1 && counts.client_wins === 1 && counts.split === 1;

  return {
    counts,
    majorityOutcome,
    isThreeWaySplit,
  };
}

function calculateSettlementPayload(
  context: {
    dispute: { dispute_type: DisputeType };
    votes: DisputeVoteRow[];
  },
  outcome: DisputeOutcome,
) {
  if (outcome === "freelancer_wins") {
    return {
      outcome,
      freelancer_share_bps: 10_000,
      client_share_bps: 0,
    };
  }

  if (outcome === "client_wins") {
    return {
      outcome,
      freelancer_share_bps: 0,
      client_share_bps: 10_000,
    };
  }

  const splitPercents = context.votes
    .map((vote) => extractFreelancerPercent(vote.justification ?? ""))
    .filter((value): value is number => typeof value === "number");

  const avgPercent = splitPercents.length
    ? Math.round(splitPercents.reduce((acc, item) => acc + item, 0) / splitPercents.length)
    : 50;

  const freelancerShareBps = Math.max(0, Math.min(10_000, avgPercent * 100));
  return {
    outcome: "split" as const,
    freelancer_share_bps: freelancerShareBps,
    client_share_bps: 10_000 - freelancerShareBps,
  };
}

function extractFreelancerPercent(justification: string) {
  const percentRegex = /(\d{1,3})\s*%/g;
  const values: number[] = [];

  for (const match of justification.matchAll(percentRegex)) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      values.push(parsed);
    }
  }

  if (values.length === 0) {
    return null;
  }

  return values[0];
}

function mapSubmissionStatusFromOutcome(outcome: DisputeOutcome) {
  if (outcome === "client_wins") {
    return "failed";
  }
  return "passed";
}

function mapBountyStatusFromOutcome(outcome: DisputeOutcome) {
  if (outcome === "client_wins") {
    return "cancelled";
  }
  return "completed";
}

async function escalateToSeniorArbitrators(
  disputeId: string,
  parties: { client_id: string; freelancer_id: string },
  dispatcher: DisputeDispatcher,
  socket: DisputeSocket,
  code: string,
) {
  const seniorIds = await getSeniorArbitratorIds(parties);
  if (seniorIds.length === 0) {
    throw new Error("DS-004: no senior arbitrators configured");
  }

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE disputes
        SET status = 'escalated',
            escalated_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [disputeId],
    );

    await client.query(
      `
        UPDATE dispute_votes
        SET is_active = FALSE,
            replaced_at = NOW()
        WHERE dispute_id = $1
          AND is_active = TRUE
      `,
      [disputeId],
    );

    for (const arbitratorId of seniorIds.slice(0, 3)) {
      await client.query(
        `
          INSERT INTO dispute_votes (
            dispute_id,
            arbitrator_id,
            vote,
            justification,
            is_challenged,
            is_active,
            assigned_at,
            voted_at
          )
          VALUES ($1, $2, NULL, NULL, FALSE, TRUE, NOW(), NOW())
        `,
        [disputeId, arbitratorId],
      );
    }
  });

  const partiesAndSeniors = [parties.client_id, parties.freelancer_id, ...seniorIds.slice(0, 3)];

  await notifyUsers(
    partiesAndSeniors,
    "dispute_escalated",
    {
      dispute_id: disputeId,
      code,
    },
    "both",
  );

  const opsIds = parseUuidList(process.env.OPS_USER_IDS ?? "");
  if (opsIds.length > 0) {
    await notifyUsers(
      opsIds,
      "dispute_escalation_ops",
      {
        dispute_id: disputeId,
        code,
      },
      "both",
    );
  }

  await socket.emitToUsers(partiesAndSeniors, "dispute:opened", {
    dispute_id: disputeId,
    escalated: true,
    reconnect_hint: "RT-001: rejoin dispute room on reconnect",
  });

  await dispatcher.send("notification/send", {
    channel: "email+in_app",
    event_type: "dispute_escalated",
    dispute_id: disputeId,
    recipients: [...partiesAndSeniors, ...opsIds],
  });
}

async function getSeniorArbitratorIds(parties: { client_id: string; freelancer_id: string }) {
  const envSenior = parseUuidList(process.env.SENIOR_ARBITRATOR_IDS ?? "");
  if (envSenior.length >= 3) {
    return envSenior;
  }

  const fallback = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM users
      WHERE role = 'admin'
        AND deleted_at IS NULL
        AND is_banned = FALSE
        AND id <> ALL($1::uuid[])
      ORDER BY random()
      LIMIT 3
    `,
    [[parties.client_id, parties.freelancer_id]],
  );

  if ((fallback.rowCount ?? 0) >= 3) {
    return fallback.rows.map((row) => row.id);
  }

  return selectArbitrators({
    excludeUserIds: [parties.client_id, parties.freelancer_id],
    count: 3,
  });
}

async function banWalletAndFlagPayouts(
  input: { wallet_address: string; reason: string },
  bannedByUserId: string,
  dispatcher: DisputeDispatcher,
  enforceMfaContext: boolean,
) {
  const wallet = normalizeWalletAddress(input.wallet_address);
  if (!isValidAlgorandAddress(wallet)) {
    throw new Error("DS-005: invalid wallet checksum");
  }

  const chainBan = await algorandService.banWalletOnChainWithRetry({
    walletAddress: wallet,
    reason: input.reason,
  });
  const banConfirmation = await algorandService.waitForTransactionConfirmation(chainBan.txId, 1);
  if (!banConfirmation.confirmed) {
    throw new Error("SC-C-003: wallet ban transaction not confirmed");
  }

  const allowlistRemoval = await algorandService.removeWalletAllowlistWithRetry({ walletAddress: wallet });
  const allowlistConfirmation = await algorandService.waitForTransactionConfirmation(allowlistRemoval.txId, 1);
  if (!allowlistConfirmation.confirmed) {
    throw new Error("SC-C-003: allowlist removal transaction not confirmed");
  }

  const affected = await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO banned_wallets (wallet_address, reason, banned_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (wallet_address)
        DO UPDATE SET reason = EXCLUDED.reason,
                      banned_by = EXCLUDED.banned_by,
                      banned_at = NOW()
      `,
      [wallet, input.reason, bannedByUserId],
    );

    await client.query(
      `
        UPDATE users
        SET is_banned = TRUE,
            updated_at = NOW()
        WHERE wallet_address = $1
      `,
      [wallet],
    );

    const payouts = await client.query<{ id: string }>(
      `
        UPDATE payouts p
        SET mismatch_flagged = TRUE,
            hold_reason = COALESCE(hold_reason, '') || CASE WHEN COALESCE(hold_reason, '') = '' THEN '' ELSE '; ' END || 'DS-005: banned wallet review required',
            updated_at = NOW()
        FROM users u
        WHERE p.freelancer_id = u.id
          AND u.wallet_address = $1
        RETURNING p.id
      `,
      [wallet],
    );

    return payouts.rows.map((row) => row.id);
  });

  await dispatcher.send("notification/send", {
    channel: "email+in_app",
    event_type: "wallet_banned",
    wallet_address: wallet,
    code: "DS-005",
    tx_id: chainBan.txId,
    enforce_mfa_context: enforceMfaContext,
  });

  return {
    tx_id: chainBan.txId,
    flagged_payout_ids: affected,
  };
}

async function notifyUsers(
  userIds: string[],
  eventType: string,
  payload: Record<string, unknown>,
  type: "in_app" | "both",
) {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  for (const userId of uniqueUserIds) {
    await dbQuery(
      `
        INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
        VALUES ($1, $2, $3, $4::jsonb, FALSE, 0)
      `,
      [userId, type, eventType, JSON.stringify(payload)],
    );
  }
}

function parseUuidList(input: string) {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[0-9a-fA-F-]{36}$/.test(item));
}
