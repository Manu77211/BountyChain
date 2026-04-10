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

export type WalletLoginInput = z.infer<typeof walletLoginSchema>;
