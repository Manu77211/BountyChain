export const PRODUCT_NAME = "BountyEscrow AI";

export const AUTH_STORAGE_KEY = "bountyescrow-auth";
export const LEGACY_AUTH_STORAGE_KEY = "trustescrow-auth";

export type SanctionsStatus = "PASSED" | "FAILED" | "PENDING" | "UNKNOWN";

export function normalizeSanctionsStatus(value: unknown): SanctionsStatus {
  if (typeof value !== "string") {
    return "UNKNOWN";
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "PASSED") {
    return "PASSED";
  }
  if (normalized === "FAILED") {
    return "FAILED";
  }
  if (normalized === "PENDING") {
    return "PENDING";
  }

  return "UNKNOWN";
}

export function hasDistinctParticipants(clientId?: string | null, freelancerId?: string | null) {
  if (!clientId || !freelancerId) {
    return true;
  }

  return clientId !== freelancerId;
}

export function canReleaseEscrow(input: {
  validationDecision?: string | null;
  clientSanctionsStatus?: unknown;
  freelancerSanctionsStatus?: unknown;
  clientId?: string | null;
  freelancerId?: string | null;
}) {
  const validationDecision = (input.validationDecision ?? "").toUpperCase();
  const clientSanctions = normalizeSanctionsStatus(input.clientSanctionsStatus);
  const freelancerSanctions = normalizeSanctionsStatus(input.freelancerSanctionsStatus);

  if (!hasDistinctParticipants(input.clientId, input.freelancerId)) {
    return {
      allowed: false,
      reason: "Client and freelancer cannot be the same identity on a bounty.",
      clientSanctions,
      freelancerSanctions,
    };
  }

  if (validationDecision !== "APPROVED") {
    return {
      allowed: false,
      reason: "Escrow remains locked until CI/CD + AI validation is approved.",
      clientSanctions,
      freelancerSanctions,
    };
  }

  if (clientSanctions !== "PASSED" || freelancerSanctions !== "PASSED") {
    return {
      allowed: false,
      reason: "Escrow remains locked until both wallet sanctions checks pass.",
      clientSanctions,
      freelancerSanctions,
    };
  }

  return {
    allowed: true,
    reason: "Validation and sanctions checks passed. Escrow can be released.",
    clientSanctions,
    freelancerSanctions,
  };
}

export const CORE_RULES = [
  "Never release escrow without passing validation.",
  "Never allow the same user to be both client and freelancer on the same bounty.",
  "All payout wallets must pass sanctions checks before release.",
  "Background orchestration must run through Inngest with retries.",
  "All API inputs must be validated with Zod before DB or blockchain execution.",
];
