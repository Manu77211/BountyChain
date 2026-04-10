"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { createBountyRequest, fundBountyRequest } from "../../../lib/api";
import { Protected } from "../../../components/protected";
import { DashboardShell } from "../../../components/dashboard-shell";
import { Button, Card, Input, PageIntro, Select, Textarea } from "../../../components/ui/primitives";
import { useAuthStore } from "../../../store/auth-store";

type CreatedBounty = {
  id: string;
  title: string;
  status: string;
};

function toDefaultDeadline() {
  const future = new Date(Date.now() + 72 * 60 * 60 * 1000);
  return future.toISOString().slice(0, 16);
}

export default function CreateBountyPage() {
  const { token, user } = useAuthStore();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [targetBranch, setTargetBranch] = useState("main");
  const [languages, setLanguages] = useState("typescript,javascript");
  const [totalAmount, setTotalAmount] = useState("1000000");
  const [scoringMode, setScoringMode] = useState<"ai_only" | "ci_only" | "hybrid">("hybrid");
  const [threshold, setThreshold] = useState("70");
  const [maxFreelancers, setMaxFreelancers] = useState("1");
  const [deadline, setDeadline] = useState(toDefaultDeadline());
  const [created, setCreated] = useState<CreatedBounty | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [funding, setFunding] = useState(false);

  const canCreate = useMemo(() => user?.role === "CLIENT", [user?.role]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      setError("Session missing. Please login again.");
      return;
    }

    setSaving(true);
    setError(null);
    setWarnings([]);

    try {
      const payload = {
        title: title.trim(),
        description: description.trim(),
        acceptance_criteria: acceptanceCriteria.trim(),
        repo_url: repoUrl.trim(),
        target_branch: targetBranch.trim(),
        allowed_languages: languages.split(",").map((item) => item.trim()).filter(Boolean),
        total_amount: totalAmount.trim(),
        scoring_mode: scoringMode,
        ai_score_threshold: Number(threshold),
        max_freelancers: Number(maxFreelancers),
        deadline: new Date(deadline).toISOString(),
      };

      const response = (await createBountyRequest(token, payload)) as {
        bounty: CreatedBounty;
        warnings?: string[];
      };

      setCreated(response.bounty);
      setWarnings(response.warnings ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onFundEscrow() {
    if (!token || !created) {
      return;
    }

    setFunding(true);
    setError(null);

    try {
      const funded = (await fundBountyRequest(token, created.id)) as { bounty: CreatedBounty };
      setCreated(funded.bounty);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setFunding(false);
    }
  }

  return (
    <Protected>
      <DashboardShell>
        <section className="space-y-6">
          <PageIntro
            title="Create Bounty"
            subtitle="Define scope, scoring mode, and deadline, then fund escrow to publish the bounty."
          />

          {!canCreate ? (
            <Card>
              <p className="text-sm text-[#8f1515]">Only client accounts can create bounties.</p>
            </Card>
          ) : null}

          <Card>
            <form className="space-y-4" onSubmit={onCreate}>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-semibold">Title</label>
                  <Input value={title} onChange={(event) => setTitle(event.target.value)} required />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold">Repo URL</label>
                  <Input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} required />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold">Description</label>
                <Textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} required />
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold">Acceptance Criteria</label>
                <Textarea rows={4} value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} required />
              </div>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="mb-1 block text-sm font-semibold">Target Branch</label>
                  <Input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} required />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold">Allowed Languages</label>
                  <Input value={languages} onChange={(event) => setLanguages(event.target.value)} required />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold">Total Amount (microALGO)</label>
                  <Input value={totalAmount} onChange={(event) => setTotalAmount(event.target.value)} required />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="mb-1 block text-sm font-semibold">Scoring Mode</label>
                  <Select value={scoringMode} onChange={(event) => setScoringMode(event.target.value as "ai_only" | "ci_only" | "hybrid") }>
                    <option value="hybrid">Hybrid</option>
                    <option value="ai_only">AI only</option>
                    <option value="ci_only">CI only</option>
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold">AI Threshold</label>
                  <Input type="number" min="0" max="100" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold">Max Freelancers</label>
                  <Input type="number" min="1" max="10" value={maxFreelancers} onChange={(event) => setMaxFreelancers(event.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold">Deadline</label>
                  <Input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} required />
                </div>
              </div>

              {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
              {warnings.length > 0 ? (
                <div className="space-y-1 rounded-xl border border-[#121212] bg-[#fff4d1] p-3 text-xs text-[#4b4b4b]">
                  {warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={saving || !canCreate}>
                  {saving ? "Creating..." : "Create Draft"}
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/dashboard/bounties">Back to Bounties</Link>
                </Button>
              </div>
            </form>
          </Card>

          {created ? (
            <Card>
              <p className="text-sm text-[#4b4b4b]">Draft created</p>
              <p className="mt-1 text-xl font-semibold">{created.title}</p>
              <p className="mt-1 text-xs text-[#4b4b4b]">Status: {created.status}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => void onFundEscrow()} disabled={funding || created.status !== "draft"}>
                  {funding ? "Funding..." : created.status === "open" ? "Escrow Funded" : "Fund Escrow"}
                </Button>
                <Button asChild variant="secondary">
                  <Link href={`/bounties/${created.id}`}>Open Bounty</Link>
                </Button>
              </div>
            </Card>
          ) : null}
        </section>
      </DashboardShell>
    </Protected>
  );
}
