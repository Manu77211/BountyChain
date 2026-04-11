import "../lib/load-env";
import algosdk from "algosdk";

const ALGOD_SERVER = process.env.ALGOD_SERVER ?? "https://testnet-api.algonode.cloud";
const ALGOD_PORT = process.env.ALGOD_PORT ?? "";
const ALGOD_TOKEN = process.env.ALGOD_TOKEN ?? "";
const EXPLORER_TX_BASE =
  process.env.ALGO_EXPLORER_TX_BASE_URL ?? "https://testnet.algoexplorer.io/tx";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

function firstDefinedEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function isUuid(value: string) {
  return UUID_REGEX.test(value);
}

function toMicroAlgo(value: string, fallback: number) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid amount value: ${value}`);
  }
  return BigInt(Math.round(parsed * 1_000_000));
}

function parsePositiveMicroAmount(raw: string, label: string) {
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    throw new Error(`${label} must be > 0`);
  }
  return parsed;
}

function resolveMicroAmount(options: {
  microEnvName: string;
  algoEnvName: string;
  algoFallback: number;
}) {
  const rawMicro = process.env[options.microEnvName]?.trim() ?? "";
  if (rawMicro.length > 0) {
    if (!/^\d+$/.test(rawMicro)) {
      throw new Error(`${options.microEnvName} must be an integer microALGO value`);
    }
    return parsePositiveMicroAmount(rawMicro, options.microEnvName);
  }

  return toMicroAlgo(process.env[options.algoEnvName] ?? String(options.algoFallback), options.algoFallback);
}

function countMnemonicWords(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

async function waitForConfirmation(client: algosdk.Algodv2, txId: string) {
  const status = await client.status().do();
  const statusWithLegacy = status as typeof status & { "last-round"?: number | bigint };
  const initialRound = statusWithLegacy["last-round"] ?? status.lastRound;
  if (typeof initialRound !== "number" && typeof initialRound !== "bigint") {
    throw new Error("Unable to read last round from Algod status response");
  }

  let lastRound = typeof initialRound === "bigint" ? initialRound : BigInt(initialRound);
  for (let i = 0; i < 15; i += 1) {
    const pending = await client.pendingTransactionInformation(txId).do();
    const pendingWithLegacy = pending as typeof pending & { "confirmed-round"?: number | bigint };
    const confirmedRound = pendingWithLegacy["confirmed-round"] ?? pending.confirmedRound;
    if (typeof confirmedRound === "bigint" && confirmedRound > 0n) {
      return Number(confirmedRound);
    }
    if (typeof confirmedRound === "number" && confirmedRound > 0) {
      return confirmedRound;
    }

    lastRound += 1n;
    await client.statusAfterBlock(lastRound).do();
  }
  throw new Error(`Transaction ${txId} was not confirmed in time`);
}

async function sendPayment(input: {
  client: algosdk.Algodv2;
  sender: algosdk.Account;
  receiver: string;
  amountMicroAlgo: bigint;
  note: string;
}) {
  const params = await input.client.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: input.sender.addr,
    receiver: input.receiver,
    amount: Number(input.amountMicroAlgo),
    note: new TextEncoder().encode(input.note),
    suggestedParams: params,
  });

  const signed = txn.signTxn(input.sender.sk);
  const { txid } = await input.client.sendRawTransaction(signed).do();
  const confirmedRound = await waitForConfirmation(input.client, txid);

  return {
    txId: txid,
    confirmedRound,
    explorerUrl: `${EXPLORER_TX_BASE.replace(/\/+$/, "")}/${encodeURIComponent(txid)}`,
  };
}

async function linkTransactionsToWebsite(input: {
  submissionId: string;
  bountyId: string;
  lockTxId: string;
  transferTxId: string;
  walletA: string;
  walletB: string;
  noteTag: string;
}) {
  if (!isUuid(input.submissionId) || !isUuid(input.bountyId)) {
    return {
      linked: false,
      detail: "Website linkage skipped: TESTNET_WEBSITE_SUBMISSION_ID/TESTNET_WEBSITE_BOUNTY_ID must be UUIDs.",
    };
  }

  try {
    const db = await import("../lib/db/client");
    await db.dbQuery(
      `
        INSERT INTO hackathon_review_runs (
          submission_id,
          bounty_id,
          action,
          decision,
          score,
          code_review_source,
          lock_tx_id,
          transfer_tx_id,
          payload
        )
        VALUES ($1, $2, 'approve_review', 'approve', 95, 'db_template', $3, $4, $5::jsonb)
      `,
      [
        input.submissionId,
        input.bountyId,
        input.lockTxId,
        input.transferTxId,
        JSON.stringify({
          source: "testnet-demo-transfer-script",
          wallet_a: input.walletA,
          wallet_b: input.walletB,
          note_tag: input.noteTag,
        }),
      ],
    );

    return { linked: true, detail: "Website linkage saved in hackathon_review_runs." };
  } catch (error) {
    return {
      linked: false,
      detail:
        error instanceof Error
          ? `Website linkage failed: ${error.message}`
          : "Website linkage failed",
    };
  }
}

async function main() {
  const senderMnemonic =
    firstDefinedEnv([
      "TESTNET_SENDER_MNEMONIC",
      "TESTNET_CLIENT_MNEMONIC",
      "TESTNET_WALLET_A_MNEMONIC",
    ]) || requireEnv("TESTNET_SENDER_MNEMONIC");
  const walletA = firstDefinedEnv(["TESTNET_WALLET_A_ADDRESS", "TESTNET_ESCROW_ADDRESS"]);
  const walletB = firstDefinedEnv(["TESTNET_WALLET_B_ADDRESS", "TESTNET_SUBMITTED_ADDRESS"]);
  if (!walletA || !walletB) {
    throw new Error(
      "Missing wallet addresses: set TESTNET_WALLET_A_ADDRESS and TESTNET_WALLET_B_ADDRESS (or legacy TESTNET_ESCROW_ADDRESS and TESTNET_SUBMITTED_ADDRESS)",
    );
  }

  const noteTag = process.env.TESTNET_NOTE_TAG?.trim() || process.env.TESTNET_SUBMISSION_ID?.trim() || `demo-${Date.now()}`;
  const websiteSubmissionId = process.env.TESTNET_WEBSITE_SUBMISSION_ID?.trim() ?? "";
  const websiteBountyId = process.env.TESTNET_WEBSITE_BOUNTY_ID?.trim() ?? "";
  const lockAmount = resolveMicroAmount({
    microEnvName: "TESTNET_LOCK_AMOUNT_MICROALGO",
    algoEnvName: "TESTNET_LOCK_AMOUNT_ALGO",
    algoFallback: 0.1,
  });
  const submitAmount = resolveMicroAmount({
    microEnvName: "TESTNET_SUBMIT_AMOUNT_MICROALGO",
    algoEnvName: "TESTNET_SUBMIT_AMOUNT_ALGO",
    algoFallback: 0.05,
  });

  if (!algosdk.isValidAddress(walletA) || !algosdk.isValidAddress(walletB)) {
    throw new Error("Wallet A or Wallet B address is invalid");
  }

  let sender: algosdk.Account;
  try {
    sender = algosdk.mnemonicToSecretKey(senderMnemonic);
  } catch (error) {
    const words = countMnemonicWords(senderMnemonic);
    if (words === 24) {
      throw new Error(
        "Provided phrase has 24 words. This script signs with algosdk mnemonicToSecretKey, which requires a 25-word Algorand mnemonic for the account. In Pera, open the funded account and export/view the full Algorand passphrase, then retry.",
      );
    }
    throw error;
  }
  const client = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
  const senderAddress = String(sender.addr);
  const lockReceiver = senderAddress === walletA ? walletB : walletA;

  const lockResult = await sendPayment({
    client,
    sender,
    receiver: lockReceiver,
    amountMicroAlgo: lockAmount,
    note: `HACKATHON_LOCK:${noteTag}`,
  });

  const submitResult = await sendPayment({
    client,
    sender,
    receiver: walletB,
    amountMicroAlgo: submitAmount,
    note: `HACKATHON_SUBMIT:${noteTag}`,
  });

  const websiteLink = await linkTransactionsToWebsite({
    submissionId: websiteSubmissionId,
    bountyId: websiteBountyId,
    lockTxId: lockResult.txId,
    transferTxId: submitResult.txId,
    walletA,
    walletB,
    noteTag,
  });

  const output = {
    network: "testnet",
    sender: senderAddress,
    flow: `${senderAddress} -> ${lockReceiver} and ${senderAddress} -> ${walletB}`,
    noteTag,
    website: {
      submissionId: websiteSubmissionId || null,
      bountyId: websiteBountyId || null,
      linked: websiteLink.linked,
      detail: websiteLink.detail,
    },
    lock: {
      amountMicroAlgo: lockAmount.toString(),
      receiver: lockReceiver,
      ...lockResult,
    },
    submit: {
      amountMicroAlgo: submitAmount.toString(),
      receiver: walletB,
      ...submitResult,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : "Unknown error";
  console.error(`TestNet transfer script failed: ${detail}`);
  process.exit(1);
});
