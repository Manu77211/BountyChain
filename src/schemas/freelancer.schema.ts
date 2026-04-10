import { z } from "zod";

export const freelancerListQuerySchema = z.object({
  skills: z.string().trim().max(120).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const freelancerIdParamSchema = z.object({
  id: z.string().uuid("id must be a UUID"),
});

export const freelancerRecommendationBodySchema = z.object({
  description: z.string().trim().min(30).max(4000),
  allowed_languages: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  min_rating: z.number().min(0).max(5).optional(),
  limit: z.number().int().min(1).max(20).default(6),
});

export const freelancerProjectSuggestionBodySchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().min(12).max(3000),
  acceptance_criteria: z.string().trim().max(4000).optional(),
  allowed_languages: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

export type FreelancerListQuery = z.infer<typeof freelancerListQuerySchema>;