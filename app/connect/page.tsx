"use client";

import Link from "next/link";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function ConnectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect");

  useEffect(() => {
    const query = redirect && redirect.startsWith("/") ? `?redirect=${encodeURIComponent(redirect)}` : "";
    router.replace(`/login${query}`);
  }, [redirect, router]);

  const loginHref = redirect && redirect.startsWith("/")
    ? `/login?redirect=${encodeURIComponent(redirect)}`
    : "/login";

  return (
    <main className="grid min-h-screen place-items-center bg-surface-0 px-6">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-surface-1 p-8 text-center shadow-xl">
        <h1 className="text-2xl font-black text-text-primary">Sign in to continue</h1>
        <p className="mt-2 text-sm text-text-tertiary">
          Wallet startup has been removed. Continue with your account credentials.
        </p>
        <Link
          href={loginHref}
          className="mt-5 inline-flex rounded-full border border-border bg-[#1040c0] px-5 py-2 text-sm font-semibold text-white"
        >
          Go to Login
        </Link>
      </section>
    </main>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<main className="grid min-h-screen place-items-center bg-surface-0">Loading...</main>}>
      <ConnectContent />
    </Suspense>
  );
}
