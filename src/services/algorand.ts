import algosdk from "algosdk";
import type { PoolClient } from "pg";
import { dbQuery, withTransaction } from "../../lib/db/client";
import { normalizeWalletAddress } from "./wallet";

const ALGOD_SERVER = process.env.ALGOD_SERVER ?? "https://testnet-api.algonode.cloud";
const ALGOD_PORT = process.env.ALGOD_PORT ?? "";
const ALGOD_TOKEN = process.env.ALGOD_TOKEN ?? "";
const INDEXER_SERVER = process.env.ALGOD_INDEXER_SERVER ?? "https://testnet-idx.algonode.cloud";
const INDEXER_PORT = process.env.ALGOD_INDEXER_PORT ?? "";
const INDEXER_TOKEN = process.env.ALGOD_INDEXER_TOKEN ?? "";
const ALGOD_MOCK_MODE = (process.env.ALGOD_MOCK_MODE ?? "true").toLowerCase() === "true";
const ALGOD_MOCK_BALANCE_MICROALGO = process.env.ALGOD_MOCK_BALANCE_MICROALGO ?? "";
const ALGOD_MOCK_BALANCE_ALGO = process.env.ALGOD_MOCK_BALANCE_ALGO ?? "1000";
const REQUIRE_SIMULATION = (process.env.ALGOD_REQUIRE_SIMULATION ?? "true").toLowerCase() === "true";
const MOCK_ESCROW_CONTRACT_PREFIX = process.env.MOCK_ESCROW_CONTRACT_PREFIX ?? "mock-escrow";

function parseDefaultMockBalanceMicroAlgo() {
  const rawMicro = ALGOD_MOCK_BALANCE_MICROALGO.trim();
  if (rawMicro.length > 0 && /^\d+$/.test(rawMicro)) {
    return BigInt(rawMicro);
  }

  const algo = Number(ALGOD_MOCK_BALANCE_ALGO);
  if (Number.isFinite(algo) && algo >= 0) {
    return BigInt(Math.trunc(algo * 1_000_000));
  }

  return 0n;
}

const DEFAULT_MOCK_BALANCE_MICROALGO = parseDefaultMockBalanceMicroAlgo();

export interface EscrowCreateResult {
  txId: string;
  contractAddress: string;
}

export interface PayoutReleaseResult {
  txId: string;
  confirmations: number;
}

export interface SplitPayoutShare {
  walletAddress: string;
  amountMicroAlgo: bigint;
  recipientUserId: string;
}

interface MockTransferRecipient {
  recipientUserId?: string;
  walletAddress: string;
  amountMicroAlgo: bigint;
}

export interface DisputeResolveInput {
  disputeId: string;
  outcome: "freelancer_wins" | "client_wins" | "split";
  freelancerShareBps: number;
}

export class AlgorandService {
  private readonly client: algosdk.Algodv2;
  private readonly indexer: algosdk.Indexer;

  constructor() {
    this.client = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
    this.indexer = new algosdk.Indexer(INDEXER_TOKEN, INDEXER_SERVER, INDEXER_PORT);
  }

  async healthCheck() {
    if (ALGOD_MOCK_MODE) {
      return true;
    }

    await this.client.status().do();
    return true;
  }

  async getWalletBalanceMicroAlgo(walletAddress: string) {
    if (ALGOD_MOCK_MODE) {
      const normalizedWallet = normalizeWalletAddress(walletAddress);
      const persisted = await this.getPersistedMockWalletBalance(normalizedWallet);
      if (persisted !== null) {
        return persisted;
      }
      return DEFAULT_MOCK_BALANCE_MICROALGO;
    }

    try {
      const account = await this.client.accountInformation(walletAddress).do();
      return BigInt(account.amount ?? 0);
    } catch {
      const indexed = await this.indexer.lookupAccountByID(walletAddress).do();
      const amount = Number((indexed.account as { amount?: number } | undefined)?.amount ?? 0);
      return BigInt(amount);
    }
  }

  async assertWalletHasEscrowBalance(walletAddress: string, totalAmount: bigint, feeBudget: bigint) {
    const balance = await this.getWalletBalanceMicroAlgo(walletAddress);
    const required = totalAmount + feeBudget;
    if (balance < required) {
      throw new Error("SC-C-001: Insufficient wallet balance to fund escrow and fees.");
    }
  }

  async createBountyEscrowWithRetry(input: {
    bountyId: string;
    creatorWallet: string;
    creatorUserId?: string;
    amountMicroAlgo: bigint;
  }) {
    let lastTxId = "";
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const created = await this.createBountyEscrow(input);
        return created;
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.includes("txId=")) {
          lastTxId = error.message.split("txId=")[1] ?? "";
        }

        if (lastTxId) {
          const exists = await this.isTransactionConfirmed(lastTxId.trim());
          if (exists) {
            return {
              txId: lastTxId.trim(),
              contractAddress: process.env.ESCROW_FALLBACK_CONTRACT_ADDRESS ?? "0",
            };
          }
        }

        if (attempt < 3) {
          await wait(250 * 2 ** attempt);
        }
      }
    }

    throw new Error(
      `SC-C-002: Escrow creation retries exhausted. ${
        lastError instanceof Error ? lastError.message : "Unknown failure"
      }`,
    );
  }

  async extendBountyDeadline(bountyId: string, newDeadlineIso: string) {
    void bountyId;
    void newDeadlineIso;
    if (ALGOD_MOCK_MODE) {
      return { txId: `mock-extend-${Date.now()}` };
    }
    throw new Error("Smart contract deadline extension call is not configured.");
  }

  async refundClientEscrow(bountyId: string) {
    if (ALGOD_MOCK_MODE) {
      const txId = `mock-refund-${bountyId}-${Date.now()}`;
      const finalTxId = await this.applyMockEscrowRefund({
        bountyId,
        txId,
      });
      return { txId: finalTxId };
    }
    throw new Error("Smart contract refund call is not configured.");
  }

  async refundClientEscrowWithRetry(input: { bountyId: string }) {
    return this.withRetry(
      async () => this.refundClientEscrow(input.bountyId),
      "SC-C-002: Client refund retries exhausted.",
      3,
    );
  }

  async openDisputeWithRetry(input: { disputeId: string; submissionId: string; bountyId: string }) {
    return this.withRetry(
      async () => this.openDispute(input),
      "SC-C-002: open_dispute retries exhausted.",
      3,
    );
  }

  async resolveDisputeWithRetry(input: DisputeResolveInput) {
    return this.withRetry(
      async () => this.resolveDispute(input),
      "SC-C-002: resolve_dispute retries exhausted.",
      3,
    );
  }

  async banWalletOnChainWithRetry(input: { walletAddress: string; reason: string }) {
    return this.withRetry(
      async () => this.banWalletOnChain(input),
      "SC-C-002: ban_wallet retries exhausted.",
      3,
    );
  }

  async removeWalletAllowlistWithRetry(input: { walletAddress: string }) {
    return this.withRetry(
      async () => this.removeWalletAllowlist(input),
      "SC-C-002: allowlist removal retries exhausted.",
      3,
    );
  }

  async isAssetOptedIn(walletAddress: string, assetId: number) {
    if (ALGOD_MOCK_MODE) {
      return true;
    }

    const account = await this.client.accountInformation(walletAddress).do();
    const assets = account.assets ?? [];
    return assets.some((asset) => Number(asset.assetId) === assetId);
  }

  async releasePayoutWithRetry(input: {
    submissionId: string;
    finalScore: number;
    amountMicroAlgo: bigint;
    recipientWallet: string;
    recipientUserId?: string;
  }) {
    return this.withRetry(
      async () => this.releasePayout(input),
      "SC-C-002: Payout retries exhausted.",
      3,
    );
  }

  async releaseSplitPayoutWithRetry(input: {
    submissionId: string;
    finalScore: number;
    shares: SplitPayoutShare[];
  }) {
    return this.withRetry(
      async () => this.releaseSplitPayout(input),
      "SC-C-002: Split payout retries exhausted.",
      3,
    );
  }

  async releaseMilestonePayoutWithRetry(input: {
    milestoneId: string;
    submissionId: string;
    amountMicroAlgo: bigint;
  }) {
    return this.withRetry(
      async () => this.releaseMilestonePayout(input),
      "SC-C-008: Milestone payout retries exhausted.",
      3,
    );
  }

  async verifyMilestoneOrder(input: { bountyId: string; expectedOrderIndex: number }) {
    if (ALGOD_MOCK_MODE) {
      return true;
    }
    void input;
    throw new Error("SC-C-008: Milestone sequence guard cannot verify contract state.");
  }

  async waitForTransactionConfirmation(txId: string, minConfirmations = 1) {
    if (!txId) {
      return { confirmed: false, confirmations: 0 };
    }

    if (ALGOD_MOCK_MODE) {
      return { confirmed: true, confirmations: Math.max(minConfirmations, 1) };
    }

    const tx = await this.client.pendingTransactionInformation(txId).do();
    const confirmedRound = Number(tx.confirmedRound ?? 0);
    if (confirmedRound <= 0) {
      return { confirmed: false, confirmations: 0 };
    }

    const status = await this.client.status().do();
    const lastRound = Number(status.lastRound ?? confirmedRound);
    const confirmations = Math.max(lastRound - confirmedRound + 1, 1);
    return {
      confirmed: confirmations >= minConfirmations,
      confirmations,
    };
  }

  async getConfirmedTransferAmount(input: { txId: string; expectedAmountMicroAlgo: bigint }) {
    if (ALGOD_MOCK_MODE) {
      return input.expectedAmountMicroAlgo;
    }

    if (!input.txId) {
      throw new Error("SC-F-005: Missing txId for payout amount verification.");
    }

    const tx = (await this.client.pendingTransactionInformation(input.txId).do()) as unknown as {
      txn?: { txn?: { amt?: number } };
      payment?: { amount?: number };
      paymentTransaction?: { amount?: number };
    };
    const amount = Number(
      tx.txn?.txn?.amt ?? tx.payment?.amount ?? tx.paymentTransaction?.amount ?? 0,
    );
    return BigInt(amount);
  }

  async isTransactionConfirmed(txId: string) {
    if (!txId) {
      return false;
    }

    if (ALGOD_MOCK_MODE) {
      return true;
    }

    try {
      const indexed = await this.indexer.lookupTransactionByID(txId).do();
      const round = Number((indexed.transaction as { confirmedRound?: number } | undefined)?.confirmedRound ?? 0);
      if (round > 0) {
        return true;
      }
    } catch {
      // Fall through to algod pending-transaction probe.
    }

    try {
      const txInfo = await this.client.pendingTransactionInformation(txId).do();
      const confirmedRound = Number(txInfo.confirmedRound ?? 0);
      return confirmedRound > 0;
    } catch {
      return false;
    }
  }

  private async createBountyEscrow(input: {
    bountyId: string;
    creatorWallet: string;
    creatorUserId?: string;
    amountMicroAlgo: bigint;
  }): Promise<EscrowCreateResult> {
    if (ALGOD_MOCK_MODE) {
      const existingHold = await dbQuery<{ lock_tx_id: string; contract_address: string }>(
        `
          SELECT lock_tx_id, contract_address
          FROM mock_escrow_holds
          WHERE bounty_id = $1
          LIMIT 1
        `,
        [input.bountyId],
      );

      if ((existingHold.rowCount ?? 0) > 0) {
        return {
          txId: existingHold.rows[0].lock_tx_id,
          contractAddress: existingHold.rows[0].contract_address,
        };
      }

      const creatorWallet = normalizeWalletAddress(input.creatorWallet);
      const creatorUserId =
        input.creatorUserId ?? (await this.resolveUserIdByWalletAddress(creatorWallet));

      if (!creatorUserId) {
        throw new Error("SC-C-001: Unable to resolve creator user for escrow lock in mock mode.");
      }

      const txId = `mock-create-${input.bountyId}-${Date.now()}`;
      const contractAddress = `${MOCK_ESCROW_CONTRACT_PREFIX}-${input.bountyId.slice(0, 8)}`;

      await withTransaction(async (client) => {
        const holdRow = await client.query<{ lock_tx_id: string; contract_address: string }>(
          `
            SELECT lock_tx_id, contract_address
            FROM mock_escrow_holds
            WHERE bounty_id = $1
            FOR UPDATE
          `,
          [input.bountyId],
        );

        if ((holdRow.rowCount ?? 0) > 0) {
          return;
        }

        const current = await this.getOrCreateMockWalletBalance(client, creatorUserId, creatorWallet);
        if (current < input.amountMicroAlgo) {
          throw new Error("SC-C-001: Insufficient wallet balance to fund escrow and fees.");
        }

        const remaining = current - input.amountMicroAlgo;
        await client.query(
          `
            UPDATE mock_wallet_balances
            SET balance_microalgo = $2,
                wallet_address = $3,
                updated_at = NOW()
            WHERE user_id = $1
          `,
          [creatorUserId, remaining.toString(), creatorWallet],
        );

        await client.query(
          `
            INSERT INTO mock_escrow_holds (
              bounty_id,
              creator_user_id,
              creator_wallet_address,
              contract_address,
              amount_microalgo,
              remaining_microalgo,
              status,
              lock_tx_id
            )
            VALUES ($1, $2, $3, $4, $5, $5, 'locked', $6)
          `,
          [
            input.bountyId,
            creatorUserId,
            creatorWallet,
            contractAddress,
            input.amountMicroAlgo.toString(),
            txId,
          ],
        );
      });

      return {
        txId,
        contractAddress,
      };
    }

    const appId = process.env.ESCROW_APP_ID;
    if (!appId) {
      throw new Error("SC-C-004: ESCROW_APP_ID missing; cannot deploy or call escrow contract.");
    }

    await this.assertDryRunSimulated("create_bounty_escrow", {
      bounty_id: input.bountyId,
      creator_wallet: input.creatorWallet,
      amount_micro_algo: input.amountMicroAlgo.toString(),
    });

    throw new Error("SC-C-004: Real escrow contract invocation is not wired in this environment.");
  }

  private async releasePayout(input: {
    submissionId: string;
    finalScore: number;
    amountMicroAlgo: bigint;
    recipientWallet: string;
    recipientUserId?: string;
  }): Promise<PayoutReleaseResult> {
    if (ALGOD_MOCK_MODE) {
      const txId = `mock-payout-${input.submissionId}-${Date.now()}`;
      const finalTxId = await this.applyMockSubmissionTransfer({
        submissionId: input.submissionId,
        transferKey: `submission:${input.submissionId}`,
        txId,
        recipients: [
          {
            recipientUserId: input.recipientUserId,
            walletAddress: input.recipientWallet,
            amountMicroAlgo: input.amountMicroAlgo,
          },
        ],
      });

      return {
        txId: finalTxId,
        confirmations: 1,
      };
    }

    await this.assertDryRunSimulated("release_payout", {
      submission_id: input.submissionId,
      amount_micro_algo: input.amountMicroAlgo.toString(),
      recipient_wallet: input.recipientWallet,
    });

    void input;
    throw new Error("SC-C-004: Smart contract release_payout is not configured.");
  }

  private async releaseSplitPayout(input: {
    submissionId: string;
    finalScore: number;
    shares: SplitPayoutShare[];
  }): Promise<PayoutReleaseResult> {
    if (ALGOD_MOCK_MODE) {
      const txId = `mock-split-${input.submissionId}-${Date.now()}`;
      const finalTxId = await this.applyMockSubmissionTransfer({
        submissionId: input.submissionId,
        transferKey: `submission:${input.submissionId}`,
        txId,
        recipients: input.shares.map((share) => ({
          recipientUserId: share.recipientUserId,
          walletAddress: share.walletAddress,
          amountMicroAlgo: share.amountMicroAlgo,
        })),
      });

      return {
        txId: finalTxId,
        confirmations: 1,
      };
    }

    await this.assertDryRunSimulated("release_split_payout", {
      submission_id: input.submissionId,
      share_count: input.shares.length,
    });

    void input;
    throw new Error("SC-C-004: Smart contract split payout is not configured.");
  }

  private async releaseMilestonePayout(input: {
    milestoneId: string;
    submissionId: string;
    amountMicroAlgo: bigint;
  }): Promise<PayoutReleaseResult> {
    if (ALGOD_MOCK_MODE) {
      const recipient = await dbQuery<{ freelancer_id: string; wallet_address: string }>(
        `
          SELECT s.freelancer_id, u.wallet_address
          FROM submissions s
          JOIN users u ON u.id = s.freelancer_id
          WHERE s.id = $1
          LIMIT 1
        `,
        [input.submissionId],
      );

      if ((recipient.rowCount ?? 0) === 0) {
        throw new Error("SC-C-008: Unable to resolve milestone payout recipient in mock mode.");
      }

      const txId = `mock-milestone-${input.milestoneId}-${Date.now()}`;
      const finalTxId = await this.applyMockSubmissionTransfer({
        submissionId: input.submissionId,
        transferKey: `milestone:${input.milestoneId}`,
        txId,
        recipients: [
          {
            recipientUserId: recipient.rows[0].freelancer_id,
            walletAddress: recipient.rows[0].wallet_address,
            amountMicroAlgo: input.amountMicroAlgo,
          },
        ],
      });

      return {
        txId: finalTxId,
        confirmations: 1,
      };
    }

    await this.assertDryRunSimulated("release_milestone_payout", {
      milestone_id: input.milestoneId,
      submission_id: input.submissionId,
      amount_micro_algo: input.amountMicroAlgo.toString(),
    });

    void input;
    throw new Error("SC-C-004: Smart contract milestone payout is not configured.");
  }

  private async openDispute(input: { disputeId: string; submissionId: string; bountyId: string }) {
    if (ALGOD_MOCK_MODE) {
      return {
        txId: `mock-open-dispute-${input.disputeId}-${Date.now()}`,
        confirmations: 1,
      };
    }

    await this.assertDryRunSimulated("open_dispute", {
      dispute_id: input.disputeId,
      submission_id: input.submissionId,
      bounty_id: input.bountyId,
    });

    void input;
    throw new Error("SC-C-004: Smart contract open_dispute is not configured.");
  }

  private async resolveDispute(input: DisputeResolveInput) {
    if (ALGOD_MOCK_MODE) {
      return {
        txId: `mock-resolve-dispute-${input.disputeId}-${Date.now()}`,
        confirmations: 1,
      };
    }

    await this.assertDryRunSimulated("resolve_dispute", {
      dispute_id: input.disputeId,
      outcome: input.outcome,
      freelancer_share_bps: input.freelancerShareBps,
    });

    void input;
    throw new Error("SC-C-004: Smart contract resolve_dispute is not configured.");
  }

  private async banWalletOnChain(input: { walletAddress: string; reason: string }) {
    if (ALGOD_MOCK_MODE) {
      return {
        txId: `mock-ban-wallet-${input.walletAddress}-${Date.now()}`,
      };
    }

    await this.assertDryRunSimulated("ban_wallet", {
      wallet_address: input.walletAddress,
      reason: input.reason,
    });

    void input;
    throw new Error("SC-C-004: Smart contract ban_wallet is not configured.");
  }

  private async removeWalletAllowlist(input: { walletAddress: string }) {
    if (ALGOD_MOCK_MODE) {
      return {
        txId: `mock-remove-allowlist-${input.walletAddress}-${Date.now()}`,
      };
    }

    await this.assertDryRunSimulated("remove_wallet_allowlist", {
      wallet_address: input.walletAddress,
    });

    void input;
    throw new Error("SC-C-004: Smart contract allowlist removal is not configured.");
  }

  private async getPersistedMockWalletBalance(walletAddress: string) {
    try {
      const result = await dbQuery<{ balance_microalgo: string }>(
        `
          SELECT balance_microalgo::text AS balance_microalgo
          FROM mock_wallet_balances
          WHERE wallet_address = $1
          LIMIT 1
        `,
        [walletAddress],
      );

      if ((result.rowCount ?? 0) === 0) {
        return null;
      }

      return BigInt(result.rows[0].balance_microalgo);
    } catch {
      return null;
    }
  }

  private async resolveUserIdByWalletAddress(walletAddress: string, client?: PoolClient) {
    const execute = client
      ? client.query.bind(client)
      : async (text: string, params: unknown[]) => dbQuery<{ id: string }>(text, params);

    const found = await execute(
      `
        SELECT id
        FROM users
        WHERE wallet_address = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [walletAddress],
    );

    return found.rows[0]?.id ?? null;
  }

  private async getOrCreateMockWalletBalance(client: PoolClient, userId: string, walletAddress: string) {
    const normalizedWallet = normalizeWalletAddress(walletAddress);

    await client.query(
      `
        INSERT INTO mock_wallet_balances (user_id, wallet_address, balance_microalgo)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET wallet_address = EXCLUDED.wallet_address,
                      updated_at = NOW()
      `,
      [userId, normalizedWallet, DEFAULT_MOCK_BALANCE_MICROALGO.toString()],
    );

    const balance = await client.query<{ balance_microalgo: string }>(
      `
        SELECT balance_microalgo::text AS balance_microalgo
        FROM mock_wallet_balances
        WHERE user_id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [userId],
    );

    if ((balance.rowCount ?? 0) === 0) {
      return 0n;
    }

    return BigInt(balance.rows[0].balance_microalgo);
  }

  private async creditMockWalletBalance(
    client: PoolClient,
    recipientUserId: string,
    walletAddress: string,
    amountMicroAlgo: bigint,
  ) {
    const current = await this.getOrCreateMockWalletBalance(client, recipientUserId, walletAddress);
    const next = current + amountMicroAlgo;

    await client.query(
      `
        UPDATE mock_wallet_balances
        SET balance_microalgo = $2,
            wallet_address = $3,
            updated_at = NOW()
        WHERE user_id = $1
      `,
      [recipientUserId, next.toString(), normalizeWalletAddress(walletAddress)],
    );
  }

  private async applyMockSubmissionTransfer(input: {
    submissionId: string;
    transferKey: string;
    txId: string;
    recipients: MockTransferRecipient[];
  }) {
    const totalAmount = input.recipients.reduce((acc, recipient) => acc + recipient.amountMicroAlgo, 0n);
    if (totalAmount <= 0n) {
      throw new Error("SC-F-004: payout amount must be positive.");
    }

    return withTransaction(async (client) => {
      const alreadyApplied = await client.query<{ tx_id: string }>(
        `
          SELECT tx_id
          FROM mock_escrow_transfers
          WHERE transfer_key = $1
          LIMIT 1
        `,
        [input.transferKey],
      );

      if ((alreadyApplied.rowCount ?? 0) > 0) {
        return alreadyApplied.rows[0].tx_id;
      }

      const submission = await client.query<{ bounty_id: string }>(
        `
          SELECT bounty_id
          FROM submissions
          WHERE id = $1
          LIMIT 1
        `,
        [input.submissionId],
      );

      if ((submission.rowCount ?? 0) === 0) {
        throw new Error("SC-F-003: submission context not found for payout transfer.");
      }

      const bountyId = submission.rows[0].bounty_id;
      const hold = await client.query<{ remaining_microalgo: string }>(
        `
          SELECT remaining_microalgo::text AS remaining_microalgo
          FROM mock_escrow_holds
          WHERE bounty_id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [bountyId],
      );

      if ((hold.rowCount ?? 0) === 0) {
        throw new Error("SC-F-004: escrow hold not found for bounty.");
      }

      const remaining = BigInt(hold.rows[0].remaining_microalgo);
      if (remaining < totalAmount) {
        throw new Error("SC-F-004: escrow hold has insufficient locked funds.");
      }

      for (const recipient of input.recipients) {
        const normalizedWallet = normalizeWalletAddress(recipient.walletAddress);
        const resolvedUserId =
          recipient.recipientUserId ?? (await this.resolveUserIdByWalletAddress(normalizedWallet, client));

        if (!resolvedUserId) {
          throw new Error("SC-F-004: payout recipient could not be resolved.");
        }

        await this.creditMockWalletBalance(
          client,
          resolvedUserId,
          normalizedWallet,
          recipient.amountMicroAlgo,
        );
      }

      const nextRemaining = remaining - totalAmount;
      const nextStatus = nextRemaining === 0n ? "released" : "partial";

      await client.query(
        `
          UPDATE mock_escrow_holds
          SET remaining_microalgo = $2,
              status = $3,
              release_tx_id = $4,
              updated_at = NOW()
          WHERE bounty_id = $1
        `,
        [bountyId, nextRemaining.toString(), nextStatus, input.txId],
      );

      await client.query(
        `
          INSERT INTO mock_escrow_transfers (transfer_key, bounty_id, tx_id, total_amount_microalgo)
          VALUES ($1, $2, $3, $4)
        `,
        [input.transferKey, bountyId, input.txId, totalAmount.toString()],
      );

      return input.txId;
    });
  }

  private async applyMockEscrowRefund(input: { bountyId: string; txId: string }) {
    return withTransaction(async (client) => {
      const transferKey = `refund:${input.bountyId}`;
      const existingTransfer = await client.query<{ tx_id: string }>(
        `
          SELECT tx_id
          FROM mock_escrow_transfers
          WHERE transfer_key = $1
          LIMIT 1
        `,
        [transferKey],
      );

      if ((existingTransfer.rowCount ?? 0) > 0) {
        return existingTransfer.rows[0].tx_id;
      }

      const hold = await client.query<{
        creator_user_id: string;
        creator_wallet_address: string;
        remaining_microalgo: string;
      }>(
        `
          SELECT creator_user_id,
                 creator_wallet_address,
                 remaining_microalgo::text AS remaining_microalgo
          FROM mock_escrow_holds
          WHERE bounty_id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [input.bountyId],
      );

      if ((hold.rowCount ?? 0) === 0) {
        return input.txId;
      }

      const row = hold.rows[0];
      const refundable = BigInt(row.remaining_microalgo);

      if (refundable > 0n) {
        await this.creditMockWalletBalance(
          client,
          row.creator_user_id,
          row.creator_wallet_address,
          refundable,
        );
      }

      await client.query(
        `
          UPDATE mock_escrow_holds
          SET remaining_microalgo = '0',
              status = 'refunded',
              refund_tx_id = $2,
              updated_at = NOW()
          WHERE bounty_id = $1
        `,
        [input.bountyId, input.txId],
      );

      if (refundable > 0n) {
        await client.query(
          `
            INSERT INTO mock_escrow_transfers (transfer_key, bounty_id, tx_id, total_amount_microalgo)
            VALUES ($1, $2, $3, $4)
          `,
          [transferKey, input.bountyId, input.txId, refundable.toString()],
        );
      }

      return input.txId;
    });
  }

  private async assertDryRunSimulated(operationName: string, metadata: Record<string, unknown>) {
    if (ALGOD_MOCK_MODE || !REQUIRE_SIMULATION) {
      return;
    }

    try {
      await this.client.status().do();
    } catch {
      throw new Error(`SC-C-003: Unable to dry-run ${operationName}; Algorand node unavailable.`);
    }

    void metadata;
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    exhaustedMessage: string,
    maxAttempts: number,
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await wait(500 * 2 ** (attempt - 1));
        }
      }
    }
    throw new Error(`${exhaustedMessage} ${lastError instanceof Error ? lastError.message : "Unknown"}`);
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
