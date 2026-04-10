"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "../../store/auth-store";
import { AuthShell } from "../../components/ui/auth-shell";
import { Button, Card, Input, Select } from "../../components/ui/primitives";

export default function RegisterPage() {
  const router = useRouter();
  const { register, loading, error, token, hydrate } = useAuthStore();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"CLIENT" | "FREELANCER">("CLIENT");

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const queryRole = new URLSearchParams(window.location.search).get("role");
    if (queryRole === "CLIENT" || queryRole === "FREELANCER") {
      setRole(queryRole);
    }
  }, []);

  useEffect(() => {
    if (token) {
      router.replace("/dashboard");
    }
  }, [token, router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await register({
        name,
        email,
        password,
        role,
      });
      router.replace("/dashboard");
    } catch {
      // Error message is managed in the store.
    }
  }

  return (
    <AuthShell
      title="Register"
      subtitle="Create your profile as Client or Freelancer and enter the bounty escrow execution workflow."
      sideNote={
        <p>
          Contract-first onboarding with clear validation, sanctions, and payout policies.
        </p>
      }
    >
      <Card>
        <form className="space-y-4" onSubmit={onSubmit}>
          <Input type="text" required placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <Input type="email" required placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
          <Input type="password" required placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />

          <Select value={role} onChange={(event) => setRole(event.target.value as "CLIENT" | "FREELANCER")}>
            <option value="CLIENT">Client</option>
            <option value="FREELANCER">Freelancer</option>
          </Select>

          {error ? <p className="border border-[#121212] bg-[#ffe2e2] px-3 py-2 text-sm text-[#8f1515]">{error}</p> : null}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Creating account..." : "Create account"}
          </Button>
        </form>

        <p className="mt-4 text-sm text-[#3f3f3f]">
          Already have an account? <Link className="font-bold text-[#1040c0] hover:underline" href="/login">Login</Link>
        </p>
      </Card>
    </AuthShell>
  );
}
