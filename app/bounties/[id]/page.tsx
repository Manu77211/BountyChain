"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  applyToProjectRequest,
  createMilestoneSubmissionRequest,
  getBountyRequest,
  getProjectRequest,
  getSubmissionRequest,
} from "../../../lib/api";
import { formatAlgoWithMicro } from "../../../lib/algo";
import { useAuthStore } from "../../../store/auth-store";
import { Button, Card, Input, Pill, Textarea } from "../../../components/ui/primitives";

type BountyView = {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  allowed_languages: string[];
  total_amount: string;
  status: string;
  scoring_mode: string;
  deadline: string;
};

type SubmissionView = {
  id: string;
  status: string;
  stage?: string;
  reviewGateStatus?: string;
  fileUrl?: string;
  notes?: string;
};

type MilestoneView = {
  id: string;
  title: string;
  amount?: number;
  status: string;
  submissions?: SubmissionView[];
};

type ProjectWorkspaceView = {
  id: string;
  freelancer?: { id: string; name: string } | null;
  milestones?: MilestoneView[];
};

type MilestoneFormState = {
  fileUrl: string;
  notes: string;
  isGithubWork: boolean;
};

type SubmissionHistory = {
  revisions: Array<{
    id: string;
    revision_no: number;
    stage: string;
    artifact_url: string;
    notes?: string | null;
    created_at: string;
  }>;
};

function isGithubUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase().includes("github.com");
  } catch {
    return false;
  }
}

export default function BountyDetailPage() {
  const params = useParams<{ id: string }>();
  const bountyId = params.id;
  const { token, user, hydrate } = useAuthStore();
  const [bounty, setBounty] = useState<BountyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<ProjectWorkspaceView | null>(null);
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [milestoneForms, setMilestoneForms] = useState<Record<string, MilestoneFormState>>({});
  const [submissionHistory, setSubmissionHistory] = useState<Record<string, SubmissionHistory>>({});
  const [savingSubmission, setSavingSubmission] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!bountyId) {
      return;
    }

    async function loadBounty() {
      setLoading(true);
      setError(null);
      try {
        const response = (await getBountyRequest(bountyId)) as { bounty: BountyView };
        setBounty(response.bounty);
      } catch (requestError) {
        setError((requestError as Error).message);
      } finally {
        setLoading(false);
      }
    }

    void loadBounty();
  }, [bountyId]);

  useEffect(() => {
    async function loadWorkspaceView() {
      if (!token || !bountyId) {
        setWorkspace(null);
        setWorkspaceMessage(null);
        return;
      }

      try {
        const data = (await getProjectRequest(token, bountyId)) as ProjectWorkspaceView;
        setWorkspace(data);
        const formState = (data.milestones ?? []).reduce((acc: Record<string, MilestoneFormState>, milestone) => {
          acc[milestone.id] = { fileUrl: "", notes: "", isGithubWork: false };
          return acc;
        }, {});
        setMilestoneForms(formState);

        const latestSubmissionIds = (data.milestones ?? [])
          .map((milestone) => milestone.submissions?.[0]?.id)
          .filter((id): id is string => Boolean(id));

        if (latestSubmissionIds.length > 0) {
          const historyEntries = await Promise.all(
            latestSubmissionIds.map(async (submissionId) => {
              try {
                const details = (await getSubmissionRequest(token, submissionId)) as SubmissionHistory;
                return [submissionId, { revisions: details.revisions ?? [] }] as const;
              } catch {
                return [submissionId, { revisions: [] }] as const;
              }
            }),
          );
          setSubmissionHistory(Object.fromEntries(historyEntries));
        } else {
          setSubmissionHistory({});
        }

        setWorkspaceMessage(null);
      } catch (requestError) {
        setWorkspace(null);
        const message = (requestError as Error).message;
        if (message.toLowerCase().includes("forbidden")) {
          setWorkspaceMessage("Submission panel appears after client assignment.");
          return;
        }
        setWorkspaceMessage(message);
      }
    }

    void loadWorkspaceView();
  }, [bountyId, token]);

  async function onApply() {
    if (!token || !bountyId) {
      setApplyMessage("Sign in as freelancer to apply.");
      return;
    }

    setApplying(true);
    setApplyMessage(null);
    try {
      await applyToProjectRequest(token, bountyId, {});
      setApplyMessage("Application submitted.");
    } catch (requestError) {
      setApplyMessage((requestError as Error).message);
    } finally {
      setApplying(false);
    }
  }

  async function onSubmitMilestone(milestoneId: string, kind: "DRAFT" | "FINAL") {
    if (!token || !bountyId) {
      return;
    }

    const state = milestoneForms[milestoneId] ?? { fileUrl: "", notes: "", isGithubWork: false };
    const fileUrl = state.fileUrl.trim();
    const notes = state.notes.trim();

    if (notes.length < 12) {
      setWorkspaceMessage("Please add a short work description (at least 12 characters).");
      return;
    }
    if (state.isGithubWork && fileUrl.length === 0) {
      setWorkspaceMessage("GitHub URL is required when this milestone includes GitHub work.");
      return;
    }
    if (state.isGithubWork && fileUrl.length > 0 && !isGithubUrl(fileUrl)) {
      setWorkspaceMessage("Please provide a valid github.com URL.");
      return;
    }

    setSavingSubmission(true);
    setWorkspaceMessage(null);
    try {
      await createMilestoneSubmissionRequest(token, bountyId, milestoneId, {
        kind,
        fileUrl: fileUrl || undefined,
        notes: notes || undefined,
      });
      const refreshed = (await getProjectRequest(token, bountyId)) as ProjectWorkspaceView;
      setWorkspace(refreshed);
      setWorkspaceMessage(kind === "FINAL" ? "Final submission sent." : "Draft saved.");
    } catch (requestError) {
      setWorkspaceMessage((requestError as Error).message);
    } finally {
      setSavingSubmission(false);
    }
  }

  const isFreelancer = String(user?.role ?? "").toUpperCase() === "FREELANCER";
  const isAssignedFreelancer = Boolean(
    isFreelancer && workspace?.freelancer?.id && user?.id && workspace.freelancer.id === user.id,
  );

  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      {loading ? <p className="text-sm text-[#4b4b4b]">Loading bounty...</p> : null}
      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}

      {bounty ? (
        <Card className="space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold">{bounty.title}</h1>
              <p className="mt-1 text-sm text-[#4b4b4b]">Deadline: {new Date(bounty.deadline).toLocaleString()}</p>
            </div>
            <Pill text={String(bounty.status).toUpperCase()} />
          </div>

          <p className="text-sm text-[#121212]">{bounty.description || "No description provided."}</p>

          <div>
            <p className="text-sm font-semibold">Acceptance Criteria</p>
            <pre className="mt-1 whitespace-pre-wrap text-xs text-[#4b4b4b]">{bounty.acceptance_criteria || "No acceptance criteria provided."}</pre>
          </div>

          <div className="grid gap-2 text-xs text-[#4b4b4b] sm:grid-cols-2">
            <p>Amount: {formatAlgoWithMicro(bounty.total_amount)}</p>
            <p>Scoring Mode: {bounty.scoring_mode}</p>
          </div>

          {(bounty.allowed_languages ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {(bounty.allowed_languages ?? []).map((language) => (
                <span key={language} className="inline-flex border border-[#121212] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase">
                  {language}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" className="h-8 px-3 text-xs">
              <Link href="/dashboard/bounties">Back to Bounties</Link>
            </Button>
            {isFreelancer ? (
              <Button className="h-8 px-3 text-xs" onClick={() => void onApply()} disabled={applying}>
                {applying ? "Applying..." : "Apply"}
              </Button>
            ) : null}
            <Button asChild variant="secondary" className="h-8 px-3 text-xs">
              <Link href={`/dashboard/chat/${bounty.id}`}>Open Chat</Link>
            </Button>
          </div>

          {applyMessage ? <p className="text-xs text-[#4b4b4b]">{applyMessage}</p> : null}
          <p className="text-xs text-[#4b4b4b]">Workspace access is available only after assignment.</p>
        </Card>
      ) : null}

      {isFreelancer ? (
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Milestone Submission Panel</h2>
          {isAssignedFreelancer ? (
            <p className="text-xs text-[#1e2a52]">You are assigned to this bounty. Submit milestone drafts/finals below.</p>
          ) : (
            <p className="text-xs text-[#4b4b4b]">You can view details now. Submission unlocks after assignment.</p>
          )}
          {workspaceMessage ? <p className="text-xs text-[#7a5a00]">{workspaceMessage}</p> : null}

          {(workspace?.milestones ?? []).map((milestone) => {
            const latestSubmission = milestone.submissions?.[0];
            const history = latestSubmission ? (submissionHistory[latestSubmission.id]?.revisions ?? []) : [];
            return (
              <div key={milestone.id} className="rounded-lg border border-[#121212] bg-[#f5f5f5] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{milestone.title}</p>
                  <Pill text={milestone.status} />
                </div>
                <p className="mt-1 text-xs text-[#4b4b4b]">Amount: {formatAlgoWithMicro(milestone.amount, 2)}</p>

                {isAssignedFreelancer ? (
                  <div className="mt-3 space-y-2 border border-[#121212] bg-white p-3">
                    <label className="flex items-center gap-2 text-xs font-semibold text-[#121212]">
                      <input
                        type="checkbox"
                        checked={milestoneForms[milestone.id]?.isGithubWork ?? false}
                        onChange={(event) =>
                          setMilestoneForms((prev) => ({
                            ...prev,
                            [milestone.id]: {
                              ...(prev[milestone.id] ?? { fileUrl: "", notes: "", isGithubWork: false }),
                              isGithubWork: event.target.checked,
                            },
                          }))
                        }
                      />
                      This milestone includes GitHub work
                    </label>
                    <Input
                      type="url"
                      placeholder="https://github.com/org/repo/pull/123"
                      value={milestoneForms[milestone.id]?.fileUrl ?? ""}
                      onChange={(event) =>
                        setMilestoneForms((prev) => ({
                          ...prev,
                          [milestone.id]: {
                            ...(prev[milestone.id] ?? { fileUrl: "", notes: "", isGithubWork: false }),
                            fileUrl: event.target.value,
                          },
                        }))
                      }
                    />
                    <Textarea
                      rows={3}
                      placeholder="Describe what you built and what to review."
                      value={milestoneForms[milestone.id]?.notes ?? ""}
                      onChange={(event) =>
                        setMilestoneForms((prev) => ({
                          ...prev,
                          [milestone.id]: {
                            ...(prev[milestone.id] ?? { fileUrl: "", notes: "", isGithubWork: false }),
                            notes: event.target.value,
                          },
                        }))
                      }
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void onSubmitMilestone(milestone.id, "DRAFT")}
                        disabled={savingSubmission}
                      >
                        {savingSubmission ? "Saving..." : "Save Draft"}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => void onSubmitMilestone(milestone.id, "FINAL")}
                        disabled={savingSubmission}
                      >
                        {savingSubmission ? "Submitting..." : "Submit Work"}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {latestSubmission ? (
                  <div className="mt-3 rounded-lg border border-[#d7d7d7] bg-white p-3">
                    <p className="text-xs font-semibold text-[#121212]">Latest Submission</p>
                    <p className="text-xs text-[#4b4b4b]">
                      Status: {latestSubmission.status}
                      {latestSubmission.stage ? ` | stage: ${latestSubmission.stage}` : ""}
                      {latestSubmission.reviewGateStatus ? ` | gate: ${latestSubmission.reviewGateStatus}` : ""}
                    </p>
                    {latestSubmission.fileUrl ? (
                      <a className="text-xs text-[#1040c0] underline" href={latestSubmission.fileUrl} target="_blank" rel="noreferrer">
                        Open artifact
                      </a>
                    ) : null}

                    <p className="mt-2 text-xs font-semibold text-[#121212]">Submission History</p>
                    {history.length > 0 ? (
                      <div className="space-y-1 text-xs text-[#4b4b4b]">
                        {history.map((revision) => (
                          <p key={revision.id}>
                            Rev {revision.revision_no} ({revision.stage}) - {new Date(revision.created_at).toLocaleString()}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-[#4b4b4b]">No revision history found.</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-[#4b4b4b]">No submissions yet for this milestone.</p>
                )}
              </div>
            );
          })}
        </Card>
      ) : null}
    </section>
  );
}