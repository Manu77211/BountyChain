"use client";

import Link from "next/link";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "../../store/auth-store";
import { AuthShell } from "../../components/ui/auth-shell";
import { Button, Card, Input } from "../../components/ui/primitives";

function resolveDashboardRoute(role?: string) {
  return String(role ?? "").toUpperCase() === "FREELANCER" ? "/dashboard/freelancers" : "/dashboard";
}

function resolveRedirectTarget(redirectParam: string | null, role?: string) {
  if (redirectParam && redirectParam.startsWith("/")) {
    return redirectParam;
  }
  return resolveDashboardRoute(role);
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, loading, error, token, user, hydrate } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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
      await login({ email, password });
    } catch {
      // Error message is managed in the store.
    }
  }

  return (
    <AuthShell
      title="Login"
      subtitle="Access your BountyEscrow AI workspace and continue escrow-backed bounty execution."
      sideNote={
        <div className="space-y-3">
          <p>Secure, role-based access for clients and freelancers with validation-gated escrow collaboration.</p>
          <p>Use your email credentials to access your workspace.</p>
        </div>
      }
    >
      <Card className="h-full border-[#121212] bg-[#fff9e8] p-7 shadow-[8px_8px_0_#121212]">
        <p className="mb-4 text-xs font-black uppercase tracking-[0.22em] text-[#1040c0]">Sign In</p>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="mb-1 block text-sm font-semibold text-[#121212]" htmlFor="email">Email</label>
            <Input id="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-[#121212]" htmlFor="password">Password</label>
            <Input id="password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>

          {error ? <p className="border border-[#121212] bg-[#ffe2e2] px-3 py-2 text-sm text-[#8f1515]">{error}</p> : null}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Logging in..." : "Login"}
          </Button>
        </form>

        <p className="mt-5 text-sm text-[#3f3f3f]">
          New here? <Link className="font-bold text-[#1040c0] hover:underline" href="/register">Create account</Link>
        </p>
      </Card>
    </AuthShell>
  );
}

function LoginFallback() {
  return (
    <AuthShell
      title="Login"
      subtitle="Access your BountyEscrow AI workspace and continue escrow-backed bounty execution."
      sideNote={
        <div className="space-y-3">
          <p>Secure, role-based access for clients and freelancers with validation-gated escrow collaboration.</p>
          <p>Use your email credentials to access your workspace.</p>
        </div>
      }
    >
      <Card className="h-full border-[#121212] bg-[#fff9e8] p-7 shadow-[8px_8px_0_#121212]">
        <p className="text-sm text-[#4b4b4b]">Loading login...</p>
      </Card>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  );
}
