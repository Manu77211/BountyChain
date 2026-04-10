"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  applyToProjectRequest,
  createProjectRequest,
  deleteProjectRequest,
  discoverOpenProjectsRequest,
  listProjectsRequest,
} from "../../../lib/api";
import { useAuthStore } from "../../../store/auth-store";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  PageIntro,
  Pill,
  ProgressBar,
  Textarea,
} from "../../../components/ui/primitives";

export default function ProjectsPage() {
  const { token, user, hydrate } = useAuthStore();
  const [projects, setProjects] = useState<any[]>([]);
  const [openProjects, setOpenProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [openCreate, setOpenCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workType, setWorkType] = useState<"STRUCTURED" | "CREATIVE">("STRUCTURED");
  const [creating, setCreating] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [applyingProjectId, setApplyingProjectId] = useState<string | null>(null);
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, {
    message: string;
    proposedAmount: string;
    estimatedDays: string;
    deliverables: string;
  }>>({});

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  async function loadProjects() {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const projectList = await listProjectsRequest(token);
      setProjects(projectList);
      if (user?.role === "FREELANCER") {
        const discoverList = await discoverOpenProjectsRequest(token);
        setOpenProjects(discoverList);
      } else {
        setOpenProjects([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, [token, user?.role]);

  const heading = useMemo(() => {
    if (user?.role === "FREELANCER") {
      return {
        title: "My Bounties",
        subtitle: "Track assigned bounty delivery pipelines and submit milestones for objective validation.",
      };
    }

    return {
      title: "Bounties",
      subtitle: "Create bounties, assign freelancers, and monitor escrow and milestone progression.",
    };
  }, [user?.role]);

  async function onCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cleanTitle = title.trim();
    const cleanDescription = description.trim();

    if (!token) {
      setError("Please login again to create a bounty.");
      return;
    }

    if (user?.role !== "CLIENT") {
      setError("Only clients can create bounties.");
      return;
    }

    if (cleanTitle.length < 3) {
      setError("Title must be at least 3 characters.");
      return;
    }

    if (cleanDescription.length < 10) {
      setError("Description must be at least 10 characters.");
      return;
    }

    setCreating(true);
    setError(null);
    setSuccess(null);

    try {
      await createProjectRequest(token, {
        title: cleanTitle,
        description: cleanDescription,
        workType,
      });
      setTitle("");
      setDescription("");
      setWorkType("STRUCTURED");
      setOpenCreate(false);
      await loadProjects();
      setSuccess("Bounty created successfully.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function onDeleteProject(projectId: string) {
    if (!token) {
      setError("Please login again to delete a project.");
      return;
    }

    const confirmed = window.confirm("Delete this project? This cannot be undone.");
    if (!confirmed) {
      return;
    }

    setDeletingProjectId(projectId);
    setError(null);
    setSuccess(null);

    try {
      await deleteProjectRequest(token, projectId);
      await loadProjects();
      setSuccess("Bounty deleted successfully.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingProjectId(null);
    }
  }

  async function onApplyToProject(projectId: string) {
    if (!token) {
      setError("Please login again to apply.");
      return;
    }

    setApplyingProjectId(projectId);
    setError(null);
    setSuccess(null);
    try {
      const draft = proposalDrafts[projectId] ?? {
        message: "",
        proposedAmount: "",
        estimatedDays: "",
        deliverables: "",
      };

      const payload = {
        message: draft.message.trim(),
        proposedAmount: draft.proposedAmount.trim() ? Number(draft.proposedAmount) : undefined,
        estimatedDays: draft.estimatedDays.trim() ? Number(draft.estimatedDays) : undefined,
        deliverables: draft.deliverables.trim(),
      };

      if (!payload.message && !payload.deliverables) {
        setError("Add a short proposal message or deliverables before applying.");
        setApplyingProjectId(null);
        return;
      }

      if (payload.proposedAmount !== undefined && (!Number.isFinite(payload.proposedAmount) || payload.proposedAmount <= 0)) {
        setError("Proposed amount must be a valid positive number.");
        setApplyingProjectId(null);
        return;
      }

      if (payload.estimatedDays !== undefined && (!Number.isInteger(payload.estimatedDays) || payload.estimatedDays <= 0)) {
        setError("Estimated days must be a positive whole number.");
        setApplyingProjectId(null);
        return;
      }

      await applyToProjectRequest(token, projectId, {
        message: payload.message || undefined,
        proposedAmount: payload.proposedAmount,
        estimatedDays: payload.estimatedDays,
        deliverables: payload.deliverables || undefined,
      });
      await loadProjects();
      setSuccess("Applied to bounty successfully.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplyingProjectId(null);
    }
  }

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageIntro title={heading.title} subtitle={heading.subtitle} />
        {user?.role === "CLIENT" ? (
          <Dialog open={openCreate} onOpenChange={setOpenCreate}>
            <DialogTrigger asChild>
              <Button>Create Bounty</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold">Create New Bounty</DialogTitle>
                <DialogDescription className="text-sm text-[#4b4b4b]">
                  Add scope details and BountyEscrow AI will initialize milestones and validation-ready structure.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={onCreateProject} className="space-y-3">
                <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Bounty title" required />
                <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} placeholder="Describe bounty deliverables" required />
                <select
                  value={workType}
                  onChange={(event) => setWorkType(event.target.value as "STRUCTURED" | "CREATIVE")}
                  className="h-11 w-full rounded-xl border border-[#121212] bg-[#f5f5f5] px-3 text-sm text-[#121212]"
                >
                  <option value="STRUCTURED">Structured</option>
                  <option value="CREATIVE">Creative</option>
                </select>
                <Button type="submit" disabled={creating} className="w-full">
                  {creating ? "Creating..." : "Create Bounty"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
      {success ? <p className="text-sm text-[#0f7b44]">{success}</p> : null}
        {loading ? <p className="text-[#4b4b4b]">Loading bounties...</p> : null}

      {user?.role === "FREELANCER" ? (
        <Card>
          <h3 className="text-lg font-semibold">Open Bounties You Can Apply To</h3>
          <p className="mt-1 text-sm text-[#4b4b4b]">Browse open bounties, show interest, and wait for selection.</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {openProjects.map((project) => (
              <div key={project.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-4">
                <p className="font-medium text-[#121212]">{project.title}</p>
                <p className="mt-1 text-xs text-[#4b4b4b]">Client {project.client?.name ?? "Unknown"}</p>
                <p className="mt-2 text-xs text-[#5b5b5b]">Applicants: {project._count?.applications ?? 0}</p>
                {!project.applications?.length ? (
                  <div className="mt-3 space-y-2">
                    <Textarea
                      rows={2}
                      placeholder="Short proposal message"
                      value={proposalDrafts[project.id]?.message ?? ""}
                      onChange={(event) =>
                        setProposalDrafts((prev) => ({
                          ...prev,
                          [project.id]: {
                            message: event.target.value,
                            proposedAmount: prev[project.id]?.proposedAmount ?? "",
                            estimatedDays: prev[project.id]?.estimatedDays ?? "",
                            deliverables: prev[project.id]?.deliverables ?? "",
                          },
                        }))
                      }
                    />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        type="number"
                        min="1"
                        step="0.01"
                        placeholder="Proposed budget"
                        value={proposalDrafts[project.id]?.proposedAmount ?? ""}
                        onChange={(event) =>
                          setProposalDrafts((prev) => ({
                            ...prev,
                            [project.id]: {
                              message: prev[project.id]?.message ?? "",
                              proposedAmount: event.target.value,
                              estimatedDays: prev[project.id]?.estimatedDays ?? "",
                              deliverables: prev[project.id]?.deliverables ?? "",
                            },
                          }))
                        }
                      />
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        placeholder="Estimated days"
                        value={proposalDrafts[project.id]?.estimatedDays ?? ""}
                        onChange={(event) =>
                          setProposalDrafts((prev) => ({
                            ...prev,
                            [project.id]: {
                              message: prev[project.id]?.message ?? "",
                              proposedAmount: prev[project.id]?.proposedAmount ?? "",
                              estimatedDays: event.target.value,
                              deliverables: prev[project.id]?.deliverables ?? "",
                            },
                          }))
                        }
                      />
                    </div>
                    <Textarea
                      rows={2}
                      placeholder="Deliverables you will provide"
                      value={proposalDrafts[project.id]?.deliverables ?? ""}
                      onChange={(event) =>
                        setProposalDrafts((prev) => ({
                          ...prev,
                          [project.id]: {
                            message: prev[project.id]?.message ?? "",
                            proposedAmount: prev[project.id]?.proposedAmount ?? "",
                            estimatedDays: prev[project.id]?.estimatedDays ?? "",
                            deliverables: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                ) : null}
                <Button
                  className="mt-3"
                  disabled={Boolean(project.applications?.length) || applyingProjectId === project.id}
                  onClick={() => void onApplyToProject(project.id)}
                >
                  {project.applications?.length
                    ? "Applied"
                    : applyingProjectId === project.id
                      ? "Applying..."
                      : "Apply to Bounty"}
                </Button>
              </div>
            ))}
            {!loading && openProjects.length === 0 ? (
              <p className="text-sm text-[#4b4b4b]">No open bounties available right now.</p>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {projects.map((project) => {
          const milestones = project.milestones ?? [];
          const approved = milestones.filter((item: any) => item.status === "APPROVED").length;
          const progress = milestones.length > 0 ? (approved / milestones.length) * 100 : 0;

          return (
            <Card key={project.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold">{project.title}</p>
                  <p className="mt-1 text-sm text-[#4b4b4b]">{user?.role === "FREELANCER" ? "Assigned by" : "Freelancer"} {project.freelancer?.name ?? "Not assigned"}</p>
                </div>
                <Pill text={project.status} />
              </div>
              <div className="mt-4">
                <p className="mb-1 text-xs text-[#4b4b4b]">Milestone Progress</p>
                <ProgressBar value={progress} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild variant="secondary">
                  <Link href={`/dashboard/bounties/${project.id}`}>View Details</Link>
                </Button>
                <Button asChild>
                  <Link href={`/dashboard/chat/${project.id}`}>Open Chat</Link>
                </Button>
                {user?.role === "CLIENT" ? (
                  <Button
                    variant="ghost"
                    onClick={() => void onDeleteProject(project.id)}
                    disabled={deletingProjectId === project.id}
                  >
                    {deletingProjectId === project.id ? "Deleting..." : "Delete"}
                  </Button>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      {!loading && projects.length === 0 ? (
        <Card>
          <p className="text-[#3f3f3f]">
            {user?.role === "FREELANCER"
              ? "No assigned bounties yet. Once a client assigns you, your delivery workflow appears here."
              : "No bounties created yet. Create your first bounty to start escrow-backed execution."}
          </p>
        </Card>
      ) : null}
    </motion.section>
  );
}

