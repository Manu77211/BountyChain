"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  approveProjectDraftRequest,
  assignFreelancerRequest,
  createProjectMeetingRequest,
  createMilestoneSubmissionRequest,
  deleteProjectRequest,
  getProjectRequest,
  listProjectMeetingsRequest,
  listProjectApplicantsRequest,
  listFreelancersRequest,
  raiseBountyAmountRequest,
  requestSubmissionChangesRequest,
  rateSubmissionRequest,
  selectProjectApplicantRequest,
} from "../../../../lib/api";
import { formatAlgoWithMicro, fromMicroAlgo, toMicroAlgo } from "../../../../lib/algo";
import { canReleaseEscrow, hasDistinctParticipants } from "../../../../lib/project-config";
import { useAuthStore } from "../../../../store/auth-store";
import { Button, Card, Input, PageIntro, Pill, ProgressBar, Select, Textarea } from "../../../../components/ui/primitives";

type MilestoneFormState = {
  fileUrl: string;
  notes: string;
};

type SubmissionView = {
  id: string;
  status: string;
  fileUrl?: string;
  notes?: string;
  clientRating?: number;
  clientFeedback?: string;
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

type FreelancerOption = {
  id: string;
  name: string;
  rating?: number;
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

export default function DashboardProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const { token, user, hydrate } = useAuthStore();

  const [project, setProject] = useState<ProjectDetailView | null>(null);
  const [freelancers, setFreelancers] = useState<FreelancerOption[]>([]);
  const [applicants, setApplicants] = useState<ApplicantView[]>([]);
  const [selectedFreelancerId, setSelectedFreelancerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ratingInputs, setRatingInputs] = useState<Record<string, string>>({});
  const [feedbackInputs, setFeedbackInputs] = useState<Record<string, string>>({});
  const [milestoneForms, setMilestoneForms] = useState<Record<string, MilestoneFormState>>({});
  const [validationResult, setValidationResult] = useState<ValidationReportView | null>(null);
  const [meetings, setMeetings] = useState<ProjectMeeting[]>([]);
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

      if (user?.role === "CLIENT" && !data.freelancer) {
        const freelancerData = (await listFreelancersRequest({})) as FreelancerOption[];
        setFreelancers(freelancerData);
        const applicantData = (await listProjectApplicantsRequest(token, projectId)) as ApplicantView[];
        setApplicants(applicantData);
      } else {
        setApplicants([]);
      }

      const initialForms = (data.milestones ?? []).reduce((acc: Record<string, MilestoneFormState>, milestone) => {
        acc[milestone.id] = { fileUrl: "", notes: "" };
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

      if (data.validationReports?.length) {
        setValidationResult(data.validationReports[0]);
      }
    } catch (e) {
      setError((e as Error).message);
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

  const canAssign = user?.role === "CLIENT" && !project?.freelancer;
  const canApproveDraft = user?.role === "CLIENT";
  const canSubmit = user?.role === "FREELANCER";

  const milestoneProgress = useMemo(() => {
    if (!project?.milestones?.length) {
      return 0;
    }

    const approved = project.milestones.filter((item) => item.status === "APPROVED").length;
    return (approved / project.milestones.length) * 100;
  }, [project]);

  async function onAssignFreelancer() {
    if (!token || !selectedFreelancerId || !projectId) {
      return;
    }

    if (!hasDistinctParticipants(project?.client?.id, selectedFreelancerId)) {
      setError("Client and freelancer cannot be the same user on a bounty.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await assignFreelancerRequest(token, projectId, selectedFreelancerId);
      setSelectedFreelancerId("");
      await loadProject();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

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

  async function onSubmitMilestone(event: FormEvent, milestoneId: string) {
    event.preventDefault();

    if (!token || !projectId) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const state = milestoneForms[milestoneId] ?? { fileUrl: "", notes: "" };
      await createMilestoneSubmissionRequest(token, projectId, milestoneId, {
        kind: "FINAL",
        fileUrl: state.fileUrl || undefined,
        notes: state.notes || undefined,
      });

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
      const report = await rateSubmissionRequest(token, submissionId, value);
      setValidationResult(report);

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

  if (error) {
    return <p className="text-sm text-[#8f1515]">{error}</p>;
  }

  if (!project) {
    return <p className="text-[#4b4b4b]">Bounty not found.</p>;
  }

  return (
    <section className="space-y-6">
      <PageIntro title={project.title} subtitle="Milestones, submissions, validation, and payout decisions are managed from this bounty workspace." />

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

      {canAssign ? (
        <Card>
          <h3 className="text-lg font-semibold">Assign Freelancer</h3>
          {applicants.length > 0 ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-[#4b4b4b]">Applicants who showed interest:</p>
              {applicants.map((application) => (
                <div key={application.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                  <div>
                    <p className="font-medium text-[#121212]">{application.freelancer?.name}</p>
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
                    <Button onClick={() => void onSelectApplicant(application.id)} disabled={saving || Boolean(project.freelancer)}>
                      {saving ? "Selecting..." : "Select Applicant"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Select value={selectedFreelancerId} onChange={(event) => setSelectedFreelancerId(event.target.value)}>
              <option value="">Select freelancer</option>
              {freelancers.map((freelancer) => (
                <option key={freelancer.id} value={freelancer.id}>
                  {freelancer.name} (rating {freelancer.rating})
                </option>
              ))}
            </Select>
            <Button onClick={onAssignFreelancer} disabled={saving || !selectedFreelancerId}>
              {saving ? "Assigning..." : "Assign Freelancer"}
            </Button>
          </div>
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
        <div className="mt-4 space-y-3">
          {(project.milestones ?? []).map((milestone) => {
            const latestSubmission = milestone.submissions?.[0];
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
                <form onSubmit={(event) => onSubmitMilestone(event, milestone.id)} className="mt-3 space-y-2">
                  <Input
                    type="url"
                    placeholder="Submission file URL"
                    value={milestoneForms[milestone.id]?.fileUrl ?? ""}
                    onChange={(event) =>
                      setMilestoneForms((prev) => ({
                        ...prev,
                        [milestone.id]: {
                          ...(prev[milestone.id] ?? { fileUrl: "", notes: "" }),
                          fileUrl: event.target.value,
                        },
                      }))
                    }
                  />
                  <Textarea
                    rows={3}
                    placeholder="Submission notes"
                    value={milestoneForms[milestone.id]?.notes ?? ""}
                    onChange={(event) =>
                      setMilestoneForms((prev) => ({
                        ...prev,
                        [milestone.id]: {
                          ...(prev[milestone.id] ?? { fileUrl: "", notes: "" }),
                          notes: event.target.value,
                        },
                      }))
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="secondary" disabled={saving}>
                      Submit Work
                    </Button>
                  </div>
                </form>
              ) : null}

              {user?.role === "CLIENT" && latestSubmission ? (
                <div className="mt-3 space-y-2 rounded-lg border border-[#121212] bg-[#f5f5f5] p-3">
                  <p className="text-xs text-[#4b4b4b]">
                    Latest submission status: {latestSubmission.status}
                  </p>
                  {latestSubmission.fileUrl ? (
                    <p className="text-xs text-[#4b4b4b]">
                      File: <a className="text-sky-300 underline" href={latestSubmission.fileUrl} target="_blank" rel="noreferrer">Open submission artifact</a>
                    </p>
                  ) : null}
                  {latestSubmission.notes ? (
                    <p className="text-xs text-[#4b4b4b]">Notes: {latestSubmission.notes}</p>
                  ) : null}
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
                  </div>
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
