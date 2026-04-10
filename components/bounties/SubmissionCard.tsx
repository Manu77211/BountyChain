"use client";

import { GitPullRequest, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ProgressBar } from "../ui/primitives";

type Submission = {
  id: string;
  freelancer_wallet_address: string;
  freelancer_email: string | null;
  submission_received_at: string;
  ci_status: string;
  ci_run_id: string | null;
  ci_retrigger_count: number;
  github_pr_url: string;
  ai_score: number | null;
  ai_score_raw: Record<string, unknown> | null;
  ai_language_mismatch_flag: boolean;
  ai_integrity_flag: boolean;
  final_score: number | null;
  payout_status: string | null;
  score_finalized_at: string | null;
  client_flagged_at: string | null;
};

type SubmissionCardProps = {
  submission: Submission;
  aiThreshold: number;
  isClient: boolean;
  onFlagScore: (submissionId: string) => void;
  onRetriggerCi: (submissionId: string) => void;
};

function initials(wallet: string) {
  return wallet.slice(0, 2).toUpperCase();
}

function timeAgo(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function progressValue(raw: Record<string, unknown> | null, key: string, fallback: number | null) {
  const nested = raw?.[key];
  if (typeof nested === "number") {
    return Math.max(0, Math.min(100, nested));
  }
  return fallback ?? 0;
}

function ciBadgeClass(status: string) {
  if (status === "passed") {
    return "bg-[#e9ffe9] text-[#1b7b30] border-[#1b7b30]";
  }
  if (status === "running" || status === "pending") {
    return "bg-[#eef5ff] text-[#1040c0] border-[#1040c0]";
  }
  if (status === "timeout") {
    return "bg-[#fff4d6] text-[#7a5a00] border-[#be8b00]";
  }
  if (status === "skipped_abuse") {
    return "bg-[#fff0dd] text-[#a35300] border-[#d07a00]";
  }
  return "bg-[#ffe7e7] text-[#8f1515] border-[#8f1515]";
}

export function SubmissionCard({ submission, aiThreshold, isClient, onFlagScore, onRetriggerCi }: SubmissionCardProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const scoreBreakdown = useMemo(() => {
    const raw = submission.ai_score_raw;
    return {
      requirementMatch: progressValue(raw, "requirement_match", submission.ai_score),
      codeQuality: progressValue(raw, "code_quality", submission.ai_score),
      ciBonus: progressValue(raw, "ci_bonus", submission.ai_score),
      integrityScore: progressValue(raw, "integrity_score", submission.ai_score),
    };
  }, [submission.ai_score, submission.ai_score_raw]);

  const canFlag = useMemo(() => {
    if (!isClient || !submission.score_finalized_at || submission.client_flagged_at) {
      return false;
    }
    const elapsed = nowMs - new Date(submission.score_finalized_at).getTime();
    return elapsed < 48 * 60 * 60 * 1000;
  }, [isClient, nowMs, submission.client_flagged_at, submission.score_finalized_at]);

  const flagCountdown = useMemo(() => {
    if (!submission.score_finalized_at) {
      return null;
    }
    const expiresAt = new Date(submission.score_finalized_at).getTime() + 48 * 60 * 60 * 1000;
    const remaining = Math.max(0, expiresAt - nowMs);
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }, [nowMs, submission.score_finalized_at]);

  const finalScore = submission.final_score ?? 0;
  const passed = finalScore >= aiThreshold;

  return (
    <div className="space-y-4 rounded-none border-2 border-[#121212] bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#121212] bg-[#f0c020] text-xs font-black text-[#121212]">
            {initials(submission.freelancer_wallet_address)}
          </div>
          <div>
            <p className="text-sm font-semibold">{submission.freelancer_wallet_address}</p>
            <p className="text-xs text-[#4b4b4b]">Submitted {timeAgo(submission.submission_received_at)}</p>
          </div>
        </div>
      </div>

      <div className="space-y-2 border border-[#121212] bg-[#f8fbff] p-3">
        <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide">
          <GitPullRequest size={14} /> CI/CD
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex border px-2 py-1 text-xs font-semibold ${ciBadgeClass(submission.ci_status)}`}>
            {submission.ci_status}
          </span>
          {submission.github_pr_url ? (
            <a href={submission.github_pr_url} target="_blank" rel="noreferrer" className="text-xs underline">
              GitHub Actions Link
            </a>
          ) : null}
          {submission.ci_status === "timeout" && submission.ci_retrigger_count < 1 ? (
            <button
              type="button"
              onClick={() => onRetriggerCi(submission.id)}
              className="inline-flex items-center gap-1 border border-[#be8b00] bg-[#fff4d6] px-2 py-1 text-xs font-semibold text-[#7a5a00]"
            >
              <RefreshCw size={12} /> Re-trigger CI
            </button>
          ) : null}
          {submission.ci_status === "skipped_abuse" ? (
            <span className="inline-flex border border-[#d07a00] bg-[#fff0dd] px-2 py-1 text-xs font-semibold text-[#a35300]">
              Test integrity issue
            </span>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 border border-[#121212] bg-[#f7fff9] p-3">
        <p className="text-xs font-semibold uppercase tracking-wide">AI Score</p>
        <div className="grid gap-2">
          <div>
            <p className="mb-1 text-xs">Requirement match: {scoreBreakdown.requirementMatch}</p>
            <ProgressBar value={scoreBreakdown.requirementMatch} />
          </div>
          <div>
            <p className="mb-1 text-xs">Code quality: {scoreBreakdown.codeQuality}</p>
            <ProgressBar value={scoreBreakdown.codeQuality} />
          </div>
          <div>
            <p className="mb-1 text-xs">CI bonus: {scoreBreakdown.ciBonus}</p>
            <ProgressBar value={scoreBreakdown.ciBonus} />
          </div>
          <div>
            <p className="mb-1 text-xs">Integrity score: {scoreBreakdown.integrityScore}</p>
            <ProgressBar value={scoreBreakdown.integrityScore} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {submission.ai_language_mismatch_flag ? (
            <span className="inline-flex border border-[#be8b00] bg-[#fff4d6] px-2 py-1 text-xs font-semibold text-[#7a5a00]">
              Language mismatch detected
            </span>
          ) : null}
          {submission.ai_integrity_flag ? (
            <span className="inline-flex border border-[#d07a00] bg-[#fff0dd] px-2 py-1 text-xs font-semibold text-[#a35300]">
              Padding/integrity flagged
            </span>
          ) : null}
        </div>

        {isClient ? (
          <div className="flex items-center gap-2 text-xs">
            {canFlag ? (
              <button type="button" className="underline" onClick={() => onFlagScore(submission.id)}>
                Flag this score
              </button>
            ) : null}
            {flagCountdown ? <span className="text-[#4b4b4b]">{flagCountdown} left</span> : null}
          </div>
        ) : null}
      </div>

      <div className={`rounded-none border-2 p-3 ${passed ? "border-[#1b7b30] bg-[#e9ffe9]" : "border-[#8f1515] bg-[#ffe7e7]"}`}>
        <p className="text-xs uppercase tracking-wide">Final Score</p>
        <p className="text-2xl font-black">
          {finalScore} / {aiThreshold}
        </p>
        <p className="text-xs font-semibold">{passed ? "PASSED" : "FAILED"}</p>
      </div>
    </div>
  );
}
