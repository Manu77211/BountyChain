import { inngest } from "./aiScoring.job";
import {
  buildDeniFinalDecision,
  prepareDeniMiniAgentContext,
  runComplianceMiniAgent,
  runQualityMiniAgent,
  runRiskMiniAgent,
  runTransactionMiniAgent,
  type DeniDemoEventPayload,
} from "../services/deniMiniAgent.service";

interface DeniDemoRequestedEvent {
  data: DeniDemoEventPayload;
}

export const deniDemoJob = inngest.createFunction(
  {
    id: "deni_demo_orchestrator",
    retries: 1,
    name: "Deni Demo Orchestrator",
  },
  { event: "deni/demo_requested" },
  async (context) => {
    const payload = (context.event as DeniDemoRequestedEvent).data;

    const deniContext = await context.step.run("prepare_context", async () => {
      return prepareDeniMiniAgentContext(payload);
    });

    const risk = await context.step.run("risk_mini_agent", async () => {
      return runRiskMiniAgent(deniContext);
    });

    const quality = await context.step.run("quality_mini_agent", async () => {
      return runQualityMiniAgent(deniContext);
    });

    const compliance = await context.step.run("compliance_mini_agent", async () => {
      return runComplianceMiniAgent(deniContext);
    });

    const tx = await context.step.run("transaction_mini_agent", async () => {
      return runTransactionMiniAgent(deniContext);
    });

    await context.step.run("emit_partial_events", async () => {
      await inngest.send({
        name: "deni/demo_risk_completed",
        data: {
          run_id: deniContext.runId,
          score: risk.score,
          detail: risk.detail,
        },
      });

      await inngest.send({
        name: "deni/demo_quality_completed",
        data: {
          run_id: deniContext.runId,
          score: quality.score,
          detail: quality.detail,
        },
      });
    });

    const summary = await context.step.run("compose_summary", async () => {
      return buildDeniFinalDecision({
        context: deniContext,
        risk,
        quality,
        compliance,
        tx,
      });
    });

    await context.step.run("emit_final_event", async () => {
      await inngest.send({
        name: "deni/demo_completed",
        data: summary,
      });
    });

    return {
      ok: true,
      ...summary,
    };
  },
);
