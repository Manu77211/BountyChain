"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  approveProjectDraftRequest,
  bootstrapProjectMilestoneRequest,
  createSubmissionReviewCommentRequest,
  createProjectMeetingRequest,
  createMilestoneSubmissionRequest,
  deleteProjectRequest,
  getProjectRequest,
  getSubmissionRequest,
  listProjectMeetingsRequest,
  listProjectApplicantsRequest,
  listSubmissionHackathonRunsRequest,
  listSubmissionReviewCommentsRequest,
  raiseBountyAmountRequest,
  requestSubmissionChangesRequest,
  rateSubmissionRequest,
  retriggerSubmissionCiRequest,
  selectProjectApplicantRequest,
  submitSubmissionReviewDecisionRequest,
} from "../../../../lib/api";
import { formatAlgoWithMicro, fromMicroAlgo, toMicroAlgo } from "../../../../lib/algo";
import { canReleaseEscrow, hasDistinctParticipants } from "../../../../lib/project-config";
import { useAuthStore } from "../../../../store/auth-store";
import { Button, Card, Input, PageIntro, Pill, ProgressBar, Textarea } from "../../../../components/ui/primitives";

type MilestoneFormState = {
  fileUrl: string;
  workDescription: string;
  deliverables: string;
  testingNotes: string;
  notes: string;
  isGithubWork: boolean;
};

type SubmissionView = {
  id: string;
  status: string;
  stage?: string;
  reviewGateStatus?: string;
  fileUrl?: string;
  notes?: string;
  clientRating?: number;
  clientFeedback?: string;
  feedbackSummary?: {
    client?: string;
    freelancer?: string;
    implementedItems?: string[];
    missingItems?: string[];
  };
};

type MilestoneView = {
  id: string;
  title: string;
  amount?: number;
  status: string;
  submissions?: SubmissionView[];
};

type ParticipantView = {
  id: string;
  name: string;
  sanctionsStatus?: string;
};

type ValidationReportView = {
  aiScore?: number;
  clientRating?: number;
  finalScore?: number;
  decision?: string;
  clientSanctionsStatus?: string;
  freelancerSanctionsStatus?: string;
  breakdown?: {
    missingElements?: string[];
  };
};

type ApplicantView = {
  id: string;
  status?: string;
  message?: string;
  proposedAmount?: number;
  estimatedDays?: number;
  deliverables?: string;
  freelancer?: {
    id: string;
    name: string;
    rating?: number;
    trustScore?: number;
  };
};

type ProjectMeeting = {
  id: string;
  projectId: string;
  title: string;
  agenda?: string;
  meetingUrl: string;
  scheduledFor: string;
  createdAt: string;
  scheduledBy: string;
};

type ProjectDetailView = {
  id: string;
  title: string;
  description?: string;
  status: string;
  draftApproved?: boolean;
  criteria?: {
    acceptanceCriteria?: string;
    requiredSkills?: string[];
    totalAmountMicroAlgo?: number;
    deadline?: string;
    scoringMode?: string;
  };
  client: ParticipantView;
  freelancer?: ParticipantView | null;
  milestones?: MilestoneView[];
  validationReports?: ValidationReportView[];
};

type ReviewCommentView = {
  id: string;
  content: string;
  comment_type: string;
  visibility: string;
  author_name: string;
  created_at: string;
};

type SubmissionDetailView = {
  submission?: {
    id: string;
    status: string;
    stage?: string;
    review_gate_status?: string;
    ci_status?: string;
    ai_score?: number | null;
    final_score?: number | null;
    approved_for_payout_at?: string | null;
  };
  payout?: {
    status?: string | null;
    tx_id?: string | null;
    tx_url?: string | null;
  };
  revisions?: Array<{
    id: string;
    revision_no: number;
    stage: string;
    artifact_url: string;
    notes?: string | null;
    created_at: string;
  }>;
};

type HackathonRunView = {
  id: string;
  action: "rate_decide" | "approve_review";
  decision: "approve" | "request_changes" | "reject";
  score: number;
  code_review_source: "groq" | "db_template";
  lock_tx_id: string | null;
  transfer_tx_id: string | null;
  created_at: string;
};

function normalizeArtifactUrl(value: string) {
  const raw = value.trim();
  if (!raw) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

const EMPTY_MILESTONE_FORM: MilestoneFormState = {
  fileUrl: "",
  workDescription: "",
  deliverables: "",
  testingNotes: "",
  notes: "",
  isGithubWork: false,
};

function buildSubmissionNotes(state: MilestoneFormState) {
  const sections = [
    ["Work Description", state.workDescription],
    ["Deliverables", state.deliverables],
    ["Testing Instructions", state.testingNotes],
    ["Additional Notes", state.notes],
  ] as const;

  return sections
    .map(([label, value]) => {
      const content = value.trim();
      if (!content) {
        return "";
      }
      return `${label}:\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function timelineTone(state: "done" | "active" | "pending" | "failed") {
  if (state === "done") {
    return "border-[#246a24] bg-[#e7f6e7] text-[#246a24]";
  }
  if (state === "active") {
    return "border-[#24406a] bg-[#e8f0ff] text-[#24406a]";
  }
  if (state === "failed") {
    return "border-[#8f1515] bg-[#ffe9e9] text-[#8f1515]";
  }
  return "border-[#707070] bg-[#f3f3f3] text-[#555]";
}

function buildSubmissionTimeline(detail?: SubmissionDetailView, fallback?: SubmissionView) {
  const submission = detail?.submission;
  const payout = detail?.payout;
  const stage = (submission?.stage ?? fallback?.stage ?? "").toLowerCase();
  const reviewGate = (submission?.review_gate_status ?? fallback?.reviewGateStatus ?? "").toLowerCase();
  const ciStatus = (submission?.ci_status ?? "").toLowerCase();
  const hasSubmission = Boolean(submission?.id ?? fallback?.id);
  const hasAiScore = submission?.ai_score !== null && submission?.ai_score !== undefined;
  const hasFinalScore = submission?.final_score !== null && submission?.final_score !== undefined;
  const payoutStatus = String(payout?.status ?? "").toLowerCase();
  const payoutReleased = Boolean(payout?.tx_id) || ["released", "paid", "completed", "success"].includes(payoutStatus);
  const payoutFailed = ["failed", "cancelled", "reversed"].includes(payoutStatus);

  const ciRunning = ["pending", "queued", "running", "awaiting_ci", "in_progress", "validating"].includes(ciStatus);
  const ciPassed = ["passed", "success"].includes(ciStatus);
  const ciFailed = ["failed", "timeout", "error", "cancelled"].includes(ciStatus);
  const awaitingApproval = ["awaiting_client_review", "changes_requested"].includes(reviewGate);
  const approved = ["approved", "auto_released"].includes(reviewGate);
  const approvalRejected = reviewGate === "rejected";

  return [
    { label: "Submitted", state: hasSubmission && stage !== "draft" ? "done" : hasSubmission ? "active" : "pending" },
    { label: "CI Running", state: ciRunning ? "active" : ciPassed || ciFailed ? "done" : hasSubmission ? "pending" : "pending" },
    { label: "CI Passed/Failed", state: ciPassed ? "done" : ciFailed ? "failed" : "pending" },
    { label: "AI Scored", state: hasAiScore || hasFinalScore ? "done" : ciPassed ? "active" : "pending" },
    { label: "Awaiting Approval", state: awaitingApproval ? "active" : approved || approvalRejected ? "done" : "pending" },
    { label: "Approved", state: approved ? "done" : approvalRejected ? "failed" : "pending" },
    { label: "Payout Released", state: payoutReleased ? "done" : payoutFailed ? "failed" : "pending" },
  ] as const;
}

export default function DashboardProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const { token, user, hydrate } = useAuthStore();

  const [project, setProject] = useState<ProjectDetailView | null>(null);
  const [applicants, setApplicants] = useState<ApplicantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ratingInputs, setRatingInputs] = useState<Record<string, string>>({});
  const [feedbackInputs, setFeedbackInputs] = useState<Record<string, string>>({});
  const [milestoneForms, setMilestoneForms] = useState<Record<string, MilestoneFormState>>({});
  const [validationResult, setValidationResult] = useState<ValidationReportView | null>(null);
  const [meetings, setMeetings] = useState<ProjectMeeting[]>([]);
  const [reviewComments, setReviewComments] = useState<Record<string, ReviewCommentView[]>>({});
  const [submissionDetails, setSubmissionDetails] = useState<Record<string, SubmissionDetailView>>({});
  const [hackathonRuns, setHackathonRuns] = useState<Record<string, HackathonRunView[]>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [meetingTitle, setMeetingTitle] = useState("Weekly Sync");
  const [meetingAgenda, setMeetingAgenda] = useState("");
  const [raiseAmountAlgo, setRaiseAmountAlgo] = useState("");
  const [raisingAmount, setRaisingAmount] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [meetingTime, setMeetingTime] = useState(() => {
    const base = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const local = new Date(base.getTime() - base.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  });

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadProject = useCallback(async () => {
    if (!token || !projectId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = (await getProjectRequest(token, projectId)) as ProjectDetailView;
      setProject(data);
      setRaiseAmountAlgo(fromMicroAlgo(data.criteria?.totalAmountMicroAlgo).toFixed(2));

      try {
        const meetingList = (await listProjectMeetingsRequest(token, projectId)) as ProjectMeeting[];
        setMeetings(meetingList ?? []);
      } catch {
        setMeetings([]);
      }

      if (user?.role === "CLIENT") {
        const applicantData = (await listProjectApplicantsRequest(token, projectId)) as ApplicantView[];
        setApplicants(applicantData);
      } else {
        setApplicants([]);
      }

      const initialForms = (data.milestones ?? []).reduce((acc: Record<string, MilestoneFormState>, milestone) => {
        acc[milestone.id] = { ...EMPTY_MILESTONE_FORM };
        return acc;
      }, {});
      setMilestoneForms(initialForms);

      const initialRatings = (data.milestones ?? []).reduce((acc: Record<string, string>, milestone) => {
        const latestSubmission = milestone.submissions?.[0];
        if (latestSubmission?.id) {
          acc[latestSubmission.id] = latestSubmission.clientRating ? String(latestSubmission.clientRating) : "70";
        }
        return acc;
      }, {});
      setRatingInputs(initialRatings);

      const initialFeedback = (data.milestones ?? []).reduce((acc: Record<string, string>, milestone) => {
        const latestSubmission = milestone.submissions?.[0];
        if (latestSubmission?.id) {
          acc[latestSubmission.id] = latestSubmission.clientFeedback ?? "";
        }
        return acc;
      }, {});
      setFeedbackInputs(initialFeedback);

      const submissionIds = (data.milestones ?? [])
        .map((milestone) => milestone.submissions?.[0]?.id)
        .filter((id): id is string => Boolean(id));
      const uniqueSubmissionIds = Array.from(new Set(submissionIds));
      if (uniqueSubmissionIds.length > 0) {
        const commentsEntries = await Promise.all(
          uniqueSubmissionIds.map(async (submissionId) => {
            try {
              const payload = (await listSubmissionReviewCommentsRequest(token, submissionId)) as {
                data?: ReviewCommentView[];
              };
              return [submissionId, payload.data ?? []] as const;
            } catch {
              return [submissionId, []] as const;
            }
          }),
        );
        setReviewComments(Object.fromEntries(commentsEntries));

        const detailEntries = await Promise.all(
          uniqueSubmissionIds.map(async (submissionId) => {
            try {
              const payload = (await getSubmissionRequest(token, submissionId)) as {
                submission?: SubmissionDetailView["submission"];
                payout?: SubmissionDetailView["payout"];
                revisions?: SubmissionDetailView["revisions"];
              };
              return [
                submissionId,
                {
                  submission: payload.submission,
                  payout: payload.payout,
                  revisions: payload.revisions ?? [],
                },
              ] as const;
            } catch {
              return [submissionId, { revisions: [] }] as const;
            }
          }),
        );
        setSubmissionDetails(Object.fromEntries(detailEntries));

        const runEntries = await Promise.all(
          uniqueSubmissionIds.map(async (submissionId) => {
            try {
              const payload = (await listSubmissionHackathonRunsRequest(token, submissionId)) as {
                data?: HackathonRunView[];
              };
              return [submissionId, payload.data ?? []] as const;
            } catch {
              return [submissionId, []] as const;
            }
          }),
        );
        setHackathonRuns(Object.fromEntries(runEntries));
      } else {
        setReviewComments({});
        setSubmissionDetails({});
        setHackathonRuns({});
      }

      if (data.validationReports?.length) {
        setValidationResult(data.validationReports[0]);
      }
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [token, projectId, user?.role]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  const finalScore = validationResult?.finalScore ?? 0;
  const requirementMatch = Math.min(100, Math.max(0, finalScore + 8));
  const completeness = Math.min(100, Math.max(0, finalScore));
  const qualityMetrics = Math.min(100, Math.max(0, finalScore - 6));
  const releaseGuard = canReleaseEscrow({
    validationDecision: validationResult?.decision,
    clientSanctionsStatus: project?.client?.sanctionsStatus ?? validationResult?.clientSanctionsStatus,
    freelancerSanctionsStatus: project?.freelancer?.sanctionsStatus ?? validationResult?.freelancerSanctionsStatus,
    clientId: project?.client?.id,
    freelancerId: project?.freelancer?.id,
  });
  const paymentStatus: "LOCKED" | "RELEASED" | "DISPUTED" = releaseGuard.allowed
    ? "RELEASED"
    : validationResult?.decision === "REJECTED"
      ? "DISPUTED"
      : "LOCKED";

  const viewerRole = String(user?.role ?? "").toUpperCase();
  const isHackathonMode = process.env.NEXT_PUBLIC_HACKATHON_MODE === "true";
  const isAssignedFreelancer = Boolean(
    project?.freelancer?.id && user?.id && project.freelancer.id === user.id,
  );
  const canApproveDraft = user?.role === "CLIENT";
  const canSubmit = viewerRole === "FREELANCER" && (isAssignedFreelancer || isHackathonMode);

  const milestoneProgress = useMemo(() => {
    if (!project?.milestones?.length) {
      return 0;
    }

    const approved = project.milestones.filter((item) => item.status === "APPROVED").length;
    return (approved / project.milestones.length) * 100;
  }, [project]);

  const latestSubmissionForTimeline = useMemo(() => {
    const all = (project?.milestones ?? [])
      .map((milestone) => milestone.submissions?.[0])
      .filter((submission): submission is SubmissionView => Boolean(submission?.id));
    return all[0] ?? null;
  }, [project?.milestones]);

  const latestTimelineDetail = latestSubmissionForTimeline
    ? submissionDetails[latestSubmissionForTimeline.id]
    : undefined;

  async function onApproveDraft() {
    if (!token || !projectId) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await approveProjectDraftRequest(token, projectId);
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onSelectApplicant(applicationId: string) {
    if (!token || !projectId) {
      return;
    }

    const selectedApplicant = applicants.find((item) => item.id === applicationId);
    if (!hasDistinctParticipants(project?.client?.id, selectedApplicant?.freelancer?.id)) {
      setError("Client and freelancer cannot be the same user on a bounty.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await selectProjectApplicantRequest(token, projectId, applicationId);
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onSubmitMilestone(milestoneId: string, submissionKind: "DRAFT" | "FINAL") {
    if (!token || !projectId) {
      return;
    }

    const state = milestoneForms[milestoneId] ?? EMPTY_MILESTONE_FORM;
    const fileUrl = normalizeArtifactUrl(state.fileUrl);
    const workDescription = state.workDescription.trim();
    const notes = buildSubmissionNotes(state);

    if (workDescription.length < 12) {
      setError("Please add a short work description (at least 12 characters).");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const result = (await createMilestoneSubmissionRequest(token, projectId, milestoneId, {
        kind: submissionKind,
        fileUrl: fileUrl || undefined,
        notes: notes || undefined,
      })) as {
        status?: string;
        downgradedToDraft?: boolean;
        ciValidationQueued?: boolean;
        ciValidationFallbackRan?: boolean;
        ciValidationStarted?: boolean;
      };

      if (submissionKind === "FINAL" && (result.downgradedToDraft || String(result.status ?? "").toLowerCase() === "draft")) {
        setNotice("Final submit was saved as draft because URL was not usable. Update URL and submit final again.");
      } else if (submissionKind === "FINAL" && result.ciValidationStarted === false) {
        setNotice("Final submission saved, but CI start failed right now. Use Re-run CI to retry.");
      } else if (submissionKind === "FINAL" && result.ciValidationFallbackRan) {
        setNotice("Final submission saved. CI fallback processing started directly.");
      } else {
        setNotice(submissionKind === "FINAL" ? "Final submission saved." : "Draft saved.");
      }

      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onBootstrapMilestone() {
    if (!token || !projectId) {
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = (await bootstrapProjectMilestoneRequest(token, projectId)) as {
        created?: boolean;
        milestones?: Array<{
          id: string;
          title: string;
          amount?: number;
          status: string;
        }>;
      };

      if (result.milestones && result.milestones.length > 0) {
        setProject((current) =>
          current
            ? {
                ...current,
                milestones: result.milestones?.map((item) => ({
                  id: item.id,
                  title: item.title,
                  amount: item.amount,
                  status: item.status,
                  submissions: [],
                })),
              }
            : current,
        );
      }

      if (result.created) {
        setNotice("Milestone 1 created.");
      } else {
        setNotice("Milestone already exists.");
      }
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onRateSubmission(submissionId: string) {
    if (!token) {
      return;
    }

    const value = Number(ratingInputs[submissionId] ?? "0");
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setError("Rating must be between 0 and 100");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const comment = (feedbackInputs[submissionId] ?? "").trim();
      const report = (await rateSubmissionRequest(token, submissionId, value, {
        comment: comment.length > 0 ? comment : undefined,
        rubric: {
          completeness: value,
          quality: value,
          communication: value,
          requirementAlignment: value,
        },
      })) as ValidationReportView & {
        payoutReleaseQueued?: boolean;
        payoutReleaseFallbackRan?: boolean;
        payoutReleaseError?: string | null;
        hackathonReviewQueued?: boolean;
        hackathonReviewFallbackRan?: boolean;
        hackathonReviewScore?: number | null;
        hackathonCodeReviewSource?: "groq" | "db_template" | null;
        hackathonLockTxId?: string | null;
        hackathonTransferTxId?: string | null;
        hackathonReviewError?: string | null;
      };
      setValidationResult(report);

      if (report.hackathonReviewError) {
        setNotice(report.hackathonReviewError);
      } else if (report.hackathonReviewQueued || report.hackathonReviewFallbackRan) {
        const parts = [
          `Hackathon review score ${report.hackathonReviewScore ?? "n/a"}`,
          `source ${report.hackathonCodeReviewSource ?? "n/a"}`,
        ];
        if (report.hackathonLockTxId) {
          parts.push(`lock https://testnet.algoexplorer.io/tx/${encodeURIComponent(report.hackathonLockTxId)}`);
        }
        if (report.hackathonTransferTxId) {
          parts.push(`transfer https://testnet.algoexplorer.io/tx/${encodeURIComponent(report.hackathonTransferTxId)}`);
        }
        setNotice(parts.join(" | "));
      } else if (report.payoutReleaseQueued === false) {
        setNotice(report.payoutReleaseError ?? "Review saved, but payout queue failed. Retry from Review actions.");
      } else if (report.payoutReleaseFallbackRan) {
        setNotice("Review saved and payout fallback processing started.");
      }

      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onRaiseAmount() {
    if (!token || !projectId || user?.role !== "CLIENT") {
      return;
    }

    const parsed = Number(raiseAmountAlgo);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a valid ALGO amount.");
      return;
    }

    setRaisingAmount(true);
    setSaving(true);
    setError(null);
    try {
      await raiseBountyAmountRequest(token, projectId, String(toMicroAlgo(parsed)));
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRaisingAmount(false);
      setSaving(false);
    }
  }

  async function onDeleteProject() {
    if (!token || !projectId || user?.role !== "CLIENT") {
      return;
    }

    const confirmed = window.confirm(
      "Delete this bounty? This action will cancel and remove it from active views.",
    );
    if (!confirmed) {
      return;
    }

    setDeletingProject(true);
    setSaving(true);
    setError(null);
    try {
      await deleteProjectRequest(token, projectId);
      router.push("/dashboard/projects");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingProject(false);
      setSaving(false);
    }
  }

  async function onRequestChanges(submissionId: string) {
    if (!token) {
      return;
    }

    const feedback = (feedbackInputs[submissionId] ?? "").trim();
    if (feedback.length < 5) {
      setError("Please add at least 5 characters of feedback before requesting changes");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await requestSubmissionChangesRequest(token, submissionId, feedback);
      setNotice("Change request sent. Submission moved back to pending.");
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onAddReviewComment(submissionId: string) {
    if (!token) {
      return;
    }

    const content = (reviewDrafts[submissionId] ?? "").trim();
    if (content.length < 3) {
      setError("Review comment must be at least 3 characters.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await createSubmissionReviewCommentRequest(token, submissionId, {
        content,
        commentType: "note",
        visibility: "both",
      });
      const payload = (await listSubmissionReviewCommentsRequest(token, submissionId)) as {
        data?: ReviewCommentView[];
      };
      setReviewComments((prev) => ({ ...prev, [submissionId]: payload.data ?? [] }));
      setReviewDrafts((prev) => ({ ...prev, [submissionId]: "" }));
      setNotice("Review comment posted.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onSubmitReviewDecision(
    submissionId: string,
    decision: "approve" | "request_changes" | "reject",
  ) {
    if (!token) {
      return;
    }

    const comment = (feedbackInputs[submissionId] ?? "").trim();
    if (comment.length < 2) {
      setError("Add a short review note before submitting decision.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = (await submitSubmissionReviewDecisionRequest(token, submissionId, {
        decision,
        comment,
      })) as {
        payoutReleaseQueued?: boolean;
        payoutReleaseFallbackRan?: boolean;
        payoutReleaseError?: string | null;
        hackathonReviewQueued?: boolean;
        hackathonReviewFallbackRan?: boolean;
        hackathonReviewScore?: number | null;
        hackathonCodeReviewSource?: "groq" | "db_template" | null;
        hackathonLockTxId?: string | null;
        hackathonTransferTxId?: string | null;
        hackathonReviewError?: string | null;
      };

      if (result.hackathonReviewError) {
        setNotice(result.hackathonReviewError);
      } else if (result.hackathonReviewQueued || result.hackathonReviewFallbackRan) {
        const parts = [
          `Hackathon review score ${result.hackathonReviewScore ?? "n/a"}`,
          `source ${result.hackathonCodeReviewSource ?? "n/a"}`,
        ];
        if (result.hackathonLockTxId) {
          parts.push(`lock https://testnet.algoexplorer.io/tx/${encodeURIComponent(result.hackathonLockTxId)}`);
        }
        if (result.hackathonTransferTxId) {
          parts.push(`transfer https://testnet.algoexplorer.io/tx/${encodeURIComponent(result.hackathonTransferTxId)}`);
        }
        setNotice(parts.join(" | "));
      } else if (decision === "approve" && result.payoutReleaseQueued === false) {
        setNotice(result.payoutReleaseError ?? "Approval saved, but payout queue failed.");
      } else if (decision === "approve" && result.payoutReleaseFallbackRan) {
        setNotice("Approval saved and payout fallback processing started.");
      } else {
        setNotice("Review decision saved.");
      }
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onRetriggerCi(submissionId: string) {
    if (!token) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = (await retriggerSubmissionCiRequest(token, submissionId)) as {
        ciValidationQueued?: boolean;
        ciValidationFallbackRan?: boolean;
        ciValidationStarted?: boolean;
      };

      if (result.ciValidationStarted === false) {
        setNotice("CI retry requested, but queue start failed.");
      } else if (result.ciValidationFallbackRan) {
        setNotice("CI retry requested and fallback processing started.");
      } else {
        setNotice("CI retry queued.");
      }
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onScheduleMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !projectId) {
      return;
    }

    const title = meetingTitle.trim();
    const when = new Date(meetingTime);
    if (title.length < 3) {
      setError("Meeting title must be at least 3 characters.");
      return;
    }
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      setError("Meeting time must be in the future.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await createProjectMeetingRequest(token, projectId, {
        title,
        agenda: meetingAgenda.trim() || undefined,
        scheduledFor: when.toISOString(),
      });
      const refreshed = (await listProjectMeetingsRequest(token, projectId)) as ProjectMeeting[];
      setMeetings(refreshed ?? []);
      setMeetingAgenda("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function applicantFitScore(application: ApplicantView) {
    const rating = Number(application.freelancer?.rating ?? 0);
    const trust = Number(application.freelancer?.trustScore ?? 0);
    const costBonus = application.proposedAmount ? Math.max(0, 20 - Math.min(20, application.proposedAmount / 50000)) : 10;
    const speedBonus = application.estimatedDays ? Math.max(0, 20 - Math.min(20, application.estimatedDays)) : 8;
    return Math.round(rating * 10 + trust * 0.2 + costBonus + speedBonus);
  }

  if (loading) {
    return <p className="text-[#4b4b4b]">Loading bounty...</p>;
  }

  if (!project) {
    return <p className="text-[#4b4b4b]">Bounty not found.</p>;
  }

  return (
    <section className="space-y-6">
      <PageIntro title={project.title} subtitle="Milestones, submissions, validation, and payout decisions are managed from this bounty workspace." />
      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
      {notice ? <p className="text-sm text-[#1b7b30]">{notice}</p> : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Bounty Header</h2>
            <p className="mt-1 text-sm text-[#4b4b4b]">Participants and status at a glance.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Pill text={project.status} />
              <Pill text={`Client ${project.client.name}`} />
              <Pill text={project.freelancer ? `Freelancer ${project.freelancer.name}` : "Freelancer not assigned"} />
            </div>
          </div>
          {project.freelancer ? (
            <Button asChild variant="secondary">
              <Link href={`/dashboard/chat/${project.id}`}>Open Chat</Link>
            </Button>
          ) : (
            <Button variant="secondary" disabled>
              Assign Freelancer To Enable Chat
            </Button>
          )}
        </div>
        <p className="mt-3 text-sm text-[#4b4b4b]">{project.description ?? "No description provided."}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-[#121212] bg-[#f5f5f5] p-3 text-xs text-[#4b4b4b]">
            <p className="font-semibold text-[#121212]">Acceptance Criteria</p>
            <p className="mt-1">{project.criteria?.acceptanceCriteria ?? "Not specified"}</p>
          </div>
          <div className="rounded-lg border border-[#121212] bg-[#f5f5f5] p-3 text-xs text-[#4b4b4b]">
            <p className="font-semibold text-[#121212]">Project Criteria</p>
            <p className="mt-1">Budget {formatAlgoWithMicro(project.criteria?.totalAmountMicroAlgo, 2)}</p>
            <p className="mt-1">Deadline {project.criteria?.deadline ? new Date(project.criteria.deadline).toLocaleString() : "Not set"}</p>
            {(project.criteria?.requiredSkills ?? []).length ? (
              <p className="mt-1">Skills {(project.criteria?.requiredSkills ?? []).join(", ")}</p>
            ) : null}

            {user?.role === "CLIENT" ? (
              <div className="mt-3 space-y-2 border border-[#121212] bg-white p-2">
                <p className="text-[11px] font-semibold text-[#121212]">Raise Bounty Amount</p>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={raiseAmountAlgo}
                    onChange={(event) => setRaiseAmountAlgo(event.target.value)}
                  />
                  <span className="text-[11px] font-semibold">ALGO</span>
                </div>
                <p className="text-[11px]">1 ALGO = 1,000,000 microALGO</p>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-8 px-3 text-xs"
                  onClick={() => void onRaiseAmount()}
                  disabled={saving || raisingAmount}
                >
                  {raisingAmount ? "Updating..." : "Raise Amount"}
                </Button>

                <Button
                  type="button"
                  className="h-8 px-3 text-xs"
                  onClick={() => void onDeleteProject()}
                  disabled={saving || deletingProject}
                >
                  {deletingProject ? "Deleting..." : "Delete Bounty"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="mt-4">
          <p className="mb-1 text-xs text-[#4b4b4b]">Milestone Completion</p>
          <ProgressBar value={milestoneProgress} />
        </div>
      </Card>

      {user?.role === "CLIENT" ? (
        <Card>
          <h3 className="text-lg font-semibold">Assign Freelancer</h3>
          {applicants.length > 0 ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-[#4b4b4b]">Applicants who showed interest:</p>
              {applicants.map((application) => (
                <div key={application.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                  <div>
                    <p className="font-medium text-[#121212]">{application.freelancer?.name}</p>
                    <p className="text-xs text-[#4b4b4b]">Application Status: {String(application.status ?? "PENDING")}</p>
                    <p className="text-xs text-[#4b4b4b]">Rating {application.freelancer?.rating} | Trust {application.freelancer?.trustScore}</p>
                    <p className="text-xs text-[#4b4b4b]">Fit score {applicantFitScore(application)}</p>
                    {application.message ? (
                      <p className="mt-1 text-xs text-[#5b5b5b]">&quot;{application.message}&quot;</p>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#5b5b5b]">
                      {application.proposedAmount ? <span>Budget {formatAlgoWithMicro(application.proposedAmount, 2)}</span> : null}
                      {application.estimatedDays ? <span>Timeline {application.estimatedDays} days</span> : null}
                    </div>
                    {application.deliverables ? (
                      <p className="mt-1 text-xs text-[#5b5b5b]">Deliverables: {application.deliverables}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                      <Link href={`/dashboard/chat/${project.id}?applicationId=${application.id}`}>Chat Applicant</Link>
                    </Button>
                    <Button
                      onClick={() => void onSelectApplicant(application.id)}
                      disabled={
                        saving ||
                        Boolean(project.freelancer) ||
                        String(application.status ?? "").toUpperCase() === "SELECTED"
                      }
                    >
                      {saving ? "Selecting..." : "Select Applicant"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {applicants.length === 0 ? (
            <p className="mt-3 text-sm text-[#4b4b4b]">
              No applicants yet. Freelancers must apply before you can select one.
            </p>
          ) : null}
        </Card>
      ) : null}

      {project.freelancer ? (
        <Card>
          <h3 className="text-lg font-semibold">Meetings</h3>
          <p className="mt-1 text-sm text-[#4b4b4b]">Schedule collaboration calls after assignment. Meeting links are generated within platform routes.</p>

          {(user?.role === "CLIENT" || user?.role === "FREELANCER") ? (
            <form onSubmit={onScheduleMeeting} className="mt-4 space-y-2">
              <div className="grid gap-2 md:grid-cols-2">
                <Input
                  value={meetingTitle}
                  onChange={(event) => setMeetingTitle(event.target.value)}
                  placeholder="Meeting title"
                  required
                />
                <Input
                  value={meetingTime}
                  onChange={(event) => setMeetingTime(event.target.value)}
                  type="datetime-local"
                  required
                />
              </div>
              <Textarea
                rows={2}
                value={meetingAgenda}
                onChange={(event) => setMeetingAgenda(event.target.value)}
                placeholder="Agenda (optional)"
              />
              <Button type="submit" disabled={saving}>{saving ? "Scheduling..." : "Schedule Meeting"}</Button>
            </form>
          ) : null}

          <div className="mt-4 space-y-2">
            {meetings.map((meeting) => (
              <div key={meeting.id} className="rounded-lg border border-[#121212] bg-[#f5f5f5] p-3">
                <p className="font-medium text-[#121212]">{meeting.title}</p>
                <p className="text-xs text-[#4b4b4b]">{new Date(meeting.scheduledFor).toLocaleString()} | by {meeting.scheduledBy}</p>
                {meeting.agenda ? <p className="mt-1 text-xs text-[#5b5b5b]">{meeting.agenda}</p> : null}
                <a href={meeting.meetingUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-[#1040c0] underline">
                  Open Meeting Link
                </a>
              </div>
            ))}
            {meetings.length === 0 ? <p className="text-sm text-[#4b4b4b]">No meetings scheduled yet.</p> : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">Milestones</h3>
          {canApproveDraft ? (
            <Button variant="secondary" onClick={onApproveDraft} disabled={saving || project.draftApproved}>
              {project.draftApproved ? "Draft Approved" : "Approve Draft"}
            </Button>
          ) : null}
        </div>
        {viewerRole === "FREELANCER" ? (
          <div className="mt-3 rounded-xl border border-[#121212] bg-[#eef4ff] p-3 text-xs text-[#1e2a52]">
            {isAssignedFreelancer
              ? "You are assigned to this bounty. Use Submit Work below for each milestone."
              : project.freelancer
                ? "Another freelancer is currently assigned. You can view updates but cannot submit work."
                : "No freelancer assigned yet. Submit becomes available after client assignment."}
          </div>
        ) : null}
        <div className="mt-4 space-y-3">
          {(project.milestones ?? []).length === 0 ? (
            <div className="rounded-xl border border-[#121212] bg-[#fff8e1] p-4">
              <p className="text-sm font-semibold text-[#121212]">No milestone configured yet</p>
              <p className="mt-1 text-xs text-[#4b4b4b]">
                A milestone is required before work can be submitted. Initialize a default "Delivery" milestone to unlock the full submit form.
              </p>
              {(user?.role === "CLIENT" || canSubmit) ? (
                <Button
                  type="button"
                  className="mt-3"
                  variant="secondary"
                  disabled={saving}
                  onClick={() => void onBootstrapMilestone()}
                >
                  {saving ? "Initializing..." : "Initialize Milestone"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {(project.milestones ?? []).map((milestone) => {
            const latestSubmission = milestone.submissions?.[0];
            const submissionDetail = latestSubmission ? submissionDetails[latestSubmission.id] : undefined;
            return (
            <div key={milestone.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{milestone.title}</p>
                  <p className="text-sm text-[#4b4b4b]">{formatAlgoWithMicro(milestone.amount, 2)}</p>
                </div>
                <Pill text={milestone.status} />
              </div>

              {canSubmit ? (
                <div className="mt-3 space-y-3 border-2 border-[#121212] bg-[linear-gradient(135deg,#fff3d1,#dce8ff)] p-4">
                  <div>
                    <p className="text-sm font-semibold text-[#121212]">Submit Work</p>
                    <p className="text-xs text-[#4b4b4b]">
                      Add what you built, include GitHub URL when relevant, then save draft or submit final.
                    </p>
                  </div>

                  <label className="flex items-center gap-2 text-xs font-semibold text-[#121212]">
                    <input
                      type="checkbox"
                      checked={milestoneForms[milestone.id]?.isGithubWork ?? false}
                      onChange={(event) =>
                        setMilestoneForms((prev) => ({
                          ...prev,
                          [milestone.id]: {
                            ...(prev[milestone.id] ?? EMPTY_MILESTONE_FORM),
                            isGithubWork: event.target.checked,
                          },
                        }))
                      }
                    />
                    This milestone includes GitHub work
                  </label>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#3f3f3f]">GitHub URL</p>
                    <Input
                      type="text"
                      placeholder="https://github.com/org/repo/pull/123"
                      value={milestoneForms[milestone.id]?.fileUrl ?? ""}
                      onChange={(event) =>
                        setMilestoneForms((prev) => ({
                          ...prev,
                          [milestone.id]: {
                            ...(prev[milestone.id] ?? EMPTY_MILESTONE_FORM),
                            fileUrl: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#3f3f3f]">Work Description</p>
                    <Textarea
                      rows={4}
                      placeholder="Explain what you delivered and what the client should review first."
                      onChange={(event) =>
                        setMilestoneForms((prev) => ({
                          ...prev,
                          [milestone.id]: {
                            ...(prev[milestone.id] ?? EMPTY_MILESTONE_FORM),
                            workDescription: event.target.value,
                          },
                        }))
                      }
                      value={milestoneForms[milestone.id]?.workDescription ?? ""}
                    />
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#3f3f3f]">Deliverables</p>
                      <Textarea
                        rows={3}
                        placeholder="List files/features completed for this milestone."
                        onChange={(event) =>
                          setMilestoneForms((prev) => ({
                            ...prev,
                            [milestone.id]: {
                              ...(prev[milestone.id] ?? EMPTY_MILESTONE_FORM),
                              deliverables: event.target.value,
                            },
                          }))
                        }
                        value={milestoneForms[milestone.id]?.deliverables ?? ""}
                      />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#3f3f3f]">Testing Instructions</p>
                      <Textarea
                        rows={3}
                        placeholder="Explain how client can verify this delivery quickly."
                        onChange={(event) =>
                          setMilestoneForms((prev) => ({
                            ...prev,
                            [milestone.id]: {
                              ...(prev[milestone.id] ?? EMPTY_MILESTONE_FORM),
                              testingNotes: event.target.value,
                            },
                          }))
                        }
                        value={milestoneForms[milestone.id]?.testingNotes ?? ""}
                      />
                    </div>
                  </div>

                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#3f3f3f]">Additional Notes (Optional)</p>
                    <Textarea
                      rows={2}
                      placeholder="Anything else reviewers should know."
                      onChange={(event) =>
                        setMilestoneForms((prev) => ({
                          ...prev,
                          [milestone.id]: {
                            ...(prev[milestone.id] ?? EMPTY_MILESTONE_FORM),
                            notes: event.target.value,
                          },
                        }))
                      }
                      value={milestoneForms[milestone.id]?.notes ?? ""}
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={saving}
                      onClick={() => void onSubmitMilestone(milestone.id, "DRAFT")}
                    >
                      {saving ? "Saving..." : "Save Draft"}
                    </Button>
                    <Button
                      type="button"
                      disabled={saving}
                      onClick={() => void onSubmitMilestone(milestone.id, "FINAL")}
                    >
                      {saving ? "Submitting..." : "Submit Work"}
                    </Button>
                  </div>

                  <div className="rounded-lg border border-[#d7d7d7] bg-white p-2">
                    <p className="text-xs font-semibold text-[#121212]">Workflow After Final Submit</p>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {[
                        "Submitted",
                        "CI Running",
                        "CI Passed/Failed",
                        "AI Scored",
                        "Awaiting Approval",
                        "Approved",
                        "Payout Released",
                      ].map((step) => (
                        <div key={step} className="rounded border border-[#707070] bg-[#f3f3f3] px-2 py-1 text-xs text-[#555]">
                          {step}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {user?.role === "FREELANCER" && latestSubmission ? (
                <div className="mt-3 space-y-2 rounded-lg border border-[#121212] bg-[#f5f5f5] p-3">
                  <p className="text-xs font-semibold text-[#121212]">Your Latest Submission</p>
                  <p className="text-xs text-[#4b4b4b]">
                    Status: {latestSubmission.status}
                    {latestSubmission.stage ? ` | stage: ${latestSubmission.stage}` : ""}
                    {latestSubmission.reviewGateStatus ? ` | gate: ${latestSubmission.reviewGateStatus}` : ""}
                    {submissionDetail?.submission?.ci_status ? ` | ci: ${submissionDetail.submission.ci_status}` : ""}
                  </p>

                  <div className="rounded-lg border border-[#d7d7d7] bg-white p-2">
                    <p className="text-xs font-semibold text-[#121212]">Submit Workflow Timeline</p>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {buildSubmissionTimeline(submissionDetail, latestSubmission).map((step) => (
                        <div key={step.label} className={`rounded border px-2 py-1 text-xs ${timelineTone(step.state)}`}>
                          {step.label}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-[#4b4b4b] md:grid-cols-2">
                      <p>CI status: {submissionDetail?.submission?.ci_status ?? "n/a"}</p>
                      <p>Review gate: {submissionDetail?.submission?.review_gate_status ?? latestSubmission.reviewGateStatus ?? "n/a"}</p>
                      <p>AI score: {submissionDetail?.submission?.ai_score ?? "n/a"}</p>
                      <p>Final score: {submissionDetail?.submission?.final_score ?? "n/a"}</p>
                      <p>Payout status: {submissionDetail?.payout?.status ?? "n/a"}</p>
                      <p>Payout tx: {submissionDetail?.payout?.tx_id ?? "n/a"}</p>
                    </div>
                    <div className="mt-2">
                      <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                        <Link href={`/submissions/${latestSubmission.id}`}>Open Full CI/Score Logs</Link>
                      </Button>
                    </div>
                  </div>

                  {latestSubmission.fileUrl ? (
                    <p className="text-xs text-[#4b4b4b]">
                      GitHub / Artifact URL:{" "}
                      <a className="text-[#1040c0] underline" href={latestSubmission.fileUrl} target="_blank" rel="noreferrer">
                        Open Link
                      </a>
                    </p>
                  ) : null}
                  {latestSubmission.notes ? (
                    <p className="text-xs text-[#4b4b4b]">Description: {latestSubmission.notes}</p>
                  ) : null}
                  <div className="rounded-lg border border-[#d7d7d7] bg-white p-2">
                    <p className="text-xs font-semibold text-[#121212]">Revision History</p>
                    {(submissionDetail?.revisions ?? []).length > 0 ? (
                      <div className="mt-1 space-y-1 text-xs text-[#4b4b4b]">
                        {(submissionDetail?.revisions ?? []).map((revision) => (
                          <p key={revision.id}>
                            Rev {revision.revision_no} ({revision.stage}) - {new Date(revision.created_at).toLocaleString()}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-[#4b4b4b]">No revisions recorded yet.</p>
                    )}
                  </div>
                </div>
              ) : null}

              {user?.role === "CLIENT" && latestSubmission ? (
                <div className="mt-3 space-y-2 rounded-lg border border-[#121212] bg-[#f5f5f5] p-3">
                  <p className="text-xs text-[#4b4b4b]">
                    Latest submission status: {latestSubmission.status}
                    {latestSubmission.stage ? ` | stage: ${latestSubmission.stage}` : ""}
                    {latestSubmission.reviewGateStatus ? ` | gate: ${latestSubmission.reviewGateStatus}` : ""}
                    {submissionDetail?.submission?.ci_status ? ` | ci: ${submissionDetail.submission.ci_status}` : ""}
                  </p>

                  <div className="rounded-lg border border-[#d7d7d7] bg-white p-2">
                    <p className="text-xs font-semibold text-[#121212]">Submission Timeline</p>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {buildSubmissionTimeline(submissionDetail, latestSubmission).map((step) => (
                        <div key={step.label} className={`rounded border px-2 py-1 text-xs ${timelineTone(step.state)}`}>
                          {step.label}
                        </div>
                      ))}
                    </div>
                  </div>

                  {latestSubmission.fileUrl ? (
                    <p className="text-xs text-[#4b4b4b]">
                      File: <a className="text-[#1040c0] underline" href={latestSubmission.fileUrl} target="_blank" rel="noreferrer">Open submission artifact</a>
                    </p>
                  ) : null}
                  {latestSubmission.notes ? (
                    <p className="text-xs text-[#4b4b4b]">Notes: {latestSubmission.notes}</p>
                  ) : null}
                  {latestSubmission.feedbackSummary?.client ? (
                    <p className="text-xs text-[#4b4b4b]">Coverage summary: {latestSubmission.feedbackSummary.client}</p>
                  ) : null}
                  <div className="rounded-lg border border-[#d7d7d7] bg-white p-2">
                    <p className="text-xs font-semibold text-[#121212]">Revision History</p>
                    {(submissionDetail?.revisions ?? []).length > 0 ? (
                      <div className="mt-1 space-y-1 text-xs text-[#4b4b4b]">
                        {(submissionDetail?.revisions ?? []).map((revision) => (
                          <p key={revision.id}>
                            Rev {revision.revision_no} ({revision.stage}) - {new Date(revision.created_at).toLocaleString()}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-[#4b4b4b]">No revisions recorded yet.</p>
                    )}
                  </div>
                  <Textarea
                    rows={2}
                    placeholder="Comment and request changes"
                    value={feedbackInputs[latestSubmission.id] ?? ""}
                    onChange={(event) =>
                      setFeedbackInputs((prev) => ({
                        ...prev,
                        [latestSubmission.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number"
                      min="0"
                      max="100"
                      value={ratingInputs[latestSubmission.id] ?? "70"}
                      onChange={(event) =>
                        setRatingInputs((prev) => ({
                          ...prev,
                          [latestSubmission.id]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      onClick={() => void onRateSubmission(latestSubmission.id)}
                      disabled={saving}
                    >
                      {saving ? "Scoring..." : "Rate + Decide"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void onRequestChanges(latestSubmission.id)}
                      disabled={saving}
                    >
                      {saving ? "Updating..." : "Request Changes"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void onSubmitReviewDecision(latestSubmission.id, "approve")}
                      disabled={saving}
                    >
                      {saving ? "Updating..." : "Approve Review"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void onSubmitReviewDecision(latestSubmission.id, "request_changes")}
                      disabled={saving}
                    >
                      {saving ? "Updating..." : "Decision: Request Changes"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {latestSubmission ? (
                <div className="mt-3 space-y-2 rounded-lg border border-[#121212] bg-white p-3">
                  <p className="text-xs font-semibold text-[#121212]">Code Review Thread</p>
                  <div className="max-h-36 space-y-1 overflow-y-auto text-xs text-[#4b4b4b]">
                    {(reviewComments[latestSubmission.id] ?? []).map((comment) => (
                      <p key={comment.id}>
                        <span className="font-semibold">{comment.author_name}</span> [{String(comment.comment_type).toUpperCase()}]: {comment.content}
                      </p>
                    ))}
                    {(reviewComments[latestSubmission.id] ?? []).length === 0 ? (
                      <p>No review comments yet.</p>
                    ) : null}
                  </div>
                  <Textarea
                    rows={2}
                    placeholder="Add a code review comment"
                    value={reviewDrafts[latestSubmission.id] ?? ""}
                    onChange={(event) =>
                      setReviewDrafts((prev) => ({
                        ...prev,
                        [latestSubmission.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void onAddReviewComment(latestSubmission.id)}
                      disabled={saving}
                    >
                      {saving ? "Posting..." : "Post Review Comment"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void onRetriggerCi(latestSubmission.id)}
                      disabled={saving}
                    >
                      {saving ? "Updating..." : "Re-run CI (timeout only)"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {latestSubmission ? (
                <div className="mt-3 rounded-lg border border-[#121212] bg-white p-3">
                  <p className="text-xs font-semibold text-[#121212]">Hackathon Review Runs</p>
                  {(hackathonRuns[latestSubmission.id] ?? []).length > 0 ? (
                    <div className="mt-2 space-y-2 text-xs text-[#4b4b4b]">
                      {(hackathonRuns[latestSubmission.id] ?? []).slice(0, 8).map((run) => (
                        <div key={run.id} className="rounded border border-[#d7d7d7] bg-[#f8f8f8] p-2">
                          <p>
                            {new Date(run.created_at).toLocaleString()} | action {run.action} | decision {run.decision}
                          </p>
                          <p>
                            score {run.score} | source {run.code_review_source}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {run.lock_tx_id ? (
                              <a
                                href={`https://testnet.algoexplorer.io/tx/${encodeURIComponent(run.lock_tx_id)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[#1040c0] underline"
                              >
                                Lock Tx
                              </a>
                            ) : null}
                            {run.transfer_tx_id ? (
                              <a
                                href={`https://testnet.algoexplorer.io/tx/${encodeURIComponent(run.transfer_tx_id)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[#1040c0] underline"
                              >
                                Transfer Tx
                              </a>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-[#4b4b4b]">No hackathon review runs yet.</p>
                  )}
                </div>
              ) : null}

              {user?.role === "FREELANCER" && latestSubmission?.clientFeedback ? (
                <div className="mt-3 rounded-lg border border-[#121212] bg-[#fff3cd] p-3">
                  <p className="text-xs text-[#8a5a00]">
                    Client requested changes: {latestSubmission.clientFeedback}
                  </p>
                </div>
              ) : null}
            </div>
            );
          })}
        </div>
      </Card>

      {user?.role === "CLIENT" ? (
        <Card>
          <h3 className="text-lg font-semibold">Client Submission Timeline</h3>
          <p className="mt-1 text-sm text-[#4b4b4b]">
            Submitted → CI Running → CI Passed/Failed → AI Scored → Awaiting Approval → Approved → Payout Released
          </p>

          {latestSubmissionForTimeline ? (
            <>
              <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {buildSubmissionTimeline(latestTimelineDetail, latestSubmissionForTimeline).map((step) => (
                  <div key={step.label} className={`rounded border px-3 py-2 text-xs font-semibold ${timelineTone(step.state)}`}>
                    {step.label}
                  </div>
                ))}
              </div>
              <div className="mt-3 grid gap-2 text-xs text-[#4b4b4b] md:grid-cols-2">
                <p>Submission status: {latestTimelineDetail?.submission?.status ?? latestSubmissionForTimeline.status}</p>
                <p>Submission stage: {latestTimelineDetail?.submission?.stage ?? latestSubmissionForTimeline.stage ?? "n/a"}</p>
                <p>CI status: {latestTimelineDetail?.submission?.ci_status ?? "n/a"}</p>
                <p>Review gate: {latestTimelineDetail?.submission?.review_gate_status ?? latestSubmissionForTimeline.reviewGateStatus ?? "n/a"}</p>
                <p>AI score: {latestTimelineDetail?.submission?.ai_score ?? "n/a"}</p>
                <p>Final score: {latestTimelineDetail?.submission?.final_score ?? "n/a"}</p>
                <p>Payout status: {latestTimelineDetail?.payout?.status ?? "n/a"}</p>
                <p>Payout tx: {latestTimelineDetail?.payout?.tx_id ?? "n/a"}</p>
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-[#4b4b4b]">No submission has been sent yet.</p>
          )}
        </Card>
      ) : null}

      <Card>
        <h3 className="text-lg font-semibold">Submission and Validation Report</h3>
        <p className="mt-1 text-sm text-[#4b4b4b]">AI score, client rating, and weighted final score determine release or dispute outcomes.</p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-4">
            <p className="text-xs text-[#4b4b4b]">AI Score</p>
            <p className="mt-1 text-2xl font-semibold">{validationResult?.aiScore ?? 0}</p>
          </div>
          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-4">
            <p className="text-xs text-[#4b4b4b]">Client Rating</p>
            <p className="mt-1 text-2xl font-semibold">{validationResult?.clientRating ?? 0}</p>
          </div>
          <div className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-4">
            <p className="text-xs text-[#4b4b4b]">Final Score</p>
            <p className="mt-1 text-2xl font-semibold">{finalScore}</p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {validationResult?.breakdown?.missingElements?.length ? (
            <p className="text-sm text-[#8a5a00]">
              Missing requirements: {validationResult.breakdown.missingElements.join(", ")}
            </p>
          ) : null}
          <div>
            <p className="mb-1 text-xs text-[#4b4b4b]">Requirement Match</p>
            <ProgressBar value={requirementMatch} />
          </div>
          <div>
            <p className="mb-1 text-xs text-[#4b4b4b]">Completeness</p>
            <ProgressBar value={completeness} />
          </div>
          <div>
            <p className="mb-1 text-xs text-[#4b4b4b]">Quality Metrics</p>
            <ProgressBar value={qualityMetrics} />
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-lg font-semibold">Escrow Status</h3>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Pill text={paymentStatus} />
          <p className="text-sm text-[#4b4b4b]">
            {paymentStatus === "RELEASED"
              ? "Escrow released to freelancer wallet."
              : paymentStatus === "DISPUTED"
                ? "Escrow remains locked pending dispute resolution."
                : "Awaiting client rating to compute final decision."}
          </p>
        </div>
        <p className="mt-2 text-xs text-[#4b4b4b]">Guardrail: {releaseGuard.reason}</p>
      </Card>
    </section>
  );
}
