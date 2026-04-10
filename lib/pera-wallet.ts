"use client";

import { PeraWalletConnect } from "@perawallet/connect";

const MAINNET_CHAIN_ID = 416001;
const TESTNET_CHAIN_ID = 416002;
const ALL_NETWORKS_CHAIN_ID = 4160;

function normalizeNetwork(value?: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.includes("mainnet")) {
    return "mainnet";
  }
  if (normalized.includes("testnet")) {
    return "testnet";
  }
  return "unknown";
}

function resolvePeraChainId() {
  const network = normalizeNetwork(process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet");
  if (network === "mainnet") {
    return MAINNET_CHAIN_ID;
  }
  if (network === "testnet") {
    return TESTNET_CHAIN_ID;
  }
  return ALL_NETWORKS_CHAIN_ID;
}

function createPeraWalletConnector() {
  return new PeraWalletConnect({
    chainId: resolvePeraChainId(),
  });
}

let peraWallet = createPeraWalletConnector();

function clearPeraSessionStorage() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem("walletconnect");
    window.localStorage.removeItem("PeraWallet.Wallet");
  } catch {
    // Ignore localStorage access errors in restricted browser contexts.
  }
}

function toErrorText(error: unknown) {
  if (error instanceof Error) {
    const detail = (error as Error & { data?: unknown }).data;
    return `${error.message} ${detail ? JSON.stringify(detail) : ""}`.trim();
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

function isRecoverableChainIdError(error: unknown) {
  const text = toErrorText(error).toLowerCase();
  return text.includes("chainid") && text.includes("undefined");
}

function isRecoverableSessionError(error: unknown) {
  const text = toErrorText(error).toLowerCase();
  return text.includes("session currently connected") || text.includes("session_connect");
}

function isRecoverableConnectError(error: unknown) {
  return isRecoverableChainIdError(error) || isRecoverableSessionError(error);
}

function toUserFacingConnectError(error: unknown) {
  const text = toErrorText(error);
  if (isRecoverableChainIdError(error) || isRecoverableSessionError(error)) {
    return new Error("AUTH-004: Wallet session corrupted. Please retry connect.");
  }
  return new Error(text || "Wallet connection failed");
}

async function resetPeraConnector() {
  try {
    await peraWallet.disconnect();
  } catch {
    // Ignore disconnect failures during forced reset.
  }
  clearPeraSessionStorage();
  peraWallet = createPeraWalletConnector();
}

async function connectWithPera() {
  const accounts = await peraWallet.connect();
  const walletAddress = accounts[0];
  if (!walletAddress) {
    throw new Error("Pera wallet did not return an account");
  }
  return walletAddress;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

export async function connectPeraWallet() {
  try {
    return await connectWithPera();
  } catch (error) {
    if (!isRecoverableConnectError(error)) {
      throw toUserFacingConnectError(error);
    }

    await resetPeraConnector();

    try {
      return await connectWithPera();
    } catch (retryError) {
      throw toUserFacingConnectError(retryError);
    }
  }
}

export async function disconnectPeraWallet() {
  try {
    await peraWallet.disconnect();
  } finally {
    await resetPeraConnector();
  }
}

export async function signLoginMessageWithPera(walletAddress: string, message: string) {
  const signData = (peraWallet as unknown as {
    signData?: (
      data: Array<{ data: Uint8Array; message: string }>,
      address: string,
    ) => Promise<Array<{ signature?: Uint8Array | string }>>;
  }).signData;

  if (!signData) {
    throw new Error("Installed Pera SDK version does not support signData");
  }

  const result = await signData(
    [{ data: new TextEncoder().encode(message), message }],
    walletAddress,
  );

  const signature = result[0]?.signature;
  if (!signature) {
    throw new Error("Pera wallet did not return a signature");
  }

  if (typeof signature === "string") {
    return signature;
  }

  return bytesToBase64(signature);
}
