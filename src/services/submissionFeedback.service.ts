interface ParsedAiPayload {
  justification?: string;
  recommendations?: string[];
  requirement_match_score?: number;
  total_score?: number;
}

export interface FeedbackReportInput {
  acceptanceCriteria: string;
  artifactUrl: string;
  notes?: string | null;
  aiRaw?: Record<string, unknown> | null;
  clientComment?: string | null;
}

export interface FeedbackReportOutput {
  aiPayload: ParsedAiPayload;
  checklistPayload: {
    total: number;
    implementedCount: number;
    missingCount: number;
  };
  implementedItems: string[];
  missingItems: string[];
  clientSummary: string;
  freelancerSummary: string;
  freelancerSuggestions: string[];
}

function parseAcceptanceCriteria(criteria: string): string[] {
  return criteria
    .split(/\n|;|\./g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4)
    .slice(0, 24);
}

function normalizeToken(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((item) => item.length >= 3);
}

function evaluateChecklist(items: string[], submissionContext: string): {
  implementedItems: string[];
  missingItems: string[];
} {
  const contextTokens = new Set(normalizeToken(submissionContext));
  const implementedItems: string[] = [];
  const missingItems: string[] = [];

  for (const item of items) {
    const tokens = normalizeToken(item);
    if (tokens.length === 0) {
      continue;
    }

    const hits = tokens.filter((token) => contextTokens.has(token)).length;
    const ratio = hits / tokens.length;

    if (ratio >= 0.4) {
      implementedItems.push(item);
      continue;
    }

    missingItems.push(item);
  }

  return { implementedItems, missingItems };
}

function parseAiRaw(aiRaw: Record<string, unknown> | null | undefined): ParsedAiPayload {
  if (!aiRaw || typeof aiRaw !== "object") {
    return {};
  }

  const maybeRecommendations = Array.isArray(aiRaw.recommendations)
    ? aiRaw.recommendations.filter((item): item is string => typeof item === "string")
    : [];

  return {
    justification: typeof aiRaw.justification === "string" ? aiRaw.justification : undefined,
    recommendations: maybeRecommendations,
    requirement_match_score:
      typeof aiRaw.requirement_match_score === "number" ? aiRaw.requirement_match_score : undefined,
    total_score: typeof aiRaw.total_score === "number" ? aiRaw.total_score : undefined,
  };
}

export function buildSubmissionFeedbackReport(input: FeedbackReportInput): FeedbackReportOutput {
  const criteriaItems = parseAcceptanceCriteria(input.acceptanceCriteria);
  const aiPayload = parseAiRaw(input.aiRaw);

  const contextPieces = [input.artifactUrl, input.notes ?? "", input.clientComment ?? "", aiPayload.justification ?? ""];
  const context = contextPieces.join(" ");

  const checklist = evaluateChecklist(criteriaItems, context);
  const aiSuggestions = aiPayload.recommendations ?? [];

  const implementedCount = checklist.implementedItems.length;
  const missingCount = checklist.missingItems.length;
  const total = criteriaItems.length;

  const clientSummary =
    total === 0
      ? "No structured acceptance criteria were found."
      : `${implementedCount}/${total} requirement items appear implemented. ${missingCount} items need attention.`;

  const freelancerSummary =
    missingCount === 0
      ? "All parsed requirement items appear covered. Focus on quality polish and verification evidence."
      : `Address ${missingCount} missing requirement items and re-submit with explicit evidence for each item.`;

  const freelancerSuggestions = [
    ...aiSuggestions.slice(0, 5),
    ...checklist.missingItems.slice(0, 4).map((item) => `Implement requirement: ${item}`),
  ].slice(0, 8);

  return {
    aiPayload,
    checklistPayload: {
      total,
      implementedCount,
      missingCount,
    },
    implementedItems: checklist.implementedItems,
    missingItems: checklist.missingItems,
    clientSummary,
    freelancerSummary,
    freelancerSuggestions,
  };
}
