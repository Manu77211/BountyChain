import { createHash, randomUUID } from "node:crypto";

export interface DeniDemoEventPayload {
  run_id?: string;
  submission_id?: string;
  bounty_id?: string;
  initiated_by?: string;
  purpose?: string;
}

export interface DeniMiniAgentContext {
  runId: string;
  submissionId: string;
  bountyId: string;
  initiatedBy: string;
  purpose: string;
  createdAtIso: string;
}

export interface DeniScoreResult {
  score: number;
  detail: string;
}

export interface DeniTxResult {
  lockTxId: string;
  transferTxId: string;
}

function stableScore(seed: string, min: number, max: number) {
  const digest = createHash("sha256").update(seed).digest();
  const value = digest.readUInt16BE(0);
  const span = Math.max(1, max - min + 1);
  return min + (value % span);
}

export function prepareDeniMiniAgentContext(payload: DeniDemoEventPayload): DeniMiniAgentContext {
  return {
    runId: payload.run_id?.trim() || randomUUID(),
    submissionId: payload.submission_id?.trim() || randomUUID(),
    bountyId: payload.bounty_id?.trim() || randomUUID(),
    initiatedBy: payload.initiated_by?.trim() || "deni-demo",
    purpose: payload.purpose?.trim() || "Deni demo orchestration",
    createdAtIso: new Date().toISOString(),
  };
}

export function runRiskMiniAgent(context: DeniMiniAgentContext): DeniScoreResult {
  const score = stableScore(`${context.runId}:risk`, 68, 96);
  return {
    score,
    detail: score >= 80 ? "Low risk profile for demo execution" : "Review recommended before release",
  };
}

export function runQualityMiniAgent(context: DeniMiniAgentContext): DeniScoreResult {
  const score = stableScore(`${context.runId}:quality`, 70, 98);
  return {
    score,
    detail: score >= 85 ? "Quality gate passed for demo" : "Quality gate passed with advisories",
  };
}

export function runComplianceMiniAgent(context: DeniMiniAgentContext): DeniScoreResult {
  const score = stableScore(`${context.runId}:compliance`, 72, 99);
  return {
    score,
    detail: score >= 85 ? "Compliance profile healthy" : "Compliance profile needs manual note",
  };
}

export function runTransactionMiniAgent(context: DeniMiniAgentContext): DeniTxResult {
  const stamp = Date.now();
  return {
    lockTxId: `deni-lock-${context.runId.slice(0, 8)}-${stamp}`,
    transferTxId: `deni-transfer-${context.runId.slice(0, 8)}-${stamp}`,
  };
}

export function buildDeniFinalDecision(input: {
  context: DeniMiniAgentContext;
  risk: DeniScoreResult;
  quality: DeniScoreResult;
  compliance: DeniScoreResult;
  tx: DeniTxResult;
}) {
  const finalScore = Math.round((input.risk.score + input.quality.score + input.compliance.score) / 3);
  const decision = finalScore >= 80 ? "approve" : "review";
  return {
    run_id: input.context.runId,
    submission_id: input.context.submissionId,
    bounty_id: input.context.bountyId,
    final_score: finalScore,
    decision,
    lock_tx_id: input.tx.lockTxId,
    transfer_tx_id: input.tx.transferTxId,
    notes: [input.risk.detail, input.quality.detail, input.compliance.detail],
  };
}
