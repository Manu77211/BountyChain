import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { dbQuery } from "../../lib/db/client";
import type { UserRole } from "../../lib/db/types";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { emitToBounty } from "../realtime/socket";
import { validateBody, validateParams, validateQuery } from "../middleware/validate";
import { buildSubmissionFeedbackReport } from "../services/submissionFeedback.service";

const router = Router();

const projectIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const milestoneParamsSchema = z.object({
  id: z.string().uuid(),
  milestoneId: z.string().uuid(),
});

const createProjectSchema = z.object({
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(10).max(5000),
  acceptanceCriteria: z.string().trim().min(3).max(5000),
  requiredSkills: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  totalAmountMicroAlgo: z.coerce.number().int().positive(),
  deadline: z.coerce.date(),
  workType: z.enum(["STRUCTURED", "CREATIVE"]).optional(),
});

const applySchema = z.object({
  message: z.string().trim().max(2000).optional(),
  proposedAmount: z.coerce.number().positive().optional(),
  estimatedDays: z.coerce.number().int().positive().optional(),
  deliverables: z.string().trim().max(5000).optional(),
});

const assignSchema = z.object({
  freelancerId: z.string().uuid(),
});

const selectApplicantSchema = z.object({
  applicationId: z.string().uuid(),
});

const milestoneSubmissionSchema = z.object({
  kind: z.enum(["DRAFT", "FINAL"]).optional(),
  fileUrl: z.string().url().optional(),
  notes: z.string().trim().max(5000).optional(),
});

const createMeetingSchema = z.object({
  title: z.string().trim().min(3).max(160),
  agenda: z.string().trim().max(4000).optional(),
  scheduledFor: z.coerce.date(),
});

const projectMessagesQuerySchema = z.object({
  applicationId: z.string().uuid().optional(),
});

type ProjectListRow = {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  allowed_languages: string[];
  total_amount: string;
  deadline: string;
  scoring_mode: string;
  status: string;
  client_id: string;
  client_name: string;
  client_wallet_address: string;
  client_trust_score: number;
  freelancer_id: string | null;
  freelancer_name: string | null;
  application_count: number;
  my_application_id: string | null;
  my_application_status: string | null;
  can_apply: boolean;
  milestones: Array<{ id: string; status: string; amount: number }> | null;
  applicants_preview: Array<{ freelancer_name: string; status: string }> | null;
};

type ProjectDetailRow = {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  allowed_languages: string[];
  total_amount: string;
  deadline: string;
  scoring_mode: string;
  status: string;
  creator_id: string;
  client_name: string;
  client_wallet_address: string;
  client_trust_score: number;
  freelancer_id: string | null;
  freelancer_name: string | null;
  draft_approved: boolean;
  milestones: Array<{ id: string; title: string; status: string; amount: number }> | null;
  latest_submission_id: string | null;
  latest_submission_status: string | null;
  latest_submission_stage: string | null;
  latest_submission_gate_status: string | null;
  latest_submission_file_url: string | null;
  latest_submission_client_rating: number | null;
  latest_submission_client_comment: string | null;
  latest_feedback_client_summary: string | null;
  latest_feedback_freelancer_summary: string | null;
  latest_feedback_implemented_items: unknown;
  latest_feedback_missing_items: unknown;
  validation_reports: Array<{
    aiScore: number | null;
    clientRating: number | null;
    finalScore: number | null;
    decision: string;
  }> | null;
  applicants_preview: Array<{ freelancer_name: string; status: string }> | null;
};

type ApplicantRow = {
  id: string;
  status: string;
  message: string | null;
  proposed_amount: string | null;
  estimated_days: number | null;
  deliverables: string | null;
  freelancer_id: string;
  freelancer_name: string;
  freelancer_rating: number;
  freelancer_trust_score: number;
};

type ProjectMessageRow = {
  id: string;
  bounty_id: string;
  application_id: string | null;
  scope: string;
  sender_id: string;
  content: string;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  file_type: string | null;
  created_at: string;
  sender_name: string;
  sender_role: string;
};

type ProjectMeetingRow = {
  id: string;
  bounty_id: string;
  title: string;
  agenda: string | null;
  meeting_url: string;
  scheduled_for: string;
  created_at: string;
  scheduled_by_name: string;
};

function requireUser(request: Parameters<typeof requireAuth>[0]) {
  if (!request.user) {
    throw new AppError(401, 401, "Unauthorized");
  }
  return request.user;
}

function toChatRole(role: string): "CLIENT" | "FREELANCER" {
  return role === "client" ? "CLIENT" : "FREELANCER";
}

function mapListRow(row: ProjectListRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status.toUpperCase(),
    client: {
      id: row.client_id,
      name: row.client_name,
      walletAddress: row.client_wallet_address,
      trustScore: row.client_trust_score,
    },
    freelancer: row.freelancer_id
      ? {
          id: row.freelancer_id,
          name: row.freelancer_name ?? "Unknown",
        }
      : null,
    criteria: {
      acceptanceCriteria: row.acceptance_criteria,
      requiredSkills: row.allowed_languages ?? [],
      totalAmountMicroAlgo: Number(row.total_amount ?? "0"),
      deadline: row.deadline,
      scoringMode: row.scoring_mode,
    },
    milestones: row.milestones ?? [],
    applications: row.my_application_id
      ? [
          {
            id: row.my_application_id,
            status: String(row.my_application_status ?? "pending").toUpperCase(),
          },
        ]
      : [],
    myApplicationStatus: row.my_application_status ? String(row.my_application_status).toUpperCase() : null,
    canApply: Boolean(row.can_apply),
    _count: {
      applications: Number(row.application_count ?? 0),
    },
    applicantsPreview: row.applicants_preview ?? [],
  };
}

function mapMeetingRow(row: ProjectMeetingRow) {
  return {
    id: row.id,
    projectId: row.bounty_id,
    title: row.title,
    agenda: row.agenda,
    meetingUrl: row.meeting_url,
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at,
    scheduledBy: row.scheduled_by_name,
  };
}

function getAppBaseUrl() {
  const candidate = process.env.NEXT_PUBLIC_APP_URL ?? process.env.FRONTEND_URL ?? "http://localhost:3000";
  return candidate.replace(/\/+$/, "");
}

function mapMessageRow(row: ProjectMessageRow) {
  return {
    id: row.id,
    projectId: row.bounty_id,
    applicationId: row.application_id,
    scope: String(row.scope).toUpperCase(),
    senderId: row.sender_id,
    content: row.content,
    fileUrl: row.file_url,
    attachment: row.file_name || row.file_size !== null || row.file_type
      ? {
          name: row.file_name,
          size: row.file_size,
          type: row.file_type,
        }
      : null,
    createdAt: row.created_at,
    sender: {
      id: row.sender_id,
      name: row.sender_name,
      role: toChatRole(row.sender_role),
    },
  };
}

async function canAccessProject(userId: string, role: UserRole, projectId: string) {
  if (role === "admin") {
    return true;
  }

  const access = await dbQuery<{ id: string }>(
    `
      SELECT b.id
      FROM bounties b
      WHERE b.id = $1
        AND b.deleted_at IS NULL
        AND (
          b.creator_id = $2
          OR EXISTS (
            SELECT 1
            FROM submissions s
            WHERE s.bounty_id = b.id
              AND s.freelancer_id = $2
          )
          OR EXISTS (
            SELECT 1
            FROM project_applications pa
            WHERE pa.bounty_id = b.id
              AND pa.freelancer_id = $2
              AND pa.status = 'selected'
          )
        )
      LIMIT 1
    `,
    [projectId, userId],
  );

  return (access.rowCount ?? 0) > 0;
}

async function canAccessApplicationConversation(
  userId: string,
  role: UserRole,
  projectId: string,
  applicationId: string,
) {
  if (role === "admin") {
    return true;
  }

  const access = await dbQuery<{ id: string }>(
    `
      SELECT pa.id
      FROM project_applications pa
      JOIN bounties b ON b.id = pa.bounty_id
      WHERE pa.id = $1
        AND pa.bounty_id = $2
        AND b.deleted_at IS NULL
        AND (
          b.creator_id = $3
          OR pa.freelancer_id = $3
        )
      LIMIT 1
    `,
    [applicationId, projectId, userId],
  );

  return (access.rowCount ?? 0) > 0;
}

async function assertCreator(userId: string, role: UserRole, projectId: string) {
  if (role === "admin") {
    return;
  }

  const creatorCheck = await dbQuery<{ id: string }>(
    `
      SELECT id
      FROM bounties
      WHERE id = $1
        AND creator_id = $2
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [projectId, userId],
  );

  if ((creatorCheck.rowCount ?? 0) === 0) {
    throw new AppError(403, 403, "Only the bounty creator can perform this action");
  }
}

async function assertParticipant(userId: string, role: UserRole, projectId: string) {
  const allowed = await canAccessProject(userId, role, projectId);
  if (!allowed) {
    throw new AppError(403, 403, "Only project participants can perform this action");
  }
}

async function hasSelectedFreelancer(projectId: string) {
  const selected = await dbQuery<{ freelancer_id: string }>(
    `
      SELECT freelancer_id
      FROM project_applications
      WHERE bounty_id = $1
        AND status = 'selected'
      LIMIT 1
    `,
    [projectId],
  );
  return (selected.rowCount ?? 0) > 0;
}

async function canAccessBountyConversation(userId: string, role: UserRole, projectId: string) {
  if (role === "admin") {
    return true;
  }

  const access = await dbQuery<{ id: string }>(
    `
      SELECT b.id
      FROM bounties b
      JOIN project_applications pa
        ON pa.bounty_id = b.id
       AND pa.status = 'selected'
      WHERE b.id = $1
        AND b.deleted_at IS NULL
        AND (
          ($3 = 'client' AND b.creator_id = $2)
          OR ($3 = 'freelancer' AND pa.freelancer_id = $2)
        )
      LIMIT 1
    `,
    [projectId, userId, role],
  );

  return (access.rowCount ?? 0) > 0;
}

function projectSelectSql() {
  return `
    SELECT b.id,
           b.title,
           b.description,
           b.acceptance_criteria,
           b.allowed_languages,
           b.total_amount::text,
           b.deadline::text,
           b.scoring_mode,
           b.status,
           c.id AS client_id,
           COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), c.wallet_address) AS client_name,
           c.wallet_address AS client_wallet_address,
           c.reputation_score AS client_trust_score,
           f.id AS freelancer_id,
           COALESCE(NULLIF(f.display_name, ''), NULLIF(f.email, ''), f.wallet_address) AS freelancer_name,
           COALESCE(app_count.application_count, 0) AS application_count,
           my_app.id AS my_application_id,
           my_app.status AS my_application_status,
           CASE
             WHEN b.status = 'open'
               AND selected.freelancer_id IS NULL
               AND b.creator_id <> $1
               AND COALESCE(my_app.status, '') <> 'selected'
             THEN TRUE
             ELSE FALSE
           END AS can_apply,
           COALESCE(ms.milestones, '[]'::json) AS milestones,
           COALESCE(ap.applicants_preview, '[]'::json) AS applicants_preview
    FROM bounties b
    JOIN users c ON c.id = b.creator_id
    LEFT JOIN LATERAL (
      SELECT pa.freelancer_id
      FROM project_applications pa
      WHERE pa.bounty_id = b.id
        AND pa.status = 'selected'
      ORDER BY pa.updated_at DESC
      LIMIT 1
    ) selected ON TRUE
    LEFT JOIN users f ON f.id = selected.freelancer_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS application_count
      FROM project_applications pa
      WHERE pa.bounty_id = b.id
    ) app_count ON TRUE
    LEFT JOIN LATERAL (
      SELECT pa.id, pa.status
      FROM project_applications pa
      WHERE pa.bounty_id = b.id
        AND pa.freelancer_id = $1
      LIMIT 1
    ) my_app ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'id', m.id,
          'status', CASE
            WHEN m.status = 'paid' THEN 'APPROVED'
            WHEN m.status = 'failed' THEN 'REJECTED'
            ELSE 'PENDING'
          END,
          'amount', m.payout_amount
        )
        ORDER BY m.order_index ASC
      ) AS milestones
      FROM milestones m
      WHERE m.bounty_id = b.id
    ) ms ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'freelancer_name', COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address),
          'status', pa.status
        )
        ORDER BY pa.updated_at DESC
      ) AS applicants_preview
      FROM project_applications pa
      JOIN users u ON u.id = pa.freelancer_id
      WHERE pa.bounty_id = b.id
    ) ap ON TRUE
  `;
}

function mapSubmissionStatus(value: string | null) {
  if (!value) {
    return "PENDING";
  }
  if (value === "passed") {
    return "VALIDATED";
  }
  return value.toUpperCase();
}

async function loadMarketplaceProjects(userId: string) {
  const baseSql = projectSelectSql();
  const discover = await dbQuery<ProjectListRow>(
    `
      ${baseSql}
      WHERE b.deleted_at IS NULL
        AND b.status = 'open'
        AND selected.freelancer_id IS NULL
      ORDER BY b.created_at DESC
      LIMIT 100
    `,
    [userId],
  );

  return discover.rows.map((row) => mapListRow(row));
}

router.get("/discover", requireAuth, async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projects = await loadMarketplaceProjects(user.userId);
    return response.status(200).json(projects);
  } catch (error) {
    return next(error);
  }
});

router.get("/marketplace", requireAuth, async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projects = await loadMarketplaceProjects(user.userId);
    return response.status(200).json(projects);
  } catch (error) {
    return next(error);
  }
});

router.get("/", requireAuth, async (request, response, next) => {
  try {
    const user = requireUser(request);

    const filters: string[] = ["b.deleted_at IS NULL"];
    const params: Array<string> = [user.userId];
    const baseSql = projectSelectSql();

    if (user.role === "client") {
      filters.push("b.creator_id = $1");
    } else if (user.role === "freelancer") {
      filters.push(`(
        EXISTS (
          SELECT 1
          FROM project_applications pa_self
          WHERE pa_self.bounty_id = b.id
            AND pa_self.freelancer_id = $1
            AND pa_self.status = 'selected'
        )
        OR EXISTS (
          SELECT 1
          FROM submissions s_self
          WHERE s_self.bounty_id = b.id
            AND s_self.freelancer_id = $1
        )
      )`);
    }

    const projects = await dbQuery<ProjectListRow>(
      `
        ${baseSql}
        WHERE ${filters.join(" AND ")}
        ORDER BY b.updated_at DESC
        LIMIT 100
      `,
      params,
    );

    return response.status(200).json(projects.rows.map((row) => mapListRow(row)));
  } catch (error) {
    return next(error);
  }
});

router.get("/my-applications", requireAuth, async (request, response, next) => {
  try {
    const user = requireUser(request);
    if (user.role !== "freelancer" && user.role !== "admin") {
      return response.status(200).json([]);
    }

    const rows = await dbQuery<
      ProjectListRow & {
        application_id: string | null;
        application_status: string | null;
        application_message: string | null;
        application_proposed_amount: string | null;
        application_estimated_days: number | null;
        application_deliverables: string | null;
        application_created_at: string;
      }
    >(
      `
        ${projectSelectSql()
          .replace(
            "SELECT b.id,",
            `SELECT own_app.id AS application_id,
                    own_app.status AS application_status,
                    own_app.message AS application_message,
                    own_app.proposed_amount::text AS application_proposed_amount,
                    own_app.estimated_days AS application_estimated_days,
                    own_app.deliverables AS application_deliverables,
                    own_app.created_at::text AS application_created_at,
                    b.id,`,
          )
          .replace("FROM bounties b", "FROM project_applications own_app JOIN bounties b ON b.id = own_app.bounty_id")}
        WHERE own_app.freelancer_id = $1
          AND b.deleted_at IS NULL
          AND my_app.id = own_app.id
        ORDER BY own_app.updated_at DESC
      `,
      [user.userId],
    );

    return response.status(200).json(
      rows.rows.map((row) => ({
        application: {
          id: row.application_id,
          status: String(row.application_status ?? "pending").toUpperCase(),
          message: row.application_message,
          proposedAmount: row.application_proposed_amount
            ? Number(row.application_proposed_amount)
            : undefined,
          estimatedDays: row.application_estimated_days ?? undefined,
          deliverables: row.application_deliverables ?? undefined,
          createdAt: row.application_created_at,
        },
        project: mapListRow(row),
      })),
    );
  } catch (error) {
    return next(error);
  }
});

router.get("/conversations", requireAuth, async (request, response, next) => {
  try {
    const user = requireUser(request);

    const rows = await dbQuery<{
      project_id: string;
      application_id: string | null;
      scope: string;
      title: string;
      counterpart_name: string | null;
      counterpart_id: string | null;
      counterpart_role: string | null;
      conversation_status: string;
      updated_at: string;
      message_id: string | null;
      message_content: string | null;
      message_file_url: string | null;
      message_created_at: string | null;
      message_sender_id: string | null;
      message_sender_name: string | null;
    }>(
      `
        WITH accessible AS (
          SELECT b.id AS project_id,
                 NULL::uuid AS application_id,
                 'bounty'::text AS scope,
                 b.title,
                 CASE
                   WHEN $1 IN ('client', 'admin')
                     THEN COALESCE(NULLIF(f_selected.display_name, ''), NULLIF(f_selected.email, ''), f_selected.wallet_address)
                   ELSE COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), c.wallet_address)
                 END AS counterpart_name,
                 CASE
                   WHEN $1 IN ('client', 'admin')
                     THEN f_selected.id
                   ELSE c.id
                 END AS counterpart_id,
                 CASE
                   WHEN $1 IN ('client', 'admin')
                     THEN CASE WHEN f_selected.id IS NULL THEN NULL ELSE 'freelancer' END
                   ELSE 'client'
                 END AS counterpart_role,
                 b.status::text AS conversation_status,
                 b.updated_at::text AS updated_at
          FROM bounties b
          JOIN users c ON c.id = b.creator_id
          LEFT JOIN LATERAL (
            SELECT pa.freelancer_id
            FROM project_applications pa
            WHERE pa.bounty_id = b.id
              AND pa.status = 'selected'
            ORDER BY pa.updated_at DESC
            LIMIT 1
          ) selected ON TRUE
          LEFT JOIN users f_selected ON f_selected.id = selected.freelancer_id
          WHERE b.deleted_at IS NULL
            AND (
              ($1 = 'admin')
              OR (
                selected.freelancer_id IS NOT NULL
                AND (
                  ($1 = 'client' AND b.creator_id = $2)
                  OR ($1 = 'freelancer' AND selected.freelancer_id = $2)
                )
              )
            )

          UNION ALL

          SELECT b.id AS project_id,
                 pa.id AS application_id,
                 'application'::text AS scope,
                 b.title,
                 CASE
                   WHEN $1 IN ('client', 'admin')
                     THEN COALESCE(NULLIF(f.display_name, ''), NULLIF(f.email, ''), f.wallet_address)
                   ELSE COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), c.wallet_address)
                 END AS counterpart_name,
                 CASE
                   WHEN $1 IN ('client', 'admin')
                     THEN f.id
                   ELSE c.id
                 END AS counterpart_id,
                 CASE
                   WHEN $1 IN ('client', 'admin')
                     THEN 'freelancer'
                   ELSE 'client'
                 END AS counterpart_role,
                 pa.status::text AS conversation_status,
                 pa.updated_at::text AS updated_at
          FROM project_applications pa
          JOIN bounties b ON b.id = pa.bounty_id
          JOIN users f ON f.id = pa.freelancer_id
          JOIN users c ON c.id = b.creator_id
          WHERE b.deleted_at IS NULL
            AND (
              $1 = 'admin'
              OR ($1 = 'client' AND b.creator_id = $2)
              OR ($1 = 'freelancer' AND pa.freelancer_id = $2)
            )
        ),
        latest_message AS (
          SELECT DISTINCT ON (bm.bounty_id, bm.scope, COALESCE(bm.application_id, '00000000-0000-0000-0000-000000000000'::uuid))
                 bm.bounty_id,
                 bm.scope,
                 bm.application_id,
                 bm.id AS message_id,
                 bm.content AS message_content,
                 bm.file_url AS message_file_url,
                 bm.created_at::text AS message_created_at,
                 bm.sender_id AS message_sender_id,
                 COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address) AS message_sender_name
          FROM bounty_messages bm
          JOIN users u ON u.id = bm.sender_id
          ORDER BY bm.bounty_id,
                   bm.scope,
                   COALESCE(bm.application_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   bm.created_at DESC
        )
        SELECT a.project_id,
               a.application_id,
               a.scope,
               a.title,
               a.counterpart_name,
               a.counterpart_id,
               a.counterpart_role,
               a.conversation_status,
               COALESCE(lm.message_created_at, a.updated_at) AS updated_at,
               lm.message_id,
               lm.message_content,
               lm.message_file_url,
               lm.message_created_at,
               lm.message_sender_id,
               lm.message_sender_name
        FROM accessible a
        LEFT JOIN latest_message lm
          ON lm.bounty_id = a.project_id
         AND lm.scope = a.scope
         AND (
           (a.application_id IS NULL AND lm.application_id IS NULL)
           OR a.application_id = lm.application_id
         )
        ORDER BY COALESCE(lm.message_created_at, a.updated_at) DESC
      `,
      [user.role, user.userId],
    );

    return response.status(200).json(
      rows.rows.map((row) => ({
        id: row.application_id ? `application:${row.application_id}` : `bounty:${row.project_id}`,
        projectId: row.project_id,
        applicationId: row.application_id,
        scope: String(row.scope).toUpperCase(),
        title: row.title,
        counterpartName: row.counterpart_name,
        counterpartId: row.counterpart_id,
        counterpartRole: row.counterpart_role ? String(row.counterpart_role).toUpperCase() : null,
        status: String(row.conversation_status).toUpperCase(),
        updatedAt: row.updated_at,
        lastMessage: row.message_id
          ? {
              id: row.message_id,
              content: row.message_content,
              fileUrl: row.message_file_url,
              createdAt: row.message_created_at,
              senderId: row.message_sender_id,
              senderName: row.message_sender_name,
            }
          : null,
      })),
    );
  } catch (error) {
    return next(error);
  }
});

router.post("/", requireAuth, validateBody(createProjectSchema), async (request, response, next) => {
  try {
    const user = requireUser(request);
    if (user.role !== "client" && user.role !== "admin") {
      throw new AppError(403, 403, "Only clients can create bounties");
    }

    const body = request.body as z.infer<typeof createProjectSchema>;
    const pseudoRepoName = body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const repoUrl = `https://github.com/hackathon/${pseudoRepoName || "bounty"}`;

    const created = await dbQuery<{
      id: string;
      title: string;
      status: string;
      creator_id: string;
      created_at: string;
    }>(
      `
        INSERT INTO bounties (
          creator_id,
          title,
          description,
          acceptance_criteria,
          repo_url,
          target_branch,
          allowed_languages,
          total_amount,
          status,
          scoring_mode,
          ai_score_threshold,
          max_freelancers,
          deadline,
          idempotency_key
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'main',
          $6,
          $7,
          'open',
          $8,
          60,
          1,
          $9,
          $10
        )
        RETURNING id, title, status, creator_id, created_at
      `,
      [
        user.userId,
        body.title,
        body.description,
        body.acceptanceCriteria,
        repoUrl,
        body.requiredSkills,
        String(body.totalAmountMicroAlgo),
        body.workType === "CREATIVE" ? "hybrid" : "ci_only",
        body.deadline.toISOString(),
        `project-${randomUUID()}`,
      ],
    );

    await dbQuery(
      `
        INSERT INTO milestones (bounty_id, title, description, payout_amount, order_index, status)
        VALUES ($1, 'Delivery', $2, $3, 0, 'pending')
      `,
      [created.rows[0].id, body.acceptanceCriteria, String(body.totalAmountMicroAlgo)],
    );

    return response.status(201).json({
      id: created.rows[0].id,
      title: created.rows[0].title,
      status: created.rows[0].status.toUpperCase(),
      criteria: {
        requiredSkills: body.requiredSkills,
        totalAmountMicroAlgo: body.totalAmountMicroAlgo,
        deadline: body.deadline.toISOString(),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get(
  "/:id/messages",
  requireAuth,
  validateParams(projectIdParamsSchema),
  validateQuery(projectMessagesQuerySchema),
  async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projectId = request.params.id;
    const query = request.query as unknown as { applicationId?: string };
    const applicationId = query.applicationId?.trim();

    if (!applicationId) {
      const assigned = await hasSelectedFreelancer(projectId);
      if (!assigned) {
        throw new AppError(409, 409, "Assign a freelancer before starting bounty chat");
      }
    }

    const allowed = applicationId
      ? await canAccessApplicationConversation(user.userId, user.role, projectId, applicationId)
      : await canAccessBountyConversation(user.userId, user.role, projectId);
    if (!allowed) {
      throw new AppError(403, 403, "Forbidden");
    }

    const messages = await dbQuery<ProjectMessageRow>(
      `
        SELECT bm.id,
               bm.bounty_id,
               bm.application_id,
               bm.scope,
               bm.sender_id,
               bm.content,
               bm.file_url,
               bm.file_name,
               bm.file_size,
               bm.file_type,
               bm.created_at::text,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address) AS sender_name,
               u.role::text AS sender_role
        FROM bounty_messages bm
        JOIN users u ON u.id = bm.sender_id
        WHERE bm.bounty_id = $1
          AND bm.scope = $2
          AND (
            ($3::uuid IS NULL AND bm.application_id IS NULL)
            OR bm.application_id = $3::uuid
          )
        ORDER BY bm.created_at ASC
        LIMIT 500
      `,
      [projectId, applicationId ? "application" : "bounty", applicationId ?? null],
    );

    return response.status(200).json(messages.rows.map((row) => mapMessageRow(row)));
  } catch (error) {
    return next(error);
  }
},
);

router.post(
  "/:id/apply",
  requireAuth,
  validateParams(projectIdParamsSchema),
  validateBody(applySchema),
  async (request, response, next) => {
    try {
      const user = requireUser(request);
      if (user.role !== "freelancer" && user.role !== "admin") {
        throw new AppError(403, 403, "Only freelancers can apply to bounties");
      }

      const projectId = request.params.id;
      const body = request.body as z.infer<typeof applySchema>;

      const bounty = await dbQuery<{ id: string; creator_id: string; status: string }>(
        `
          SELECT id, creator_id, status
          FROM bounties
          WHERE id = $1
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [projectId],
      );

      if ((bounty.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Bounty not found");
      }

      if (bounty.rows[0].creator_id === user.userId) {
        throw new AppError(409, 409, "XC-001: bounty creator cannot apply to own bounty");
      }

      if (bounty.rows[0].status !== "open") {
        throw new AppError(409, 409, "Only open bounties can receive applications");
      }

      const selected = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM project_applications
          WHERE bounty_id = $1
            AND status = 'selected'
          LIMIT 1
        `,
        [projectId],
      );

      if ((selected.rowCount ?? 0) > 0) {
        throw new AppError(409, 409, "A freelancer is already selected for this bounty");
      }

      const application = await dbQuery<{
        id: string;
        status: string;
      }>(
        `
          INSERT INTO project_applications (
            bounty_id,
            freelancer_id,
            message,
            proposed_amount,
            estimated_days,
            deliverables,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'pending')
          ON CONFLICT (bounty_id, freelancer_id)
          DO UPDATE
            SET message = EXCLUDED.message,
                proposed_amount = EXCLUDED.proposed_amount,
                estimated_days = EXCLUDED.estimated_days,
                deliverables = EXCLUDED.deliverables,
                status = 'pending',
                updated_at = NOW()
          RETURNING id, status
        `,
        [
          projectId,
          user.userId,
          body.message?.trim() || null,
          body.proposedAmount !== undefined ? Math.round(body.proposedAmount) : null,
          body.estimatedDays ?? null,
          body.deliverables?.trim() || null,
        ],
      );

      return response.status(201).json({
        id: application.rows[0].id,
        status: String(application.rows[0].status).toUpperCase(),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/:id/applicants", requireAuth, validateParams(projectIdParamsSchema), async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projectId = request.params.id;

    await assertCreator(user.userId, user.role, projectId);

    const applicants = await dbQuery<ApplicantRow>(
      `
        SELECT pa.id,
               pa.status,
               pa.message,
               pa.proposed_amount::text,
               pa.estimated_days,
               pa.deliverables,
               u.id AS freelancer_id,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address) AS freelancer_name,
               ROUND((u.reputation_score::numeric / 20.0), 2) AS freelancer_rating,
               u.reputation_score AS freelancer_trust_score
        FROM project_applications pa
        JOIN users u ON u.id = pa.freelancer_id
        WHERE pa.bounty_id = $1
        ORDER BY (pa.status = 'selected') DESC, pa.created_at DESC
      `,
      [projectId],
    );

    return response.status(200).json(
      applicants.rows.map((row) => ({
        id: row.id,
        status: String(row.status ?? "pending").toUpperCase(),
        message: row.message,
        proposedAmount: row.proposed_amount ? Number(row.proposed_amount) : undefined,
        estimatedDays: row.estimated_days ?? undefined,
        deliverables: row.deliverables ?? undefined,
        freelancer: {
          id: row.freelancer_id,
          name: row.freelancer_name,
          rating: Number(row.freelancer_rating),
          trustScore: Number(row.freelancer_trust_score),
        },
      })),
    );
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/:id/select-applicant",
  requireAuth,
  validateParams(projectIdParamsSchema),
  validateBody(selectApplicantSchema),
  async (request, response, next) => {
    try {
      const user = requireUser(request);
      const projectId = request.params.id;
      await assertCreator(user.userId, user.role, projectId);

      const body = request.body as z.infer<typeof selectApplicantSchema>;

      const target = await dbQuery<{ id: string; freelancer_id: string }>(
        `
          SELECT id, freelancer_id
          FROM project_applications
          WHERE id = $1
            AND bounty_id = $2
          LIMIT 1
        `,
        [body.applicationId, projectId],
      );

      if ((target.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Applicant not found");
      }

      await dbQuery(
        `
          UPDATE project_applications
          SET status = CASE WHEN id = $1 THEN 'selected' ELSE 'rejected' END,
              updated_at = NOW()
          WHERE bounty_id = $2
        `,
        [body.applicationId, projectId],
      );

      await dbQuery(
        `
          UPDATE bounties
          SET status = 'in_progress',
              updated_at = NOW()
          WHERE id = $1
            AND deleted_at IS NULL
        `,
        [projectId],
      );

      return response.status(200).json({
        selected: true,
        freelancerId: target.rows[0].freelancer_id,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/:id/assign",
  requireAuth,
  validateParams(projectIdParamsSchema),
  validateBody(assignSchema),
  async (request, response, next) => {
    try {
      const user = requireUser(request);
      const projectId = request.params.id;
      await assertCreator(user.userId, user.role, projectId);

      const body = request.body as z.infer<typeof assignSchema>;

      const targetApplication = await dbQuery<{ id: string; freelancer_id: string }>(
        `
          SELECT id, freelancer_id
          FROM project_applications
          WHERE bounty_id = $1
            AND freelancer_id = $2
          LIMIT 1
        `,
        [projectId, body.freelancerId],
      );

      if ((targetApplication.rowCount ?? 0) === 0) {
        throw new AppError(409, 409, "Only applicants can be selected for assignment");
      }

      await dbQuery(
        `
          UPDATE project_applications
          SET status = CASE WHEN id = $1 THEN 'selected' ELSE 'rejected' END,
              updated_at = NOW()
          WHERE bounty_id = $2
        `,
        [targetApplication.rows[0].id, projectId],
      );

      await dbQuery(
        `
          UPDATE bounties
          SET status = 'in_progress',
              updated_at = NOW()
          WHERE id = $1
            AND deleted_at IS NULL
        `,
        [projectId],
      );

      return response.status(200).json({
        assigned: true,
        freelancerId: targetApplication.rows[0].freelancer_id,
        applicationId: targetApplication.rows[0].id,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post("/:id/draft-approve", requireAuth, validateParams(projectIdParamsSchema), async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projectId = request.params.id;
    await assertCreator(user.userId, user.role, projectId);

    await dbQuery(
      `
        UPDATE bounties
        SET status = CASE WHEN status = 'draft' THEN 'open' ELSE status END,
            updated_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
      `,
      [projectId],
    );

    return response.status(200).json({ approved: true });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/:id/milestones/:milestoneId/submissions",
  requireAuth,
  validateParams(milestoneParamsSchema),
  validateBody(milestoneSubmissionSchema),
  async (request, response, next) => {
    try {
      const user = requireUser(request);
      if (user.role !== "freelancer" && user.role !== "admin") {
        throw new AppError(403, 403, "Only freelancers can submit milestone work");
      }

      const { id: projectId, milestoneId } = request.params;
      const body = request.body as z.infer<typeof milestoneSubmissionSchema>;
      const submissionKind = body.kind ?? "FINAL";

      const milestone = await dbQuery<{ id: string; bounty_id: string }>(
        `
          SELECT id, bounty_id
          FROM milestones
          WHERE id = $1
            AND bounty_id = $2
          LIMIT 1
        `,
        [milestoneId, projectId],
      );

      if ((milestone.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Milestone not found");
      }

      const bounty = await dbQuery<{ acceptance_criteria: string }>(
        `
          SELECT acceptance_criteria
          FROM bounties
          WHERE id = $1
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [projectId],
      );

      if ((bounty.rowCount ?? 0) === 0) {
        throw new AppError(404, 404, "Bounty not found");
      }

      const evidenceUrl = body.fileUrl ?? `https://example.com/submissions/${projectId}/${milestoneId}`;
      const branchName = `milestone-${milestoneId.slice(0, 8)}`;
      const idempotency = `milestone-${milestoneId}-${user.userId}`;
      const reviewWindowMinutes = Number(process.env.REVIEW_WINDOW_MINUTES ?? "720");

      const existingSubmission = await dbQuery<{
        id: string;
      }>(
        `
          SELECT id
          FROM submissions
          WHERE bounty_id = $1
            AND freelancer_id = $2
            AND status IN ('draft', 'submitted', 'in_progress', 'awaiting_ci', 'validating', 'passed', 'disputed')
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [projectId, user.userId],
      );

      let submissionId: string;

      if ((existingSubmission.rowCount ?? 0) > 0) {
        submissionId = existingSubmission.rows[0].id;
        await dbQuery(
          `
            UPDATE submissions
            SET github_pr_url = $2,
                github_branch = $3,
                status = $4,
                submission_stage = $5,
                review_gate_status = $6,
                review_window_ends_at = $7,
                submission_received_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
          `,
          [
            submissionId,
            evidenceUrl,
            branchName,
            submissionKind === "FINAL" ? "submitted" : "draft",
            submissionKind === "FINAL" ? "final" : "draft",
            submissionKind === "FINAL" ? "awaiting_client_review" : "none",
            submissionKind === "FINAL"
              ? new Date(Date.now() + reviewWindowMinutes * 60_000).toISOString()
              : null,
          ],
        );
      } else {
        const created = await dbQuery<{ id: string }>(
          `
            INSERT INTO submissions (
              bounty_id,
              freelancer_id,
              github_pr_url,
              github_branch,
              github_repo_id,
              status,
              submission_stage,
              review_gate_status,
              review_window_ends_at,
              scoring_idempotency_key,
              submission_received_at
            )
            VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, NOW())
            RETURNING id
          `,
          [
            projectId,
            user.userId,
            evidenceUrl,
            branchName,
            submissionKind === "FINAL" ? "submitted" : "draft",
            submissionKind === "FINAL" ? "final" : "draft",
            submissionKind === "FINAL" ? "awaiting_client_review" : "none",
            submissionKind === "FINAL"
              ? new Date(Date.now() + reviewWindowMinutes * 60_000).toISOString()
              : null,
            `${idempotency}-${randomUUID()}`,
          ],
        );
        submissionId = created.rows[0].id;
      }

      const latestRevision = await dbQuery<{ revision_no: number }>(
        `
          SELECT COALESCE(MAX(revision_no), 0) AS revision_no
          FROM submission_revisions
          WHERE submission_id = $1
        `,
        [submissionId],
      );

      const nextRevisionNo = Number(latestRevision.rows[0]?.revision_no ?? 0) + 1;

      const revision = await dbQuery<{ id: string }>(
        `
          INSERT INTO submission_revisions (
            submission_id,
            bounty_id,
            freelancer_id,
            revision_no,
            stage,
            artifact_url,
            notes,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          RETURNING id
        `,
        [
          submissionId,
          projectId,
          user.userId,
          nextRevisionNo,
          submissionKind === "FINAL" ? "final" : "draft",
          evidenceUrl,
          body.notes ?? null,
          JSON.stringify({ milestone_id: milestoneId, kind: submissionKind }),
        ],
      );

      const feedback = buildSubmissionFeedbackReport({
        acceptanceCriteria: bounty.rows[0].acceptance_criteria,
        artifactUrl: evidenceUrl,
        notes: body.notes ?? null,
        clientComment: null,
      });

      await dbQuery(
        `
          INSERT INTO submission_feedback_reports (
            submission_id,
            revision_id,
            generated_by,
            ai_payload,
            checklist_payload,
            implemented_items,
            missing_items,
            client_summary,
            freelancer_summary,
            freelancer_suggestions
          )
          VALUES ($1, $2, 'hybrid', $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb)
        `,
        [
          submissionId,
          revision.rows[0].id,
          JSON.stringify(feedback.aiPayload),
          JSON.stringify(feedback.checklistPayload),
          JSON.stringify(feedback.implementedItems),
          JSON.stringify(feedback.missingItems),
          feedback.clientSummary,
          feedback.freelancerSummary,
          JSON.stringify(feedback.freelancerSuggestions),
        ],
      );

      await dbQuery(
        `
          UPDATE bounties
          SET status = CASE
                         WHEN $2 = 'DRAFT' THEN 'draft'
                         WHEN status = 'draft' THEN 'in_progress'
                         ELSE status
                       END,
              updated_at = NOW()
          WHERE id = $1
            AND deleted_at IS NULL
        `,
        [projectId, submissionKind],
      );

      emitToBounty(projectId, submissionKind === "FINAL" ? "bounty:submission_finalized" : "bounty:submission_draft_saved", {
        bounty_id: projectId,
        submission_id: submissionId,
        revision_no: nextRevisionNo,
        stage: submissionKind,
      });

      return response.status(201).json({
        id: submissionId,
        status: submissionKind === "FINAL" ? "submitted" : "draft",
        stage: submissionKind,
        revisionNo: nextRevisionNo,
        feedback: {
          clientSummary: feedback.clientSummary,
          freelancerSummary: feedback.freelancerSummary,
          implementedItems: feedback.implementedItems,
          missingItems: feedback.missingItems,
          suggestions: feedback.freelancerSuggestions,
        },
        notes: body.notes ?? null,
      });
    } catch (error) {
      const maybePg = error as { code?: string };
      if (maybePg.code === "23505") {
        return response.status(409).json({
          error: "Conflict",
          code: 409,
          detail: "An active submission already exists for this bounty",
        });
      }
      return next(error);
    }
  },
);

router.get("/:id/meetings", requireAuth, validateParams(projectIdParamsSchema), async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projectId = request.params.id;

    await assertParticipant(user.userId, user.role, projectId);

    const meetings = await dbQuery<ProjectMeetingRow>(
      `
        SELECT pm.id,
               pm.bounty_id,
               pm.title,
               pm.agenda,
               pm.meeting_url,
               pm.scheduled_for::text,
               pm.created_at::text,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address) AS scheduled_by_name
        FROM project_meetings pm
        JOIN users u ON u.id = pm.scheduled_by
        WHERE pm.bounty_id = $1
        ORDER BY pm.scheduled_for ASC, pm.created_at ASC
      `,
      [projectId],
    );

    return response.status(200).json(meetings.rows.map((row) => mapMeetingRow(row)));
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/:id/meetings",
  requireAuth,
  validateParams(projectIdParamsSchema),
  validateBody(createMeetingSchema),
  async (request, response, next) => {
    try {
      const user = requireUser(request);
      const projectId = request.params.id;
      const body = request.body as z.infer<typeof createMeetingSchema>;

      await assertParticipant(user.userId, user.role, projectId);

      const assigned = await hasSelectedFreelancer(projectId);
      if (!assigned) {
        throw new AppError(409, 409, "Assign a freelancer before scheduling meetings");
      }

      const meetingId = randomUUID();
      const meetingUrl = `${getAppBaseUrl()}/dashboard/chat/${projectId}?meeting=${meetingId}`;

      const created = await dbQuery<ProjectMeetingRow>(
        `
          INSERT INTO project_meetings (
            id,
            bounty_id,
            scheduled_by,
            title,
            agenda,
            scheduled_for,
            meeting_url
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id,
                    bounty_id,
                    title,
                    agenda,
                    meeting_url,
                    scheduled_for::text,
                    created_at::text,
                    (
                      SELECT COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address)
                      FROM users u
                      WHERE u.id = $3
                    ) AS scheduled_by_name
        `,
        [
          meetingId,
          projectId,
          user.userId,
          body.title,
          body.agenda?.trim() || null,
          body.scheduledFor.toISOString(),
          meetingUrl,
        ],
      );

      return response.status(201).json(mapMeetingRow(created.rows[0]));
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/:id", requireAuth, validateParams(projectIdParamsSchema), async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projectId = request.params.id;

    const allowed = await canAccessProject(user.userId, user.role, projectId);
    if (!allowed && user.role !== "client") {
      throw new AppError(403, 403, "Forbidden");
    }

    const detail = await dbQuery<ProjectDetailRow>(
      `
        SELECT b.id,
               b.title,
           b.description,
           b.acceptance_criteria,
           b.allowed_languages,
           b.total_amount::text,
           b.deadline::text,
           b.scoring_mode,
               b.status,
               b.creator_id,
               COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), c.wallet_address) AS client_name,
               c.wallet_address AS client_wallet_address,
               c.reputation_score AS client_trust_score,
               f.id AS freelancer_id,
               COALESCE(NULLIF(f.display_name, ''), NULLIF(f.email, ''), f.wallet_address) AS freelancer_name,
               b.status <> 'draft' AS draft_approved,
               COALESCE(ms.milestones, '[]'::json) AS milestones,
               ls.id AS latest_submission_id,
               ls.status AS latest_submission_status,
               ls.submission_stage AS latest_submission_stage,
               ls.review_gate_status AS latest_submission_gate_status,
               ls.github_pr_url AS latest_submission_file_url,
               ls.client_rating_stars AS latest_submission_client_rating,
               ls.last_client_comment AS latest_submission_client_comment,
               lfr.client_summary AS latest_feedback_client_summary,
               lfr.freelancer_summary AS latest_feedback_freelancer_summary,
               lfr.implemented_items AS latest_feedback_implemented_items,
               lfr.missing_items AS latest_feedback_missing_items,
               COALESCE(vr.validation_reports, '[]'::json) AS validation_reports,
               COALESCE(ap.applicants_preview, '[]'::json) AS applicants_preview
        FROM bounties b
        JOIN users c ON c.id = b.creator_id
        LEFT JOIN LATERAL (
          SELECT pa.freelancer_id
          FROM project_applications pa
          WHERE pa.bounty_id = b.id
            AND pa.status = 'selected'
          ORDER BY pa.updated_at DESC
          LIMIT 1
        ) selected ON TRUE
        LEFT JOIN users f ON f.id = selected.freelancer_id
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'id', m.id,
              'title', m.title,
              'amount', m.payout_amount,
              'status', CASE
                WHEN m.status = 'paid' THEN 'APPROVED'
                WHEN m.status = 'failed' THEN 'REJECTED'
                ELSE 'PENDING'
              END
            )
            ORDER BY m.order_index ASC
          ) AS milestones
          FROM milestones m
          WHERE m.bounty_id = b.id
        ) ms ON TRUE
        LEFT JOIN LATERAL (
          SELECT s.id,
                 s.status,
                 s.submission_stage,
                 s.review_gate_status,
                 s.github_pr_url,
                 s.client_rating_stars,
                 s.last_client_comment
          FROM submissions s
          WHERE s.bounty_id = b.id
          ORDER BY s.updated_at DESC
          LIMIT 1
        ) ls ON TRUE
        LEFT JOIN LATERAL (
          SELECT fr.client_summary,
                 fr.freelancer_summary,
                 fr.implemented_items,
                 fr.missing_items
          FROM submission_feedback_reports fr
          WHERE fr.submission_id = ls.id
          ORDER BY fr.created_at DESC
          LIMIT 1
        ) lfr ON TRUE
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'aiScore', s.ai_score,
              'clientRating', s.client_rating_stars,
              'finalScore', s.final_score,
              'decision', CASE
                WHEN s.final_score IS NULL THEN 'PENDING'
                WHEN s.final_score >= 70 THEN 'APPROVED'
                ELSE 'REJECTED'
              END
            )
            ORDER BY s.updated_at DESC
          ) AS validation_reports
          FROM submissions s
          WHERE s.bounty_id = b.id
        ) vr ON TRUE
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'freelancer_name', COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.wallet_address),
              'status', pa.status
            )
            ORDER BY pa.updated_at DESC
          ) AS applicants_preview
          FROM project_applications pa
          JOIN users u ON u.id = pa.freelancer_id
          WHERE pa.bounty_id = b.id
        ) ap ON TRUE
        WHERE b.id = $1
          AND b.deleted_at IS NULL
        LIMIT 1
      `,
      [projectId],
    );

    if ((detail.rowCount ?? 0) === 0) {
      throw new AppError(404, 404, "Bounty not found");
    }

    if (user.role === "client" && detail.rows[0].creator_id !== user.userId) {
      throw new AppError(403, 403, "Forbidden");
    }

    const row = detail.rows[0];

    return response.status(200).json({
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status.toUpperCase(),
      draftApproved: row.draft_approved,
      criteria: {
        acceptanceCriteria: row.acceptance_criteria,
        requiredSkills: row.allowed_languages ?? [],
        totalAmountMicroAlgo: Number(row.total_amount ?? "0"),
        deadline: row.deadline,
        scoringMode: row.scoring_mode,
      },
      client: {
        id: row.creator_id,
        name: row.client_name,
        walletAddress: row.client_wallet_address,
        trustScore: row.client_trust_score,
      },
      freelancer: row.freelancer_id
        ? {
            id: row.freelancer_id,
            name: row.freelancer_name ?? "Unknown",
          }
        : null,
      milestones: (row.milestones ?? []).map((milestone) => ({
        ...milestone,
        submissions: row.latest_submission_id
          ? [
              {
                id: row.latest_submission_id,
                status: mapSubmissionStatus(row.latest_submission_status),
                fileUrl: row.latest_submission_file_url ?? undefined,
                clientRating: row.latest_submission_client_rating ?? undefined,
                stage: row.latest_submission_stage ?? undefined,
                reviewGateStatus: row.latest_submission_gate_status ?? undefined,
                clientFeedback: row.latest_submission_client_comment ?? undefined,
                feedbackSummary: {
                  client: row.latest_feedback_client_summary ?? undefined,
                  freelancer: row.latest_feedback_freelancer_summary ?? undefined,
                  implementedItems: Array.isArray(row.latest_feedback_implemented_items)
                    ? row.latest_feedback_implemented_items
                    : [],
                  missingItems: Array.isArray(row.latest_feedback_missing_items)
                    ? row.latest_feedback_missing_items
                    : [],
                },
              },
            ]
          : [],
      })),
      validationReports: row.validation_reports ?? [],
      applicantsPreview: row.applicants_preview ?? [],
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", requireAuth, validateParams(projectIdParamsSchema), async (request, response, next) => {
  try {
    const user = requireUser(request);
    const projectId = request.params.id;
    await assertCreator(user.userId, user.role, projectId);

    await dbQuery(
      `
        UPDATE bounties
        SET status = 'cancelled',
            deleted_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
      `,
      [projectId],
    );

    return response.status(204).send();
  } catch (error) {
    return next(error);
  }
});

export default router;
