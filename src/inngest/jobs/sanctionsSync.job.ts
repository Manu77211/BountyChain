import { dbQuery } from "../../../lib/db/client";
import { inngest } from "../client";
import { createInAppNotification } from "../shared";

interface SanctionsRecord {
  wallet_address: string;
  source: string;
  reason: string;
}

const WALLET_REGEX = /^[A-Z2-7]{58}$/;

function normalizeWalletAddress(value: string) {
  return value.trim().toUpperCase();
}

function parseProviderPayload(payload: unknown): SanctionsRecord[] {
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
          const entry = item as Record<string, unknown>;
          const wallet = entry.wallet_address ?? entry.wallet ?? entry.address;
          const reason = typeof entry.reason === "string" ? entry.reason : "listed";

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
      .filter((item): item is SanctionsRecord => item !== null)
      .filter((item) => WALLET_REGEX.test(item.wallet_address));
  }

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.wallets)) {
      return parseProviderPayload(obj.wallets);
    }
  }

  return [];
}

async function fetchProviderSanctionsList() {
  const url = process.env.COMPLIANCE_PROVIDER_URL;
  if (!url) {
    return [] as SanctionsRecord[];
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.COMPLIANCE_PROVIDER_TOKEN
        ? { Authorization: `Bearer ${process.env.COMPLIANCE_PROVIDER_TOKEN}` }
        : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`CL-001: provider returned ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return parseProviderPayload(payload);
}

async function runSanctionsSync(triggeredBy: "schedule" | "admin") {
  const providerRows = await fetchProviderSanctionsList();
  if (providerRows.length === 0) {
    return {
      provider_wallet_count: 0,
      flagged_user_count: 0,
      quarantined_payout_count: 0,
    };
  }

  const walletAddresses = [...new Set(providerRows.map((row) => row.wallet_address))];

  const users = await dbQuery<{ id: string; wallet_address: string }>(
    `
      SELECT id, wallet_address
      FROM users
      WHERE wallet_address = ANY($1::text[])
        AND deleted_at IS NULL
    `,
    [walletAddresses],
  );

  let quarantinedPayoutCount = 0;

  for (const user of users.rows) {
    const detail = providerRows.find((item) => item.wallet_address === normalizeWalletAddress(user.wallet_address));

    await dbQuery(
      "UPDATE users SET is_sanctions_flagged = TRUE, updated_at = NOW() WHERE id = $1",
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
        VALUES ($1, $2, $3, TRUE, $4, $5::jsonb)
      `,
      [
        user.wallet_address,
        user.id,
        `inngest:sanctions_sync:${triggeredBy}`,
        detail?.source ?? "provider",
        JSON.stringify({ reason: detail?.reason ?? "listed", source: detail?.source ?? "provider" }),
      ],
    );
  }

  if (users.rows.length > 0) {
    const admins = await dbQuery<{ id: string }>(
      "SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL",
    );

    for (const admin of admins.rows) {
      await createInAppNotification(admin.id, "sanctions_flagged", {
        code: "CL-001",
        triggered_by: triggeredBy,
        affected_user_ids: users.rows.map((row) => row.id),
        quarantined_payout_count: quarantinedPayoutCount,
      });
    }
  }

  return {
    provider_wallet_count: providerRows.length,
    flagged_user_count: users.rows.length,
    quarantined_payout_count: quarantinedPayoutCount,
  };
}

export const sanctionsSyncJob = inngest.createFunction(
  {
    id: "sanctions-sync",
    name: "Sanctions Sync",
    retries: 1,
  },
  { cron: "0 0 * * *" },
  async ({ step }) => {
    return step.run("sync-sanctions-list", async () => {
      return runSanctionsSync("schedule");
    });
  },
);

export const sanctionsSyncOnDemandJob = inngest.createFunction(
  {
    id: "sanctions-sync-on-demand",
    name: "Sanctions Sync On Demand",
    retries: 1,
  },
  { event: "system/sanctions_sync" },
  async ({ step }) => {
    return step.run("sync-sanctions-list-admin", async () => {
      return runSanctionsSync("admin");
    });
  },
);
