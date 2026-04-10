"use client";

import Link from "next/link";
import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { MARKETING_COLORS as C } from "./theme";

export function MarketingPricing() {
  const plans = [
    {
      name: "Open Source",
      price: "Free",
      sub: "forever",
      color: C.white,
      textColor: C.black,
      accent: C.blue,
      features: ["Up to 5 active bounties", "ALGO & USDC support", "Basic verification", "Community support", "On-chain transparency"],
      cta: "Get Started",
      ctaBg: C.black,
      ctaText: C.white,
      ctaHref: "/register?role=CLIENT",
    },
    {
      name: "Protocol",
      price: "1%",
      sub: "of bounty value",
      color: C.blue,
      textColor: C.white,
      accent: C.yellow,
      features: ["Unlimited bounties", "All ASA tokens", "Hybrid AI + CI scoring", "GitHub webhook validation", "Priority arbitration", "Webhook & API access"],
      cta: "Start Building",
      ctaBg: C.yellow,
      ctaText: C.black,
      ctaHref: "/register?role=CLIENT",
      elevated: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      sub: "volume discounts",
      color: C.white,
      textColor: C.black,
      accent: C.red,
      features: ["Everything in Protocol", "Multi-sig arbitration flows", "Private bounty boards", "SLA support", "Custom contract logic"],
      cta: "Contact Us",
      ctaBg: C.black,
      ctaText: C.white,
      ctaHref: "/faq",
    },
  ];

  return (
    <section
      id="pricing"
      style={{
        backgroundColor: C.bg,
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
      }}
      className="py-16 md:py-24"
    >
      <div className="mx-auto max-w-7xl px-5 md:px-12">
        <p className="mb-4 text-xs font-black uppercase tracking-widest" style={{ color: C.red }}>
          Pricing
        </p>
        <h2 className="mb-14 text-4xl font-black uppercase leading-[0.9] tracking-tighter md:text-5xl" style={{ color: C.black }}>
          Simple.
          <br />
          <span style={{ color: C.blue }}>On-Chain.</span>
        </h2>

        <div className="grid items-end gap-6 lg:grid-cols-3">
          {plans.map((p, i) => (
            <div
              key={i}
              className={`relative p-8 transition-transform duration-200 hover:-translate-y-1 ${p.elevated ? "lg:-mt-8" : ""}`}
              style={{
                backgroundColor: p.color,
                border: `${p.elevated ? 4 : 3}px solid ${C.black}`,
                boxShadow: `${p.elevated ? 12 : 8}px ${p.elevated ? 12 : 8}px 0px 0px ${C.black}`,
              }}
            >
              {p.elevated ? (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1 text-xs font-black uppercase tracking-wider" style={{ backgroundColor: C.yellow, border: `2px solid ${C.black}` }}>
                  Most Popular
                </div>
              ) : null}

              <div className="absolute right-5 top-5 h-4 w-4" style={{ backgroundColor: p.accent, borderRadius: i === 1 ? "50%" : "0" }} />
              <div className="mb-4 text-xs font-black uppercase tracking-widest" style={{ color: p.accent }}>
                {p.name}
              </div>
              <div className="mb-1 text-5xl font-black tracking-tighter" style={{ color: p.textColor }}>
                {p.price}
              </div>
              <div className="mb-7 text-sm font-bold uppercase tracking-wider" style={{ color: p.textColor, opacity: 0.7 }}>
                {p.sub}
              </div>

              <div className="mb-7" style={{ borderTop: `2px solid ${p.textColor === C.white ? "rgba(255,255,255,0.3)" : C.black}` }} />
              <ul className="mb-8 space-y-3">
                {p.features.map((f, j) => (
                  <li key={j} className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: p.accent, border: `1px solid ${p.textColor === C.white ? "transparent" : C.black}` }}>
                      <Check size={11} color={p.accent === C.yellow ? C.black : C.white} strokeWidth={3} />
                    </div>
                    <span className="text-sm font-medium" style={{ color: p.textColor }}>
                      {f}
                    </span>
                  </li>
                ))}
              </ul>

              <Link
                href={p.ctaHref}
                className="block w-full py-3 text-center font-black uppercase tracking-wider transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                style={{
                  backgroundColor: p.ctaBg,
                  color: p.ctaText,
                  border: `2px solid ${C.black}`,
                  boxShadow: `4px 4px 0px 0px ${p.textColor === C.white ? "rgba(0,0,0,0.5)" : C.black}`,
                }}
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MarketingFaq() {
  const [open, setOpen] = useState<number | null>(null);

  const faqs = [
    {
      q: "How does payout release work?",
      a: "Escrow releases only when CI/CD + AI validation passes and both payout wallets clear sanctions checks.",
    },
    {
      q: "Can the same account be both client and freelancer?",
      a: "No. The platform enforces identity separation on each bounty.",
    },
    {
      q: "How are background jobs handled?",
      a: "Validation orchestration runs through Inngest workflows with retries for resiliency.",
    },
    {
      q: "How is scoring calculated?",
      a: "Hybrid scoring combines GROQ analysis, CI/CD results, and client rating into a final decision.",
    },
    {
      q: "What if there is a dispute?",
      a: "Funds remain locked and move through an on-chain multi-sig arbitration process.",
    },
    {
      q: "How are API inputs validated?",
      a: "All API payloads are expected to pass strict Zod schemas before DB or blockchain execution.",
    },
  ];

  return (
    <section
      id="faq"
      style={{
        backgroundColor: C.bg,
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
      }}
      className="py-16 md:py-24"
    >
      <div className="mx-auto grid max-w-7xl gap-12 px-5 md:px-12 lg:grid-cols-[300px_1fr]">
        <div>
          <p className="mb-4 text-xs font-black uppercase tracking-widest" style={{ color: C.blue }}>
            FAQ
          </p>
          <h2 className="text-4xl font-black uppercase leading-[0.9] tracking-tighter md:text-5xl" style={{ color: C.black }}>
            Common
            <br />
            <span style={{ color: C.red }}>Questions.</span>
          </h2>
          <div className="mt-8 h-24 w-24 rounded-full" style={{ backgroundColor: C.yellow, border: `4px solid ${C.black}` }} />
          <div className="mt-4 h-16 w-16" style={{ backgroundColor: C.blue, border: `4px solid ${C.black}` }} />
        </div>

        <div className="space-y-4">
          {faqs.map((f, i) => (
            <div key={i} style={{ border: `3px solid ${C.black}`, boxShadow: open === i ? "none" : `4px 4px 0px 0px ${C.black}`, transition: "box-shadow 0.2s ease" }}>
              <button
                className="flex w-full items-center justify-between p-5 text-left transition-colors duration-200"
                style={{ backgroundColor: open === i ? C.red : C.white, color: open === i ? C.white : C.black }}
                onClick={() => setOpen(open === i ? null : i)}
              >
                <span className="pr-4 font-black uppercase tracking-tight">{f.q}</span>
                <ChevronDown size={20} strokeWidth={3} className="shrink-0 transition-transform duration-200" style={{ transform: open === i ? "rotate(180deg)" : "none" }} />
              </button>
              {open === i ? (
                <div className="px-5 py-4" style={{ backgroundColor: "#FFF9C4", borderTop: `3px solid ${C.black}` }}>
                  <p className="text-sm font-medium leading-relaxed" style={{ color: C.black }}>
                    {f.a}
                  </p>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MarketingCta() {
  return (
    <section
      style={{
        backgroundColor: C.yellow,
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
        position: "relative",
        overflow: "hidden",
      }}
      className="py-20 md:py-32"
    >
      <div
        className="absolute rounded-full"
        style={{
          width: 400,
          height: 400,
          border: "4px solid rgba(0,0,0,0.15)",
          top: "-100px",
          right: "-80px",
        }}
      />
      <div
        className="absolute"
        style={{
          width: 200,
          height: 200,
          backgroundColor: "rgba(0,0,0,0.08)",
          transform: "rotate(45deg)",
          bottom: "-60px",
          left: "5%",
        }}
      />

      <div className="relative z-10 mx-auto max-w-4xl px-5 text-center md:px-12">
        <h2 className="mb-6 text-5xl font-black uppercase leading-[0.9] tracking-tighter md:text-7xl" style={{ color: C.black }}>
          Ready to Ship
          <br />
          <span style={{ color: C.red }}>Trustless</span>
          <br />
          Bounties?
        </h2>
        <p className="mx-auto mb-10 max-w-xl text-lg font-medium" style={{ color: "rgba(0,0,0,0.7)" }}>
          Join teams using BountyEscrow AI to run deterministic bounty execution with verifiable release rules.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <Link
            href="/register?role=CLIENT"
            className="flex items-center gap-2 px-8 py-4 font-black uppercase tracking-wider text-white transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            style={{
              backgroundColor: C.red,
              border: `3px solid ${C.black}`,
              boxShadow: `6px 6px 0px 0px ${C.black}`,
            }}
          >
            Post Your First Bounty <ArrowRight size={18} />
          </Link>
          <Link
            href="/features"
            className="flex items-center gap-2 px-8 py-4 font-black uppercase tracking-wider transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
            style={{
              backgroundColor: C.white,
              border: `3px solid ${C.black}`,
              boxShadow: `6px 6px 0px 0px ${C.black}`,
              color: C.black,
            }}
          >
            Read the Docs
          </Link>
        </div>
      </div>
    </section>
  );
}

export function MarketingFooter() {
  return (
    <footer style={{ backgroundColor: C.black, fontFamily: "'Outfit', sans-serif" }} className="px-5 py-12 md:px-12">
      <div className="mx-auto grid max-w-7xl gap-10 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-1">
          <div className="mb-4 flex items-center gap-2">
            <div className="flex items-center gap-1">
              <div className="h-3 w-3 rounded-full" style={{ backgroundColor: C.red }} />
              <div className="h-3 w-3" style={{ backgroundColor: C.blue }} />
              <div className="h-3 w-3" style={{ backgroundColor: C.yellow, clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)" }} />
            </div>
            <span className="font-black uppercase tracking-tighter text-white">BountyEscrow AI</span>
          </div>
          <p className="text-sm font-medium leading-relaxed text-gray-400">Algorand bounty escrow with CI/CD + AI validation, sanctions checks, and arbitration guardrails.</p>
        </div>

        {[
          {
            title: "Product",
            links: [
              { label: "Features", href: "/features" },
              { label: "Pricing", href: "/pricing" },
              { label: "For Clients", href: "/for-clients" },
              { label: "For Freelancers", href: "/for-freelancers" },
            ],
          },
          {
            title: "Developers",
            links: [
              { label: "API Reference", href: "/features" },
              { label: "Smart Contracts", href: "/features" },
              { label: "Validation Rules", href: "/faq" },
              { label: "Pricing Rules", href: "/pricing" },
            ],
          },
          {
            title: "Company",
            links: [
              { label: "Login", href: "/login" },
              { label: "Register", href: "/register" },
              { label: "Dashboard", href: "/dashboard" },
              { label: "FAQ", href: "/faq" },
            ],
          },
        ].map((col) => (
          <div key={col.title}>
            <div className="mb-4 text-xs font-black uppercase tracking-widest" style={{ color: C.yellow }}>
              {col.title}
            </div>
            <ul className="space-y-2">
              {col.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="text-sm font-medium text-gray-400 transition-colors duration-200 hover:text-white">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mx-auto mt-12 flex max-w-7xl flex-col items-center justify-between gap-4 border-t-2 border-t-[#2a2a2a] pt-6 sm:flex-row">
        <p className="text-xs font-bold uppercase tracking-wider text-gray-600">© 2026 BountyEscrow AI. All rights reserved.</p>
        <div className="flex items-center gap-2">
          <div className="px-3 py-1 text-xs font-black uppercase tracking-wider" style={{ backgroundColor: C.blue, color: C.white, border: "1px solid #333" }}>
            Built on Algorand
          </div>
          <div className="h-2 w-2 rounded-full" style={{ backgroundColor: "#22c55e" }} />
          <span className="text-xs font-bold text-gray-500">All systems operational</span>
        </div>
      </div>
    </footer>
  );
}
