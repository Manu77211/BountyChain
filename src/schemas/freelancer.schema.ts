import { z } from "zod";

export const freelancerListQuerySchema = z.object({
  skills: z.string().trim().max(120).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type FreelancerListQuery = z.infer<typeof freelancerListQuerySchema>;