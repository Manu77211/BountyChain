import { dbQuery } from "../../lib/db/client";
import { inngest } from "./aiScoring.job";
import { logEvent } from "../utils/logger";

interface SanctionsRecord {
  wallet_address: string;
  source: string;
  reason: string;
}

const ALGORAND_WALLET_REGEX = /^[A-Z2-7]{58}$/;

function normalizeWalletAddress(value: string) {
  return value.trim().toUpperCase();
}

function parseSanctionsPayload(payload: unknown): SanctionsRecord[] {
  if (!payload) {
    return [];
  }

  const source = process.env.COMPLIANCE_PROVIDER_NAME ?? "provider";

  if (Array.isArray(payload)) {
    return payload
      .map((item) => {
        if (typeof item === "string") {
          return {
            wallet_address: normalizeWalletAddress(item),
            source,
            reason: "listed",
          };
        }

        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          const wallet = rec.wallet_address ?? rec.wallet ?? rec.address;
          const reason = typeof rec.reason === "string" ? rec.reason : "listed";

          if (typeof wallet === "string") {
            return {
              wallet_address: normalizeWalletAddress(wallet),
              source,
              reason,
            };
          }
        }

        return null;
      })
      .filter((row): row is SanctionsRecord => row !== null)
      .filter((row) => ALGORAND_WALLET_REGEX.test(row.wallet_address));
  }

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const wallets = obj.wallets;
    if (Array.isArray(wallets)) {
      return parseSanctionsPayload(wallets);
    }
  }

  return [];
}

async function fetchProviderSanctionsList(): Promise<SanctionsRecord[]> {
  const providerUrl = process.env.COMPLIANCE_PROVIDER_URL;
  if (!providerUrl) {
    return [];
  }

  const response = await fetch(providerUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.COMPLIANCE_PROVIDER_TOKEN
        ? { Authorization: `Bearer ${process.env.COMPLIANCE_PROVIDER_TOKEN}` }
        : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Compliance provider returned ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return parseSanctionsPayload(payload);
}

async function getComplianceRecipients() {
  const explicitIds = (process.env.COMPLIANCE_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const admins = await dbQuery<{ id: string }>(
    "SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL",
  );

  const recipientIds = new Set<string>(explicitIds);
  for (const admin of admins.rows) {
    recipientIds.add(admin.id);
  }

  return [...recipientIds];
}

async function notifyComplianceTeam(userIds: string[], payload: Record<string, unknown>) {
  for (const userId of userIds) {
    await dbQuery(
      `
        INSERT INTO notifications (user_id, type, event_type, payload, delivered, failed_attempts)
        VALUES ($1, 'in_app', 'sanctions_flagged', $2::jsonb, FALSE, 0)
      `,
      [userId, JSON.stringify(payload)],
    );
  }
}

export const sanctionsSyncJob = inngest.createFunction(
  {
    id: "sanctions_sync",
    name: "Sanctions Sync Job",
    retries: 1,
  },
  { cron: "0 0 * * *" },
  async (context) => {
    const summary = await context.step.run("sync_sanctions_list", async () => {
      const providerRows = await fetchProviderSanctionsList();
      if (providerRows.length === 0) {
        return {
          provider_wallet_count: 0,
          flagged_user_count: 0,
          quarantined_payout_count: 0,
        };
      }

      const walletAddresses = [...new Set(providerRows.map((row) => row.wallet_address))];
      const affectedUsers = await dbQuery<{ id: string; wallet_address: string }>(
        `
          SELECT id, wallet_address
          FROM users
          WHERE deleted_at IS NULL
            AND is_sanctions_flagged = FALSE
            AND wallet_address = ANY($1::text[])
        `,
        [walletAddresses],
      );

      let quarantinedPayoutCount = 0;

      for (const user of affectedUsers.rows) {
        const details = providerRows.find((row) => row.wallet_address === normalizeWalletAddress(user.wallet_address));
        await dbQuery(
          `
            UPDATE users
            SET is_sanctions_flagged = TRUE,
                updated_at = NOW()
            WHERE id = $1
          `,
          [user.id],
        );

        const payoutUpdate = await dbQuery(
          `
            UPDATE payouts
            SET status = 'quarantined',
                hold_reason = COALESCE(hold_reason, 'sanctions_list_match'),
                updated_at = NOW()
            WHERE freelancer_id = $1
              AND status IN ('pending', 'processing')
          `,
          [user.id],
        );

        quarantinedPayoutCount += payoutUpdate.rowCount ?? 0;

        await dbQuery(
          `
            INSERT INTO sanctions_screenings (wallet_address, user_id, route_name, is_flagged, source, details)
            VALUES ($1, $2, 'scheduled:sanctions_sync', TRUE, $3, $4::jsonb)
          `,
          [
            user.wallet_address,
            user.id,
            details?.source ?? "provider",
            JSON.stringify({
              reason: details?.reason ?? "listed",
              source: details?.source ?? "provider",
            }),
          ],
        );
      }

      if (affectedUsers.rows.length > 0) {
        const complianceRecipients = await getComplianceRecipients();
        await notifyComplianceTeam(complianceRecipients, {
          code: "CL-001",
          affected_user_ids: affectedUsers.rows.map((row) => row.id),
          provider_wallet_count: providerRows.length,
          quarantined_payout_count: quarantinedPayoutCount,
        });
      }

      return {
        provider_wallet_count: providerRows.length,
        flagged_user_count: affectedUsers.rows.length,
        quarantined_payout_count: quarantinedPayoutCount,
      };
    });

    logEvent("info", "Sanctions sync completed", {
      event_type: "sanctions_sync_completed",
      ...summary,
    });

    return {
      ok: true,
      summary,
    };
  },
);
