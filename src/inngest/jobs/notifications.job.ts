import { dbQuery } from "../../../lib/db/client";
import { sendNotification } from "../../services/notification.service";
import { inngest } from "../client";
import { asString, createInAppNotification } from "../shared";

export const notificationJob = inngest.createFunction(
  {
    id: "send-notification",
    name: "Notification Dispatcher",
    retries: 3,
    concurrency: { limit: 50 },
  },
  { event: "notification/send" },
  async ({ event, step }) => {
    const deduped = await step.run("check-duplicate-notification", async () => {
      const existing = await dbQuery<{ id: string }>(
        `
          SELECT id
          FROM notifications
          WHERE user_id = $1
            AND event_type = $2
            AND created_at >= NOW() - INTERVAL '60 seconds'
          LIMIT 1
        `,
        [event.data.user_id, event.data.event_type],
      );

      return (existing.rowCount ?? 0) > 0;
    });

    if (deduped) {
      return {
        deduped: true,
      };
    }

    try {
      const result = await step.run("dispatch-notification", async () => {
        return sendNotification({
          user_id: event.data.user_id,
          event_type: event.data.event_type,
          payload: event.data.payload,
          channels: event.data.channels,
        });
      });

      return {
        deduped: false,
        result,
      };
    } catch (error) {
      await step.run("fallback-to-in-app", async () => {
        await createInAppNotification(event.data.user_id, `${event.data.event_type}_fallback`, {
          payload: event.data.payload,
          detail: asString(error instanceof Error ? error.message : "notification dispatch failed"),
          code: "RT-003",
        });
      });

      return {
        deduped: false,
        fallback: true,
      };
    }
  },
);
