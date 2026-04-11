import { dbQuery } from "../../lib/db/client";

const HACKATHON_MODE = process.env.HACKATHON_MODE === "true";
const ALGOD_MOCK_MODE = (process.env.ALGOD_MOCK_MODE ?? "true").toLowerCase() === "true";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const GROQ_TIMEOUT_MS = 12_000;
const WALLET_REGEX = /^[A-Z2-7]{58}$/;

export type HackathonReviewAction = "rate_decide" | "approve_review";

export interface HackathonReviewInput {
  submissionId: string;
  bountyId: string;
  reviewerId: string;
  action: HackathonReviewAction;
  decision: "approve" | "request_changes" | "reject";
  clientRating?: number;
  comment?: string;
}

interface HackathonReviewContext {
  submissionId: string;
  bountyId: string;
  freelancerId: string;
  creatorId: string;
  creatorWallet: string;
  artifactUrl: string;
  acceptanceCriteria: string;
  totalAmountMicroAlgo: string;
  currentFinalScore: number | null;
  currentClientRatingStars: number | null;
}

interface HackathonReviewConfig {
  action: HackathonReviewAction;
  fallback_base_score: number;
  approved_min_score: number;
  request_changes_max_score: number;
  reject_max_score: number;
  default_client_rating: number;
  transfer_basis_points: number;
  lock_enabled: boolean;
  summary_template: string;
  recommendations: string[];
}

export interface HackathonCodeReviewResult {
  source: "groq" | "db_template";
  summary: string;
  recommendations: string[];
  score: number;
}

export interface HackathonReviewPipelineResult {
  score: number;
  codeReviewSource: "groq" | "db_template";
  lockTxId: string | null;
  transferTxId: string | null;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function loadHackathonReviewConfig(action: HackathonReviewAction): Promise<HackathonReviewConfig> {
  const row = await dbQuery<{
    action: HackathonReviewAction;
    fallback_base_score: number;
    approved_min_score: number;
    request_changes_max_score: number;
    reject_max_score: number;
    default_client_rating: number;
    transfer_basis_points: number;
    lock_enabled: boolean;
    summary_template: string;
    recommendations: unknown;
  }>(
    `
      SELECT action,
             fallback_base_score,
             approved_min_score,
             request_changes_max_score,
             reject_max_score,
             default_client_rating,
             transfer_basis_points,
             lock_enabled,
             summary_template,
             recommendations
      FROM hackathon_review_configs
      WHERE action = $1
      LIMIT 1
    `,
    [action],
  );

  if ((row.rowCount ?? 0) === 0) {
    throw new Error(`Missing hackathon review config for action ${action}`);
  }

  const current = row.rows[0];
  return {
    action: current.action,
    fallback_base_score: clampScore(current.fallback_base_score),
    approved_min_score: clampScore(current.approved_min_score),
    request_changes_max_score: clampScore(current.request_changes_max_score),
    reject_max_score: clampScore(current.reject_max_score),
    default_client_rating: clampScore(current.default_client_rating),
    transfer_basis_points: Math.max(1, Math.min(10_000, Number(current.transfer_basis_points))),
    lock_enabled: Boolean(current.lock_enabled),
    summary_template: current.summary_template,
    recommendations: Array.isArray(current.recommendations)
      ? current.recommendations.map((item) => String(item)).slice(0, 8)
      : [],
  };
}

function computeHackathonScore(input: {
  currentFinalScore: number | null;
  clientRating?: number;
  decision: "approve" | "request_changes" | "reject";
  config: HackathonReviewConfig;
}) {
  const base = input.currentFinalScore ?? input.clientRating ?? input.config.default_client_rating;
  if (input.decision === "approve") {
    return clampScore(Math.max(base, input.config.approved_min_score));
  }
  if (input.decision === "request_changes") {
    return clampScore(Math.min(base, input.config.request_changes_max_score));
  }
  return clampScore(Math.min(base, input.config.reject_max_score));
}

function buildConfiguredReview(input: {
  decision: "approve" | "request_changes" | "reject";
  artifactUrl: string;
  acceptanceCriteria: string;
  score: number;
  config: HackathonReviewConfig;
}): HackathonCodeReviewResult {
  const decisionLabel = input.decision.replace("_", " ").toUpperCase();
  const criteriaPreview = input.acceptanceCriteria.slice(0, 220);
  const summary = input.config.summary_template
    .replace(/\{decision\}/g, decisionLabel)
    .replace(/\{artifact_url\}/g, input.artifactUrl)
    .replace(/\{criteria_preview\}/g, criteriaPreview)
    .replace(/\{score\}/g, String(input.score));

  return {
    source: "db_template",
    summary,
    recommendations:
      input.config.recommendations.length > 0
        ? input.config.recommendations
        : ["Review template configured without recommendations."],
    score: input.score,
  };
}

async function maybeRequestGroqReview(input: {
  decision: "approve" | "request_changes" | "reject";
  artifactUrl: string;
  acceptanceCriteria: string;
}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "You are a strict hackathon code reviewer. Return JSON only.",
          },
          {
            role: "user",
            content: `Decision=${input.decision}\nArtifact=${input.artifactUrl}\nCriteria=${input.acceptanceCriteria}\nReturn {summary:string,recommendations:string[]}`,
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as {
      summary?: string;
      recommendations?: string[];
    };

    if (!parsed.summary || !Array.isArray(parsed.recommendations)) {
      return null;
    }

    return {
      summary: String(parsed.summary).slice(0, 800),
      recommendations: parsed.recommendations.map((item) => String(item).slice(0, 220)).slice(0, 5),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadHackathonReviewContext(input: HackathonReviewInput): Promise<HackathonReviewContext> {
  const row = await dbQuery<{
    submission_id: string;
    bounty_id: string;
    freelancer_id: string;
    creator_id: string;
    creator_wallet: string;
    github_pr_url: string;
    acceptance_criteria: string;
    total_amount: string;
    final_score: number | null;
    client_rating_stars: number | null;
  }>(
    `
      SELECT s.id AS submission_id,
             s.bounty_id,
             s.freelancer_id,
             b.creator_id,
             u.wallet_address AS creator_wallet,
             s.github_pr_url,
             b.acceptance_criteria,
             b.total_amount::text,
             s.final_score,
             s.client_rating_stars
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      JOIN users u ON u.id = b.creator_id
      WHERE s.id = $1
        AND s.bounty_id = $2
      LIMIT 1
    `,
    [input.submissionId, input.bountyId],
  );

  if ((row.rowCount ?? 0) === 0) {
    throw new Error("Hackathon review context not found");
  }

  const current = row.rows[0];
  return {
    submissionId: current.submission_id,
    bountyId: current.bounty_id,
    freelancerId: current.freelancer_id,
    creatorId: current.creator_id,
    creatorWallet: current.creator_wallet,
    artifactUrl: current.github_pr_url,
    acceptanceCriteria: current.acceptance_criteria,
    totalAmountMicroAlgo: current.total_amount,
    currentFinalScore: current.final_score,
    currentClientRatingStars: current.client_rating_stars,
  };
}

export async function generateHackathonCodeReview(
  context: HackathonReviewContext,
  config: HackathonReviewConfig,
  input: HackathonReviewInput,
): Promise<HackathonCodeReviewResult> {
  const score = computeHackathonScore({
    currentFinalScore: context.currentFinalScore,
    clientRating: input.clientRating,
    decision: input.decision,
    config,
  });

  const configured = buildConfiguredReview({
    decision: input.decision,
    artifactUrl: context.artifactUrl,
    acceptanceCriteria: context.acceptanceCriteria,
    score,
    config,
  });

  const groq = await maybeRequestGroqReview({
    decision: input.decision,
    artifactUrl: context.artifactUrl,
    acceptanceCriteria: context.acceptanceCriteria,
  });

  if (!groq) {
    return configured;
  }

  return {
    source: "groq",
    summary: groq.summary,
    recommendations: groq.recommendations,
    score,
  };
}

export async function persistHackathonCodeReview(
  context: HackathonReviewContext,
  input: HackathonReviewInput,
  review: HackathonCodeReviewResult,
) {
  const pipelineKey = `hackathon:${context.submissionId}:${input.action}`;

  const existingComment = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM submission_review_comments
      WHERE submission_id = $1
        AND metadata ->> 'pipeline_key' = $2
      LIMIT 1
    `,
    [context.submissionId, pipelineKey],
  );

  if ((existingComment.rowCount ?? 0) === 0) {
  await dbQuery(
    `
      INSERT INTO submission_review_comments (
        submission_id,
        author_id,
        comment_type,
        visibility,
        content,
        metadata
      )
      VALUES ($1, $2, 'note', 'both', $3, $4::jsonb)
    `,
    [
      context.submissionId,
      input.reviewerId,
      review.summary,
      JSON.stringify({
        source: "hackathon_pipeline",
        pipeline_key: pipelineKey,
        action: input.action,
        review_source: review.source,
        score: review.score,
        recommendations: review.recommendations,
      }),
    ],
  );
  }

  const existingReport = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM submission_feedback_reports
      WHERE submission_id = $1
        AND ai_payload ->> 'pipeline_key' = $2
      LIMIT 1
    `,
    [context.submissionId, pipelineKey],
  );

  if ((existingReport.rowCount ?? 0) > 0) {
    return;
  }

  await dbQuery(
    `
      INSERT INTO submission_feedback_reports (
        submission_id,
        generated_by,
        ai_payload,
        checklist_payload,
        implemented_items,
        missing_items,
        client_summary,
        freelancer_summary,
        freelancer_suggestions,
        client_comment
      )
      VALUES ($1, 'hybrid', $2::jsonb, $3::jsonb, '[]'::jsonb, '[]'::jsonb, $4, $5, $6::jsonb, $7)
    `,
    [
      context.submissionId,
      JSON.stringify({ source: review.source, score: review.score, pipeline_key: pipelineKey }),
      JSON.stringify({ action: input.action, decision: input.decision }),
      review.summary,
      "Hackathon review recorded and persisted.",
      JSON.stringify(review.recommendations),
      input.comment ?? null,
    ],
  );
}

export async function upsertHackathonScore(
  context: HackathonReviewContext,
  review: HackathonCodeReviewResult,
) {
  const stars = Math.max(1, Math.min(5, Math.round(review.score / 20)));
  const updated = await dbQuery<{ final_score: number | null }>(
    `
      UPDATE submissions
      SET ai_score = COALESCE(ai_score, $2),
          final_score = COALESCE(final_score, $2),
          client_rating_stars = COALESCE(client_rating_stars, $3),
          score_finalized_at = COALESCE(score_finalized_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
      RETURNING final_score
    `,
    [context.submissionId, review.score, stars],
  );

  return updated.rows[0]?.final_score ?? review.score;
}

export async function ensureHackathonCoinLock(
  context: HackathonReviewContext,
  config: HackathonReviewConfig,
) {
  if (!config.lock_enabled) {
    return null;
  }

  await dbQuery(
    `
      UPDATE bounties
      SET escrow_locked = TRUE,
          updated_at = NOW()
      WHERE id = $1
    `,
    [context.bountyId],
  );

  if (!HACKATHON_MODE || !ALGOD_MOCK_MODE) {
    return null;
  }

  if (!WALLET_REGEX.test(context.creatorWallet)) {
    return `hack-lock-${context.submissionId.slice(0, 8)}-${Date.now()}`;
  }

  const existing = await dbQuery<{ lock_tx_id: string }>(
    `SELECT lock_tx_id FROM mock_escrow_holds WHERE bounty_id = $1 LIMIT 1`,
    [context.bountyId],
  );

  if ((existing.rowCount ?? 0) > 0) {
    return existing.rows[0].lock_tx_id;
  }

  const lockTxId = `hack-lock-${context.submissionId.slice(0, 8)}-${Date.now()}`;
  await dbQuery(
    `
      INSERT INTO mock_escrow_holds (
        bounty_id,
        creator_user_id,
        creator_wallet_address,
        contract_address,
        amount_microalgo,
        remaining_microalgo,
        status,
        lock_tx_id
      )
      VALUES ($1, $2, $3, $4, $5, $5, 'locked', $6)
    `,
    [
      context.bountyId,
      context.creatorId,
      context.creatorWallet,
      `hack-lock-${context.bountyId.slice(0, 8)}`,
      context.totalAmountMicroAlgo,
      lockTxId,
    ],
  );

  return lockTxId;
}

export async function recordHackathonTransferEvidence(
  context: HackathonReviewContext,
  config: HackathonReviewConfig,
  input: HackathonReviewInput,
) {
  if (!HACKATHON_MODE || !ALGOD_MOCK_MODE) {
    return null;
  }

  const total = BigInt(context.totalAmountMicroAlgo || "0");
  const basisPoints = input.decision === "approve" ? config.transfer_basis_points : 1;
  const computedAmount = total > 0n ? (total * BigInt(basisPoints)) / 10_000n : 0n;
  const transferAmount = computedAmount > 0n ? computedAmount : 1n;
  const txId = `hack-review-${context.submissionId.slice(0, 8)}-${Date.now()}`;

  const inserted = await dbQuery<{ tx_id: string }>(
    `
      INSERT INTO mock_escrow_transfers (
        transfer_key,
        bounty_id,
        tx_id,
        total_amount_microalgo
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (transfer_key)
      DO UPDATE SET tx_id = EXCLUDED.tx_id
      RETURNING tx_id
    `,
    [
      `hack-review:${context.submissionId}:${input.action}`,
      context.bountyId,
      txId,
      transferAmount.toString(),
    ],
  );

  return inserted.rows[0]?.tx_id ?? txId;
}

export async function executeHackathonReviewPipeline(
  input: HackathonReviewInput,
): Promise<HackathonReviewPipelineResult> {
  const context = await loadHackathonReviewContext(input);
  const config = await loadHackathonReviewConfig(input.action);
  const review = await generateHackathonCodeReview(context, config, input);
  await persistHackathonCodeReview(context, input, review);
  const score = await upsertHackathonScore(context, review);
  const lockTxId = await ensureHackathonCoinLock(context, config);
  const transferTxId = await recordHackathonTransferEvidence(context, config, input);

  await dbQuery(
    `
      INSERT INTO hackathon_review_runs (
        submission_id,
        bounty_id,
        action,
        decision,
        score,
        code_review_source,
        lock_tx_id,
        transfer_tx_id,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `,
    [
      context.submissionId,
      context.bountyId,
      input.action,
      input.decision,
      score,
      review.source,
      lockTxId,
      transferTxId,
      JSON.stringify({
        recommendations: review.recommendations,
        comment: input.comment ?? null,
      }),
    ],
  );

  return {
    score,
    codeReviewSource: review.source,
    lockTxId,
    transferTxId,
  };
}
