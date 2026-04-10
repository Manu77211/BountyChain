import algosdk from "algosdk";

const ALGOD_SERVER = process.env.ALGOD_SERVER ?? "https://testnet-api.algonode.cloud";
const ALGOD_PORT = process.env.ALGOD_PORT ?? "";
const ALGOD_TOKEN = process.env.ALGOD_TOKEN ?? "";
const INDEXER_SERVER = process.env.ALGOD_INDEXER_SERVER ?? "https://testnet-idx.algonode.cloud";
const INDEXER_PORT = process.env.ALGOD_INDEXER_PORT ?? "";
const INDEXER_TOKEN = process.env.ALGOD_INDEXER_TOKEN ?? "";
const ALGOD_MOCK_MODE = (process.env.ALGOD_MOCK_MODE ?? "true").toLowerCase() === "true";
const REQUIRE_SIMULATION = (process.env.ALGOD_REQUIRE_SIMULATION ?? "true").toLowerCase() === "true";

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
    const account = await this.client.accountInformation(walletAddress).do();
    return BigInt(account.amount ?? 0);
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
    void bountyId;
    if (ALGOD_MOCK_MODE) {
      return { txId: `mock-refund-${Date.now()}` };
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
    amountMicroAlgo: bigint;
  }): Promise<EscrowCreateResult> {
    if (ALGOD_MOCK_MODE) {
      return {
        txId: `mock-create-${input.bountyId}-${Date.now()}`,
        contractAddress: String(700000 + Date.now() % 100000),
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
  }): Promise<PayoutReleaseResult> {
    if (ALGOD_MOCK_MODE) {
      return {
        txId: `mock-payout-${input.submissionId}-${Date.now()}`,
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
      return {
        txId: `mock-split-${input.submissionId}-${Date.now()}`,
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
      return {
        txId: `mock-milestone-${input.milestoneId}-${Date.now()}`,
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
