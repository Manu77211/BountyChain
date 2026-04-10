import { dbQuery } from "../../../lib/db/client";
import { resolveDispute, runDisputeEscalationCycle } from "../../services/dispute.service";
import { inngest } from "../client";
import { createInAppNotification } from "../shared";

export const disputeResolutionJob = inngest.createFunction(
  {
    id: "dispute-resolution",
    name: "Dispute Resolution Executor",
    retries: 3,
    concurrency: { key: "event.data.dispute_id", limit: 1 },
  },
  { event: "dispute/all_votes_in" },
  async ({ event, step }) => {
    const voteSummary = await step.run("tally-votes", async () => {
      const challengedVoted = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM dispute_votes
          WHERE dispute_id = $1
            AND is_challenged = TRUE
            AND vote IS NOT NULL
            AND is_active = FALSE
        `,
        [event.data.dispute_id],
      );

      if ((challengedVoted.rowCount ?? 0) > 0) {
        await dbQuery(
          `
            UPDATE dispute_votes
            SET vote = NULL,
                justification = NULL,
                voted_at = NOW()
            WHERE dispute_id = $1
              AND is_challenged = TRUE
              AND is_active = FALSE
          `,
          [event.data.dispute_id],
        );

        return {
          blocked: true,
          reason: "DS-003: challenged arbitrator vote invalidated",
        };
      }

      const counts = await dbQuery<{ votes_in: string; votes_needed: string }>(
        `
          SELECT COUNT(vote)::text AS votes_in,
                 COUNT(*)::text AS votes_needed
          FROM dispute_votes
          WHERE dispute_id = $1
            AND is_active = TRUE
        `,
        [event.data.dispute_id],
      );

      return {
        blocked: false,
        votesIn: Number(counts.rows[0]?.votes_in ?? "0"),
        votesNeeded: Number(counts.rows[0]?.votes_needed ?? "0"),
      };
    });

    if (
      voteSummary.blocked ||
      !("votesIn" in voteSummary) ||
      !("votesNeeded" in voteSummary) ||
      voteSummary.votesIn < voteSummary.votesNeeded
    ) {
      return {
        state: "waiting_for_replacement_vote",
      };
    }

    const selfDealing = await step.run("check-admin-self-dealing", async () => {
      const parties = await dbQuery<{ creator_id: string; freelancer_id: string }>(
        `
          SELECT b.creator_id, s.freelancer_id
          FROM disputes d
          JOIN submissions s ON s.id = d.submission_id
          JOIN bounties b ON b.id = s.bounty_id
          WHERE d.id = $1
          LIMIT 1
        `,
        [event.data.dispute_id],
      );

      if ((parties.rowCount ?? 0) === 0) {
        throw new Error("DS-404: dispute not found");
      }

      const ids = [parties.rows[0].creator_id, parties.rows[0].freelancer_id];
      const admins = await dbQuery<{ id: string }>(
        "SELECT id FROM users WHERE role = 'admin' AND id = ANY($1::uuid[])",
        [ids],
      );

      return {
        blocked: (admins.rowCount ?? 0) > 0,
        partyIds: ids,
      };
    });

    if (selfDealing.blocked) {
      await step.run("escalate-admin-self-dealing", async () => {
        await dbQuery(
          `
            UPDATE disputes
            SET status = 'escalated',
                escalated_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
              AND status IN ('under_review', 'open')
          `,
          [event.data.dispute_id],
        );
      });

      await step.sendEvent("emit-dispute-escalated", {
        name: "dispute/escalated",
        data: {
          dispute_id: event.data.dispute_id,
          reason: "split_vote",
        },
      });

      return {
        state: "escalated_self_dealing",
      };
    }

    const resolution = await step.run("resolve-dispute", async () => {
      return resolveDispute(
        {
          dispute_id: event.data.dispute_id,
        },
        {
          send: async (name, data) => {
            await step.sendEvent("forward-dispute-service-event", {
              name: name as never,
              data: data as never,
            });
          },
        },
        {
          emitToUsers: async (userIds, eventName, payload) => {
            for (const userId of [...new Set(userIds)]) {
              await createInAppNotification(userId, eventName, payload);
            }
          },
        },
      );
    });

    if ("outcome" in resolution && "tx_id" in resolution) {
      await step.sendEvent("emit-dispute-resolved", {
        name: "dispute/resolved",
        data: {
          dispute_id: event.data.dispute_id,
          outcome: resolution.outcome,
          settlement_tx_id: resolution.tx_id,
        },
      });
    }

    return resolution;
  },
);

export const disputeEscalationJob = inngest.createFunction(
  {
    id: "dispute-escalation",
    name: "Dispute SLA Escalation",
    retries: 2,
  },
  { cron: "0 */6 * * *" },
  async ({ step }) => {
    const staleDisputes = await step.run("find-stale-disputes", async () => {
      const rows = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM disputes
          WHERE status = 'under_review'
            AND raised_at < NOW() - INTERVAL '7 days'
        `,
      );
      return rows.rows;
    });

    if (staleDisputes.length === 0) {
      return {
        escalated: 0,
      };
    }

    try {
      const cycle = await step.run("escalate-dispute-cycle", async () => {
        return runDisputeEscalationCycle(
          {
            send: async (name, data) => {
              await step.sendEvent("forward-dispute-escalation-event", {
                name: name as never,
                data: data as never,
              });
            },
          },
          {
            emitToUsers: async (userIds, eventName, payload) => {
              for (const userId of [...new Set(userIds)]) {
                await createInAppNotification(userId, eventName, payload);
              }
            },
          },
        );
      });

      return cycle;
    } catch (error) {
      await step.run("freeze-dispute-no-arbitrators", async () => {
        await dbQuery(
          `
            UPDATE disputes
            SET status = 'escalated',
                updated_at = NOW()
            WHERE id = ANY($1::uuid[])
          `,
          [staleDisputes.map((item) => item.id)],
        );
      });

      const admins = await step.run("fetch-platform-admins", async () => {
        const rows = await dbQuery<{ id: string }>(
          "SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL",
        );
        return rows.rows.map((row) => row.id);
      });

      await step.run("notify-platform-admins", async () => {
        for (const adminId of admins) {
          await createInAppNotification(adminId, "dispute_frozen_no_arbitrators", {
            reason: "no_eligible_arbitrators",
            dispute_ids: staleDisputes.map((item) => item.id),
          });
        }
      });

      return {
        escalated: staleDisputes.length,
        fallback: true,
        detail: error instanceof Error ? error.message : "DS-004 fallback escalation",
      };
    }
  },
);
