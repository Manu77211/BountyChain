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

function normalizeApiErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("database unavailable")) {
    return "Backend database is currently unavailable. Check DATABASE_URL and API server status.";
  }
  if (normalized.includes("cannot reach api server")) {
    return "Backend API is unreachable. Start the API server and verify NEXT_PUBLIC_API_URL.";
  }
  return message;
}

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

    const fieldErrors = payload.issues?.fieldErrors
      ? Object.values(payload.issues.fieldErrors).flat().filter(Boolean)
      : [];

    const formErrors = payload.issues?.formErrors ?? [];
    const merged = [...formErrors, ...fieldErrors];

    if (merged.length > 0) {
      return normalizeApiErrorMessage(merged.join(" | "));
    }

    if (payload.detail) {
      return normalizeApiErrorMessage(payload.detail);
    }

    if (payload.message) {
      return normalizeApiErrorMessage(payload.message);
    }

    return normalizeApiErrorMessage(fallback);
  }
  const text = await response.text();
  return normalizeApiErrorMessage(text || fallback);
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
    role: "CLIENT" | "FREELANCER" | "ADMIN" | "ARBITRATOR";
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

  const mappedRole =
    data.user.role === "client"
      ? "CLIENT"
      : data.user.role === "arbitrator"
        ? "ARBITRATOR"
        : data.user.role === "admin"
          ? "ADMIN"
          : "FREELANCER";
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

export async function getAuthNonceRequest(walletAddress?: string) {
  const query = new URLSearchParams();
  if (walletAddress) {
    query.set("wallet_address", walletAddress);
  }

  const suffix = query.toString() ? `?${query.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/auth/nonce${suffix}`, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to request wallet nonce"));
  }

  return (await response.json()) as {
    nonce: string;
    message: string;
    expires_in: number;
  };
}

export async function authMeRequest(token?: string) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await safeFetch(`${API_BASE_URL}/auth/me`, {
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to refresh auth session"));
  }

  return (await response.json()) as {
    user: AuthPayload["user"] & { wallet_address?: string };
  };
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

export async function meStatsRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/users/me/stats`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load dashboard stats"));
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

export async function getFreelancerRequest(freelancerId: string) {
  const response = await safeFetch(`${API_BASE_URL}/freelancers/${freelancerId}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load freelancer"));
  }
  return response.json();
}

export async function createProjectRequest(
  token: string,
  payload: {
    title: string;
    description: string;
    acceptanceCriteria: string;
    requiredSkills: string[];
    totalAmountMicroAlgo: number;
    deadline: string;
    workType: "STRUCTURED" | "CREATIVE";
  },
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

export async function listMyProjectApplicationsRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/my-applications`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load project applications"));
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

export async function retriggerSubmissionCiRequest(token: string, submissionId: string) {
  const response = await safeFetch(`${API_BASE_URL}/submissions/${submissionId}/retrigger-ci`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to re-trigger CI"));
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

export async function listProjectMeetingsRequest(token: string, projectId: string) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/meetings`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load meetings"));
  }

  return response.json();
}

export async function createProjectMeetingRequest(
  token: string,
  projectId: string,
  payload: {
    title: string;
    agenda?: string;
    scheduledFor: string;
  },
) {
  const response = await safeFetch(`${API_BASE_URL}/projects/${projectId}/meetings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to schedule meeting"));
  }

  return response.json();
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

export async function listMyBountiesRequest(
  token: string,
  params?: {
    status?: string;
    language?: string;
    limit?: number;
    cursor?: string;
  },
) {
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
  const response = await safeFetch(`${API_BASE_URL}/bounties/mine${suffix}`, {
    headers: withAuth(token),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load your bounties"));
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

export async function extendBountyDeadlineRequest(token: string, bountyId: string, deadline: string) {
  const response = await safeFetch(`${API_BASE_URL}/bounties/${bountyId}/extend-deadline`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify({ deadline }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to extend deadline"));
  }

  return response.json();
}

export async function cancelBountyRequest(token: string, bountyId: string) {
  const response = await safeFetch(`${API_BASE_URL}/bounties/${bountyId}`, {
    method: "DELETE",
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to cancel bounty"));
  }

  return response.json();
}

export async function validateGithubRepoRequest(token: string, repoUrl: string) {
  const search = new URLSearchParams({ url: repoUrl });
  const response = await safeFetch(`${API_BASE_URL}/github/validate-repo?${search.toString()}`, {
    headers: withAuth(token),
  });

  const payload = (await response.json()) as {
    error?: string;
    code?: number;
    detail?: string;
    install_url?: string;
    repository_accessible?: boolean;
    app_installed?: boolean;
    has_workflows?: boolean;
    warning?: string | null;
  };

  if (!response.ok) {
    return {
      ok: false,
      detail: payload.detail ?? payload.error ?? "Failed to validate repository",
      install_url: payload.install_url ?? null,
    };
  }

  return {
    ok: true,
    repository_accessible: Boolean(payload.repository_accessible),
    app_installed: Boolean(payload.app_installed),
    has_workflows: Boolean(payload.has_workflows),
    warning: payload.warning ?? null,
    install_url: payload.install_url ?? null,
  };
}

export async function getBountyContextRequest(token: string, bountyId: string) {
  const response = await safeFetch(`${API_BASE_URL}/bounties/${bountyId}/context`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load bounty context"));
  }

  return response.json() as Promise<{
    bounty: Record<string, unknown>;
    creator: { id: string; wallet_address: string; email: string | null } | null;
    milestones: Array<Record<string, unknown>>;
    submissions: Array<Record<string, unknown>>;
    submissions_count: number;
    active_submission_count: number;
    viewer: {
      role: string;
      user_id: string;
      is_client: boolean;
      is_freelancer: boolean;
    };
    activity: Array<{
      key: string;
      label: string;
      at: string;
      detail?: string;
    }>;
  }>;
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

export async function listSubmissionsRequest(token: string, params?: { query?: string; limit?: number }) {
  const search = new URLSearchParams();
  if (params?.query) {
    search.set("query", params.query);
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/submissions${suffix}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load submissions"));
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

export async function listDisputesRequest(
  token: string,
  params?: {
    scope?: "my" | "arbitrator";
    status?: string;
    limit?: number;
  },
) {
  const search = new URLSearchParams();
  if (params?.scope) {
    search.set("scope", params.scope);
  }
  if (params?.status) {
    search.set("status", params.status);
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/disputes${suffix}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load disputes"));
  }

  return response.json();
}

export async function getDisputeActivityRequest(token: string, disputeId: string) {
  const response = await safeFetch(`${API_BASE_URL}/disputes/${disputeId}/activity`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load dispute activity"));
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

export async function getProfileSummaryRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/users/me/summary`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load profile summary"));
  }

  return response.json();
}

export async function listProfileActivitiesRequest(
  token: string,
  params: {
    type: "bounties" | "submissions" | "payouts" | "disputes";
    page?: number;
    page_size?: number;
    from?: string;
    to?: string;
  },
) {
  const search = new URLSearchParams({ type: params.type });
  if (params.page) {
    search.set("page", String(params.page));
  }
  if (params.page_size) {
    search.set("page_size", String(params.page_size));
  }
  if (params.from) {
    search.set("from", params.from);
  }
  if (params.to) {
    search.set("to", params.to);
  }

  const response = await safeFetch(`${API_BASE_URL}/users/me/activities?${search.toString()}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load profile activities"));
  }

  return response.json();
}

export async function listProfilePayoutsRequest(
  token: string,
  params?: {
    page?: number;
    page_size?: number;
    from?: string;
    to?: string;
  },
) {
  const search = new URLSearchParams();
  if (params?.page) {
    search.set("page", String(params.page));
  }
  if (params?.page_size) {
    search.set("page_size", String(params.page_size));
  }
  if (params?.from) {
    search.set("from", params.from);
  }
  if (params?.to) {
    search.set("to", params.to);
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/users/me/payouts${suffix}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load payout history"));
  }

  return response.json();
}

export async function adminOverviewRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/admin/overview`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load admin overview"));
  }

  return response.json();
}

export async function adminConsistencyAlertsRequest(token: string) {
  const response = await safeFetch(`${API_BASE_URL}/admin/consistency-alerts`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load consistency alerts"));
  }

  return response.json();
}

export async function adminListBountiesRequest(
  token: string,
  params?: {
    status?: string;
    creator?: string;
    from?: string;
    to?: string;
    limit?: number;
  },
) {
  const search = new URLSearchParams();
  if (params?.status) {
    search.set("status", params.status);
  }
  if (params?.creator) {
    search.set("creator", params.creator);
  }
  if (params?.from) {
    search.set("from", params.from);
  }
  if (params?.to) {
    search.set("to", params.to);
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/admin/bounties${suffix}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load admin bounties"));
  }

  return response.json();
}

export async function adminBountyActionRequest(
  token: string,
  bountyId: string,
  action: "force-expire" | "force-refund" | "override-scoring" | "cancel",
  payload?: Record<string, unknown>,
) {
  const response = await safeFetch(`${API_BASE_URL}/admin/bounties/${bountyId}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to run bounty admin action"));
  }

  return response.json();
}

export async function adminListUsersRequest(
  token: string,
  params?: { query?: string; role?: "client" | "freelancer" | "arbitrator" | "admin"; limit?: number },
) {
  const search = new URLSearchParams();
  if (params?.query) {
    search.set("query", params.query);
  }
  if (params?.role) {
    search.set("role", params.role);
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/admin/users${suffix}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load admin users"));
  }

  return response.json();
}

export async function adminRemoveBanRequest(token: string, userId: string) {
  const response = await safeFetch(`${API_BASE_URL}/admin/users/${userId}/remove-ban`, {
    method: "POST",
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to remove ban"));
  }

  return response.json();
}

export async function adminChangeRoleRequest(
  token: string,
  userId: string,
  role: "client" | "freelancer" | "arbitrator" | "admin",
) {
  const response = await safeFetch(`${API_BASE_URL}/admin/users/${userId}/change-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify({ role }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to change role"));
  }

  return response.json();
}

export async function adminBanWalletRequest(
  token: string,
  payload: {
    wallet_address: string;
    reason: string;
    mfa_token: string;
  },
) {
  const response = await safeFetch(`${API_BASE_URL}/admin/ban-wallet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to ban wallet"));
  }

  return response.json();
}

export async function adminListDisputesRequest(token: string, params?: { status?: string; limit?: number }) {
  const search = new URLSearchParams();
  if (params?.status) {
    search.set("status", params.status);
  }
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/admin/disputes${suffix}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load admin disputes"));
  }

  return response.json();
}

export async function adminManualResolveDisputeRequest(
  token: string,
  disputeId: string,
  payload: {
    outcome: "freelancer_wins" | "client_wins" | "split";
    freelancer_share_percent?: number;
    justification: string;
  },
) {
  const response = await safeFetch(`${API_BASE_URL}/admin/disputes/${disputeId}/manual-resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...withAuth(token),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to manually resolve dispute"));
  }

  return response.json();
}

export async function adminDeadLettersRequest(token: string, params?: { limit?: number }) {
  const search = new URLSearchParams();
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }

  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await safeFetch(`${API_BASE_URL}/admin/dead-letters${suffix}`, {
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to load dead letters"));
  }

  return response.json();
}

export async function adminRetryDeadLetterRequest(token: string, id: number) {
  const response = await safeFetch(`${API_BASE_URL}/admin/dead-letters/${id}/retry`, {
    method: "POST",
    headers: withAuth(token),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Failed to retry dead letter"));
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
