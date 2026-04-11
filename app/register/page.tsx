"use client";

import Link from "next/link";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "../../store/auth-store";
import { AuthShell } from "../../components/ui/auth-shell";
import { Button, Card, Input, Select } from "../../components/ui/primitives";

function resolveDashboardRoute(role?: string) {
  return String(role ?? "").toUpperCase() === "FREELANCER" ? "/dashboard/freelancers" : "/dashboard";
}

function resolveRedirectTarget(redirectParam: string | null, role?: string) {
  if (redirectParam && redirectParam.startsWith("/")) {
    return redirectParam;
  }
  return resolveDashboardRoute(role);
}

function getInitialRoleFromQuery(): "CLIENT" | "FREELANCER" {
  if (typeof window === "undefined") {
    return "CLIENT";
  }
  const queryRole = new URLSearchParams(window.location.search).get("role");
  if (queryRole === "CLIENT" || queryRole === "FREELANCER") {
    return queryRole;
  }
  return "CLIENT";
}

function RegisterContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { register, loading, error, token, user, hydrate } = useAuthStore();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"CLIENT" | "FREELANCER">(getInitialRoleFromQuery);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (token) {
      router.replace(resolveRedirectTarget(searchParams.get("redirect"), user?.role));
    }
  }, [token, user?.role, router, searchParams]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await register({
        name,
        email,
        password,
        role,
      });
    } catch {
      // Error message is managed in the store.
    }
  }

  return (
    <AuthShell
      title="Register"
      subtitle="Create your profile as Client or Freelancer and enter the bounty escrow execution workflow."
      sideNote={
        <div className="space-y-3">
          <p>Contract-first onboarding with clear validation, sanctions, and payout policies.</p>
          <p>Choose your role first; the dashboard and available actions are tailored after sign-up.</p>
        </div>
      }
    >
      <Card className="h-full border-[#121212] bg-[#fff9e8] p-7 shadow-[8px_8px_0_#121212]">
        <p className="mb-4 text-xs font-black uppercase tracking-[0.22em] text-[#1040c0]">Create Account</p>
        <form className="space-y-4" onSubmit={onSubmit}>
          <Input type="text" required placeholder="Full name" value={name} onChange={(event) => setName(event.target.value)} />
          <Input type="email" required placeholder="Email address" value={email} onChange={(event) => setEmail(event.target.value)} />
          <Input type="password" required placeholder="Password (minimum 8 characters)" value={password} onChange={(event) => setPassword(event.target.value)} />

          <Select value={role} onChange={(event) => setRole(event.target.value as "CLIENT" | "FREELANCER")}>
            <option value="CLIENT">Client</option>
            <option value="FREELANCER">Freelancer</option>
          </Select>

          {error ? <p className="border border-[#121212] bg-[#ffe2e2] px-3 py-2 text-sm text-[#8f1515]">{error}</p> : null}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Creating account..." : "Create account"}
          </Button>
        </form>

        <p className="mt-5 text-sm text-[#3f3f3f]">
          Already have an account? <Link className="font-bold text-[#1040c0] hover:underline" href="/login">Login</Link>
        </p>
      </Card>
    </AuthShell>
  );
}

function RegisterFallback() {
  return (
    <AuthShell
      title="Register"
      subtitle="Create your profile as Client or Freelancer and enter the bounty escrow execution workflow."
      sideNote={
        <div className="space-y-3">
          <p>Contract-first onboarding with clear validation, sanctions, and payout policies.</p>
          <p>Choose your role first; the dashboard and available actions are tailored after sign-up.</p>
        </div>
      }
    >
      <Card className="h-full border-[#121212] bg-[#fff9e8] p-7 shadow-[8px_8px_0_#121212]">
        <p className="text-sm text-[#4b4b4b]">Loading registration...</p>
      </Card>
    </AuthShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<RegisterFallback />}>
      <RegisterContent />
    </Suspense>
  );
}
