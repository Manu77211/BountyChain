import { createHash } from "node:crypto";
import { dbQuery, withTransaction } from "../../lib/db/client";
import type { CiStatus, ScoringMode } from "../../lib/db/types";
import { calculateFinalScore } from "../utils/scoreCalculator";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama3-70b-8192";
const GROQ_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  "You are a senior software engineer evaluating a code submission for a freelance bounty platform. You must evaluate the submission fairly and objectively. You must penalize: excessive non-functional comments, duplicate code patterns, code padding, AI-generated filler text, and mismatched programming languages. You must not penalize: unconventional but valid approaches, different languages if the client permitted them. Return ONLY valid JSON. No preamble. No markdown.";

export interface AiScoringJobInput {
  submission_id: string;
  bounty_id: string;
  cached_diff: string;
  ci_status: CiStatus;
  scoring_mode: ScoringMode;
  event_hash?: string;
  retry_count?: number;
}

export interface GroqScorePayload {
  requirement_match_score: number;
  code_quality_score: number;
  ci_bonus: number;
  integrity_score: number;
  total_score: number;
  integrity_flag: boolean;
  language_mismatch_flag: boolean;
  language_detected: string;
  justification: string;
  recommendations: string[];
}

interface Dispatcher {
  send: (eventName: string, data: Record<string, unknown>) => Promise<void>;
}

interface SubmissionContext {
  submission: {
    id: string;
    bounty_id: string;
    freelancer_id: string;
    ci_status: CiStatus;
    skipped_test_count: number;
    total_test_count: number;
    client_rating_stars: number | null;
  };
  bounty: {
    id: string;
    acceptance_criteria: string;
    allowed_languages: string[];
    scoring_mode: ScoringMode;
    ai_score_threshold: number;
  };
  creatorId: string;
}

export async function processAiScoringJob(input: AiScoringJobInput, dispatcher: Dispatcher) {
  const eventHash = input.event_hash ?? hashEvent(input);
  const idempotency = await idempotencyCheck({
    submissionId: input.submission_id,
    eventHash,
  });

  if (idempotency.state === "existing") {
    return {
      state: "existing",
      ai_score: idempotency.existingScore,
      final_score: idempotency.existingFinalScore,
    };
  }

  if (idempotency.state === "in_progress") {
    return { state: "scoring_in_progress" };
  }

  const context = await fetchBountyContext(input.submission_id, input.bounty_id);

  if (!context.bounty.acceptance_criteria?.trim()) {
    throw new Error("AI-C-002: acceptance_criteria cannot be empty for AI scoring");
  }

  if (context.bounty.scoring_mode === "ci_only") {
    const ciOnly = calculateFinalScore({
      scoringMode: "ci_only",
      aiScore: null,
      ciStatus: context.submission.ci_status,
      skippedTestCount: context.submission.skipped_test_count,
      totalTestCount: context.submission.total_test_count,
      clientRatingStars: context.submission.client_rating_stars ?? null,
    });

    await dbQuery(
      `
        UPDATE submissions
        SET ai_score = NULL,
            ai_score_raw = jsonb_build_object('mode', 'ci_only', 'scored_at', NOW()),
            final_score = $1,
            ai_scoring_in_progress = FALSE,
            ai_scoring_status = 'completed',
            score_finalized_at = NOW(),
            status = CASE WHEN $1 >= $2 THEN 'passed' ELSE 'failed' END
        WHERE id = $3
      `,
      [ciOnly.finalScore, context.bounty.ai_score_threshold, context.submission.id],
    );

    if (ciOnly.finalScore >= context.bounty.ai_score_threshold) {
      await dispatcher.send("payout_release/requested", {
        submission_id: context.submission.id,
        bounty_id: context.bounty.id,
        final_score: ciOnly.finalScore,
      });
      return { state: "passed", ai_score: null, final_score: ciOnly.finalScore };
    }

    await notifyScoreFailure({
      submissionId: context.submission.id,
      freelancerId: context.submission.freelancer_id,
      creatorId: context.creatorId,
      finalScore: ciOnly.finalScore,
      justification: "CI-only scoring result is below threshold.",
    });
    return { state: "failed", ai_score: null, final_score: ciOnly.finalScore };
  }

  if (
    context.submission.ci_status !== "passed" &&
    context.submission.ci_status !== "timeout" &&
    context.bounty.scoring_mode !== "ai_only"
  ) {
    await markSubmissionFailedWithoutAi(context.submission.id, context.submission.ci_status);
    return {
      state: "ci_failed",
      detail: "CI status prevents AI scoring",
    };
  }

  const prompt = buildScoringPrompt({
    acceptanceCriteria: context.bounty.acceptance_criteria,
    allowedLanguages: context.bounty.allowed_languages,
    cachedDiff: input.cached_diff,
    ciStatus: context.submission.ci_status,
    skippedTestCount: context.submission.skipped_test_count,
    totalTestCount: context.submission.total_test_count,
  });

  let rawGroqContent = "";
  try {
    rawGroqContent = await callGroqApi(prompt);
  } catch (error) {
    await markScoringTimeout(context.submission.id, error);
    throw error;
  }

  let parsedScore: GroqScorePayload;
  try {
    parsedScore = validateGroqScore(parseGroqResponse(rawGroqContent));
  } catch (error) {
    await handleMalformedGroqResponse({
      submissionId: context.submission.id,
      rawResponse: rawGroqContent,
      error,
      retryCount: input.retry_count ?? 0,
      dispatcher,
      eventHash,
      baseInput: input,
    });
    return {
      state: "malformed",
      detail: "AI-F-002: malformed GROQ response",
    };
  }

  const languageMismatchRequiresOverride =
    parsedScore.language_mismatch_flag &&
    !context.bounty.allowed_languages
      .map((value) => value.toLowerCase())
      .includes(parsedScore.language_detected.toLowerCase());

  const finalScore = calculateFinalScore({
    scoringMode: context.bounty.scoring_mode,
    aiScore: parsedScore.total_score,
    ciStatus: context.submission.ci_status,
    skippedTestCount: context.submission.skipped_test_count,
    totalTestCount: context.submission.total_test_count,
    clientRatingStars: context.submission.client_rating_stars ?? null,
  });

  await validateAndStoreScore({
    submissionId: context.submission.id,
    score: parsedScore,
    rawResponse: rawGroqContent,
    finalScore: finalScore.finalScore,
    eventHash,
  });

  if (parsedScore.integrity_flag) {
    await notifyAiIntegrityHold(context.submission.id, context.creatorId, parsedScore.justification);
    return {
      state: "held_integrity",
      ai_score: parsedScore.total_score,
      final_score: finalScore.finalScore,
    };
  }

  if (languageMismatchRequiresOverride) {
    await notifyLanguageOverrideNeeded(context.submission.id, context.creatorId, parsedScore.language_detected);
    return {
      state: "language_override_required",
      ai_score: parsedScore.total_score,
      final_score: finalScore.finalScore,
    };
  }

  if (finalScore.finalScore >= context.bounty.ai_score_threshold) {
    await dispatcher.send("payout_release/requested", {
      submission_id: context.submission.id,
      bounty_id: context.bounty.id,
      final_score: finalScore.finalScore,
    });

    await dbQuery(
      "UPDATE submissions SET status = 'passed', ai_scoring_status = 'completed', ai_scoring_in_progress = FALSE WHERE id = $1",
      [context.submission.id],
    );

    return {
      state: "passed",
      ai_score: parsedScore.total_score,
      final_score: finalScore.finalScore,
    };
  }

  await dbQuery(
    "UPDATE submissions SET status = 'failed', ai_scoring_status = 'completed', ai_scoring_in_progress = FALSE WHERE id = $1",
    [context.submission.id],
  );

  await notifyScoreFailure({
    submissionId: context.submission.id,
    freelancerId: context.submission.freelancer_id,
    creatorId: context.creatorId,
    finalScore: finalScore.finalScore,
    justification: parsedScore.justification,
  });

  return {
    state: "failed",
    ai_score: parsedScore.total_score,
    final_score: finalScore.finalScore,
  };
}

export async function flagAiScoreForDispute(input: {
  submissionId: string;
  clientUserId: string;
  reason: string;
}) {
  const scored = await dbQuery<{
    submission_id: string;
    bounty_id: string;
    creator_id: string;
    score_finalized_at: Date | null;
  }>(
    `
      SELECT s.id AS submission_id, s.bounty_id, b.creator_id, s.score_finalized_at
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      WHERE s.id = $1
        AND b.deleted_at IS NULL
      LIMIT 1
    `,
    [input.submissionId],
  );

  if (scored.rowCount === 0) {
    throw new Error("AI-C-001: Submission not found");
  }

  const row = scored.rows[0];
  if (row.creator_id !== input.clientUserId) {
    throw new Error("AI-C-001: Only bounty client can flag AI score");
  }

  const finalizedAt = row.score_finalized_at;
  if (!finalizedAt || Date.now() - new Date(finalizedAt).getTime() > 48 * 60 * 60 * 1000) {
    throw new Error("AI-C-001: Client flag window expired");
  }

  return withTransaction(async (client) => {
    const dispute = await client.query<{ id: string }>(
      `
        INSERT INTO disputes (submission_id, raised_by, reason, status, raised_at)
        VALUES ($1, $2, $3, 'open', NOW())
        RETURNING id
      `,
      [input.submissionId, input.clientUserId, input.reason],
    );

    await client.query(
      "UPDATE submissions SET status = 'disputed', client_flagged_at = NOW() WHERE id = $1",
      [input.submissionId],
    );

    return dispute.rows[0];
  });
}

async function idempotencyCheck(input: { submissionId: string; eventHash: string }) {
  const key = createScoringIdempotencyKey(input.submissionId, input.eventHash);

  const result = await dbQuery<{
    id: string;
    ai_score: number | null;
    final_score: number | null;
    scoring_idempotency_key: string;
    ai_scoring_in_progress: boolean;
  }>(
    `
      SELECT id, ai_score, final_score, scoring_idempotency_key, ai_scoring_in_progress
      FROM submissions
      WHERE id = $1
      LIMIT 1
    `,
    [input.submissionId],
  );

  if (result.rowCount === 0) {
    throw new Error("Submission not found for ai_scoring");
  }

  const submission = result.rows[0];

  if (submission.ai_scoring_in_progress) {
    return { state: "in_progress" as const };
  }

  if (submission.scoring_idempotency_key === key && submission.ai_score !== null) {
    return {
      state: "existing" as const,
      existingScore: submission.ai_score,
      existingFinalScore: submission.final_score,
    };
  }

  await dbQuery(
    `
      UPDATE submissions
      SET scoring_idempotency_key = $1,
          ai_scoring_last_event_hash = $2,
          ai_scoring_in_progress = TRUE,
          ai_scoring_status = 'in_progress',
          ai_scoring_attempts = ai_scoring_attempts + 1
      WHERE id = $3
    `,
    [key, input.eventHash, input.submissionId],
  );

  return { state: "ready" as const };
}

async function fetchBountyContext(submissionId: string, bountyId: string): Promise<SubmissionContext> {
  const result = await dbQuery<{
    submission_id: string;
    bounty_id: string;
    freelancer_id: string;
    ci_status: CiStatus;
    skipped_test_count: number;
    total_test_count: number;
    client_rating_stars: number | null;
    scoring_mode: ScoringMode;
    ai_score_threshold: number;
    acceptance_criteria: string;
    allowed_languages: string[];
    creator_id: string;
  }>(
    `
      SELECT
        s.id AS submission_id,
        s.bounty_id,
        s.freelancer_id,
        s.ci_status,
        s.skipped_test_count,
        s.total_test_count,
        s.client_rating_stars,
        b.scoring_mode,
        b.ai_score_threshold,
        b.acceptance_criteria,
        b.allowed_languages,
        b.creator_id
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      WHERE s.id = $1
        AND s.bounty_id = $2
        AND b.deleted_at IS NULL
      LIMIT 1
    `,
    [submissionId, bountyId],
  );

  if (result.rowCount === 0) {
    throw new Error("Submission or bounty context not found");
  }

  const row = result.rows[0];

  return {
    submission: {
      id: row.submission_id,
      bounty_id: row.bounty_id,
      freelancer_id: row.freelancer_id,
      ci_status: row.ci_status,
      skipped_test_count: row.skipped_test_count,
      total_test_count: row.total_test_count,
      client_rating_stars: row.client_rating_stars,
    },
    bounty: {
      id: row.bounty_id,
      acceptance_criteria: row.acceptance_criteria,
      allowed_languages: row.allowed_languages,
      scoring_mode: row.scoring_mode,
      ai_score_threshold: row.ai_score_threshold,
    },
    creatorId: row.creator_id,
  };
}

function buildScoringPrompt(input: {
  acceptanceCriteria: string;
  allowedLanguages: string[];
  cachedDiff: string;
  ciStatus: CiStatus;
  skippedTestCount: number;
  totalTestCount: number;
}) {
  const userPrompt = `Evaluate this submission against the requirements.\n\nACCEPTANCE CRITERIA:\n${
    input.acceptanceCriteria
  }\n\nALLOWED LANGUAGES: ${input.allowedLanguages.join(", ")}\n\nCODE DIFF SUMMARY:\n${
    input.cachedDiff
  }\n\nCI/CD RESULT: ${input.ciStatus}\nSKIPPED TESTS: ${input.skippedTestCount} / ${
    input.totalTestCount
  }\n\nReturn JSON:\n{\n  requirement_match_score: 0-40,\n  code_quality_score: 0-30,\n  ci_bonus: 0-20,\n  integrity_score: 0-10,\n  total_score: 0-100,\n  integrity_flag: boolean,\n  language_mismatch_flag: boolean,\n  language_detected: string,\n  justification: string (max 200 words),\n  recommendations: string[]\n}`;

  return {
    model: GROQ_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  };
}

async function callGroqApi(payload: Record<string, unknown>) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("AI-F-001: GROQ_API_KEY is missing");
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    try {
      const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 429 || response.status >= 500) {
        const retryableError = new Error(`AI-F-001: GROQ unavailable (${response.status})`);
        lastError = retryableError;
        if (attempt < 3) {
          await wait(attempt * attempt * 500);
          continue;
        }
        throw retryableError;
      }

      if (!response.ok) {
        throw new Error(`GROQ request failed (${response.status})`);
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("AI-F-002: GROQ returned empty content");
      }

      return content;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new Error("AI-F-006: GROQ scoring timed out after 30s");
      } else {
        lastError = error;
      }

      if (attempt < 3) {
        await wait(attempt * attempt * 500);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("AI-F-001: GROQ unavailable after retries");
}

function parseGroqResponse(content: string): GroqScorePayload {
  const normalized = content.trim();
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error("AI-F-002: GROQ payload is not JSON");
  }

  const jsonSlice = normalized.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice) as GroqScorePayload;
}

function validateGroqScore(payload: GroqScorePayload): GroqScorePayload {
  const intFields: Array<keyof GroqScorePayload> = [
    "requirement_match_score",
    "code_quality_score",
    "ci_bonus",
    "integrity_score",
    "total_score",
  ];

  for (const field of intFields) {
    const value = payload[field];
    if (!Number.isInteger(value)) {
      throw new Error(`AI-F-002: ${String(field)} must be an integer`);
    }
  }

  if (payload.requirement_match_score < 0 || payload.requirement_match_score > 40) {
    throw new Error("AI-F-002: requirement_match_score out of range");
  }
  if (payload.code_quality_score < 0 || payload.code_quality_score > 30) {
    throw new Error("AI-F-002: code_quality_score out of range");
  }
  if (payload.ci_bonus < 0 || payload.ci_bonus > 20) {
    throw new Error("AI-F-002: ci_bonus out of range");
  }
  if (payload.integrity_score < 0 || payload.integrity_score > 10) {
    throw new Error("AI-F-002: integrity_score out of range");
  }
  if (payload.total_score < 0 || payload.total_score > 100) {
    throw new Error("AI-F-002: total_score out of range");
  }

  const recomputedTotal =
    payload.requirement_match_score +
    payload.code_quality_score +
    payload.ci_bonus +
    payload.integrity_score;

  if (recomputedTotal !== payload.total_score) {
    throw new Error("AI-F-002: total_score must equal component sum");
  }

  if (!Array.isArray(payload.recommendations)) {
    throw new Error("AI-F-002: recommendations must be an array");
  }

  return payload;
}

async function validateAndStoreScore(input: {
  submissionId: string;
  score: GroqScorePayload;
  rawResponse: string;
  finalScore: number;
  eventHash: string;
}) {
  const aiRaw = {
    ...input.score,
    raw_response: input.rawResponse,
    scored_at: new Date().toISOString(),
    event_hash: input.eventHash,
  };

  const sql = `
    UPDATE submissions
    SET ai_score = $1,
        ai_score_raw = $2::jsonb,
        ai_integrity_flag = $3,
        ai_language_mismatch_flag = $4,
        final_score = $5,
        ai_scoring_in_progress = FALSE,
        ai_scoring_status = 'completed',
        score_finalized_at = NOW()
    WHERE id = $6
  `;

  await dbQuery(sql, [
    input.score.total_score,
    JSON.stringify(aiRaw),
    input.score.integrity_flag,
    input.score.language_mismatch_flag,
    input.finalScore,
    input.submissionId,
  ]);
}

async function handleMalformedGroqResponse(input: {
  submissionId: string;
  rawResponse: string;
  error: unknown;
  retryCount: number;
  dispatcher: Dispatcher;
  eventHash: string;
  baseInput: AiScoringJobInput;
}) {
  const errorMessage = input.error instanceof Error ? input.error.message : "Unknown parse failure";

  await dbQuery(
    `
      UPDATE submissions
      SET ai_score = NULL,
          ai_score_raw = jsonb_build_object(
            'parse_error', $1,
            'raw_response', $2,
            'event_hash', $3,
            'scored_at', NOW()
          ),
          ai_scoring_in_progress = FALSE,
          ai_scoring_status = 'parse_failed'
      WHERE id = $4
    `,
    [errorMessage, input.rawResponse, input.eventHash, input.submissionId],
  );

  if (input.retryCount < 2) {
    await input.dispatcher.send("ai_scoring/requested", {
      ...input.baseInput,
      event_hash: input.eventHash,
      retry_count: input.retryCount + 1,
    });
    return;
  }

  await markSubmissionManualReview(input.submissionId, "AI-F-002: malformed GROQ response after retries");
}

async function markScoringTimeout(submissionId: string, error: unknown) {
  const detail = error instanceof Error ? error.message : "Timeout";
  await dbQuery(
    `
      UPDATE submissions
      SET ai_score = NULL,
          ai_scoring_status = 'timeout',
          ai_scoring_in_progress = FALSE,
          ai_score_raw = jsonb_build_object('timeout_detail', $1, 'timed_out_at', NOW())
      WHERE id = $2
    `,
    [detail, submissionId],
  );
}

async function markSubmissionManualReview(submissionId: string, reason: string) {
  await dbQuery(
    `
      UPDATE submissions
      SET ai_scoring_status = 'manual_review',
          ai_scoring_in_progress = FALSE,
          status = 'disputed',
          ai_score_raw = COALESCE(ai_score_raw, '{}'::jsonb) || jsonb_build_object('manual_review_reason', $1)
      WHERE id = $2
    `,
    [reason, submissionId],
  );

  const sub = await dbQuery<{ freelancer_id: string; bounty_id: string }>(
    "SELECT freelancer_id, bounty_id FROM submissions WHERE id = $1 LIMIT 1",
    [submissionId],
  );
  if (sub.rowCount === 0) {
    return;
  }

  const bounty = await dbQuery<{ creator_id: string }>(
    "SELECT creator_id FROM bounties WHERE id = $1 LIMIT 1",
    [sub.rows[0].bounty_id],
  );

  const targetUsers = [sub.rows[0].freelancer_id, bounty.rows[0]?.creator_id].filter(Boolean);
  for (const userId of targetUsers) {
    await dbQuery(
      "INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts) VALUES ($1, 'in_app', 'ai_manual_review', $2::jsonb, FALSE, 0)",
      [userId, JSON.stringify({ submission_id: submissionId, reason })],
    );
  }
}

async function markSubmissionFailedWithoutAi(submissionId: string, ciStatus: CiStatus) {
  await dbQuery(
    `
      UPDATE submissions
      SET status = 'failed',
          ai_scoring_in_progress = FALSE,
          ai_scoring_status = 'completed',
          final_score = 0,
          ai_score = NULL,
          ai_score_raw = jsonb_build_object('ci_gate_failed', TRUE, 'ci_status', $1, 'updated_at', NOW())
      WHERE id = $2
    `,
    [ciStatus, submissionId],
  );
}

async function notifyAiIntegrityHold(submissionId: string, creatorId: string, justification: string) {
  await dbQuery(
    "INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts) VALUES ($1, 'in_app', 'ai_integrity_hold', $2::jsonb, FALSE, 0)",
    [creatorId, JSON.stringify({ submission_id: submissionId, justification })],
  );
}

async function notifyLanguageOverrideNeeded(submissionId: string, creatorId: string, languageDetected: string) {
  await dbQuery(
    "INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts) VALUES ($1, 'in_app', 'ai_language_override_required', $2::jsonb, FALSE, 0)",
    [creatorId, JSON.stringify({ submission_id: submissionId, language_detected: languageDetected, code: 'AI-F-003' })],
  );
}

async function notifyScoreFailure(input: {
  submissionId: string;
  freelancerId: string;
  creatorId: string;
  finalScore: number;
  justification: string;
}) {
  await dbQuery(
    "INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts) VALUES ($1, 'in_app', 'submission_failed_score', $2::jsonb, FALSE, 0)",
    [
      input.freelancerId,
      JSON.stringify({
        submission_id: input.submissionId,
        final_score: input.finalScore,
        justification: input.justification,
      }),
    ],
  );

  await dbQuery(
    "INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts) VALUES ($1, 'in_app', 'client_score_summary', $2::jsonb, FALSE, 0)",
    [
      input.creatorId,
      JSON.stringify({
        submission_id: input.submissionId,
        final_score: input.finalScore,
        justification: input.justification,
      }),
    ],
  );
}

function createScoringIdempotencyKey(submissionId: string, eventHash: string) {
  return createHash("sha256").update(`${submissionId}:${eventHash}`).digest("hex");
}

function hashEvent(payload: AiScoringJobInput) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
