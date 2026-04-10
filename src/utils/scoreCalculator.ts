import type { CiStatus, ScoringMode } from "../../lib/db/types";

export interface FinalScoreInput {
  scoringMode: ScoringMode;
  aiScore: number | null;
  ciStatus: CiStatus;
  skippedTestCount: number;
  totalTestCount: number;
  clientRatingStars: number | null;
}

export interface FinalScoreResult {
  ciScorePercent: number;
  clientRatingScore: number;
  aiScore: number | null;
  finalScore: number;
}

export function calculateCiScorePercent(input: {
  ciStatus: CiStatus;
  skippedTestCount: number;
  totalTestCount: number;
}) {
  const { ciStatus, skippedTestCount, totalTestCount } = input;
  const ratio = totalTestCount > 0 ? skippedTestCount / totalTestCount : 0;

  if (ciStatus === "passed" && skippedTestCount === 0) {
    return 100;
  }
  if (ciStatus === "passed" && ratio < 0.2) {
    return 70;
  }
  if (ciStatus === "passed" && ratio >= 0.2) {
    return 0;
  }
  if (ciStatus === "timeout") {
    return 40;
  }
  if (ciStatus === "failed" || ciStatus === "skipped_abuse" || ciStatus === "ci_not_found") {
    return 0;
  }

  return 0;
}

export function calculateClientRatingScore(clientRatingStars: number | null) {
  if (!clientRatingStars) {
    return 50;
  }

  const clamped = Math.max(1, Math.min(5, clientRatingStars));
  return Math.round((clamped / 5) * 100);
}

export function calculateFinalScore(input: FinalScoreInput): FinalScoreResult {
  const ciScorePercent = calculateCiScorePercent({
    ciStatus: input.ciStatus,
    skippedTestCount: input.skippedTestCount,
    totalTestCount: input.totalTestCount,
  });

  const clientRatingScore = calculateClientRatingScore(input.clientRatingStars);
  const aiScore = input.aiScore;

  if (input.scoringMode === "ai_only") {
    return {
      ciScorePercent,
      clientRatingScore,
      aiScore,
      finalScore: aiScore ?? 0,
    };
  }

  if (input.scoringMode === "ci_only") {
    // Requirement specifies ci_score * 100 where ci_score is normalized.
    const ciScoreNormalized = ciScorePercent / 100;
    return {
      ciScorePercent,
      clientRatingScore,
      aiScore,
      finalScore: Math.round(ciScoreNormalized * 100),
    };
  }

  const hybrid = (aiScore ?? 0) * 0.5 + ciScorePercent * 0.3 + clientRatingScore * 0.2;
  return {
    ciScorePercent,
    clientRatingScore,
    aiScore,
    finalScore: Math.round(hybrid),
  };
}
