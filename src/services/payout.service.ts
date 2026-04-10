import { randomUUID } from "node:crypto";
import { dbQuery, withTransaction } from "../../lib/db/client";
import type { BountyStatus, PayoutStatus, SubmissionStatus } from "../../lib/db/types";
import { screenWalletAndLog } from "../middleware/sanctions";
import { emitToBounty, emitToUser } from "../realtime/socket";
import { AlgorandService, type SplitPayoutShare } from "./algorand";
import { isValidAlgorandAddress, normalizeWalletAddress } from "./wallet";

const PLATFORM_FEE_BPS = 200n;
const BPS_DENOMINATOR = 10_000n;
const MISMATCH_TOLERANCE_MICROALGO = 1000n;
const CLOCK_SKEW_SECONDS = 60;

const algorandService = new AlgorandService();

export interface JobDispatcher {
  send: (eventName: string, data: Record<string, unknown>) => Promise<void>;
}

export interface SocketNotifier {
  emitToUser: (userId: string, eventName: string, payload: Record<string, unknown>) => Promise<void>;
}

interface PayoutPrecheckResult {
  submission: {
    id: string;
    bounty_id: string;
    freelancer_id: string;
    status: SubmissionStatus;
    final_score: number | null;
    ai_integrity_flag: boolean;
    submission_received_at: Date;
    milestone_id: string | null;
  };
  bounty: {
    id: string;
    creator_id: string;
    total_amount: string;
    status: BountyStatus;
    ai_score_threshold: number;
    payout_asset_id: string | null;
    payout_asset_code: string;
    contributor_splits: Array<Record<string, unknown>>;
  };
  freelancerWallet: string;
}

interface RecipientShare {
  userId: string;
  walletAddress: string;
  amountMicroAlgo: bigint;
  shareKey: string;
  status: PayoutStatus;
  holdReason: string | null;
}

interface StoredPayoutRecord {
  payoutId: string;
  recipient: RecipientShare;
}

interface DeadlineCandidate {
  id: string;
  creator_id: string;
  deadline: Date;
  grace_period_minutes: number;
  status: BountyStatus;
  extension_count: number;
}

interface DowntimeWindow {
  started_at: Date;
  ended_at: Date | null;
}

export async function processPayoutRelease(
  input: { submission_id: string; bounty_id: string; final_score: number },
  dispatcher: JobDispatcher,
  notifier: SocketNotifier,
) {
  const precheck = await runPrePayoutChecks(input);
  await ensureAssetOptInIfNeeded(precheck, notifier);
  const shares = await calculatePayoutShares(precheck);
  const storedPayouts = await storeExpectedPayouts(precheck, shares);

  const executable = storedPayouts.filter((record) => record.recipient.status !== "quarantined");
  const quarantined = storedPayouts.filter((record) => record.recipient.status === "quarantined");

  if (executable.length === 0) {
    await markSubmissionAndBountyOnQuarantine(precheck);
    await alertCompliance(precheck, "SC-F-004: all payout shares quarantined");
    return { state: "quarantined", payout_count: storedPayouts.length };
  }

  const payoutResult = await executePayout(precheck, executable);
  await verifyAndFinalizePayouts(precheck, executable, payoutResult.txId, dispatcher);
  await postPayout(precheck, dispatcher, notifier);

  for (const quarantinedRecord of quarantined) {
    await dispatcher.send("payout_share/retry_requested", {
      payout_id: quarantinedRecord.payoutId,
      submission_id: precheck.submission.id,
      bounty_id: precheck.bounty.id,
      reason: quarantinedRecord.recipient.holdReason,
    });
  }

  return {
    state: "released",
    tx_id: payoutResult.txId,
    payout_count: storedPayouts.length,
    quarantined_count: quarantined.length,
  };
}

export async function processMilestoneRelease(
  input: { milestone_id: string; submission_id: string; approved_by_client?: boolean },
  dispatcher: JobDispatcher,
) {
  const milestone = await dbQuery<{
    id: string;
    bounty_id: string;
    status: string;
    order_index: number;
    payout_amount: string;
    payout_tx_id: string | null;
  }>(
    `
      SELECT id, bounty_id, status, order_index, payout_amount, payout_tx_id
      FROM milestones
      WHERE id = $1
      LIMIT 1
    `,
    [input.milestone_id],
  );

  if (milestone.rowCount === 0) {
    throw new Error("SC-C-008: milestone not found");
  }

  const row = milestone.rows[0];
  if (row.status !== "unlocked") {
    throw new Error("SC-C-008: milestone must be unlocked before release");
  }

  const sequenceOk = await algorandService.verifyMilestoneOrder({
    bountyId: row.bounty_id,
    expectedOrderIndex: row.order_index,
  });
  if (!sequenceOk) {
    throw new Error("SC-C-008: milestone order mismatch against contract state");
  }

  const release = await algorandService.releaseMilestonePayoutWithRetry({
    milestoneId: row.id,
    submissionId: input.submission_id,
    amountMicroAlgo: parseBigIntStrict(row.payout_amount),
  });

  const confirmation = await algorandService.waitForTransactionConfirmation(release.txId, 1);
  if (!confirmation.confirmed) {
    throw new Error("SC-C-003: milestone payout tx not confirmed");
  }

  await dbQuery(
    `
      UPDATE milestones
      SET status = 'paid',
          payout_tx_id = $1,
          updated_at = NOW()
      WHERE id = $2
    `,
    [release.txId, row.id],
  );

  await dispatcher.send("notification/send", {
    event_type: "milestone_paid",
    milestone_id: row.id,
    submission_id: input.submission_id,
  });

  return { state: "paid", milestone_id: row.id, tx_id: release.txId };
}

export async function processDeadlineRefundCycle(dispatcher: JobDispatcher) {
  const candidates = await dbQuery<DeadlineCandidate>(
    `
      SELECT id, creator_id, deadline, grace_period_minutes, status, extension_count
      FROM bounties
      WHERE status IN ('open', 'in_progress', 'accepted')
        AND deadline < NOW()
    `,
  );

  const outcomes: Array<{ bounty_id: string; state: string }> = [];

  for (const bounty of candidates.rows) {
    const adjustedDeadline = await getEffectiveDeadlineWithDowntime(bounty.id, bounty.deadline);
    const now = new Date();
    if (now.getTime() <= adjustedDeadline.getTime()) {
      continue;
    }

    if (bounty.extension_count > 2) {
      await dbQuery(
        "UPDATE bounties SET extension_count = 2, updated_at = NOW() WHERE id = $1",
        [bounty.id],
      );
    }

    const submissions = await dbQuery<{
      id: string;
      freelancer_id: string;
      status: SubmissionStatus;
      submission_received_at: Date;
    }>(
      `
        SELECT id, freelancer_id, status, submission_received_at
        FROM submissions
        WHERE bounty_id = $1
      `,
      [bounty.id],
    );

    if (submissions.rowCount === 0) {
      await handleNoSubmissionExpiry(bounty, dispatcher);
      outcomes.push({ bounty_id: bounty.id, state: "expired_no_submission" });
      continue;
    }

    const toleranceDeadline = new Date(adjustedDeadline.getTime() + CLOCK_SKEW_SECONDS * 1000);

    const inProgress = submissions.rows.filter((submission) => {
      const submittedWithinSkew = submission.submission_received_at.getTime() <= toleranceDeadline.getTime();
      return submission.status === "in_progress" && submittedWithinSkew;
    });

    if (inProgress.length > 0) {
      const graceExpiresAt = new Date(
        adjustedDeadline.getTime() + bounty.grace_period_minutes * 60 * 1000,
      );
      if (now.getTime() <= graceExpiresAt.getTime()) {
        await logGracePeriodSkip(bounty.id, graceExpiresAt);
        outcomes.push({ bounty_id: bounty.id, state: "grace_skip" });
        continue;
      }

      await handleExpiredIncomplete(bounty, inProgress, dispatcher);
      outcomes.push({ bounty_id: bounty.id, state: "expired_incomplete" });
      continue;
    }

    const nonFailed = submissions.rows.filter((submission) => submission.status !== "failed");
    if (nonFailed.length === 0) {
      await handleAllFailedRefund(bounty, submissions.rows, dispatcher);
      outcomes.push({ bounty_id: bounty.id, state: "expired_all_failed" });
    }
  }

  return { processed: outcomes.length, outcomes };
}

async function runPrePayoutChecks(input: {
  submission_id: string;
  bounty_id: string;
  final_score: number;
}): Promise<PayoutPrecheckResult> {
  const state = await dbQuery<{
    submission_id: string;
    bounty_id: string;
    freelancer_id: string;
    submission_status: SubmissionStatus;
    submission_final_score: number | null;
    ai_integrity_flag: boolean;
    review_gate_status: string;
    review_window_ends_at: Date | null;
    approved_for_payout_at: Date | null;
    submission_received_at: Date;
    milestone_id: string | null;
    bounty_creator_id: string;
    bounty_total_amount: string;
    bounty_status: BountyStatus;
    ai_score_threshold: number;
    payout_asset_id: string | null;
    payout_asset_code: string;
    contributor_splits: Array<Record<string, unknown>>;
    freelancer_wallet: string;
  }>(
    `
      SELECT s.id AS submission_id,
             s.bounty_id,
             s.freelancer_id,
             s.status AS submission_status,
             s.final_score AS submission_final_score,
             s.ai_integrity_flag,
             s.review_gate_status,
             s.review_window_ends_at,
             s.approved_for_payout_at,
             s.submission_received_at,
             p.milestone_id,
             b.creator_id AS bounty_creator_id,
             b.total_amount AS bounty_total_amount,
             b.status AS bounty_status,
             b.ai_score_threshold,
             b.payout_asset_id,
             b.payout_asset_code,
             b.contributor_splits,
             u.wallet_address AS freelancer_wallet
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      JOIN users u ON u.id = s.freelancer_id
      LEFT JOIN payouts p ON p.submission_id = s.id
      WHERE s.id = $1
        AND b.id = $2
      ORDER BY p.created_at DESC
      LIMIT 1
    `,
    [input.submission_id, input.bounty_id],
  );

  if (state.rowCount === 0) {
    throw new Error("SC-F-003: submission/bounty context not found for payout");
  }

  const row = state.rows[0];
  if (!(row.submission_status === "validating" || row.submission_status === "passed")) {
    throw new Error("SC-F-003: submission must be validating or passed before payout");
  }

  if (row.review_gate_status === "changes_requested") {
    throw new Error("SC-F-009: payout blocked while submission is in changes_requested state");
  }

  if (
    row.review_gate_status === "awaiting_client_review" &&
    row.review_window_ends_at &&
    row.review_window_ends_at.getTime() > Date.now()
  ) {
    throw new Error("SC-F-009: review window still active, payout deferred");
  }

  if (
    row.review_gate_status === "awaiting_client_review" &&
    row.review_window_ends_at &&
    row.review_window_ends_at.getTime() <= Date.now()
  ) {
    await dbQuery(
      `
        UPDATE submissions
        SET review_gate_status = 'auto_released',
            approved_for_payout_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [row.submission_id],
    );
  }

  if (!(row.bounty_status === "in_progress" || row.bounty_status === "accepted")) {
    throw new Error("SC-F-003: bounty status must be in_progress or accepted");
  }

  const effectiveScore = row.submission_final_score ?? input.final_score;
  if (effectiveScore < row.ai_score_threshold) {
    throw new Error("SC-F-003: score below bounty threshold");
  }

  if (row.ai_integrity_flag) {
    throw new Error("SC-F-003: ai_integrity_flag blocks payout");
  }

  if (row.freelancer_id === row.bounty_creator_id) {
    throw new Error("XC-001: bounty creator cannot be payout recipient");
  }

  const normalizedFreelancerWallet = normalizeWalletAddress(row.freelancer_wallet);
  validateWalletChecksum(normalizedFreelancerWallet);

  const sanction = await screenWalletAndLog(normalizedFreelancerWallet, "payout.release", row.freelancer_id);
  if (sanction.flagged) {
    await quarantinePayoutBySanction(row.submission_id, row.freelancer_id, "XC-003: sanctions check failed at payout");
    throw new Error("XC-003: sanctions check failed at payout");
  }

  return {
    submission: {
      id: row.submission_id,
      bounty_id: row.bounty_id,
      freelancer_id: row.freelancer_id,
      status: row.submission_status,
      final_score: effectiveScore,
      ai_integrity_flag: row.ai_integrity_flag,
      submission_received_at: row.submission_received_at,
      milestone_id: row.milestone_id,
    },
    bounty: {
      id: row.bounty_id,
      creator_id: row.bounty_creator_id,
      total_amount: row.bounty_total_amount,
      status: row.bounty_status,
      ai_score_threshold: row.ai_score_threshold,
      payout_asset_id: row.payout_asset_id,
      payout_asset_code: row.payout_asset_code,
      contributor_splits: row.contributor_splits ?? [],
    },
    freelancerWallet: normalizedFreelancerWallet,
  };
}

async function ensureAssetOptInIfNeeded(precheck: PayoutPrecheckResult, notifier: SocketNotifier) {
  if (precheck.bounty.payout_asset_code === "ALGO") {
    return;
  }

  const assetId = Number(precheck.bounty.payout_asset_id ?? "0");
  if (!assetId) {
    throw new Error("SC-F-002: payout asset configured without valid asset id");
  }

  const optedIn = await algorandService.isAssetOptedIn(precheck.freelancerWallet, assetId);
  if (optedIn) {
    return;
  }

  await notifier.emitToUser(precheck.submission.freelancer_id, "validation:opt_in_required", {
    code: "SC-F-002",
    asset_id: assetId,
    submission_id: precheck.submission.id,
    bounty_id: precheck.bounty.id,
  });

  emitToUser(precheck.submission.freelancer_id, "validation:opt_in_required", {
    code: "SC-F-002",
    asset_id: assetId,
    submission_id: precheck.submission.id,
    bounty_id: precheck.bounty.id,
  });

  const start = Date.now();
  const timeoutMs = 30 * 60 * 1000;

  while (Date.now() - start <= timeoutMs) {
    await wait(60_000);
    const current = await algorandService.isAssetOptedIn(precheck.freelancerWallet, assetId);
    if (current) {
      return;
    }
  }

  await dbQuery(
    `
      INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
      VALUES ($1, 'in_app', 'opt_in_required_timeout', $2::jsonb, FALSE, 0)
    `,
    [
      precheck.submission.freelancer_id,
      JSON.stringify({
        code: "SC-F-002",
        submission_id: precheck.submission.id,
        bounty_id: precheck.bounty.id,
      }),
    ],
  );

  await holdPayout(precheck.submission.id, precheck.submission.freelancer_id, "SC-F-002: opt-in not completed");
  throw new Error("SC-F-002: freelancer asset opt-in timed out");
}

async function calculatePayoutShares(precheck: PayoutPrecheckResult): Promise<RecipientShare[]> {
  const bountyAmount = parseBigIntStrict(precheck.bounty.total_amount);
  const fee = (bountyAmount * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
  const distributable = bountyAmount - fee;

  if (distributable <= 0n) {
    throw new Error("SC-F-004: distributable amount is non-positive after fee");
  }

  const configuredSplits = precheck.bounty.contributor_splits;
  if (!Array.isArray(configuredSplits) || configuredSplits.length === 0) {
    return [
      {
        userId: precheck.submission.freelancer_id,
        walletAddress: precheck.freelancerWallet,
        amountMicroAlgo: distributable,
        shareKey: "primary",
        status: "pending",
        holdReason: null,
      },
    ];
  }

  const totalWeight = configuredSplits.reduce((acc, split) => {
    const weight = Number(split.weight ?? 0);
    return acc + (Number.isFinite(weight) && weight > 0 ? weight : 0);
  }, 0);

  if (totalWeight <= 0) {
    throw new Error("SC-F-004: invalid split weights");
  }

  const resolved = await resolveSplitRecipients(configuredSplits, distributable, totalWeight);
  const sum = resolved.reduce((acc, share) => acc + share.amountMicroAlgo, 0n);
  if (sum > bountyAmount) {
    throw new Error("SC-F-004: split sum exceeds bounty total amount");
  }

  return resolved;
}

async function resolveSplitRecipients(
  configuredSplits: Array<Record<string, unknown>>,
  distributable: bigint,
  totalWeight: number,
): Promise<RecipientShare[]> {
  const results: RecipientShare[] = [];

  for (let index = 0; index < configuredSplits.length; index += 1) {
    const split = configuredSplits[index];
    const userId = String(split.user_id ?? "").trim();
    const walletFromConfig = String(split.wallet_address ?? "").trim();
    const weight = Number(split.weight ?? 0);

    if (!userId || !Number.isFinite(weight) || weight <= 0) {
      results.push({
        userId: userId || `unknown_${index}`,
        walletAddress: walletFromConfig,
        amountMicroAlgo: 0n,
        shareKey: `split_${index}`,
        status: "quarantined",
        holdReason: "SC-F-004: malformed split configuration",
      });
      continue;
    }

    const amount = (distributable * BigInt(Math.floor(weight * 10_000))) / BigInt(Math.floor(totalWeight * 10_000));

    let walletAddress = walletFromConfig;
    if (!walletAddress) {
      const walletRow = await dbQuery<{ wallet_address: string }>(
        "SELECT wallet_address FROM users WHERE id = $1 LIMIT 1",
        [userId],
      );
      walletAddress = walletRow.rows[0]?.wallet_address ?? "";
    }

    const normalizedWallet = normalizeWalletAddress(walletAddress);

    if (!normalizedWallet || !isValidAlgorandAddress(normalizedWallet)) {
      results.push({
        userId,
        walletAddress: normalizedWallet,
        amountMicroAlgo: amount,
        shareKey: `split_${index}`,
        status: "quarantined",
        holdReason: "SC-F-004: recipient wallet is invalid",
      });
      continue;
    }

    results.push({
      userId,
      walletAddress: normalizedWallet,
      amountMicroAlgo: amount,
      shareKey: `split_${index}`,
      status: "pending",
      holdReason: null,
    });
  }

  const sum = results.reduce((acc, share) => acc + share.amountMicroAlgo, 0n);
  const delta = distributable - sum;
  if (delta > 0n) {
    const firstValid = results.find((share) => share.status !== "quarantined");
    if (firstValid) {
      firstValid.amountMicroAlgo += delta;
    }
  }

  return results;
}

async function storeExpectedPayouts(
  precheck: PayoutPrecheckResult,
  shares: RecipientShare[],
): Promise<StoredPayoutRecord[]> {
  const groupId = randomUUID();

  return withTransaction(async (client) => {
    await client.query(
      `
        UPDATE submissions
        SET status = 'validating',
            updated_at = NOW()
        WHERE id = $1
      `,
      [precheck.submission.id],
    );

    const inserted: StoredPayoutRecord[] = [];

    for (const share of shares) {
      const result = await client.query<{ id: string }>(
        `
          INSERT INTO payouts (
            submission_id,
            freelancer_id,
            expected_amount,
            status,
            retry_count,
            mismatch_flagged,
            split_share_key,
            hold_reason,
            payout_group_id
          )
          VALUES ($1, $2, $3, $4, 0, FALSE, $5, $6, $7)
          RETURNING id
        `,
        [
          precheck.submission.id,
          share.userId,
          share.amountMicroAlgo.toString(),
          share.status,
          share.shareKey,
          share.holdReason,
          groupId,
        ],
      );

      inserted.push({ payoutId: result.rows[0].id, recipient: share });
    }

    return inserted;
  });
}

async function executePayout(
  precheck: PayoutPrecheckResult,
  executable: StoredPayoutRecord[],
): Promise<{ txId: string }> {
  const atomicShares: SplitPayoutShare[] = executable.map((record) => ({
    walletAddress: record.recipient.walletAddress,
    amountMicroAlgo: record.recipient.amountMicroAlgo,
    recipientUserId: record.recipient.userId,
  }));

  let txId: string;
  if (atomicShares.length === 1) {
    const release = await algorandService.releasePayoutWithRetry({
      submissionId: precheck.submission.id,
      finalScore: precheck.submission.final_score ?? 0,
      amountMicroAlgo: atomicShares[0].amountMicroAlgo,
      recipientWallet: atomicShares[0].walletAddress,
    });
    txId = release.txId;
  } else {
    const split = await algorandService.releaseSplitPayoutWithRetry({
      submissionId: precheck.submission.id,
      finalScore: precheck.submission.final_score ?? 0,
      shares: atomicShares,
    });
    txId = split.txId;
  }

  const confirmed = await algorandService.waitForTransactionConfirmation(txId, 1);
  if (!confirmed.confirmed) {
    throw new Error("SC-C-003: payout tx is not confirmed on-chain");
  }

  return { txId };
}

async function verifyAndFinalizePayouts(
  precheck: PayoutPrecheckResult,
  executable: StoredPayoutRecord[],
  txId: string,
  dispatcher: JobDispatcher,
) {
  const expectedTotal = executable.reduce((acc, item) => acc + item.recipient.amountMicroAlgo, 0n);
  const actualTotal = await algorandService.getConfirmedTransferAmount({
    txId,
    expectedAmountMicroAlgo: expectedTotal,
  });

  const mismatch = absBigInt(actualTotal - expectedTotal) > MISMATCH_TOLERANCE_MICROALGO;

  for (const record of executable) {
    await dbQuery(
      `
        UPDATE payouts
        SET status = 'completed',
            actual_amount = $1,
            tx_id = $2,
            mismatch_flagged = $3,
            updated_at = NOW()
        WHERE id = $4
      `,
      [record.recipient.amountMicroAlgo.toString(), txId, mismatch, record.payoutId],
    );
  }

  if (mismatch) {
    emitToBounty(precheck.bounty.id, "payout:mismatch_flagged", {
      bounty_id: precheck.bounty.id,
      submission_id: precheck.submission.id,
      tx_id: txId,
      expected_amount: expectedTotal.toString(),
      actual_amount: actualTotal.toString(),
    });

    await dispatcher.send("admin/alert", {
      code: "SC-F-005",
      submission_id: precheck.submission.id,
      bounty_id: precheck.bounty.id,
      expected_amount: expectedTotal.toString(),
      actual_amount: actualTotal.toString(),
      detail: "Payout amount mismatch above tolerance",
    });
  }
}

async function postPayout(
  precheck: PayoutPrecheckResult,
  dispatcher: JobDispatcher,
  notifier: SocketNotifier,
) {
  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE submissions
        SET status = 'passed',
            updated_at = NOW()
        WHERE id = $1
      `,
      [precheck.submission.id],
    );

    await client.query(
      `
        UPDATE bounties
        SET status = 'completed',
            updated_at = NOW()
        WHERE id = $1
      `,
      [precheck.bounty.id],
    );

    await client.query(
      `
        UPDATE users
        SET reputation_score = reputation_score + 5,
            updated_at = NOW()
        WHERE id = $1
      `,
      [precheck.submission.freelancer_id],
    );
  });

  await notifier.emitToUser(precheck.submission.freelancer_id, "bounty:payout_released", {
    submission_id: precheck.submission.id,
    bounty_id: precheck.bounty.id,
  });

  await notifier.emitToUser(precheck.bounty.creator_id, "bounty:payout_released", {
    submission_id: precheck.submission.id,
    bounty_id: precheck.bounty.id,
  });

  emitToBounty(precheck.bounty.id, "bounty:payout_released", {
    bounty_id: precheck.bounty.id,
    submission_id: precheck.submission.id,
  });

  await dispatcher.send("notification/send", {
    channel: "email+in_app",
    event_type: "payout_released",
    submission_id: precheck.submission.id,
    bounty_id: precheck.bounty.id,
    recipients: [precheck.submission.freelancer_id, precheck.bounty.creator_id],
  });
}

async function quarantinePayoutBySanction(submissionId: string, freelancerId: string, reason: string) {
  await dbQuery(
    `
      INSERT INTO payouts (submission_id, freelancer_id, expected_amount, status, retry_count, mismatch_flagged, hold_reason)
      VALUES ($1, $2, '0', 'quarantined', 0, FALSE, $3)
    `,
    [submissionId, freelancerId, reason],
  );

  await dbQuery(
    `
      UPDATE submissions
      SET status = 'failed',
          updated_at = NOW()
      WHERE id = $1
    `,
    [submissionId],
  );
}

async function holdPayout(submissionId: string, freelancerId: string, reason: string) {
  await dbQuery(
    `
      UPDATE payouts
      SET status = 'quarantined',
          hold_reason = $1,
          updated_at = NOW()
      WHERE submission_id = $2
        AND freelancer_id = $3
    `,
    [reason, submissionId, freelancerId],
  );
}

async function markSubmissionAndBountyOnQuarantine(precheck: PayoutPrecheckResult) {
  await dbQuery(
    `
      UPDATE submissions
      SET status = 'failed',
          updated_at = NOW()
      WHERE id = $1
    `,
    [precheck.submission.id],
  );

  await dbQuery(
    `
      UPDATE bounties
      SET status = 'in_progress',
          updated_at = NOW()
      WHERE id = $1
    `,
    [precheck.bounty.id],
  );
}

async function alertCompliance(precheck: PayoutPrecheckResult, reason: string) {
  await dbQuery(
    `
      INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
      VALUES ($1, 'in_app', 'compliance_payout_quarantine', $2::jsonb, FALSE, 0)
    `,
    [
      precheck.bounty.creator_id,
      JSON.stringify({
        submission_id: precheck.submission.id,
        bounty_id: precheck.bounty.id,
        reason,
      }),
    ],
  );
}

async function handleNoSubmissionExpiry(bounty: DeadlineCandidate, dispatcher: JobDispatcher) {
  const refund = await algorandService.refundClientEscrowWithRetry({ bountyId: bounty.id });
  await dbQuery(
    `
      UPDATE bounties
      SET status = 'expired_no_submission',
          updated_at = NOW()
      WHERE id = $1
    `,
    [bounty.id],
  );

  await dispatcher.send("notification/send", {
    event_type: "deadline_refund_no_submission",
    code: "DL-C-001",
    bounty_id: bounty.id,
    tx_id: refund.txId,
    recipients: [bounty.creator_id],
  });

  emitToBounty(bounty.id, "bounty:expired", {
    bounty_id: bounty.id,
    reason: "expired_no_submission",
    tx_id: refund.txId,
  });
}

async function handleExpiredIncomplete(
  bounty: DeadlineCandidate,
  inProgress: Array<{ id: string; freelancer_id: string }>,
  dispatcher: JobDispatcher,
) {
  const refund = await algorandService.refundClientEscrowWithRetry({ bountyId: bounty.id });
  const freelancerIds = inProgress.map((submission) => submission.freelancer_id);

  await withTransaction(async (client) => {
    await client.query(
      `
        UPDATE bounties
        SET status = 'expired',
            updated_at = NOW()
        WHERE id = $1
      `,
      [bounty.id],
    );

    await client.query(
      `
        UPDATE submissions
        SET status = 'expired_incomplete',
            updated_at = NOW()
        WHERE bounty_id = $1
          AND status = 'in_progress'
      `,
      [bounty.id],
    );

    for (const freelancerId of freelancerIds) {
      await client.query(
        `
          UPDATE users
          SET reputation_score = GREATEST(0, reputation_score - 5),
              updated_at = NOW()
          WHERE id = $1
        `,
        [freelancerId],
      );
    }
  });

  await dispatcher.send("notification/send", {
    event_type: "deadline_refund_incomplete",
    code: "DL-C-002",
    bounty_id: bounty.id,
    tx_id: refund.txId,
    recipients: [bounty.creator_id, ...freelancerIds],
  });

  emitToBounty(bounty.id, "bounty:expired", {
    bounty_id: bounty.id,
    reason: "expired_incomplete",
    tx_id: refund.txId,
  });
}

async function handleAllFailedRefund(
  bounty: DeadlineCandidate,
  submissions: Array<{ id: string; freelancer_id: string; status: SubmissionStatus }>,
  dispatcher: JobDispatcher,
) {
  const refund = await algorandService.refundClientEscrowWithRetry({ bountyId: bounty.id });
  await dbQuery(
    `
      UPDATE bounties
      SET status = 'expired_all_failed',
          updated_at = NOW()
      WHERE id = $1
    `,
    [bounty.id],
  );

  const summary = submissions.map((submission) => ({
    submission_id: submission.id,
    status: submission.status,
  }));

  await dispatcher.send("notification/send", {
    event_type: "deadline_refund_all_failed",
    code: "XC-005",
    bounty_id: bounty.id,
    tx_id: refund.txId,
    recipients: [bounty.creator_id],
    summary,
  });

  emitToBounty(bounty.id, "bounty:expired", {
    bounty_id: bounty.id,
    reason: "expired_all_failed",
    tx_id: refund.txId,
  });
}

async function getEffectiveDeadlineWithDowntime(bountyId: string, baselineDeadline: Date) {
  const downtime = await dbQuery<DowntimeWindow>(
    `
      SELECT started_at, ended_at
      FROM platform_downtime
      WHERE started_at <= $1
        AND COALESCE(ended_at, NOW()) >= $2
      ORDER BY started_at ASC
    `,
    [baselineDeadline, baselineDeadline],
  );

  if (downtime.rowCount === 0) {
    return baselineDeadline;
  }

  let extraMs = 0;
  for (const window of downtime.rows) {
    const endedAt = window.ended_at ?? new Date();
    extraMs += Math.max(0, endedAt.getTime() - window.started_at.getTime());
  }

  const adjusted = new Date(baselineDeadline.getTime() + extraMs);

  await dbQuery(
    `
      INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
      SELECT creator_id, 'in_app', 'deadline_adjusted_downtime', $2::jsonb, FALSE, 0
      FROM bounties
      WHERE id = $1
    `,
    [
      bountyId,
      JSON.stringify({
        code: "XC-002",
        bounty_id: bountyId,
        extra_ms: extraMs,
        adjusted_deadline: adjusted.toISOString(),
      }),
    ],
  );

  return adjusted;
}

async function logGracePeriodSkip(bountyId: string, graceExpiresAt: Date) {
  await dbQuery(
    `
      INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
      SELECT creator_id, 'in_app', 'deadline_grace_skip', $2::jsonb, FALSE, 0
      FROM bounties
      WHERE id = $1
    `,
    [
      bountyId,
      JSON.stringify({
        code: "DL-C-002",
        bounty_id: bountyId,
        grace_expires_at: graceExpiresAt.toISOString(),
      }),
    ],
  );
}

function validateWalletChecksum(walletAddress: string) {
  if (!isValidAlgorandAddress(walletAddress)) {
    throw new Error("SC-F-001: invalid Algorand wallet checksum");
  }
}

function parseBigIntStrict(value: string) {
  if (!/^\d+$/.test(value)) {
    throw new Error("SC-F-004: expected integer microALGO amount");
  }
  return BigInt(value);
}

function absBigInt(value: bigint) {
  return value >= 0n ? value : -value;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
