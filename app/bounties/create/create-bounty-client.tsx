"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import confetti from "canvas-confetti";
import { Check, CheckCircle2, Code2, GripVertical, Info, Sparkles, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { Protected } from "../../../components/protected";
import { Button, Card, Input, PageIntro, Textarea } from "../../../components/ui/primitives";
import {
  createBountyRequest,
  fundBountyRequest,
  listMyBountiesRequest,
  recommendFreelancersRequest,
  suggestProjectDescriptionRequest,
  validateGithubRepoRequest,
} from "../../../lib/api";
import { MICRO_ALGO_PER_ALGO, fromMicroAlgo, toMicroAlgo } from "../../../lib/algo";
import { useAuthStore } from "../../../store/auth-store";
import { AppShell } from "../../../src/components/layout/AppShell";

const STORAGE_KEY = "bounty-create-form-v1";
const STEPS = ["Basics", "Technical Config", "Payment & Timeline", "Review & Fund"];

const formSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(100, "Title must be at most 100 characters"),
  description: z.string().trim().min(50, "Description must be at least 50 characters"),
  acceptanceCriteria: z.string().trim().min(100, "Acceptance criteria must be at least 100 characters"),
  repoUrl: z.string().url("Enter a valid URL").regex(/^https:\/\/github\.com\/.+\/.+$/, "Use a valid GitHub repository URL"),
  targetBranch: z.string().trim().min(1, "Target branch is required"),
  scoringMode: z.enum(["hybrid", "ai_only", "ci_only"]),
  aiThreshold: z.number().min(40).max(100),
  allowedLanguages: z.array(z.string()).min(1, "Select at least one language"),
  payoutMode: z.enum(["simple", "milestones"]),
  totalAmountAlgo: z.number().positive("Amount must be greater than 0"),
  deadline: z.string().min(1, "Deadline is required"),
  maxFreelancers: z.enum(["1", "3", "5", "unlimited"]),
  milestones: z.array(
    z.object({
      title: z.string().trim().min(1, "Milestone title is required"),
      amountAlgo: z.number().positive("Milestone amount must be greater than 0"),
      description: z.string().trim().min(5, "Milestone description is required"),
    }),
  ),
});

type FormValues = z.infer<typeof formSchema>;

type RepoState = {
  status: "idle" | "loading" | "success" | "error" | "warning";
  message: string;
  installUrl: string | null;
};

type FundingState = "idle" | "signing" | "broadcasting" | "confirming" | "success" | "error" | "timeout";

type RecommendedFreelancer = {
  id: string;
  name: string;
  rating: number;
  trustScore: number;
  stats: {
    totalSubmissions: number;
    passedSubmissions: number;
    disputedSubmissions: number;
    recentSubmissions: number;
  };
  match: {
    score: number;
    reasons: string[];
  };
  recentWork: Array<{
    bountyId: string;
    title: string;
    status: string;
    finalScore: number | null;
    submittedAt: string;
  }>;
};

type DraftBounty = {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  repo_url: string;
  target_branch: string;
  allowed_languages: string[];
  total_amount: string;
  scoring_mode: "hybrid" | "ai_only" | "ci_only";
  ai_score_threshold: number;
  max_freelancers: number;
  deadline: string;
  created_at: string;
};

const languageOptions = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "C#",
  "Solidity",
];

const scoringModes: Array<{ value: "hybrid" | "ai_only" | "ci_only"; title: string; desc: string; icon: typeof Sparkles; recommended?: boolean }> = [
  {
    value: "hybrid",
    title: "AI + CI/CD Hybrid",
    desc: "Combines AI quality scoring with workflow validation.",
    icon: Workflow,
    recommended: true,
  },
  {
    value: "ai_only",
    title: "AI Only",
    desc: "Uses AI scoring without CI/CD checks.",
    icon: Sparkles,
  },
  {
    value: "ci_only",
    title: "CI/CD Only",
    desc: "Uses workflow checks and bypasses AI scoring.",
    icon: Code2,
  },
];

function defaultDeadline() {
  return new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function toDateTimeLocal(value: string) {
  return new Date(value).toISOString().slice(0, 16);
}

function normalizeLanguageLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  const matched = languageOptions.find((language) => language.toLowerCase() === normalized);
  if (matched) {
    return matched;
  }
  return value.trim();
}

function textAreaAutoResize(target: HTMLTextAreaElement) {
  target.style.height = "auto";
  target.style.height = `${Math.min(target.scrollHeight, 300)}px`;
}

function loadPersisted() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { step: number; values: FormValues };
    return parsed;
  } catch {
    return null;
  }
}

export default function CreateBountyPage() {
  const router = useRouter();
  const { token, user } = useAuthStore();
  const [step, setStep] = useState(1);
  const [repoState, setRepoState] = useState<RepoState>({ status: "idle", message: "", installUrl: null });
  const [fundingState, setFundingState] = useState<FundingState>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdBountyId, setCreatedBountyId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendedFreelancer[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [descriptionSuggestionLoading, setDescriptionSuggestionLoading] = useState(false);
  const [descriptionSuggestionMessage, setDescriptionSuggestionMessage] = useState<string | null>(null);
  const [shortlistedIds, setShortlistedIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<DraftBounty[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);

  const isClient = String(user?.role ?? "").toUpperCase() === "CLIENT";
  const isHackathonMode = process.env.NEXT_PUBLIC_HACKATHON_MODE === "true";
  const connectedNetwork = isHackathonMode ? "TestNet" : "MainNet";

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    mode: "onBlur",
    defaultValues: {
      title: "",
      description: "",
      acceptanceCriteria: "",
      repoUrl: "",
      targetBranch: "main",
      scoringMode: "hybrid",
      aiThreshold: 60,
      allowedLanguages: ["TypeScript"],
      payoutMode: "simple",
      totalAmountAlgo: 1,
      deadline: defaultDeadline(),
      maxFreelancers: "1",
      milestones: [
        {
          title: "Milestone 1",
          amountAlgo: 1,
          description: "Complete and submit the agreed deliverable with clear documentation.",
        },
      ],
    },
  });

  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: "milestones",
  });

  useEffect(() => {
    if (!user) {
      return;
    }
    if (!isClient) {
      router.replace("/dashboard/bounties");
    }
  }, [isClient, router, user]);

  useEffect(() => {
    const persisted = loadPersisted();
    if (!persisted) {
      return;
    }

    form.reset(persisted.values);
    setStep(Math.max(1, Math.min(4, persisted.step)));
  }, [form]);

  useEffect(() => {
    const subscription = form.watch((values) => {
      if (typeof window === "undefined") {
        return;
      }
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          step,
          values,
        }),
      );
    });

    return () => subscription.unsubscribe();
  }, [form, step]);

  useEffect(() => {
    async function loadRecentDrafts() {
      if (!token || !isClient) {
        return;
      }

      setDraftsLoading(true);
      try {
        const response = (await listMyBountiesRequest(token, {
          status: "draft",
          limit: 5,
        })) as { data?: DraftBounty[] };
        setDrafts(response.data ?? []);
      } catch {
        setDrafts([]);
      } finally {
        setDraftsLoading(false);
      }
    }

    void loadRecentDrafts();
  }, [isClient, token]);

  const payoutMode = form.watch("payoutMode");
  const totalAmountAlgo = form.watch("totalAmountAlgo");
  const aiThreshold = form.watch("aiThreshold");
  const deadlineValue = form.watch("deadline");

  const milestonesTotal = useMemo(
    () => fields.reduce((acc, _field, index) => acc + Number(form.getValues(`milestones.${index}.amountAlgo`) || 0), 0),
    [fields, form],
  );

  const shortDeadline = useMemo(() => {
    const value = new Date(deadlineValue).getTime();
    return value - Date.now() < 24 * 60 * 60 * 1000;
  }, [deadlineValue]);

  const currentBalanceAlgo = Number(process.env.NEXT_PUBLIC_TEST_WALLET_BALANCE_ALGO ?? 10);
  const totalLockAlgo = Number(totalAmountAlgo || 0) + 0.2;
  const neededMoreAlgo = Math.max(0, totalLockAlgo - currentBalanceAlgo);
  const insufficientBalance = neededMoreAlgo > 0;
  const wrongNetwork = connectedNetwork !== "MainNet" && !isHackathonMode;

  async function validateRepoOnBlur() {
    const repoUrl = form.getValues("repoUrl");
    if (!repoUrl || !token) {
      return;
    }

    setRepoState({ status: "loading", message: "Validating repository...", installUrl: null });
    const result = await validateGithubRepoRequest(token, repoUrl);

    if (!result.ok) {
      setRepoState({
        status: "error",
        message: "GitHub App not installed - Install it here",
        installUrl: result.install_url,
      });
      return;
    }

    if (!result.has_workflows) {
      setRepoState({
        status: "warning",
        message: "No CI/CD workflow detected - scoring will use AI only",
        installUrl: null,
      });
      return;
    }

    setRepoState({ status: "success", message: "Repository accessible", installUrl: null });
  }

  async function findFreelancerRecommendations() {
    if (!token) {
      setRecommendationError("Session missing. Please sign in again.");
      return;
    }

    const description = form.getValues("description").trim();
    const criteria = form.getValues("acceptanceCriteria").trim();
    const combined = `${description}\n${criteria}`.trim();

    if (combined.length < 30) {
      setRecommendationError("Add a meaningful description first to get accurate recommendations.");
      return;
    }

    setRecommendationsLoading(true);
    setRecommendationError(null);
    try {
      const response = (await recommendFreelancersRequest(token, {
        description: combined,
        allowed_languages: form
          .getValues("allowedLanguages")
          .map((value) => value.toLowerCase()),
        limit: 6,
      })) as { data?: RecommendedFreelancer[] };

      setRecommendations(response.data ?? []);
    } catch (error) {
      setRecommendationError((error as Error).message);
    } finally {
      setRecommendationsLoading(false);
    }
  }

  async function improveProjectDescription() {
    if (!token) {
      setDescriptionSuggestionMessage("Session missing. Please sign in again.");
      return;
    }

    const description = form.getValues("description").trim();
    if (description.length < 12) {
      setDescriptionSuggestionMessage("Add a short draft description first.");
      return;
    }

    setDescriptionSuggestionLoading(true);
    setDescriptionSuggestionMessage(null);

    try {
      const response = await suggestProjectDescriptionRequest(token, {
        title: form.getValues("title").trim(),
        description,
        acceptance_criteria: form.getValues("acceptanceCriteria").trim(),
        allowed_languages: form.getValues("allowedLanguages").map((value) => value.toLowerCase()),
      });

      form.setValue("title", response.data.suggestedTitle, { shouldDirty: true, shouldValidate: true });
      form.setValue("description", response.data.suggestedDescription, {
        shouldDirty: true,
        shouldValidate: true,
      });
      form.setValue("acceptanceCriteria", response.data.suggestedAcceptanceCriteria, {
        shouldDirty: true,
        shouldValidate: true,
      });

      setDescriptionSuggestionMessage(
        response.data.aiUsed
          ? "Description updated using AI suggestion."
          : "AI unavailable, applied a structured fallback suggestion.",
      );
    } catch (error) {
      setDescriptionSuggestionMessage((error as Error).message);
    } finally {
      setDescriptionSuggestionLoading(false);
    }
  }

  function toggleShortlist(freelancerId: string) {
    setShortlistedIds((current) =>
      current.includes(freelancerId)
        ? current.filter((id) => id !== freelancerId)
        : [...current, freelancerId],
    );
  }

  function copyOutreachMessage(freelancer: RecommendedFreelancer) {
    const title = form.getValues("title").trim() || "a bounty";
    const message = `Hi ${freelancer.name}, we think you're a strong fit for ${title}. Please review and apply when you're available.`;
    void navigator.clipboard.writeText(message);
  }

  function loadDraftIntoForm(draft: DraftBounty) {
    form.reset({
      title: draft.title,
      description: draft.description,
      acceptanceCriteria: draft.acceptance_criteria,
      repoUrl: draft.repo_url,
      targetBranch: draft.target_branch,
      scoringMode: draft.scoring_mode,
      aiThreshold: draft.ai_score_threshold,
      allowedLanguages: draft.allowed_languages.map(normalizeLanguageLabel),
      payoutMode: "simple",
      totalAmountAlgo: fromMicroAlgo(draft.total_amount),
      deadline: toDateTimeLocal(draft.deadline),
      maxFreelancers:
        draft.max_freelancers >= 9999
          ? "unlimited"
          : String(draft.max_freelancers) === "1" || String(draft.max_freelancers) === "3" || String(draft.max_freelancers) === "5"
            ? (String(draft.max_freelancers) as FormValues["maxFreelancers"])
            : "unlimited",
      milestones: [
        {
          title: "Milestone 1",
          amountAlgo: fromMicroAlgo(draft.total_amount),
          description: "Complete and submit deliverables according to bounty acceptance criteria.",
        },
      ],
    });
    setStep(1);
    setSubmitError(null);
  }

  async function nextStep() {
    setSubmitError(null);

    if (step === 1) {
      const ok = await form.trigger(["title", "description", "acceptanceCriteria"]);
      if (!ok) {
        return;
      }
      if (form.getValues("acceptanceCriteria").trim().length < 100) {
        form.setError("acceptanceCriteria", {
          type: "manual",
          message: "Acceptance criteria is required to continue",
        });
        return;
      }
    }

    if (step === 2) {
      const ok = await form.trigger([
        "repoUrl",
        "targetBranch",
        "scoringMode",
        "aiThreshold",
        "allowedLanguages",
      ]);
      if (!ok) {
        return;
      }
    }

    if (step === 3) {
      const ok = await form.trigger(["payoutMode", "totalAmountAlgo", "deadline", "maxFreelancers", "milestones"]);
      if (!ok) {
        return;
      }
    }

    setStep((prev) => Math.min(4, prev + 1));
  }

  function prevStep() {
    setSubmitError(null);
    setStep((prev) => Math.max(1, prev - 1));
  }

  async function fundEscrow() {
    if (!token) {
      setSubmitError("Session missing. Please sign in again.");
      return;
    }

    if (insufficientBalance) {
      setFundingState("error");
      setSubmitError(`Insufficient balance. You need ${neededMoreAlgo.toFixed(2)} more ALGO.`);
      return;
    }

    if (wrongNetwork) {
      setFundingState("error");
      setSubmitError("Switch to MainNet first.");
      return;
    }

    setSubmitError(null);

    try {
      const values = form.getValues();
      let bountyId = createdBountyId;
      if (!bountyId) {
        const created = (await createBountyRequest(token, {
          title: values.title,
          description: values.description,
          acceptance_criteria: values.acceptanceCriteria,
          repo_url: values.repoUrl,
          target_branch: values.targetBranch,
          allowed_languages: values.allowedLanguages,
          total_amount: String(toMicroAlgo(values.totalAmountAlgo)),
          scoring_mode: values.scoringMode,
          ai_score_threshold: values.aiThreshold,
          max_freelancers: values.maxFreelancers === "unlimited" ? 9999 : Number(values.maxFreelancers),
          deadline: new Date(values.deadline).toISOString(),
        })) as { bounty: { id: string } };
        bountyId = created.bounty.id;
        setCreatedBountyId(bountyId);
      }

      setFundingState("signing");
      await new Promise((resolve) => setTimeout(resolve, 300));
      setFundingState("broadcasting");
      await fundBountyRequest(token, bountyId);
      setFundingState("confirming");
      await new Promise((resolve) => setTimeout(resolve, 450));
      setFundingState("success");
      window.sessionStorage.removeItem(STORAGE_KEY);
      void confetti({
        particleCount: 120,
        spread: 80,
        origin: { y: 0.6 },
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("SC-C-004")) {
        setSubmitError("Bounty creation failed - no funds were locked. Please try again.");
        setFundingState("error");
        return;
      }
      if (message.includes("SC-C-002")) {
        setSubmitError("Transaction is taking longer than expected.");
        setFundingState("timeout");
        return;
      }
      setSubmitError(message);
      setFundingState("error");
    }
  }

  function stepState(index: number) {
    if (index + 1 < step) {
      return "done";
    }
    if (index + 1 === step) {
      return "active";
    }
    return "pending";
  }

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro
            title="Create Bounty"
            subtitle="Configure technical scoring, payout controls, and escrow funding in a guided 4-step flow."
          />

          {!isClient ? (
            <Card>
              <p className="text-sm text-[#8f1515]">Only clients can create bounties. Redirecting...</p>
            </Card>
          ) : null}

          <Card className="space-y-5">
            <div className="flex items-center gap-2 overflow-x-auto">
              {STEPS.map((label, index) => {
                const state = stepState(index);
                return (
                  <div key={label} className="flex items-center gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold ${
                          state === "done"
                            ? "border-[#1040c0] bg-[#1040c0] text-white"
                            : state === "active"
                              ? "border-[#1040c0] bg-[#1040c0] text-white"
                              : "border-[#a0a0a0] bg-white text-[#a0a0a0]"
                        }`}
                      >
                        {state === "done" ? <Check size={14} /> : index + 1}
                      </span>
                      <span className={`text-sm ${state === "pending" ? "text-text-tertiary" : "text-[#121212]"}`}>
                        {label}
                      </span>
                    </div>
                    {index < STEPS.length - 1 ? <div className="h-[2px] w-8 bg-[#d7d7d7]" /> : null}
                  </div>
                );
              })}
            </div>

            {step === 1 ? (
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-semibold">Title</label>
                  <Input {...form.register("title")} maxLength={100} />
                  {form.formState.errors.title ? (
                    <p className="mt-1 text-xs text-[#8f1515]">{form.formState.errors.title.message}</p>
                  ) : null}
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="block text-sm font-semibold">Description</label>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 px-3 text-xs"
                      onClick={() => void improveProjectDescription()}
                      disabled={descriptionSuggestionLoading}
                    >
                      {descriptionSuggestionLoading ? "Improving..." : "Improve with AI"}
                    </Button>
                  </div>
                  <Textarea
                    {...form.register("description")}
                    rows={4}
                    onInput={(event) => textAreaAutoResize(event.currentTarget)}
                  />
                  {descriptionSuggestionMessage ? (
                    <p className="mt-1 text-xs text-[#4b4b4b]">{descriptionSuggestionMessage}</p>
                  ) : null}
                  {form.formState.errors.description ? (
                    <p className="mt-1 text-xs text-[#8f1515]">{form.formState.errors.description.message}</p>
                  ) : null}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold">Acceptance Criteria</label>
                  <Textarea
                    {...form.register("acceptanceCriteria")}
                    rows={5}
                    onInput={(event) => textAreaAutoResize(event.currentTarget)}
                  />
                  <p className="mt-1 text-xs text-[#4b4b4b]">
                    Be specific - the AI uses this to score submissions.
                  </p>
                  {form.formState.errors.acceptanceCriteria ? (
                    <p className="mt-1 text-xs text-[#8f1515]">{form.formState.errors.acceptanceCriteria.message}</p>
                  ) : null}
                </div>

                <Card className="space-y-3 bg-[#f7fbff]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">Find Matching Freelancers</p>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-8 px-3 text-xs"
                      onClick={() => void findFreelancerRecommendations()}
                      disabled={recommendationsLoading}
                    >
                      {recommendationsLoading ? "Finding matches..." : "Find Matches"}
                    </Button>
                  </div>

                  <p className="text-xs text-[#4b4b4b]">
                    Use your description and acceptance criteria to rank best-fit freelancers before publishing.
                  </p>

                  {recommendationError ? (
                    <p className="text-xs text-[#8f1515]">{recommendationError}</p>
                  ) : null}

                  {recommendations.length > 0 ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      {recommendations.map((freelancer) => {
                        const shortlisted = shortlistedIds.includes(freelancer.id);
                        return (
                          <div key={freelancer.id} className="space-y-2 border border-[#121212] bg-white p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold">{freelancer.name}</p>
                                <p className="text-xs text-[#4b4b4b]">Match {freelancer.match.score}/100</p>
                              </div>
                              <span className="border border-[#121212] bg-[#f0c020] px-2 py-0.5 text-[10px] font-bold uppercase">
                                Trust {freelancer.trustScore}
                              </span>
                            </div>

                            <p className="text-xs text-[#4b4b4b]">
                              Rating {freelancer.rating.toFixed(2)} | Passed {freelancer.stats.passedSubmissions}/
                              {freelancer.stats.totalSubmissions}
                            </p>

                            {freelancer.match.reasons.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {freelancer.match.reasons.map((reason) => (
                                  <span key={reason} className="border border-[#121212] bg-[#f6f6f6] px-2 py-0.5 text-[10px]">
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            ) : null}

                            <div className="flex flex-wrap gap-2">
                              <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                                <Link href={`/dashboard/freelancers/${freelancer.id}`}>View Profile</Link>
                              </Button>
                              <Button
                                type="button"
                                variant={shortlisted ? "primary" : "secondary"}
                                className="h-8 px-3 text-xs"
                                onClick={() => toggleShortlist(freelancer.id)}
                              >
                                {shortlisted ? "Shortlisted" : "Shortlist"}
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                className="h-8 px-3 text-xs"
                                onClick={() => copyOutreachMessage(freelancer)}
                              >
                                Copy Outreach
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </Card>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-5">
                <div>
                  <label className="mb-1 block text-sm font-semibold">GitHub Repo URL</label>
                  <div className="relative">
                    <Code2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5f5f5f]" />
                    <Input className="pl-9" {...form.register("repoUrl")} onBlur={() => void validateRepoOnBlur()} />
                  </div>
                  {repoState.status === "loading" ? <p className="mt-1 text-xs text-[#4b4b4b]">Validating...</p> : null}
                  {repoState.status === "success" ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-[#1b7b30]">
                      <CheckCircle2 size={14} /> Repository accessible
                    </p>
                  ) : null}
                  {repoState.status === "warning" ? (
                    <p className="mt-1 text-xs text-[#9a6a00]">{repoState.message}</p>
                  ) : null}
                  {repoState.status === "error" ? (
                    <p className="mt-1 text-xs text-[#8f1515]">
                      {repoState.message}{" "}
                      {repoState.installUrl ? (
                        <a href={repoState.installUrl} target="_blank" rel="noreferrer" className="underline">
                          Install it here
                        </a>
                      ) : null}
                    </p>
                  ) : null}
                  {form.formState.errors.repoUrl ? (
                    <p className="mt-1 text-xs text-[#8f1515]">{form.formState.errors.repoUrl.message}</p>
                  ) : null}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold">Target Branch</label>
                  <Input {...form.register("targetBranch")} />
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-semibold">Scoring Mode</p>
                  <div className="grid gap-3 md:grid-cols-3">
                    {scoringModes.map((mode) => {
                      const Icon = mode.icon;
                      const active = form.watch("scoringMode") === mode.value;
                      return (
                        <button
                          key={mode.value}
                          type="button"
                          onClick={() => form.setValue("scoringMode", mode.value, { shouldValidate: true })}
                          className={`rounded-none border-2 p-3 text-left ${
                            active ? "border-[#1040c0] bg-[#e9f0ff]" : "border-[#121212] bg-white"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1 text-sm font-semibold">
                              <Icon size={14} /> {mode.title}
                            </span>
                            {mode.recommended ? (
                              <span className="border border-[#121212] bg-[#f0c020] px-2 py-[2px] text-[10px] font-bold uppercase">
                                Recommended
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-2 text-xs text-[#4b4b4b]">{mode.desc}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-sm font-semibold">AI Score Threshold</label>
                    <span className="text-xs font-semibold">{aiThreshold}</span>
                  </div>
                  <input
                    type="range"
                    min={40}
                    max={100}
                    step={1}
                    className="w-full accent-[#1040c0]"
                    value={aiThreshold}
                    onChange={(event) => form.setValue("aiThreshold", Number(event.target.value), { shouldValidate: true })}
                  />
                  <p className="mt-1 text-xs text-[#4b4b4b]">
                    Submissions scoring below {aiThreshold}/100 will be auto-rejected.
                  </p>
                </div>

                <div>
                  <p className="mb-2 text-sm font-semibold">Allowed Languages</p>
                  <div className="flex flex-wrap gap-2">
                    {languageOptions.map((language) => {
                      const selected = form.watch("allowedLanguages").includes(language);
                      return (
                        <button
                          type="button"
                          key={language}
                          onClick={() => {
                            const current = form.getValues("allowedLanguages");
                            const next = current.includes(language)
                              ? current.filter((item) => item !== language)
                              : [...current, language];
                            form.setValue("allowedLanguages", next, { shouldValidate: true });
                          }}
                          className={`border px-3 py-1 text-xs font-semibold ${
                            selected ? "border-[#1040c0] bg-[#1040c0] text-white" : "border-[#121212] bg-white"
                          }`}
                        >
                          {language}
                        </button>
                      );
                    })}
                  </div>
                  {form.formState.errors.allowedLanguages ? (
                    <p className="mt-1 text-xs text-[#8f1515]">{form.formState.errors.allowedLanguages.message}</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="space-y-5">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => form.setValue("payoutMode", "simple")}
                    className={`border px-3 py-1 text-sm font-semibold ${
                      payoutMode === "simple" ? "border-[#1040c0] bg-[#1040c0] text-white" : "border-[#121212] bg-white"
                    }`}
                  >
                    Simple
                  </button>
                  <button
                    type="button"
                    onClick={() => form.setValue("payoutMode", "milestones")}
                    className={`border px-3 py-1 text-sm font-semibold ${
                      payoutMode === "milestones" ? "border-[#1040c0] bg-[#1040c0] text-white" : "border-[#121212] bg-white"
                    }`}
                  >
                    Milestones
                  </button>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold">Total Amount</label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={form.watch("totalAmountAlgo")}
                      onChange={(event) =>
                        form.setValue("totalAmountAlgo", Number(event.target.value), { shouldValidate: true })
                      }
                    />
                    <span className="text-sm font-bold text-[#6e5a00]">ALGO</span>
                  </div>
                  <p className="mt-1 text-xs text-[#4b4b4b]">
                    1 ALGO = {MICRO_ALGO_PER_ALGO.toLocaleString()} microALGO. Balance checks run in microALGO before funding.
                  </p>
                </div>

                {payoutMode === "milestones" ? (
                  <div className="space-y-3 rounded-none border-2 border-[#121212] bg-[#f8f8f8] p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">Milestones</p>
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-8 px-3 text-xs"
                        onClick={() => append({ title: "", amountAlgo: 0, description: "" })}
                      >
                        Add Milestone
                      </Button>
                    </div>

                    {fields.map((field, index) => (
                      <div
                        key={field.id}
                        draggable
                        onDragStart={() => setDragIndex(index)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (dragIndex === null || dragIndex === index) {
                            return;
                          }
                          move(dragIndex, index);
                          setDragIndex(null);
                        }}
                        className="space-y-2 border border-[#121212] bg-white p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 text-xs text-[#5f5f5f]">
                            <GripVertical size={14} /> Drag to reorder
                          </span>
                          <button
                            type="button"
                            className="text-xs font-semibold text-[#8f1515]"
                            onClick={() => remove(index)}
                            disabled={fields.length === 1}
                          >
                            Remove
                          </button>
                        </div>
                        <Input placeholder="Title" {...form.register(`milestones.${index}.title`)} />
                        <Input
                          type="number"
                          min={1}
                          step={0.1}
                          placeholder="Amount (ALGO)"
                          value={form.watch(`milestones.${index}.amountAlgo`) || 0}
                          onChange={(event) =>
                            form.setValue(`milestones.${index}.amountAlgo`, Number(event.target.value), {
                              shouldValidate: true,
                            })
                          }
                        />
                        <details>
                          <summary className="cursor-pointer text-xs font-semibold">Description</summary>
                          <Textarea
                            className="mt-2"
                            rows={3}
                            {...form.register(`milestones.${index}.description`)}
                          />
                        </details>
                      </div>
                    ))}

                    <p className="text-xs text-[#4b4b4b]">
                      Running total: {milestonesTotal.toFixed(2)} / {Number(totalAmountAlgo || 0).toFixed(2)} ALGO
                    </p>
                    {milestonesTotal > Number(totalAmountAlgo || 0) ? (
                      <p className="text-xs text-[#8f1515]">Milestone sum is greater than total bounty amount.</p>
                    ) : null}
                  </div>
                ) : null}

                <div>
                  <label className="mb-1 block text-sm font-semibold">Deadline</label>
                  <Input
                    type="datetime-local"
                    className="bg-[#101520] text-white"
                    value={form.watch("deadline")}
                    onChange={(event) => form.setValue("deadline", event.target.value, { shouldValidate: true })}
                  />
                  {shortDeadline ? (
                    <div className="mt-2 border border-[#be8b00] bg-[#fff4d6] p-2 text-xs text-[#7a5a00]">
                      Short deadline - freelancers may not have enough time.
                    </div>
                  ) : null}
                </div>

                <div>
                  <p className="mb-2 text-sm font-semibold">Max Freelancers</p>
                  <div className="flex flex-wrap gap-2">
                    {["1", "3", "5", "unlimited"].map((count) => (
                      <button
                        type="button"
                        key={count}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                          form.watch("maxFreelancers") === count
                            ? "border-[#1040c0] bg-[#1040c0] text-white"
                            : "border-[#121212] bg-white"
                        }`}
                        onClick={() => form.setValue("maxFreelancers", count as FormValues["maxFreelancers"])}
                      >
                        {count === "unlimited" ? "Unlimited" : count}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {step === 4 ? (
              <div className="space-y-4">
                <Card className="space-y-3 bg-[#f7fbff]">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Basics</p>
                    <button type="button" className="text-xs underline" onClick={() => setStep(1)}>
                      Edit
                    </button>
                  </div>
                  <p className="text-sm font-semibold">{form.watch("title")}</p>
                  <p className="text-xs text-[#4b4b4b]">{form.watch("description")}</p>

                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Technical Config</p>
                    <button type="button" className="text-xs underline" onClick={() => setStep(2)}>
                      Edit
                    </button>
                  </div>
                  <p className="text-xs text-[#4b4b4b]">{form.watch("repoUrl")} ({form.watch("targetBranch")})</p>

                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Payment & Timeline</p>
                    <button type="button" className="text-xs underline" onClick={() => setStep(3)}>
                      Edit
                    </button>
                  </div>
                  <p className="text-xs text-[#4b4b4b]">
                    {Number(form.watch("totalAmountAlgo") || 0).toFixed(2)} ALGO, deadline {new Date(form.watch("deadline")).toLocaleString()}
                  </p>
                </Card>

                <Card className="space-y-3">
                  <p className="text-sm font-semibold">Wallet Check</p>
                  <p className="text-xs text-[#4b4b4b]">Connected network: {connectedNetwork}</p>
                  <p className="text-xs text-[#4b4b4b]">Current balance: {currentBalanceAlgo.toFixed(2)} ALGO</p>
                  <p className="text-xs text-[#4b4b4b]">Amount to lock: {totalLockAlgo.toFixed(2)} ALGO</p>

                  {insufficientBalance ? (
                    <div className="border border-[#8f1515] bg-[#ffe7e7] p-2 text-xs text-[#8f1515]">
                      Insufficient balance. You need {neededMoreAlgo.toFixed(2)} more ALGO. <Link href="/dashboard/wallet" className="underline">Top up</Link>
                    </div>
                  ) : null}

                  {wrongNetwork ? (
                    <div className="border border-[#be8b00] bg-[#fff4d6] p-2 text-xs text-[#7a5a00]">
                      Switch to MainNet first.
                    </div>
                  ) : null}

                  {submitError ? (
                    <div className="border border-[#8f1515] bg-[#ffe7e7] p-2 text-xs text-[#8f1515]">
                      {submitError}
                      {fundingState === "timeout" ? (
                        <a
                          href="https://testnet.explorer.perawallet.app"
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 underline"
                        >
                          Check Status
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  {fundingState === "success" ? (
                    <div className="border border-[#1b7b30] bg-[#e9ffe9] p-2 text-xs text-[#1b7b30]">
                      Bounty is live!{" "}
                      {createdBountyId ? <Link href={`/bounties/${createdBountyId}`} className="underline">View Bounty</Link> : null}
                    </div>
                  ) : null}

                  <Button
                    className="w-full"
                    disabled={fundingState === "signing" || fundingState === "broadcasting" || fundingState === "confirming" || fundingState === "success"}
                    onClick={() => void fundEscrow()}
                  >
                    {fundingState === "idle" ? "Fund Escrow" : null}
                    {fundingState === "signing" ? "Signing transaction..." : null}
                    {fundingState === "broadcasting" ? "Broadcasting..." : null}
                    {fundingState === "confirming" ? "Waiting for confirmation..." : null}
                    {fundingState === "success" ? "Escrow Funded" : null}
                    {fundingState === "error" || fundingState === "timeout" ? "Retry Funding" : null}
                  </Button>
                </Card>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-2">
              <Button variant="secondary" onClick={prevStep} disabled={step === 1}>
                Back
              </Button>
              {step < 4 ? (
                <Button onClick={() => void nextStep()}>Continue</Button>
              ) : null}
            </div>
          </Card>

          <Card className="border-[#121212] bg-[#fffaf0]">
            <p className="flex items-center gap-1 text-xs text-[#6b5600]">
              <Info size={14} /> Form progress is saved per step in your current session.
            </p>
          </Card>

          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Recent Draft Bounties</h3>
              <Button
                type="button"
                variant="secondary"
                className="h-8 px-3 text-xs"
                onClick={() => void (async () => {
                  if (!token) {
                    return;
                  }
                  setDraftsLoading(true);
                  try {
                    const response = (await listMyBountiesRequest(token, {
                      status: "draft",
                      limit: 5,
                    })) as { data?: DraftBounty[] };
                    setDrafts(response.data ?? []);
                  } finally {
                    setDraftsLoading(false);
                  }
                })()}
              >
                Refresh Drafts
              </Button>
            </div>

            {draftsLoading ? <p className="text-xs text-[#4b4b4b]">Loading drafts...</p> : null}

            {!draftsLoading && drafts.length === 0 ? (
              <p className="text-xs text-[#4b4b4b]">No draft bounties yet.</p>
            ) : null}

            {drafts.map((draft) => (
              <div key={draft.id} className="flex flex-wrap items-center justify-between gap-2 border border-[#121212] bg-[#f8f8f8] p-3">
                <div>
                  <p className="text-sm font-semibold">{draft.title}</p>
                  <p className="text-xs text-[#4b4b4b]">
                    {fromMicroAlgo(draft.total_amount).toFixed(2)} ALGO | {draft.scoring_mode} | {new Date(draft.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-8 px-3 text-xs"
                    onClick={() => loadDraftIntoForm(draft)}
                  >
                    Load Into Form
                  </Button>
                  <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                    <Link href={`/bounties/${draft.id}`}>Open Draft</Link>
                  </Button>
                </div>
              </div>
            ))}
          </Card>
        </section>
      </AppShell>
    </Protected>
  );
}
