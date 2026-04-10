import algosdk from "algosdk";

const ALGOD_SERVER = process.env.ALGOD_SERVER ?? "https://testnet-api.algonode.cloud";
const ALGOD_PORT = process.env.ALGOD_PORT ?? "";
const ALGOD_TOKEN = process.env.ALGOD_TOKEN ?? "";
const ALGOD_MOCK_MODE = (process.env.ALGOD_MOCK_MODE ?? "true").toLowerCase() === "true";

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

export class AlgorandService {
  private readonly client: algosdk.Algodv2;

  constructor() {
    this.client = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
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

  async extendBountyDeadline(_bountyId: string, _newDeadlineIso: string) {
    if (ALGOD_MOCK_MODE) {
      return { txId: `mock-extend-${Date.now()}` };
    }
    throw new Error("Smart contract deadline extension call is not configured.");
  }

  async refundClientEscrow(_bountyId: string) {
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

    void input;
    throw new Error("SC-C-004: Smart contract milestone payout is not configured.");
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
