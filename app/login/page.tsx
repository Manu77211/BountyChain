"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "../../store/auth-store";
import { AuthShell } from "../../components/ui/auth-shell";
import { Button, Card, Input } from "../../components/ui/primitives";

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, error, token, hydrate } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (token) {
      router.replace("/dashboard");
    }
  }, [token, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await login({ email, password });
      router.replace("/dashboard");
    } catch {
      // Error message is managed in the store.
    }
  }

  return (
    <AuthShell
      title="Login"
      subtitle="Access your BountyEscrow AI workspace and continue escrow-backed bounty execution."
      sideNote={
        <p>
          Secure, role-based access for clients and freelancers with validation-gated escrow collaboration.
        </p>
      }
    >
      <Card>
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

        <p className="mt-4 text-sm text-[#3f3f3f]">
          New here? <Link className="font-bold text-[#1040c0] hover:underline" href="/register">Create account</Link>
        </p>
      </Card>
    </AuthShell>
  );
}
