import { Router } from "express";
import { dbQuery } from "../../lib/db/client";
import { AlgorandService } from "../services/algorand";
import { getRealtimeServer } from "../realtime/socket";
import { inngest } from "../jobs/aiScoring.job";

type HealthState = "ok" | "error" | "rate_limited";
type OverallState = "ok" | "degraded" | "down";

interface ServiceHealth {
  database: HealthState;
  algorand_node: HealthState;
  groq_api: HealthState;
  github_api: HealthState;
  inngest: HealthState;
  socket_io: HealthState;
}

const router = Router();
const algorandService = new AlgorandService();

async function probeDatabase() {
  try {
    await dbQuery("SELECT 1 AS ok");
    return "ok" as const;
  } catch {
    return "error" as const;
  }
}

async function probeAlgorand() {
  try {
    await algorandService.healthCheck();
    return "ok" as const;
  } catch {
    return "error" as const;
  }
}

async function probeGroq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return "error" as const;
  }

  const response = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (response.status === 429) {
    return "rate_limited" as const;
  }
  return response.ok ? ("ok" as const) : ("error" as const);
}

async function probeGitHub() {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch("https://api.github.com/rate_limit", { headers });
  return response.ok ? ("ok" as const) : ("error" as const);
}

function probeInngest() {
  try {
    const hasClient = Boolean(inngest);
    const hasKey = Boolean(process.env.INNGEST_EVENT_KEY || process.env.INNGEST_SIGNING_KEY);
    return hasClient && hasKey ? ("ok" as const) : ("error" as const);
  } catch {
    return "error" as const;
  }
}

function probeSocketIo() {
  const io = getRealtimeServer();
  return io ? ("ok" as const) : ("error" as const);
}

function deriveOverallStatus(services: ServiceHealth): OverallState {
  if (services.database === "error") {
    return "down";
  }

  const external = [
    services.algorand_node,
    services.groq_api,
    services.github_api,
    services.inngest,
    services.socket_io,
  ];

  return external.every((state) => state === "ok") ? "ok" : "degraded";
}

router.get("/health", async (_request, response) => {
  const [database, algorandNode, groqApi, githubApi] = await Promise.all([
    probeDatabase(),
    probeAlgorand(),
    probeGroq().catch(() => "error" as const),
    probeGitHub().catch(() => "error" as const),
  ]);

  const services: ServiceHealth = {
    database,
    algorand_node: algorandNode,
    groq_api: groqApi,
    github_api: githubApi,
    inngest: probeInngest(),
    socket_io: probeSocketIo(),
  };

  const status = deriveOverallStatus(services);
  const httpStatus = status === "down" ? 503 : 200;

  return response.status(httpStatus).json({
    status,
    services,
    uptime_seconds: Math.floor(process.uptime()),
    version: process.env.npm_package_version ?? "0.1.0",
  });
});

export default router;
