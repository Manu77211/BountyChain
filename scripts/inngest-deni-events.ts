import "../lib/load-env";
import { randomUUID } from "node:crypto";
import { inngest } from "../src/jobs/aiScoring.job";

function toCount(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(20, Math.floor(parsed));
}

async function main() {
  const eventCount = toCount(process.env.DENI_DEMO_EVENT_COUNT, 3);
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];

  for (let index = 0; index < eventCount; index += 1) {
    const runId = randomUUID();
    events.push({
      name: "deni/demo_requested",
      data: {
        run_id: runId,
        submission_id: randomUUID(),
        bounty_id: randomUUID(),
        initiated_by: process.env.DENI_INITIATOR ?? "deni-script",
        purpose: process.env.DENI_PURPOSE ?? "Deni demo event fan-out",
      },
    });
  }

  for (const event of events) {
    await inngest.send(event);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        sent: events.length,
        event_names: events.map((item) => item.name),
        run_ids: events.map((item) => String(item.data.run_id ?? "")),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : "Unknown error";
  console.error(`Failed to send Deni Inngest demo events: ${detail}`);
  process.exit(1);
});
