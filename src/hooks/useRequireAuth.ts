"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "../../store/auth-store";
import { authMeRequest } from "../../lib/api";

const HACKATHON_MODE = process.env.NEXT_PUBLIC_HACKATHON_MODE === "true";

export function useRequireAuth() {
  const router = useRouter();
  const pathname = usePathname();
  const { token, user, hydrate } = useAuthStore();
  const [isHydrating, setIsHydrating] = useState(true);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  useEffect(() => {
    hydrate();

    const timer = window.setTimeout(() => {
      setIsHydrating(false);
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [hydrate]);

  useEffect(() => {
    async function loadWalletAddress() {
      if (!token) {
        setWalletAddress(null);
        return;
      }

      try {
        const profile = await authMeRequest(token);
        setWalletAddress(profile.user.wallet_address ?? null);
      } catch {
        setWalletAddress(null);
      }
    }

    void loadWalletAddress();
  }, [token]);

  useEffect(() => {
    if (isHydrating) {
      return;
    }

    if (HACKATHON_MODE) {
      return;
    }

    if (!token) {
      const redirectPath = pathname || "/dashboard";
      const encoded = encodeURIComponent(redirectPath);
      router.replace(`/connect?redirect=${encoded}`);
    }
  }, [isHydrating, pathname, router, token]);

  const normalizedWalletAddress = useMemo(() => walletAddress, [walletAddress]);

  return {
    user,
    wallet_address: normalizedWalletAddress,
    isLoading: isHydrating || (!token && !HACKATHON_MODE),
  };
}
