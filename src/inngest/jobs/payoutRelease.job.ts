import algosdk from "algosdk";
import { dbQuery } from "../../../lib/db/client";
import { screenWalletAndLog } from "../../middleware/sanctions";
import { emitToUser } from "../../realtime/socket";
import { AlgorandService } from "../../services/algorand";
import { processPayoutRelease } from "../../services/payout.service";
import { inngest } from "../client";
import { asString, createInAppNotification } from "../shared";

interface PayoutContext {
  submission_id: string;
  bounty_id: string;
  freelancer_id: string;
  creator_id: string;
  submission_status: string;
  final_score: number | null;
  escrow_locked: boolean;
  payout_asset_id: string | null;
  payout_asset_code: string;
  wallet_address: string;
  total_amount: string;
  latest_payout_id: string | null;
  latest_payout_status: string | null;
}

const algorandService = new AlgorandService();

async function loadPayoutContext(submissionId: string, bountyId: string) {
  const rows = await dbQuery<PayoutContext>(
    `
      SELECT s.id AS submission_id,
             s.bounty_id,
             s.freelancer_id,
             b.creator_id,
             s.status AS submission_status,
             s.final_score,
             b.escrow_locked,
             b.payout_asset_id,
             b.payout_asset_code,
             u.wallet_address,
             b.total_amount,
             p.id AS latest_payout_id,
             p.status AS latest_payout_status
      FROM submissions s
      JOIN bounties b ON b.id = s.bounty_id
      JOIN users u ON u.id = s.freelancer_id
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM payouts
        WHERE submission_id = s.id
        ORDER BY created_at DESC
        LIMIT 1
      ) p ON TRUE
      WHERE s.id = $1
        AND b.id = $2
      LIMIT 1
    `,
    [submissionId, bountyId],
  );

  if ((rows.rowCount ?? 0) === 0) {
    throw new Error("SC-F-404: payout context not found");
  }

  return rows.rows[0];
}

export const payoutReleaseJob = inngest.createFunction(
  {
    id: "payout-release",
    name: "Payout Release Engine",
    retries: 5,
    concurrency: { limit: 5 },
    timeouts: { finish: "20m" },
  },
  { event: "payout/release_requested" },
  async ({ event, step }) => {
    const context = await step.run("pre-payout-checks", async () => {
      const loaded = await loadPayoutContext(event.data.submission_id, event.data.bounty_id);

      if (loaded.freelancer_id === loaded.creator_id) {
        throw new Error("XC-001: freelancer cannot equal bounty creator");
      }

      if (!loaded.escrow_locked) {
        throw new Error("SC-F-003: escrow must be locked before payout");
      }

      if (loaded.submission_status !== "validating") {
        throw new Error("SC-F-003: submission is not payout-eligible");
      }

      if (loaded.latest_payout_status === "completed") {
        return {
          ...loaded,
          skip: true,
        };
      }

      const wallet = asString(loaded.wallet_address).trim().toUpperCase();
      if (!algosdk.isValidAddress(wallet)) {
        await step.sendEvent("emit-invalid-wallet-quarantine", {
          name: "payout/quarantined",
          data: {
            payout_id: loaded.latest_payout_id ?? "",
            wallet,
            reason: "invalid_wallet",
          },
        });

        throw new Error("SC-F-001: invalid Algorand address");
      }

      const sanctions = await screenWalletAndLog(wallet, "inngest.payout.release", loaded.freelancer_id);
      if (sanctions.flagged) {
        await step.sendEvent("emit-sanctions-quarantine", {
          name: "payout/quarantined",
          data: {
            payout_id: loaded.latest_payout_id ?? "",
            wallet,
            reason: "sanctions",
          },
        });

        throw new Error("XC-003: sanctions check failed at payout");
      }

      return {
        ...loaded,
        wallet,
        skip: false,
      };
    });

    if (context.skip) {
      return {
        skipped: true,
      };
    }

    const normalizedWallet = context.wallet_address.trim().toUpperCase();

    await step.run("check-opt-in", async () => {
      if (context.payout_asset_code === "ALGO") {
        return { optedIn: true };
      }

      const assetId = Number(context.payout_asset_id ?? "0");
      if (!assetId) {
        throw new Error("SC-F-002: payout asset id is required");
      }

      const payoutId = context.latest_payout_id ?? "";

      await step.sendEvent("notify-opt-in-required", {
        name: "payout/opt_in_required",
        data: {
          freelancer_id: context.freelancer_id,
          asset_id: assetId,
          payout_id: payoutId,
        },
      });

      emitToUser(context.freelancer_id, "validation:opt_in_required", {
        payout_id: payoutId,
        asset_id: assetId,
        submission_id: context.submission_id,
      });

      for (let index = 0; index < 30; index += 1) {
        const optedIn = await algorandService.isAssetOptedIn(normalizedWallet, assetId);
        if (optedIn) {
          return { optedIn: true };
        }
        await step.sleep(`wait-opt-in-${index + 1}`, "60s");
      }

      await step.sendEvent("emit-opt-in-timeout-quarantine", {
        name: "payout/quarantined",
        data: {
          payout_id: payoutId,
          wallet: normalizedWallet,
          reason: "opt_in_timeout",
        },
      });

      await createInAppNotification(context.freelancer_id, "payout_opt_in_timeout", {
        payout_id: payoutId,
        submission_id: context.submission_id,
        bounty_id: context.bounty_id,
        code: "SC-F-002",
      });

      throw new Error("SC-F-002: asset opt-in timeout");
    });

    await step.run("dry-run-transaction", async () => {
      const healthy = await algorandService.healthCheck();
      if (!healthy) {
        throw new Error("SC-C-001: Algorand node health failed before payout broadcast");
      }
    });

    const release = await step.run("execute-payout", async () => {
      return processPayoutRelease(
        {
          submission_id: context.submission_id,
          bounty_id: context.bounty_id,
          final_score: context.final_score ?? 0,
        },
        {
          send: async (name, data) => {
            await step.sendEvent("forward-payout-service-event", {
              name: name as never,
              data: data as never,
            });
          },
        },
        {
          emitToUser: async (userId, eventName, payload) => {
            emitToUser(userId, eventName as never, payload);
          },
        },
      );
    });

    const mismatch = await step.run("verify-amount-on-chain", async () => {
      const payouts = await dbQuery<{ id: string; expected_amount: string; actual_amount: string | null }>(
        `
          SELECT id, expected_amount, actual_amount
          FROM payouts
          WHERE submission_id = $1
            AND status = 'completed'
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [context.submission_id],
      );

      if ((payouts.rowCount ?? 0) === 0) {
        return { flagged: false };
      }

      const expected = BigInt(payouts.rows[0].expected_amount);
      const actual = BigInt(payouts.rows[0].actual_amount ?? payouts.rows[0].expected_amount);
      const delta = expected > actual ? expected - actual : actual - expected;

      if (delta > 1000n) {
        await step.sendEvent("emit-payout-mismatch", {
          name: "payout/mismatch_detected",
          data: {
            payout_id: payouts.rows[0].id,
            expected: Number(expected),
            actual: Number(actual),
          },
        });

        await createInAppNotification(context.creator_id, "payout_amount_mismatch", {
          code: "SC-F-005",
          payout_id: payouts.rows[0].id,
          expected: expected.toString(),
          actual: actual.toString(),
        });

        return {
          flagged: true,
          payoutId: payouts.rows[0].id,
        };
      }

      return { flagged: false };
    });

    await step.run("post-payout-state-update", async () => {
      if (release.state !== "released") {
        return;
      }

      const payoutRow = await dbQuery<{ id: string; tx_id: string | null; actual_amount: string | null }>(
        `
          SELECT id, tx_id, actual_amount
          FROM payouts
          WHERE submission_id = $1
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [context.submission_id],
      );

      if ((payoutRow.rowCount ?? 0) === 0) {
        return;
      }

      await step.sendEvent("emit-payout-completed", {
        name: "payout/completed",
        data: {
          payout_id: payoutRow.rows[0].id,
          tx_id: payoutRow.rows[0].tx_id ?? "",
          actual_amount: Number(payoutRow.rows[0].actual_amount ?? "0"),
        },
      });
    });

    return {
      state: release.state,
      mismatch_flagged: mismatch.flagged,
    };
  },
);
