import { createHash } from "node:crypto";
import { dbQuery } from "../../lib/db/client";
import type { CiStatus, ScoringMode } from "../../lib/db/types";
import { parseGitHubRepo } from "./wallet";

export interface ValidationDispatcher {
  send: (eventName: string, data: Record<string, unknown>) => Promise<void>;
}

interface ValidationContext {
  submission: {
    id: string;
    bounty_id: string;
    freelancer_id: string;
    github_branch: string;
    head_sha: string | null;
    ci_status: CiStatus;
    ci_run_id: string | null;
  };
  bounty: {
    id: string;
    creator_id: string;
    repo_url: string;
    scoring_mode: ScoringMode;
  };
}

interface WorkflowStatusResult {
  ciStatus: CiStatus;
  runId: string | null;
  source: "live" | "cache";
}

interface GitHubWorkflowRunPayload {
  repository?: { id?: number };
  workflow_run?: {
    id?: number;
    status?: string;
    conclusion?: string | null;
    head_branch?: string | null;
    head_sha?: string | null;
  };
}

export async function processCiValidationJob(
  input: { submission_id: string },
  dispatcher: ValidationDispatcher,
) {
  const context = await getValidationContext(input.submission_id);
  if (!context) {
    throw new Error("CI-V-404: submission not found");
  }

  if (context.bounty.scoring_mode === "ai_only") {
    await dbQuery(
      `
        UPDATE submissions
        SET ci_status = 'ci_not_found',
            status = CASE WHEN status = 'draft' THEN 'validating' ELSE status END,
            evidence_source = 'cache'
        WHERE id = $1
      `,
      [context.submission.id],
    );

    await emitAiScoringRequested(context, "ci_not_found", context.submission.ci_run_id, dispatcher);
    return { state: "queued_ai", ci_status: "ci_not_found" as const };
  }

  const workflow = await fetchWorkflowStatus(context);
  await persistCiStatus(context, workflow);

  if (workflow.ciStatus === "passed") {
    await emitAiScoringRequested(context, workflow.ciStatus, workflow.runId, dispatcher);
    return { state: "queued_ai", ci_status: workflow.ciStatus };
  }

  if (workflow.ciStatus === "running" || workflow.ciStatus === "pending") {
    return { state: "awaiting_ci", ci_status: workflow.ciStatus };
  }

  await notifyCiFailure(context, workflow.ciStatus);
  return { state: "ci_failed", ci_status: workflow.ciStatus };
}

export async function queueCiValidationFromWorkflowWebhook(
  payload: GitHubWorkflowRunPayload,
  dispatcher: ValidationDispatcher,
  deliveryId: string,
) {
  const repositoryId = payload.repository?.id;
  const branch = payload.workflow_run?.head_branch ?? null;
  const headSha = payload.workflow_run?.head_sha ?? null;

  if (!repositoryId || !branch) {
    return { queued: false, reason: "missing_repository_or_branch" };
  }

  const target = await dbQuery<{ id: string }>(
    `
      SELECT s.id
      FROM submissions s
      WHERE s.github_repo_id = $1::bigint
        AND s.github_branch = $2
        AND ($3::text IS NULL OR s.head_sha = $3 OR s.head_sha IS NULL)
        AND s.status IN ('submitted', 'awaiting_ci', 'validating', 'failed')
      ORDER BY s.updated_at DESC
      LIMIT 1
    `,
    [String(repositoryId), branch, headSha],
  );

  if (target.rowCount === 0) {
    return { queued: false, reason: "submission_not_found" };
  }

  await dispatcher.send("ci_validation/requested", {
    submission_id: target.rows[0].id,
    delivery_id: deliveryId,
  });

  return { queued: true, submission_id: target.rows[0].id };
}

async function getValidationContext(submissionId: string): Promise<ValidationContext | null> {
  const result = await dbQuery<{
    submission_id: string;
    bounty_id: string;
    freelancer_id: string;
    github_branch: string;
    head_sha: string | null;
    ci_status: CiStatus;
    ci_run_id: string | null;
    creator_id: string;
    repo_url: string;
    scoring_mode: ScoringMode;
  }>(
    `
      SELECT s.id AS submission_id,
             s.bounty_id,
             s.freelancer_id,
             s.github_branch,
             s.head_sha,
             s.ci_status,
             s.ci_run_id,
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

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    submission: {
      id: row.submission_id,
      bounty_id: row.bounty_id,
      freelancer_id: row.freelancer_id,
      github_branch: row.github_branch,
      head_sha: row.head_sha,
      ci_status: row.ci_status,
      ci_run_id: row.ci_run_id,
    },
    bounty: {
      id: row.bounty_id,
      creator_id: row.creator_id,
      repo_url: row.repo_url,
      scoring_mode: row.scoring_mode,
    },
  };
}

async function fetchWorkflowStatus(context: ValidationContext): Promise<WorkflowStatusResult> {
  const repo = parseGitHubRepo(context.bounty.repo_url);
  if (!repo) {
    return { ciStatus: "ci_not_found", runId: null, source: "cache" };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ciStatus: "ci_not_found", runId: null, source: "cache" };
  }

  const endpoint = buildWorkflowRunsEndpoint(repo.owner, repo.repo, context.submission.github_branch);
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    return { ciStatus: "ci_not_found", runId: null, source: "cache" };
  }

  const body = (await response.json()) as {
    workflow_runs?: Array<{ id: number; status: string; conclusion: string | null; head_sha: string }>;
  };

  const candidate = selectWorkflowRun(body.workflow_runs ?? [], context.submission.head_sha);
  if (!candidate) {
    return { ciStatus: "ci_not_found", runId: null, source: "cache" };
  }

  return {
    ciStatus: mapWorkflowToCiStatus(candidate.status, candidate.conclusion),
    runId: String(candidate.id),
    source: "live",
  };
}

function buildWorkflowRunsEndpoint(owner: string, repo: string, branch: string) {
  const encodedBranch = encodeURIComponent(branch);
  return `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=10&branch=${encodedBranch}`;
}

function selectWorkflowRun(
  runs: Array<{ id: number; status: string; conclusion: string | null; head_sha: string }>,
  headSha: string | null,
) {
  if (headSha) {
    const exact = runs.find((run) => run.head_sha === headSha);
    if (exact) {
      return exact;
    }
  }
  return runs[0] ?? null;
}

function mapWorkflowToCiStatus(status: string, conclusion: string | null): CiStatus {
  if (status === "queued" || status === "waiting") {
    return "pending";
  }
  if (status === "in_progress" || status === "requested") {
    return "running";
  }
  if (status !== "completed") {
    return "pending";
  }
  if (conclusion === "success") {
    return "passed";
  }
  if (conclusion === "timed_out") {
    return "timeout";
  }
  if (conclusion === "skipped" || conclusion === "neutral") {
    return "skipped_abuse";
  }
  return "failed";
}

async function persistCiStatus(context: ValidationContext, workflow: WorkflowStatusResult) {
  const submissionStatus = resolveSubmissionStatusForCi(workflow.ciStatus);
  await dbQuery(
    `
      UPDATE submissions
      SET ci_status = $1,
          ci_run_id = COALESCE($2, ci_run_id),
          evidence_source = $3,
          status = $4,
          updated_at = NOW()
      WHERE id = $5
    `,
    [workflow.ciStatus, workflow.runId, workflow.source, submissionStatus, context.submission.id],
  );
}

function resolveSubmissionStatusForCi(ciStatus: CiStatus) {
  if (ciStatus === "passed") {
    return "validating";
  }
  if (ciStatus === "running" || ciStatus === "pending") {
    return "awaiting_ci";
  }
  return "failed";
}

async function emitAiScoringRequested(
  context: ValidationContext,
  ciStatus: CiStatus,
  ciRunId: string | null,
  dispatcher: ValidationDispatcher,
) {
  const eventHash = createHash("sha256")
    .update(`${context.submission.id}:${context.bounty.id}:${ciStatus}:${ciRunId ?? "none"}`)
    .digest("hex");

  await dispatcher.send("ai_scoring/requested", {
    submission_id: context.submission.id,
    bounty_id: context.bounty.id,
    cached_diff: "",
    ci_status: ciStatus,
    scoring_mode: context.bounty.scoring_mode,
    event_hash: eventHash,
  });
}

async function notifyCiFailure(context: ValidationContext, ciStatus: CiStatus) {
  const detail = `CI validation failed with status ${ciStatus}`;
  const recipients = [context.submission.freelancer_id, context.bounty.creator_id];

  for (const userId of recipients) {
    await dbQuery(
      `
        INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
        VALUES ($1, 'in_app', 'ci_validation_failed', $2::jsonb, FALSE, 0)
      `,
      [
        userId,
        JSON.stringify({
          submission_id: context.submission.id,
          bounty_id: context.bounty.id,
          detail,
        }),
      ],
    );
  }
}
