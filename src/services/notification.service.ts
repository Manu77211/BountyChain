import nodemailer, { type Transporter } from "nodemailer";
import { dbQuery } from "../../lib/db/client";
import { emitToUser, type RealtimeEventName } from "../realtime/socket";

type Channel = "email" | "in_app" | "both";

interface NotificationInput {
  user_id?: string;
  recipients?: string[];
  event_type: string;
  payload?: Record<string, unknown>;
  channels?: Channel[] | Channel;
  subject?: string;
}

let transporter: Transporter | null = null;

export async function sendNotification(input: NotificationInput) {
  const recipients = normalizeRecipients(input.user_id, input.recipients);
  if (recipients.length === 0) {
    return { processed: 0 };
  }

  const { needsEmail, needsInApp, dbType } = parseChannels(input.channels);
  const payload = input.payload ?? {};
  const realtimeEvent = toRealtimeEvent(input.event_type);

  const results: Array<{ user_id: string; delivered: boolean; email_failed: boolean }> = [];

  for (const userId of recipients) {
    const inserted = await dbQuery<{ id: string }>(
      `
        INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
        VALUES ($1, $2, $3, $4::jsonb, FALSE, 0)
        RETURNING id
      `,
      [userId, dbType, input.event_type, JSON.stringify(payload)],
    );

    const notificationId = inserted.rows[0]?.id;
    let inAppDelivered = false;
    let emailDelivered = false;
    let emailFailed = false;

    if (needsInApp) {
      emitToUser(userId, realtimeEvent, {
        ...payload,
        event_type: input.event_type,
      });
      emitToUser(userId, "notification:new", {
        id: notificationId,
        event_type: input.event_type,
        payload,
      });
      inAppDelivered = true;
    }

    if (needsEmail) {
      const user = await dbQuery<{ email: string | null }>(
        "SELECT email FROM users WHERE id = $1 LIMIT 1",
        [userId],
      );

      const email = user.rows[0]?.email;
      if (email) {
        emailDelivered = await sendEmailWithRetry({
          to: email,
          subject: input.subject ?? buildDefaultSubject(input.event_type),
          eventType: input.event_type,
          payload,
        });
      }

      if (!emailDelivered) {
        emailFailed = true;
        if (!needsInApp) {
          emitToUser(userId, "notification:new", {
            id: notificationId,
            event_type: input.event_type,
            payload,
            fallback: "RT-003",
          });
          inAppDelivered = true;
        }
      }
    }

    const delivered = needsEmail ? emailDelivered : inAppDelivered;
    const failedAttempts = emailFailed ? 3 : 0;

    await dbQuery(
      `
        UPDATE notifications
        SET delivered = $1,
            failed_attempts = $2
        WHERE id = $3
      `,
      [delivered, failedAttempts, notificationId],
    );

    results.push({
      user_id: userId,
      delivered,
      email_failed: emailFailed,
    });
  }

  return {
    processed: results.length,
    results,
  };
}

function normalizeRecipients(userId?: string, list?: string[]) {
  const flat = [userId, ...(list ?? [])].filter((value): value is string => Boolean(value));
  return [...new Set(flat)];
}

function parseChannels(channels: NotificationInput["channels"]) {
  const values = Array.isArray(channels) ? channels : channels ? [channels] : ["both"];
  const expanded = new Set<Channel>();

  for (const channel of values) {
    if (channel !== "email" && channel !== "in_app" && channel !== "both") {
      continue;
    }

    if (channel === "both") {
      expanded.add("email");
      expanded.add("in_app");
      continue;
    }
    expanded.add(channel);
  }

  const needsEmail = expanded.has("email");
  const needsInApp = expanded.has("in_app");

  const dbType: Channel = needsEmail && needsInApp ? "both" : needsEmail ? "email" : "in_app";

  return {
    needsEmail,
    needsInApp,
    dbType,
  };
}

function toRealtimeEvent(eventType: string): RealtimeEventName {
  const known: Record<string, RealtimeEventName> = {
    "bounty:funded": "bounty:funded",
    "bounty:accepted": "bounty:accepted",
    "bounty:ci_running": "bounty:ci_running",
    "bounty:ci_passed": "bounty:ci_passed",
    "bounty:ci_failed": "bounty:ci_failed",
    "bounty:scoring": "bounty:scoring",
    "bounty:scored": "bounty:scored",
    "bounty:payout_released": "bounty:payout_released",
    "bounty:expired": "bounty:expired",
    "bounty:deadline_extended": "bounty:deadline_extended",
    "bounty:disputed": "bounty:disputed",
    "dispute:vote_cast": "dispute:vote_cast",
    "dispute:resolved": "dispute:resolved",
    "payout:mismatch_flagged": "payout:mismatch_flagged",
    "validation:opt_in_required": "validation:opt_in_required",
  };

  return known[eventType] ?? "notification:new";
}

async function sendEmailWithRetry(input: {
  to: string;
  subject: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const tx = getEmailTransport();
      await tx.sendMail({
        from: process.env.SMTP_FROM ?? "noreply@bountyescrow.local",
        to: input.to,
        subject: input.subject,
        text: `${input.eventType}\n\n${JSON.stringify(input.payload, null, 2)}`,
      });
      return true;
    } catch {
      if (attempt < 3) {
        await wait(250 * 2 ** (attempt - 1));
      }
    }
  }

  return false;
}

function getEmailTransport() {
  if (transporter) {
    return transporter;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP not configured");
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });

  return transporter;
}

function buildDefaultSubject(eventType: string) {
  return `BountyEscrow update: ${eventType}`;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
