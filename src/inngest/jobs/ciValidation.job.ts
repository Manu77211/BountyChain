import { dbQuery } from "../../../lib/db/client";
import { parseGitHubRepo } from "../../services/wallet";
import { inngest } from "../client";
import { asNumber, asString, createInAppNotification } from "../shared";

interface SubmissionContextRow {
  id: string;
  bounty_id: string;
  freelancer_id: string;
  github_pr_url: string;
  github_repo_id: string;
  ci_status: string;
  status: string;
  ci_retrigger_count: number;
  creator_id: string;
  repo_url: string;
  scoring_mode: "ai_only" | "ci_only" | "hybrid";
}

interface GitHubRunResult {
  conclusion: "success" | "failure" | "timed_out" | "skipped" | "cancelled" | "unknown";
  status: string;
  repositoryId: string | null;
  rateLimitRemaining: number;
  rateLimitResetAt: number | null;
}

const TERMINAL_CI_STATUSES = new Set(["passed", "failed", "timeout", "skipped_abuse"]);

function parsePrNumber(url: string) {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function mapConclusion(status: string, conclusion: string | null | undefined): GitHubRunResult["conclusion"] {
  if (status !== "completed") {
    return "unknown";
  }
  if (conclusion === "success") {
    return "success";
  }
  if (conclusion === "timed_out") {
    return "timed_out";
  }
  if (conclusion === "failure") {
    return "failure";
  }
  if (conclusion === "skipped" || conclusion === "neutral") {
    return "skipped";
  }
  if (conclusion === "cancelled") {
    return "cancelled";
  }
  return "unknown";
}

async function fetchGitHubRun(repoUrl: string, runId: string): Promise<GitHubRunResult> {
  const repo = parseGitHubRepo(repoUrl);
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token || !runId) {
    return {
      conclusion: "unknown",
      status: "unknown",
      repositoryId: null,
      rateLimitRemaining: 999,
      rateLimitResetAt: null,
    };
  }

  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const remaining = asNumber(Number(response.headers.get("x-ratelimit-remaining") ?? "999"), 999);
  const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? "0");

  if (!response.ok) {
    return {
      conclusion: "unknown",
      status: "unknown",
      repositoryId: null,
      rateLimitRemaining: remaining,
      rateLimitResetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt * 1000 : null,
    };
  }

  const body = (await response.json()) as {
    status?: string;
    conclusion?: string | null;
    repository?: { id?: number };
  };

  return {
    conclusion: mapConclusion(asString(body.status), body.conclusion),
    status: asString(body.status, "unknown"),
    repositoryId: body.repository?.id ? String(body.repository.id) : null,
    rateLimitRemaining: remaining,
    rateLimitResetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt * 1000 : null,
  };
}

async function fetchPrEvidence(repoUrl: string, prUrl: string) {
  const repo = parseGitHubRepo(repoUrl);
  const token = process.env.GITHUB_TOKEN;
  const prNumber = parsePrNumber(prUrl);
  if (!repo || !token || !prNumber) {
    return { diff: "", title: "", filesChanged: 0, source: "cache" as const, baseRepoId: null as string | null };
  }

  const [prResponse, diffResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),
    fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`, {
      headers: {
        Accept: "application/vnd.github.v3.diff",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),
  ]);

  if (!prResponse.ok) {
    return { diff: "", title: "", filesChanged: 0, source: "cache" as const, baseRepoId: null as string | null };
  }

  const prBody = (await prResponse.json()) as {
    title?: string;
    changed_files?: number;
    base?: { repo?: { id?: number } };
  };

  const diff = diffResponse.ok ? await diffResponse.text() : "";

  return {
    diff,
    title: asString(prBody.title),
    filesChanged: asNumber(prBody.changed_files, 0),
    source: diff ? ("live" as const) : ("cache" as const),
    baseRepoId: prBody.base?.repo?.id ? String(prBody.base.repo.id) : null,
  };
}

export const ciValidationJob = inngest.createFunction(
  {
    id: "ci-validation",
    name: "CI/CD Validation Pipeline",
    retries: 3,
    concurrency: { limit: 20 },
    timeouts: { finish: "45m" },
  },
  { event: "submission/ci_completed" },
  async ({ event, step, logger }) => {
    const submissionId = event.data.submission_id;

    const context = await step.run("load-submission-context", async () => {
      const rows = await dbQuery<SubmissionContextRow>(
        `
          SELECT s.id,
                 s.bounty_id,
                 s.freelancer_id,
                 s.github_pr_url,
                 s.github_repo_id,
                 s.ci_status,
                 s.status,
                 s.ci_retrigger_count,
                 b.creator_id,
                 b.repo_url,
                 b.scoring_mode
          FROM submissions s
          JOIN bounties b ON b.id = s.bounty_id
          WHERE s.id = $1
          LIMIT 1
        `,
        [submissionId],
      );

      if ((rows.rowCount ?? 0) === 0) {
        throw new Error("GH-F-404: submission not found");
      }

      return rows.rows[0];
    });

    const already = await step.run("check-idempotency", async () => {
      if (TERMINAL_CI_STATUSES.has(context.ci_status) || ["passed", "failed"].includes(context.status)) {
        return { skip: true };
      }
      return { skip: false };
    });

    if (already.skip) {
      return { skipped: true };
    }

    let ciResult = await step.run("fetch-ci-result", async () => {
      return fetchGitHubRun(context.repo_url, event.data.run_id);
    });

    if (ciResult.rateLimitRemaining < 100 && ciResult.rateLimitResetAt) {
      await step.sleepUntil("wait-for-rate-limit", new Date(ciResult.rateLimitResetAt));
      ciResult = await step.run("fetch-ci-result-after-rate-limit", async () => {
        return fetchGitHubRun(context.repo_url, event.data.run_id);
      });
    }

    const integrity = await step.run("check-test-integrity", async () => {
      const skippedCount = Math.max(0, event.data.skipped_count);
      const totalCount = Math.max(0, event.data.total_count);
      const ratio = totalCount === 0 ? 0 : skippedCount / totalCount;

      await dbQuery(
        `
          UPDATE submissions
          SET skipped_test_count = $1,
              total_test_count = $2,
              updated_at = NOW()
          WHERE id = $3
        `,
        [skippedCount, totalCount, submissionId],
      );

      return {
        abused: ratio > 0.2,
        ratio,
      };
    });

    const evidence = await step.run("cache-evidence", async () => {
      const live = await fetchPrEvidence(context.repo_url, context.github_pr_url);
      if (live.diff) {
        await dbQuery(
          `
            UPDATE submissions
            SET ai_score_raw = COALESCE(ai_score_raw, '{}'::jsonb) || $1::jsonb,
                evidence_source = 'live',
                updated_at = NOW()
            WHERE id = $2
          `,
          [
            JSON.stringify({
              cached_diff: live.diff,
              pr_title: live.title,
              files_changed: live.filesChanged,
            }),
            submissionId,
          ],
        );
        return live;
      }

      const fallback = await dbQuery<{ ai_score_raw: Record<string, unknown> | null }>(
        "SELECT ai_score_raw FROM submissions WHERE id = $1 LIMIT 1",
        [submissionId],
      );
      const cached = asString(fallback.rows[0]?.ai_score_raw?.cached_diff);

      await dbQuery(
        "UPDATE submissions SET evidence_source = 'cache', updated_at = NOW() WHERE id = $1",
        [submissionId],
      );

      return {
        ...live,
        diff: cached,
      };
    });

    const repoCheck = await step.run("verify-repo-match", async () => {
      if (!evidence.baseRepoId) {
        return { rejectedFork: false };
      }

      if (evidence.baseRepoId !== context.github_repo_id) {
        await dbQuery(
          `
            UPDATE submissions
            SET ci_status = 'failed',
                status = 'failed',
                ai_score_raw = COALESCE(ai_score_raw, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
            WHERE id = $1
          `,
          [
            submissionId,
            JSON.stringify({ rejected_fork: true, code: "GH-F-008" }),
          ],
        );

        await step.sendEvent("notify-rejected-fork", {
          name: "notification/send",
          data: {
            user_id: context.freelancer_id,
            event_type: "submission_rejected_fork",
            channels: ["in_app"],
            payload: {
              submission_id: submissionId,
              bounty_id: context.bounty_id,
              code: "GH-F-008",
            },
          },
        });

        return { rejectedFork: true };
      }

      return { rejectedFork: false };
    });

    await step.run("multi-contributor-isolation", async () => {
      const contributors = await dbQuery<{ count: string }>(
        `
          SELECT COUNT(DISTINCT freelancer_id)::text AS count
          FROM submissions
          WHERE bounty_id = $1
            AND status IN ('submitted', 'validating', 'awaiting_ci')
        `,
        [context.bounty_id],
      );

      logger.info?.({
        event_type: "ci_multi_contributor_check",
        bounty_id: context.bounty_id,
        contributor_count: Number(contributors.rows[0]?.count ?? "0"),
      });
    });

    const statusFromEvent = event.data.ci_status;
    const finalCiStatus =
      ciResult.conclusion === "success"
        ? "passed"
        : ciResult.conclusion === "timed_out"
          ? "timeout"
          : ciResult.conclusion === "skipped"
            ? "skipped_abuse"
            : statusFromEvent;

    await step.run("persist-ci-state", async () => {
      const status = finalCiStatus === "passed" ? "validating" : "failed";
      await dbQuery(
        `
          UPDATE submissions
          SET ci_status = $1,
              ci_run_id = $2,
              status = $3,
              updated_at = NOW()
          WHERE id = $4
        `,
        [finalCiStatus, event.data.run_id, status, submissionId],
      );

      if (finalCiStatus === "timeout") {
        await dbQuery(
          `
            UPDATE submissions
            SET ci_retrigger_count = ci_retrigger_count + 1,
                updated_at = NOW()
            WHERE id = $1
          `,
          [submissionId],
        );
      }
    });

    if (finalCiStatus === "passed" && !integrity.abused && !repoCheck.rejectedFork) {
      await step.sendEvent("trigger-ai-scoring", {
        name: "submission/scoring_requested",
        data: {
          submission_id: submissionId,
          bounty_id: context.bounty_id,
          scoring_mode: context.scoring_mode,
          cached_diff: evidence.diff,
        },
      });

      return {
        state: "queued_ai_scoring",
      };
    }

    await step.run("notify-ci-failure", async () => {
      const detail = {
        submission_id: submissionId,
        bounty_id: context.bounty_id,
        ci_status: finalCiStatus,
        integrity_abuse: integrity.abused,
        code: finalCiStatus === "timeout" ? "GH-F-003" : "GH-F-004",
      };

      await createInAppNotification(context.freelancer_id, "submission_ci_failed", detail);
      await createInAppNotification(context.creator_id, "submission_ci_failed", detail);
    });

    return {
      state: "failed_ci",
      ci_status: finalCiStatus,
    };
  },
);
