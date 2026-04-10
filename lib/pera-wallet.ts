"use client";

import { PeraWalletConnect } from "@perawallet/connect";

const peraWallet = new PeraWalletConnect();

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

export async function connectPeraWallet() {
  const accounts = await peraWallet.connect();
  const walletAddress = accounts[0];
  if (!walletAddress) {
    throw new Error("Pera wallet did not return an account");
  }
  return walletAddress;
}

export async function disconnectPeraWallet() {
  await peraWallet.disconnect();
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
