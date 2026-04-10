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

let activePeraWallet: PeraWalletConnect | null = null;

function clearPeraSessionStorage(options?: { force?: boolean }) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // Only remove Pera's storage, NOT WalletConnect storage (needed for mobile scanner bridge)
    window.localStorage.removeItem("PeraWallet.Wallet");
    
    // Only remove walletconnect if explicitly forced (mobile scanner needs this)
    if (options?.force) {
      window.localStorage.removeItem("walletconnect");
    }
    logWalletDebug("Cleared session storage", options?.force ? "force=true" : "force=false");
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

function logWalletDebug(label: string, data?: unknown) {
  if (typeof window !== "undefined") {
    console.log(
      `[Pera Debug] ${label}`,
      data ? (typeof data === "object" ? JSON.stringify(data) : data) : "",
    );
  }
}

function toUserFacingConnectError(error: unknown) {
  const text = toErrorText(error);
  logWalletDebug("Error before mapping", text);
  if (isRecoverableChainIdError(error) || isRecoverableSessionError(error)) {
    logWalletDebug("Detected recoverable error type", isRecoverableChainIdError(error) ? "chainId" : "session");
    return new Error("AUTH-004: Wallet session corrupted. Disconnect and retry.");
  }
  return new Error(text || "Wallet connection failed");
}

async function resetPeraConnector(options?: { forceWipe?: boolean }) {
  if (activePeraWallet) {
    try {
      await activePeraWallet.disconnect();
    } catch {
      // Ignore disconnect failures during forced reset.
    }
  }

  // Only wipe WalletConnect storage if explicitly forced
  clearPeraSessionStorage({ force: options?.forceWipe ?? false });
  activePeraWallet = null;
}

async function connectWithPera(connector: PeraWalletConnect) {
  const accounts = await connector.connect();
  const walletAddress = accounts[0];
  if (!walletAddress) {
    throw new Error("Pera wallet did not return an account");
  }
  return walletAddress;
}

async function verifyConnectorState(connector: PeraWalletConnect, expectedAddress: string) {
  logWalletDebug("Verifying connector state for address", expectedAddress);

  // Check if connector has getConnectedAccounts (safe method that doesn't call internal state)
  const getConnectedAccounts = (connector as unknown as {
    getConnectedAccounts?: () => string[];
  }).getConnectedAccounts;

  if (getConnectedAccounts) {
    try {
      const connectedAccounts = getConnectedAccounts();
      logWalletDebug("getConnectedAccounts returned", connectedAccounts);
      if (connectedAccounts.includes(expectedAddress)) {
        logWalletDebug("Session verification passed - address in connected accounts");
        return; // Session looks good
      }
    } catch (err) {
      logWalletDebug("getConnectedAccounts error", toErrorText(err));
    }
  }

  // If we reach here, session state is unreliable - throw error to force fresh reconnect
  logWalletDebug("Session verification failed - connector state unreliable");
  throw new Error("CONNECTOR_STATE_CORRUPTED");
}

async function signMessageWithConnector(
  connector: PeraWalletConnect,
  walletAddress: string,
  message: string,
) {
  const signData = (connector as unknown as {
    signData?: (
      data: Array<{ data: Uint8Array; message: string }>,
      address: string,
    ) => Promise<Array<{ signature?: Uint8Array | string }>>;
  }).signData;

  if (!signData) {
    throw new Error("Installed Pera SDK version does not support signData");
  }

  logWalletDebug("Calling signData on connector");
  const result = await signData(
    [{ data: new TextEncoder().encode(message), message }],
    walletAddress,
  );
  logWalletDebug("signData completed successfully");
  return result;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

export async function connectPeraWallet() {
  logWalletDebug("connectPeraWallet: Starting");
  const connector = createPeraWalletConnector();
  activePeraWallet = connector;

  try {
    const address = await connectWithPera(connector);
    logWalletDebug("connectPeraWallet: Success", address);
    return address;
  } catch (error) {
    logWalletDebug("connectPeraWallet: First attempt failed", toErrorText(error));

    if (!isRecoverableConnectError(error)) {
      activePeraWallet = null;
      throw toUserFacingConnectError(error);
    }

    logWalletDebug("connectPeraWallet: Error is recoverable, soft reset and retrying");
    // Soft reset - don't wipe WalletConnect session (needed for mobile bridge)
    await resetPeraConnector({ forceWipe: false });
    
    const retryConnector = createPeraWalletConnector();
    activePeraWallet = retryConnector;

    try {
      const address = await connectWithPera(retryConnector);
      logWalletDebug("connectPeraWallet: Retry success", address);
      return address;
    } catch (retryError) {
      logWalletDebug("connectPeraWallet: Retry failed", toErrorText(retryError));
      activePeraWallet = null;
      throw toUserFacingConnectError(retryError);
    }
  }
}

export async function disconnectPeraWallet() {
  logWalletDebug("disconnectPeraWallet: Forcing full disconnect");
  await resetPeraConnector({ forceWipe: true });
}

export async function signLoginMessageWithPera(walletAddress: string, message: string) {
  logWalletDebug("signLoginMessageWithPera: Starting for address", walletAddress);

  let result: Array<{ signature?: Uint8Array | string }>;
  let connector = activePeraWallet ?? createPeraWalletConnector();
  activePeraWallet = connector;

  // ATTEMPT 1: Try signing with current connector
  try {
    logWalletDebug("signLoginMessageWithPera: Attempt 1 - direct sign");
    result = await signMessageWithConnector(connector, walletAddress, message);
    logWalletDebug("signLoginMessageWithPera: Attempt 1 success");
    // Success - continue to signature extraction below
  } catch (error) {
    const errorText = toErrorText(error);
    logWalletDebug("signLoginMessageWithPera: Attempt 1 failed", errorText);

    if (!isRecoverableConnectError(error)) {
      // Not recoverable - throw user-facing error immediately
      logWalletDebug("signLoginMessageWithPera: Error is not recoverable");
      throw toUserFacingConnectError(error);
    }

    // ATTEMPT 2: Error is recoverable - create FRESH connector (discard the stale one)
    logWalletDebug("signLoginMessageWithPera: Error is recoverable, creating fresh connector");

    try {
      // Discard old connector (don't try to fix it)
      await resetPeraConnector({ forceWipe: false });

      // Create brand new connector with explicit chainId
      const freshConnector = createPeraWalletConnector();
      activePeraWallet = freshConnector;

      logWalletDebug("signLoginMessageWithPera: Attempt 2 - sign with fresh connector");
      result = await signMessageWithConnector(freshConnector, walletAddress, message);
      logWalletDebug("signLoginMessageWithPera: Attempt 2 success");
      // Success - continue to signature extraction below
    } catch (freshError) {
      const freshErrorText = toErrorText(freshError);
      logWalletDebug("signLoginMessageWithPera: Attempt 2 failed", freshErrorText);

      // Fresh connector also failed - session is corrupted on Pera side
      // Force full disconnect and ask user to reconnect
      logWalletDebug("signLoginMessageWithPera: Fresh connector failed, forcing hard disconnect");

      try {
        await resetPeraConnector({ forceWipe: true });
      } catch {
        // Ignore reset errors
      }

      throw new Error(
        "AUTH-004: Wallet session corrupted. Close all Pera windows, disconnect this dApp in Pera settings, and reconnect.",
      );
    }
  }

  // Extract signature from successful sign attempt
  const signature = result[0]?.signature;
  if (!signature) {
    logWalletDebug("signLoginMessageWithPera: No signature returned");
    throw new Error("Pera wallet did not return a signature");
  }

  logWalletDebug("signLoginMessageWithPera: Signature obtained successfully");

  if (typeof signature === "string") {
    return signature;
  }

  return bytesToBase64(signature);
}
