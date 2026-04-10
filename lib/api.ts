function normalizeApiBaseUrl(rawUrl?: string) {
  const fallback = "http://localhost:4000/api";
  const candidate = (rawUrl ?? fallback).trim();
  const withoutTrailingSlash = candidate.replace(/\/+$/, "");

  if (withoutTrailingSlash.endsWith("/api")) {
    return withoutTrailingSlash;
  }

  return `${withoutTrailingSlash}/api`;
}

export const API_BASE_URL = normalizeApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
export const SOCKET_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, "");

const NETWORK_ERROR_MESSAGE =
  "Cannot reach API server. Start backend on port 4000 using npm run api:start (or run npm run dev) and set NEXT_PUBLIC_API_URL in .env or .env.local.";

async function parseErrorMessage(response: Response, fallback: string) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as {
      error?: string;
      code?: number;
      detail?: string;
      message?: string;
      issues?: {
        formErrors?: string[];
        fieldErrors?: Record<string, string[] | undefined>;
      };
    };

    if (payload.detail) {
      return payload.detail;
    }

    if (payload.message) {
      return payload.message;
    }

    const fieldErrors = payload.issues?.fieldErrors
      ? Object.values(payload.issues.fieldErrors).flat().filter(Boolean)
      : [];

    const formErrors = payload.issues?.formErrors ?? [];
    const merged = [...formErrors, ...fieldErrors];

    if (merged.length > 0) {
      return merged.join(" | ");
    }

    return fallback;
  }
  const text = await response.text();
  return text || fallback;
}

async function safeFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
}

export interface AuthPayload {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: "CLIENT" | "FREELANCER";
    skills: string[];
    rating: number;
    trustScore: number;
    experience: string;
    portfolio: string[];
  };
}

export async function registerRequest(payload: {
  name: string;
  email: string;
  password: string;
  role: "CLIENT" | "FREELANCER";
  skills?: string[];
  experience?: string;
  portfolio?: string[];
}) {
  const response = await safeFetch(`${API_BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Registration failed"));
  }

  return (await response.json()) as AuthPayload;
}

export async function loginRequest(payload: { email: string; password: string }) {
  const response = await safeFetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Login failed"));
  }

  return (await response.json()) as AuthPayload;
}

export async function walletLoginRequest(payload: {
  wallet_address: string;
  signed_message: string;
  signature: string;
  role?: "client" | "freelancer";
}) {
  const response = await safeFetch(`${API_BASE_URL}/auth/wallet-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Wallet login failed"));
  }

  const data = (await response.json()) as {
    access_token: string;
    user: {
      id: string;
      email?: string | null;
      role: "client" | "freelancer" | "admin" | "arbitrator";
      reputation_score?: number;
      wallet_address?: string;
    };
  };

  const mappedRole = data.user.role === "client" ? "CLIENT" : "FREELANCER";
  return {
    token: data.access_token,
    user: {
      id: data.user.id,
      name: data.user.email ?? data.user.wallet_address ?? "Wallet User",
      email: data.user.email ?? "",
      role: mappedRole,
      skills: [],
      rating: Number(((data.user.reputation_score ?? 100) / 20).toFixed(2)),
      trustScore: data.user.reputation_score ?? 100,
      experience: "",
      portfolio: [],
    },
  } as AuthPayload;
}

export async function meRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/users/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load profile"));
  }

  return response.json();
}

export async function listFreelancersRequest(params: { skills?: string; rating?: number }) {
  const query = new URLSearchParams();
  if (params.skills) {
    query.set("skills", params.skills);
  }
  if (typeof params.rating === "number" && !Number.isNaN(params.rating)) {
    query.set("rating", String(params.rating));
  }

  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/freelancers${suffix}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load freelancers"));
  }
  return response.json();
}

export async function createProjectRequest(
  token: string,
  payload: { title: string; description: string; workType: "STRUCTURED" | "CREATIVE" },
) {
  const response = await safeFetch(`${API_BASE_URL}/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to create bounty"));
  }

  return response.json();
}

export async function listProjectsRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load bounties"));
  }

  return response.json();
}

export async function getProjectRequest(token: string, projectId: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load bounty"));
  }

  return response.json();
}

export async function assignFreelancerRequest(
  token: string,
  projectId: string,
  freelancerId: string,
) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/assign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ freelancerId }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to assign freelancer"));
  }

  return response.json();
}

export async function deleteProjectRequest(token: string, projectId: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to delete bounty"));
  }
}

export async function discoverOpenProjectsRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/discover`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to discover bounties"));
  }

  return response.json();
}

export async function applyToProjectRequest(
  token: string,
  projectId: string,
  payload?: {
    message?: string;
    proposedAmount?: number;
    estimatedDays?: number;
    deliverables?: string;
  },
) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to apply to bounty"));
  }

  return response.json();
}

export async function listProjectApplicantsRequest(token: string, projectId: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/applicants`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load bounty applicants"));
  }

  return response.json();
}

export async function selectProjectApplicantRequest(
  token: string,
  projectId: string,
  applicationId: string,
) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/select-applicant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ applicationId }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to select bounty applicant"));
  }

  return response.json();
}

export async function approveProjectDraftRequest(token: string, projectId: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/draft-approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ approved: true }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to approve bounty draft"));
  }

  return response.json();
}

export async function createMilestoneSubmissionRequest(
  token: string,
  projectId: string,
  milestoneId: string,
  payload: {
    kind: "DRAFT" | "FINAL";
    fileUrl?: string;
    notes?: string;
  },
) {
  const response = await safeFetch(
    `${API_BASE_URL}/projects/${projectId}/milestones/${milestoneId}/submissions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to submit milestone"));
  }

  return response.json();
}

export async function createSubmissionRequest(
  token: string,
  payload: { milestoneId: string; fileUrl?: string; notes?: string },
) {
  const response = await safeFetch(`${API_BASE_URL}/submissions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to submit work"));
  }

  return response.json();
}

export async function rateSubmissionRequest(token: string, submissionId: string, rating: number) {
  const response = await safeFetch(`${API_BASE_URL}/submissions/${submissionId}/rate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ rating }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to rate submission"));
  }

  return response.json();
}

export async function requestSubmissionChangesRequest(token: string, submissionId: string, feedback: string) {
  const response = await safeFetch(`${API_BASE_URL}/submissions/${submissionId}/request-changes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ feedback }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to request changes"));
  }

  return response.json();
}

export interface ProjectMessage {
  id: string;
  projectId: string;
  senderId: string;
  content: string;
  fileUrl: string | null;
  createdAt: string;
  sender: {
    id: string;
    name: string;
    role: "CLIENT" | "FREELANCER";
  };
}

export async function listProjectMessagesRequest(token: string, projectId: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/messages`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load bounty messages"));
  }

  return (await response.json()) as ProjectMessage[];
}

function withAuth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

export async function listBountiesRequest(params?: {
  status?: string;
  language?: string;
  limit?: number;
  cursor?: string;
}) {
  const search = new URLSearchParams();
  if (params?.status) {
    search.set("status", params.status);
  }
  if (params?.language) {
    search.set("language", params.language);
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }
  if (params?.cursor) {
    search.set("cursor", params.cursor);
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/bounties${suffix}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load bounties"));
  }
  return response.json();
}

export async function getBountyRequest(bountyId: string) {
  const response = await safeFetch(`${API_BASE_URL}/bounties/${bountyId}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load bounty"));
  }
  return response.json();
}

export async function createBountyRequest(
  token: string,
  payload: {
    title: string;
    description: string;
    acceptance_criteria: string;
    repo_url: string;
    target_branch: string;
    allowed_languages: string[];
    total_amount: string;
    scoring_mode: "ai_only" | "ci_only" | "hybrid";
    ai_score_threshold: number;
    max_freelancers: number;
    deadline: string;
  },
) {
  const response = await safeFetch(`${API_BASE_URL}/bounties`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to create bounty"));
  }

  return response.json();
}

export async function fundBountyRequest(token: string, bountyId: string) {
  const response = await safeFetch(`${API_BASE_URL}/bounties/${bountyId}/fund`, {
    method: "POST",
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to fund bounty"));
  }

  return response.json();
}

export async function acceptBountyRequest(
  token: string,
  bountyId: string,
  payload: {
    github_pr_url: string;
    github_branch: string;
    github_repo_id: number;
  },
) {
  const response = await safeFetch(`${API_BASE_URL}/bounties/${bountyId}/accept`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to accept bounty"));
  }

  return response.json();
}

export async function getSubmissionRequest(token: string, submissionId: string) {
  const response = await safeFetch(`${API_BASE_URL}/submissions/${submissionId}`, {
    headers: withAuth(token),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load submission"));
  }
  return response.json();
}

export async function flagSubmissionScoreRequest(token: string, submissionId: string, reason: string) {
  const response = await safeFetch(`${API_BASE_URL}/submissions/${submissionId}/flag-score`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify({ reason }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to flag score"));
  }

  return response.json();
}

export async function getDisputeRequest(token: string, disputeId: string) {
  const response = await safeFetch(`${API_BASE_URL}/disputes/${disputeId}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load dispute"));
  }

  return response.json();
}

export async function openDisputeRequest(
  token: string,
  payload: {
    submission_id: string;
    reason: string;
    dispute_type: "score_unfair" | "quality_low" | "requirement_mismatch" | "fraud" | "non_delivery";
  },
) {
  const response = await safeFetch(`${API_BASE_URL}/disputes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to open dispute"));
  }

  return response.json();
}

export async function voteDisputeRequest(
  token: string,
  disputeId: string,
  payload: { vote: "freelancer_wins" | "client_wins" | "split"; justification: string },
) {
  const response = await safeFetch(`${API_BASE_URL}/disputes/${disputeId}/vote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to submit vote"));
  }

  return response.json();
}

export async function challengeDisputeArbitratorRequest(
  token: string,
  disputeId: string,
  payload: { arbitrator_id: string; justification: string },
) {
  const response = await safeFetch(`${API_BASE_URL}/disputes/${disputeId}/challenge-arbitrator`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to challenge arbitrator"));
  }

  return response.json();
}

export async function updateMeRequest(token: string, payload: { email?: string }) {
  const response = await safeFetch(`${API_BASE_URL}/users/me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to update profile"));
  }

  return response.json();
}

export async function disconnectSessionRequest() {
  const response = await safeFetch(`${API_BASE_URL}/auth/disconnect`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to disconnect session"));
  }

  return response.json();
}
