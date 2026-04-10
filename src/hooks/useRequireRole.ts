"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "../../store/auth-store";

export function useRequireRole(allowedRoles: string[]) {
  const router = useRouter();
  const { user, hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!user) {
      return;
    }

    const normalized = String(user.role ?? "").toUpperCase();
    const allowed = allowedRoles.map((role) => role.toUpperCase());

    if (!allowed.includes(normalized)) {
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem("app.toast.warning", "You do not have permission to access that page.");
      }
      router.replace("/dashboard");
    }
  }, [allowedRoles, router, user]);
}
