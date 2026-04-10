import { inngest } from "./aiScoring.job";
import { sendNotification } from "../services/notification.service";

interface SendNotificationEvent {
  data: {
    user_id?: string;
    recipients?: string[];
    event_type: string;
    payload?: Record<string, unknown>;
    channels?: "email" | "in_app" | "both" | Array<"email" | "in_app" | "both">;
    channel?: "email" | "in_app" | "both" | "email+in_app";
    subject?: string;
    [key: string]: unknown;
  };
}

async function handleSendNotification(event: SendNotificationEvent) {
  const channels = event.data.channels ?? mapLegacyChannel(event.data.channel);
  const payload = event.data.payload ?? extractPayload(event.data);

  return sendNotification({
    user_id: event.data.user_id,
    recipients: event.data.recipients,
    event_type: event.data.event_type,
    payload,
    channels,
    subject: event.data.subject,
  });
}

function mapLegacyChannel(channel?: SendNotificationEvent["data"]["channel"]) {
  if (channel === "email+in_app") {
    return "both" as const;
  }
  return channel;
}

function extractPayload(data: SendNotificationEvent["data"]) {
  const excludedKeys = new Set(["user_id", "recipients", "event_type", "payload", "channels", "channel", "subject"]);
  const payloadEntries = Object.entries(data).filter(([key]) => !excludedKeys.has(key));
  return Object.fromEntries(payloadEntries);
}

export const sendNotificationJob = inngest.createFunction(
  {
    id: "send_notification",
    name: "Send Notification Job",
    retries: 0,
  },
  { event: "send_notification/requested" },
  async (context) => {
    const event = context.event as SendNotificationEvent;
    const result = await context.step.run("send_notification", async () => {
      return handleSendNotification(event);
    });

    return {
      ok: true,
      result,
    };
  },
);

export const sendNotificationCompatJob = inngest.createFunction(
  {
    id: "send_notification_compat",
    name: "Send Notification Compat Job",
    retries: 0,
  },
  { event: "notification/send" },
  async (context) => {
    const event = context.event as SendNotificationEvent;
    const result = await context.step.run("send_notification_compat", async () => {
      return handleSendNotification(event);
    });

    return {
      ok: true,
      result,
    };
  },
);
