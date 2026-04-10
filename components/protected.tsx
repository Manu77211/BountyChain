"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "../store/auth-store";

const HACKATHON_MODE = process.env.NEXT_PUBLIC_HACKATHON_MODE === "true";

export function Protected({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { token, hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (HACKATHON_MODE) {
      return;
    }

    if (token === null) {
      const handle = setTimeout(() => {
        const current = useAuthStore.getState().token;
        if (!current) {
          router.push("/login");
        }
      }, 200);
      return () => clearTimeout(handle);
    }
  }, [router, token]);

  return <>{children}</>;
}
