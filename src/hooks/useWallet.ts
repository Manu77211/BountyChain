"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getAuthNonceRequest, walletLoginRequest } from "../../lib/api";
import { connectPeraWallet, disconnectPeraWallet, signLoginMessageWithPera } from "../../lib/pera-wallet";
import { useAuthStore } from "../../store/auth-store";

type Network = "mainnet" | "testnet" | "unknown";

type WalletState = "idle" | "connecting" | "signing" | "success" | "error";

type AlgoSignerAccount = {
  address: string;
};

type AlgoSignerClient = {
  connect: () => Promise<void>;
  accounts: (input: { ledger: "MainNet" | "TestNet" }) => Promise<AlgoSignerAccount[]>;
  signBytes: (message: string, address: string) => Promise<{ signature?: string }>;
};

function normalizeNetwork(value?: string): Network {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("mainnet")) {
    return "mainnet";
  }
  if (normalized.includes("testnet")) {
    return "testnet";
  }
  return "unknown";
}

function mapWalletError(error: unknown) {
  const message = (error as Error)?.message ?? "Wallet connection failed";
  if (message.toLowerCase().includes("chainid") && message.toLowerCase().includes("undefined")) {
    return "AUTH-004: Wallet session corrupted. Please close wallet prompt and retry.";
  }
  if (message.toLowerCase().includes("session currently connected") || message.toLowerCase().includes("session_connect")) {
    return "AUTH-004: Existing wallet session was stale. Please retry connect.";
  }
  if (message.includes("AUTH-002")) {
    return "AUTH-002: Signature declined. Please approve in your wallet.";
  }
  if (message.includes("AUTH-003")) {
    return "AUTH-003: Different wallet detected. Please use the same wallet you connected with.";
  }
  if (message.includes("SC-C-006")) {
    return "SC-C-006: Your wallet is on TestNet. Please switch to MainNet to continue.";
  }
  if (message.includes("AUTH-005")) {
    return "AUTH-005: Wallet connected, but signature verification is still required.";
  }
  if (message.includes("AUTH-004")) {
    return "AUTH-004: Connection lost. Reconnecting...";
  }
  return message;
}

async function connectAlgoSignerWallet() {
  const algoSigner = (window as unknown as { AlgoSigner?: AlgoSignerClient }).AlgoSigner;
  if (!algoSigner) {
    throw new Error("AlgoSigner is not installed. Install Extension.");
  }

  await algoSigner.connect();
  const accounts = await algoSigner.accounts({ ledger: "TestNet" });
  const first = accounts?.[0]?.address as string | undefined;
  if (!first) {
    throw new Error("No wallet account returned by AlgoSigner.");
  }

  return {
    address: first,
    network: "testnet" as Network,
    sign: async (message: string) => {
      const encoded = btoa(unescape(encodeURIComponent(message)));
      const signed = await algoSigner.signBytes(encoded, first);
      return signed?.signature ?? "";
    },
  };
}

export function useWallet() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setSession, logout } = useAuthStore();

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<Network>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [status, setStatus] = useState<WalletState>("idle");
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);

  const requiredNetwork = normalizeNetwork(process.env.NEXT_PUBLIC_ALGORAND_NETWORK ?? "testnet");
  const roleQuery = String(searchParams.get("role") ?? "freelancer").toLowerCase();
  const selectedRole: "client" | "freelancer" = roleQuery === "client" ? "client" : "freelancer";

  const finishAuth = useCallback(
    async (
      address: string,
      signer: (message: string) => Promise<string>,
      role: "client" | "freelancer" = selectedRole,
      detectedNetwork: Network = "unknown",
    ) => {
      setWalletAddress(address);
      setNetwork(detectedNetwork);

      if (requiredNetwork === "mainnet" && detectedNetwork === "testnet") {
        throw new Error("SC-C-006");
      }

      const nonce = await getAuthNonceRequest(address);
      setStatus("signing");

      const signature = await signer(nonce.message);
      if (!signature) {
        throw new Error("AUTH-002");
      }

      const response = await walletLoginRequest({
        wallet_address: address,
        signed_message: nonce.message,
        signature,
        role,
      });

      setSession(response);
      setStatus("success");

      const redirect = searchParams.get("redirect");
      const next = redirect && redirect.startsWith("/") ? redirect : "/dashboard";
      router.replace(next);
    },
    [requiredNetwork, router, searchParams, selectedRole, setSession],
  );

  const connectPera = useCallback(async () => {
    setSelectedWallet("Pera Wallet");
    setIsConnecting(true);
    setError(null);
    setStatus("connecting");

    try {
      const address = await connectPeraWallet();
      await finishAuth(address, (message) => signLoginMessageWithPera(address, message), "freelancer", requiredNetwork);
    } catch (connectError) {
      setStatus("error");
      setError(mapWalletError(connectError));
      throw connectError;
    } finally {
      setIsConnecting(false);
    }
  }, [finishAuth, requiredNetwork]);

  const connectWalletConnect = useCallback(async () => {
    setSelectedWallet("WalletConnect");
    setIsConnecting(true);
    setError(null);
    setStatus("connecting");

    try {
      try {
        const address = await connectPeraWallet();
        await finishAuth(address, (message) => signLoginMessageWithPera(address, message), "freelancer", requiredNetwork);
      } catch {
        setError("AUTH-004: Connection lost. Reconnecting...");
        const address = await connectPeraWallet();
        await finishAuth(address, (message) => signLoginMessageWithPera(address, message), "freelancer", requiredNetwork);
      }
    } catch (connectError) {
      setStatus("error");
      setError(mapWalletError(connectError));
      throw connectError;
    } finally {
      setIsConnecting(false);
    }
  }, [finishAuth, requiredNetwork]);

  const connectAlgoSigner = useCallback(async () => {
    setSelectedWallet("AlgoSigner");
    setIsConnecting(true);
    setError(null);
    setStatus("connecting");

    try {
      const wallet = await connectAlgoSignerWallet();
      await finishAuth(wallet.address, wallet.sign, "freelancer", wallet.network);
    } catch (connectError) {
      setStatus("error");
      setError(mapWalletError(connectError));
      throw connectError;
    } finally {
      setIsConnecting(false);
    }
  }, [finishAuth]);

  const disconnect = useCallback(() => {
    void disconnectPeraWallet();
    logout();
    setWalletAddress(null);
    setNetwork("unknown");
    setError(null);
    setStatus("idle");
  }, [logout]);

  const isConnected = useMemo(() => Boolean(walletAddress), [walletAddress]);

  return {
    connectPera,
    connectWalletConnect,
    connectAlgoSigner,
    disconnect,
    wallet_address: walletAddress,
    is_connected: isConnected,
    is_connecting: isConnecting,
    network,
    error,
    status,
    selectedWallet,
  };
}
