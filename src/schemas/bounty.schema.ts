import { z } from "zod";

const uuidParamSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
});

export const createBountySchema = z.object({
  title: z.string().trim().min(3),
  description: z.string().trim().min(10),
  acceptance_criteria: z.string().trim().min(10),
  repo_url: z.string().url().regex(/^https:\/\/github\.com\/.+\/.+$/, "repo_url must be a GitHub repository URL"),
  target_branch: z.string().trim().min(1).default("main"),
  allowed_languages: z.array(z.string().trim().min(1)).min(1),
  total_amount: z.coerce.bigint().refine((value) => value > 0n, "total_amount must be > 0"),
  deadline: z.coerce.date(),
  scoring_mode: z.enum(["ai_only", "ci_only", "hybrid"]),
  ai_score_threshold: z.number().int().min(0).max(100),
  max_freelancers: z.number().int().min(1).default(1),
});

export const fundBountyParamsSchema = uuidParamSchema;

export const bountyListQuerySchema = z.object({
  status: z.enum(["draft", "open", "in_progress", "completed", "expired", "cancelled", "disputed", "pending_escrow"]).optional(),
  language: z.string().trim().optional(),
  min_amount: z.coerce.bigint().optional(),
  max_amount: z.coerce.bigint().optional(),
  sort_by: z.enum(["deadline", "amount", "created"]).default("created"),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export const extendDeadlineSchema = z.object({
  deadline: z.coerce.date(),
});

export const acceptBountySchema = z.object({
  github_pr_url: z.string().url(),
  github_branch: z.string().trim().min(1),
  github_repo_id: z.coerce.bigint().refine((value) => value > 0n, "github_repo_id must be > 0"),
});

export const idParamSchema = uuidParamSchema;

export type CreateBountyInput = z.infer<typeof createBountySchema>;
export type BountyListQueryInput = z.infer<typeof bountyListQuerySchema>;
