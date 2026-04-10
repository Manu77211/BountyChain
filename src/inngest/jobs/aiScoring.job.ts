import { createHash } from "node:crypto";
import { dbQuery } from "../../../lib/db/client";
import { emitToBounty } from "../../realtime/socket";
import { inngest } from "../client";
import { asString, createInAppNotification } from "../shared";

interface ScoringContext {
  submission_id: string;
  bounty_id: string;
  freelancer_id: string;
  freelancer_wallet: string;
  creator_id: string;
  ci_status: "pending" | "running" | "passed" | "failed" | "skipped_abuse" | "timeout" | "ci_not_found";
  scoring_mode: "ai_only" | "ci_only" | "hybrid";
  acceptance_criteria: string;
  allowed_languages: string[];
  ai_score_threshold: number;
  total_amount: string;
  contributor_splits: Array<Record<string, unknown>>;
  scoring_idempotency_key: string | null;
  ai_score: number | null;
  final_score: number | null;
  ai_scoring_attempts: number;
}

interface GroqScore {
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

class RateLimitError extends Error {
  retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("AI-F-001: GROQ rate limit");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class TimeoutError extends Error {
  constructor() {
    super("AI-F-006: GROQ request timed out");
  }
}

class ContextLengthError extends Error {
  constructor() {
    super("GROQ context_length_exceeded");
  }
}

class MalformedResponseError extends Error {
  raw: string;

  constructor(raw: string) {
    super("AI-F-002: malformed JSON response");
    this.raw = raw;
  }
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama3-70b-8192";

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildIdempotencyKey(input: {
  submissionId: string;
  bountyId: string;
  scoringMode: string;
  cachedDiff: string;
}) {
  return createHash("sha256")
    .update(`${input.submissionId}:${input.bountyId}:${input.scoringMode}:${input.cachedDiff}`)
    .digest("hex");
}

function truncateDiff(diff: string, criteria: string) {
  const estimatedTokens = estimateTokens(diff);
  if (estimatedTokens <= 6000) {
    return { diff, truncated: false };
  }

  const keywords = criteria
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length >= 4)
    .slice(0, 30);

  const fileChunks = diff.split("diff --git ");
  const ranked = fileChunks
    .map((chunk) => {
      const lower = chunk.toLowerCase();
      const score = keywords.reduce((acc, keyword) => (lower.includes(keyword) ? acc + 1 : acc), 0);
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score);

  let current = "";
  for (const item of ranked) {
    const candidate = `${current}${current ? "\n" : ""}diff --git ${item.chunk}`;
    if (estimateTokens(candidate) > 6000) {
      break;
    }
    current = candidate;
  }

  return {
    diff: current || diff.slice(0, 24_000),
    truncated: true,
  };
}

async function callGroq(diff: string, context: ScoringContext) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("AI-F-001: GROQ_API_KEY is missing");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Score this submission. Return strict JSON with scores and flags. Penalize padding, mismatch, and abuse. Never output markdown.",
          },
          {
            role: "user",
            content: [
              `Acceptance criteria:\n${context.acceptance_criteria}`,
              `Allowed languages: ${context.allowed_languages.join(", ")}`,
              `CI status: ${context.ci_status}`,
              `Diff:\n${diff}`,
              "JSON schema: requirement_match_score, code_quality_score, ci_bonus, integrity_score, total_score, integrity_flag, language_mismatch_flag, language_detected, justification, recommendations[]",
            ].join("\n\n"),
          },
        ],
      }),
    });

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after") ?? "30";
      const retryAfter = Number(retryAfterHeader);
      throw new RateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30);
    }

    const bodyText = await response.text();

    if (response.status === 400 && bodyText.includes("context_length_exceeded")) {
      throw new ContextLengthError();
    }

    if (!response.ok) {
      throw new Error(`AI-F-001: GROQ failed (${response.status})`);
    }

    const parsedOuter = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = parsedOuter.choices?.[0]?.message?.content ?? "";
    const trimmed = content.trim();
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");

    if (first < 0 || last < first) {
      throw new MalformedResponseError(trimmed);
    }

    const jsonText = trimmed.slice(first, last + 1);

    let score: GroqScore;
    try {
      score = JSON.parse(jsonText) as GroqScore;
    } catch {
      throw new MalformedResponseError(trimmed);
    }

    return {
      score,
      raw: trimmed,
      partialScore: false,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function metadataOnlyScore(context: ScoringContext) {
  const ciBaseline = context.ci_status === "passed" ? 78 : context.ci_status === "timeout" ? 62 : 48;
  const score: GroqScore = {
    requirement_match_score: clamp(Math.round(ciBaseline * 0.35), 0, 40),
    code_quality_score: clamp(Math.round(ciBaseline * 0.3), 0, 30),
    ci_bonus: clamp(context.ci_status === "passed" ? 18 : 8, 0, 20),
    integrity_score: 5,
    total_score: 0,
    integrity_flag: false,
    language_mismatch_flag: false,
    language_detected: "unknown",
    justification: "Metadata-only fallback score because GROQ context constraints were exceeded.",
    recommendations: ["Review full diff manually to confirm quality."],
  };

  score.total_score = clamp(
    score.requirement_match_score + score.code_quality_score + score.ci_bonus + score.integrity_score,
    0,
    100,
  );

  return score;
}

function computeFinalScore(mode: ScoringContext["scoring_mode"], ciStatus: ScoringContext["ci_status"], aiTotal: number) {
  const ciScore = ciStatus === "passed" ? 100 : ciStatus === "timeout" ? 60 : 0;

  if (mode === "ai_only") {
    return clamp(Math.round(aiTotal), 0, 100);
  }
  if (mode === "ci_only") {
    return clamp(Math.round(ciScore), 0, 100);
  }
  return clamp(Math.round(aiTotal * 0.8 + ciScore * 0.2), 0, 100);
}

export const aiScoringJob = inngest.createFunction(
  {
    id: "ai-scoring",
    name: "AI Submission Scoring",
    retries: 3,
    concurrency: { limit: 10 },
    timeouts: { finish: "10m" },
  },
  { event: "submission/scoring_requested" },
  async ({ event, step }) => {
    const idempotencyKey = buildIdempotencyKey({
      submissionId: event.data.submission_id,
      bountyId: event.data.bounty_id,
      scoringMode: event.data.scoring_mode,
      cachedDiff: event.data.cached_diff,
    });

    const idempotency = await step.run("check-idempotency", async () => {
      const rows = await dbQuery<ScoringContext>(
        `
          SELECT s.id AS submission_id,
                 s.bounty_id,
                 s.freelancer_id,
                 s.ci_status,
                 s.scoring_idempotency_key,
                 s.ai_score,
                 s.final_score,
                 s.ai_scoring_attempts,
                 b.creator_id,
                 b.scoring_mode,
                 b.acceptance_criteria,
                 b.allowed_languages,
                 b.ai_score_threshold,
                 b.total_amount,
                 b.contributor_splits,
                 u.wallet_address AS freelancer_wallet
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          JOIN users u ON u.id = s.freelancer_id
          WHERE s.id = $1
            AND b.id = $2
          LIMIT 1
        `,
        [event.data.submission_id, event.data.bounty_id],
      );

      if ((rows.rowCount ?? 0) === 0) {
        throw new Error("AI-F-404: submission context not found");
      }

      const context = rows.rows[0];
      if (context.scoring_idempotency_key === idempotencyKey && context.ai_score !== null) {
        return {
          skip: true,
          context,
        };
      }

      await dbQuery(
        `
          UPDATE submissions
          SET scoring_idempotency_key = $1,
              ai_scoring_in_progress = TRUE,
              ai_scoring_status = 'in_progress',
              ai_scoring_attempts = ai_scoring_attempts + 1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [idempotencyKey, event.data.submission_id],
      );

      return {
        skip: false,
        context,
      };
    });

    if (idempotency.skip) {
      return {
        skipped: true,
        ai_score: idempotency.context.ai_score,
        final_score: idempotency.context.final_score,
      };
    }

    const context = await step.run("load-context", async () => {
      const rows = await dbQuery<ScoringContext>(
        `
          SELECT s.id AS submission_id,
                 s.bounty_id,
                 s.freelancer_id,
                 s.ci_status,
                 s.scoring_idempotency_key,
                 s.ai_score,
                 s.final_score,
                 s.ai_scoring_attempts,
                 b.creator_id,
                 b.scoring_mode,
                 b.acceptance_criteria,
                 b.allowed_languages,
                 b.ai_score_threshold,
                 b.total_amount,
                 b.contributor_splits,
                 u.wallet_address AS freelancer_wallet
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          JOIN users u ON u.id = s.freelancer_id
          WHERE s.id = $1
            AND b.id = $2
          LIMIT 1
        `,
        [event.data.submission_id, event.data.bounty_id],
      );

      if ((rows.rowCount ?? 0) === 0) {
        throw new Error("AI-F-404: scoring context missing");
      }

      return rows.rows[0];
    });

    const diffValidation = await step.run("validate-diff-size", async () => {
      const reduced = truncateDiff(event.data.cached_diff, context.acceptance_criteria ?? "");
      if (reduced.truncated) {
        await dbQuery(
          `
            UPDATE submissions
            SET ai_score_raw = COALESCE(ai_score_raw, '{}'::jsonb) || $1::jsonb,
                updated_at = NOW()
            WHERE id = $2
          `,
          [JSON.stringify({ truncation_applied: true, original_tokens: estimateTokens(event.data.cached_diff) }), context.submission_id],
        );
      }
      return reduced;
    });

    let aiResult: { score: GroqScore; raw: string; partialScore: boolean };

    try {
      aiResult = await step.run("call-groq", async () => {
        return callGroq(diffValidation.diff, context);
      });
    } catch (error) {
      if (error instanceof RateLimitError) {
        await step.sleep("groq-rate-limit", `${error.retryAfterSeconds}s`);
        aiResult = await step.run("call-groq-after-rate-limit", async () => {
          return callGroq(diffValidation.diff, context);
        });
      } else if (error instanceof ContextLengthError) {
        const halfDiff = diffValidation.diff.slice(0, Math.floor(diffValidation.diff.length / 2));
        try {
          aiResult = await step.run("call-groq-after-context-trim", async () => {
            return callGroq(halfDiff, context);
          });
        } catch {
          aiResult = await step.run("metadata-only-fallback-score", async () => {
            return {
              score: metadataOnlyScore(context),
              raw: "metadata-only",
              partialScore: true,
            };
          });
        }
      } else if (error instanceof TimeoutError) {
        await step.run("mark-scoring-timeout", async () => {
          await dbQuery(
            `
              UPDATE submissions
              SET ai_scoring_status = 'timeout',
                  ai_scoring_in_progress = FALSE,
                  ai_score_raw = COALESCE(ai_score_raw, '{}'::jsonb) || $1::jsonb,
                  updated_at = NOW()
              WHERE id = $2
            `,
            [JSON.stringify({ code: "AI-F-006", timeout: true }), context.submission_id],
          );
        });

        await step.sendEvent("requeue-after-timeout", {
          name: "submission/scoring_requested",
          data: {
            submission_id: context.submission_id,
            bounty_id: context.bounty_id,
            scoring_mode: context.scoring_mode,
            cached_diff: diffValidation.diff,
          },
        });

        return {
          state: "timeout_requeued",
        };
      } else if (error instanceof MalformedResponseError) {
        await step.run("store-malformed-response", async () => {
          await dbQuery(
            `
              UPDATE submissions
              SET ai_scoring_status = 'parse_failed',
                  ai_scoring_in_progress = FALSE,
                  ai_score_raw = COALESCE(ai_score_raw, '{}'::jsonb) || $1::jsonb,
                  updated_at = NOW()
              WHERE id = $2
            `,
            [JSON.stringify({ code: "AI-F-002", raw: error.raw }), context.submission_id],
          );
        });

        if (context.ai_scoring_attempts < 3) {
          await step.sendEvent("requeue-after-parse-failure", {
            name: "submission/scoring_requested",
            data: {
              submission_id: context.submission_id,
              bounty_id: context.bounty_id,
              scoring_mode: context.scoring_mode,
              cached_diff: diffValidation.diff,
            },
          });
          return {
            state: "parse_failure_requeued",
          };
        }

        await step.run("set-manual-review-after-parse-failure", async () => {
          await dbQuery(
            `
              UPDATE submissions
              SET ai_scoring_status = 'manual_review',
                  ai_scoring_in_progress = FALSE,
                  status = 'disputed',
                  updated_at = NOW()
              WHERE id = $1
            `,
            [context.submission_id],
          );
        });

        return {
          state: "manual_review",
        };
      } else {
        throw error;
      }
    }

    const stored = await step.run("validate-and-store-score", async () => {
      const score = aiResult.score;
      const allowed = (context.allowed_languages ?? []).map((entry) => entry.toLowerCase());
      const languageMismatch =
        Boolean(score.language_mismatch_flag) &&
        Boolean(score.language_detected) &&
        !allowed.includes(score.language_detected.toLowerCase());

      const finalScore = computeFinalScore(context.scoring_mode, context.ci_status, score.total_score);

      await dbQuery(
        `
          UPDATE submissions
          SET ai_score = $1,
              final_score = $2,
              ai_integrity_flag = $3,
              ai_language_mismatch_flag = $4,
              ai_score_raw = COALESCE(ai_score_raw, '{}'::jsonb) || $5::jsonb,
              ai_scoring_in_progress = FALSE,
              ai_scoring_status = 'completed',
              score_finalized_at = NOW(),
              status = CASE WHEN $2 >= $6 AND NOT $3 THEN 'passed' ELSE 'failed' END,
              updated_at = NOW()
          WHERE id = $7
        `,
        [
          score.total_score,
          finalScore,
          Boolean(score.integrity_flag),
          languageMismatch,
          JSON.stringify({
            groq_raw: aiResult.raw,
            partial_score_flag: aiResult.partialScore,
            justification: asString(score.justification),
            recommendations: Array.isArray(score.recommendations) ? score.recommendations : [],
          }),
          context.ai_score_threshold,
          context.submission_id,
        ],
      );

      return {
        finalScore,
        languageMismatch,
        integrityFlag: Boolean(score.integrity_flag),
      };
    });

    const passed = stored.finalScore >= context.ai_score_threshold;

    await step.run("emit-realtime-score", async () => {
      emitToBounty(context.bounty_id, "bounty:scored", {
        bounty_id: context.bounty_id,
        submission_id: context.submission_id,
        final_score: stored.finalScore,
        passed_threshold: passed,
        integrity_flag: stored.integrityFlag,
      });
    });

    if (passed && !stored.integrityFlag) {
      const totalAmount = Number(context.total_amount);
      const splitMap = Array.isArray(context.contributor_splits)
        ? context.contributor_splits
            .map((item) => {
              const wallet = typeof item.wallet_address === "string" ? item.wallet_address : null;
              const amount = typeof item.amount === "number" ? item.amount : null;
              return wallet && amount ? { wallet, amount } : null;
            })
            .filter((item): item is { wallet: string; amount: number } => item !== null)
        : [];

      await step.sendEvent("trigger-payout", {
        name: "payout/release_requested",
        data: {
          submission_id: context.submission_id,
          bounty_id: context.bounty_id,
          freelancer_wallet: context.freelancer_wallet,
          amount_micro_algo: Number.isFinite(totalAmount) ? totalAmount : 0,
          is_split: splitMap.length > 0,
          split_map: splitMap.length > 0 ? splitMap : undefined,
        },
      });
    }

    await step.sendEvent("notify-freelancer-score", {
      name: "notification/send",
      data: {
        user_id: context.freelancer_id,
        event_type: "submission_scored",
        channels: ["in_app"],
        payload: {
          submission_id: context.submission_id,
          bounty_id: context.bounty_id,
          final_score: stored.finalScore,
          passed_threshold: passed,
          integrity_flag: stored.integrityFlag,
        },
      },
    });

    await step.sendEvent("notify-client-score", {
      name: "notification/send",
      data: {
        user_id: context.creator_id,
        event_type: "submission_scored",
        channels: ["in_app"],
        payload: {
          submission_id: context.submission_id,
          bounty_id: context.bounty_id,
          final_score: stored.finalScore,
          passed_threshold: passed,
          integrity_flag: stored.integrityFlag,
        },
      },
    });

    if (stored.integrityFlag) {
      await createInAppNotification(context.creator_id, "submission_integrity_hold", {
        submission_id: context.submission_id,
        bounty_id: context.bounty_id,
        code: "AI-F-004",
      });
    }

    return {
      state: passed ? "passed" : "failed",
      final_score: stored.finalScore,
      integrity_flag: stored.integrityFlag,
    };
  },
);
