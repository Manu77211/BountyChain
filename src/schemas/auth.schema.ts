import { z } from "zod";

const walletAddressSchema = z
  .string()
  .trim()
  .regex(/^[A-Z2-7]{58}$/, "wallet_address must be a valid Algorand address");

export const walletLoginSchema = z.object({
  wallet_address: walletAddressSchema,
  signed_message: z.string().min(1, "signed_message is required"),
  signature: z.string().min(1, "signature is required"),
  role: z.enum(["client", "freelancer", "arbitrator", "admin"]).optional(),
});

export const refreshSchema = z.object({}).passthrough();

const registerRoleSchema = z
  .enum(["CLIENT", "FREELANCER", "client", "freelancer"])
  .transform((value) => value.toUpperCase() as "CLIENT" | "FREELANCER");

export const registerSchema = z.object({
  name: z.string().trim().min(2, "name must be at least 2 characters").max(120),
  email: z.string().trim().email("email must be valid"),
  password: z.string().min(8, "password must be at least 8 characters"),
  role: registerRoleSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().email("email must be valid"),
  password: z.string().min(1, "password is required"),
});

export type WalletLoginInput = z.infer<typeof walletLoginSchema>;
