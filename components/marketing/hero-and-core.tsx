"use client";

import Link from "next/link";
import { ArrowRight, Check, Code, Globe, Lock, Shield, Zap } from "lucide-react";
import { MARKETING_COLORS as C } from "./theme";

export function MarketingHero() {
  return (
    <section
      style={{
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
        backgroundColor: C.bg,
      }}
    >
      <div className="mx-auto grid min-h-[90vh] max-w-7xl lg:grid-cols-2">
        <div className="flex flex-col justify-center px-5 py-16 md:px-12 lg:py-0" style={{ borderRight: `4px solid ${C.black}` }}>
          <div className="mb-8 flex items-center gap-3">
            <div
              className="px-3 py-1 text-xs font-black uppercase tracking-widest"
              style={{
                backgroundColor: C.yellow,
                border: `2px solid ${C.black}`,
                boxShadow: `3px 3px 0px 0px ${C.black}`,
              }}
            >
              Powered by Algorand
            </div>
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: C.red }} />
          </div>

          <h1 className="mb-8 text-5xl font-black uppercase leading-[0.9] tracking-tighter sm:text-6xl lg:text-7xl xl:text-8xl" style={{ color: C.black }}>
            Trustless
            <br />
            <span style={{ color: C.red }}>Bounty</span>
            <br />
            Escrow.
          </h1>

          <p className="mb-10 max-w-md text-lg font-medium leading-relaxed" style={{ color: C.black }}>
            Post bounties, lock funds in Algorand escrow, validate with GitHub CI/CD plus GROQ scoring, and release only when policy checks pass.
          </p>

          <div className="flex flex-wrap gap-4">
            <Link
              href="/register?role=CLIENT"
              className="flex items-center gap-2 px-7 py-4 font-black uppercase tracking-wider text-white transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
              style={{
                backgroundColor: C.red,
                border: `2px solid ${C.black}`,
                boxShadow: `6px 6px 0px 0px ${C.black}`,
              }}
            >
              Post a Bounty <ArrowRight size={18} />
            </Link>
            <Link
              href="/for-freelancers"
              className="flex items-center gap-2 px-7 py-4 font-black uppercase tracking-wider transition-all duration-200 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
              style={{
                backgroundColor: C.white,
                border: `2px solid ${C.black}`,
                boxShadow: `6px 6px 0px 0px ${C.black}`,
                color: C.black,
              }}
            >
              Browse Bounties
            </Link>
          </div>

          <div className="mt-12 grid grid-cols-3 gap-0" style={{ borderTop: `2px solid ${C.black}`, paddingTop: "1.5rem" }}>
            {[
              { value: "$2.4M", label: "Escrowed" },
              { value: "1,800+", label: "Bounties" },
              { value: "0.001s", label: "Finality" },
            ].map((s, i) => (
              <div
                key={i}
                className="pr-4 md:pr-6"
                style={{
                  borderRight: i < 2 ? `2px solid ${C.black}` : "none",
                  paddingLeft: i > 0 ? "1rem" : 0,
                }}
              >
                <div className="text-xl font-black md:text-3xl" style={{ color: i === 0 ? C.red : i === 1 ? C.blue : C.black }}>
                  {s.value}
                </div>
                <div className="mt-1 text-xs font-bold uppercase tracking-widest" style={{ color: C.black }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative hidden items-center justify-center overflow-hidden lg:flex" style={{ backgroundColor: C.blue }}>
          <div
            className="absolute inset-0 opacity-20"
            style={{
              backgroundImage: "radial-gradient(#fff 2px, transparent 2px)",
              backgroundSize: "24px 24px",
            }}
          />
          <div
            className="absolute rounded-full"
            style={{
              width: 420,
              height: 420,
              border: "4px solid rgba(255,255,255,0.3)",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
            }}
          />
          <div
            className="absolute"
            style={{
              width: 200,
              height: 200,
              backgroundColor: C.yellow,
              border: `4px solid ${C.black}`,
              transform: "rotate(45deg)",
              top: "10%",
              right: "5%",
              boxShadow: `8px 8px 0px 0px ${C.black}`,
            }}
          />
          <div
            className="absolute"
            style={{
              width: 160,
              height: 160,
              backgroundColor: C.red,
              border: `4px solid ${C.black}`,
              bottom: "12%",
              left: "8%",
              boxShadow: `8px 8px 0px 0px ${C.black}`,
            }}
          />
          <div
            className="relative z-10 w-[280px] p-8"
            style={{
              backgroundColor: C.white,
              border: `4px solid ${C.black}`,
              boxShadow: `12px 12px 0px 0px ${C.black}`,
            }}
          >
            <div className="absolute -right-4 -top-4 h-8 w-8 rounded-full" style={{ backgroundColor: C.yellow, border: `2px solid ${C.black}` }} />
            <div className="mb-3 text-xs font-black uppercase tracking-widest" style={{ color: C.blue }}>
              Active Bounty
            </div>
            <div className="mb-2 text-2xl font-black uppercase leading-tight" style={{ color: C.black }}>
              Fix AMM Slippage Bug
            </div>
            <div className="mb-5 flex items-center gap-2">
              <div className="px-2 py-0.5 text-xs font-bold uppercase" style={{ backgroundColor: C.yellow, border: `1px solid ${C.black}` }}>
                Open
              </div>
              <span className="text-xs font-medium" style={{ color: C.black }}>
                3 days left
              </span>
            </div>
            <div className="flex items-center justify-between pt-4" style={{ borderTop: `2px solid ${C.black}` }}>
              <span className="text-xs font-bold uppercase tracking-wider">Reward</span>
              <span className="text-xl font-black" style={{ color: C.red }}>
                500 ALGO
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function MarketingStatsBar() {
  const stats = [
    { num: "Socket.io", label: "Real-Time Updates" },
    { num: "GROQ", label: "LLM Scoring Engine" },
    { num: "Neon", label: "PostgreSQL Storage" },
    { num: "Inngest", label: "Background Jobs" },
  ];

  return (
    <section
      style={{
        backgroundColor: C.yellow,
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
      }}
    >
      <div className="mx-auto grid max-w-7xl grid-cols-2 lg:grid-cols-4">
        {stats.map((s, i) => (
          <div
            key={i}
            className="flex flex-col items-center px-8 py-10 text-center"
            style={{
              borderRight: i < stats.length - 1 ? `4px solid ${C.black}` : "none",
              borderBottom: i < 2 ? `4px solid ${C.black}` : "none",
            }}
          >
            <div className="relative mb-3" style={{ width: 56, height: 56 }}>
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: i % 3 === 0 ? C.red : i % 3 === 1 ? C.blue : C.black,
                  transform: "rotate(45deg)",
                  border: `2px solid ${C.black}`,
                }}
              />
              <div className="absolute inset-0 flex items-center justify-center text-xs font-black text-white">{i + 1}</div>
            </div>
            <div className="text-3xl font-black tracking-tighter" style={{ color: C.black }}>
              {s.num}
            </div>
            <div className="mt-1 text-xs font-bold uppercase tracking-widest" style={{ color: C.black }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function MarketingFeatures() {
  const features = [
    {
      icon: <Shield size={28} />,
      color: C.red,
      title: "Smart Contract Escrow",
      desc: "Funds are locked in an Algorand AVM smart contract the moment a bounty is posted.",
      shape: "square",
    },
    {
      icon: <Zap size={28} />,
      color: C.blue,
      title: "CI/CD Webhook Gates",
      desc: "GitHub webhook events and pipeline status gate releases before payout is allowed.",
      shape: "circle",
    },
    {
      icon: <Code size={28} />,
      color: C.yellow,
      title: "Hybrid GROQ Scoring",
      desc: "Final decisions combine AI analysis, CI outcomes, and client rating for objective scoring.",
      shape: "triangle",
    },
    {
      icon: <Globe size={28} />,
      color: C.red,
      title: "Wallet Auth + Compliance",
      desc: "Pera Wallet, WalletConnect, and AlgoSigner flows include sanctions-aware payout controls.",
      shape: "square",
    },
    {
      icon: <Lock size={28} />,
      color: C.blue,
      title: "Multi-Sig Arbitration",
      desc: "Disputed bounties remain locked until on-chain multi-sig arbitration resolves outcomes.",
      shape: "circle",
    },
    {
      icon: <Check size={28} />,
      color: C.black,
      title: "Inngest Retry Safety",
      desc: "Critical validation, settlement, and notification jobs run through retryable Inngest workflows.",
      shape: "triangle",
    },
  ];

  return (
    <section
      id="features"
      style={{
        backgroundColor: C.bg,
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
      }}
      className="py-16 md:py-24"
    >
      <div className="mx-auto max-w-7xl px-5 md:px-12">
        <div className="mb-14 flex items-start gap-6">
          <div className="h-16 w-16 shrink-0 items-center justify-center bg-[#121212] text-3xl font-black text-white md:flex">F</div>
          <div>
            <p className="mb-2 text-xs font-black uppercase tracking-widest" style={{ color: C.red }}>
              Why BountyEscrow AI
            </p>
            <h2 className="text-4xl font-black uppercase leading-[0.9] tracking-tighter md:text-5xl" style={{ color: C.black }}>
              Built on
              <br />
              Primitives
              <br />
              <span style={{ color: C.blue }}>That Work.</span>
            </h2>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <div
              key={i}
              className="relative cursor-default p-7 transition-transform duration-200 hover:-translate-y-1"
              style={{
                backgroundColor: C.white,
                border: `3px solid ${C.black}`,
                boxShadow: `8px 8px 0px 0px ${C.black}`,
              }}
            >
              <div
                className="absolute right-4 top-4"
                style={{
                  width: 14,
                  height: 14,
                  backgroundColor: f.color,
                  borderRadius: f.shape === "circle" ? "50%" : "0",
                  clipPath: f.shape === "triangle" ? "polygon(50% 0%, 0% 100%, 100% 100%)" : "none",
                }}
              />
              <div
                className="mb-5 flex h-14 w-14 items-center justify-center"
                style={{
                  backgroundColor: f.color,
                  border: `2px solid ${C.black}`,
                  boxShadow: `3px 3px 0px 0px ${C.black}`,
                  color: f.color === C.yellow ? C.black : C.white,
                }}
              >
                {f.icon}
              </div>
              <h3 className="mb-3 text-lg font-black uppercase tracking-tight" style={{ color: C.black }}>
                {f.title}
              </h3>
              <p className="text-sm font-medium leading-relaxed" style={{ color: "#444" }}>
                {f.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MarketingHowItWorks() {
  const steps = [
    {
      n: "01",
      color: C.red,
      title: "Post Bounty",
      desc: "Client defines acceptance criteria and locks escrow in an Algorand contract.",
    },
    {
      n: "02",
      color: C.blue,
      title: "Ship to GitHub",
      desc: "Freelancer accepts terms and pushes implementation evidence to the repository.",
    },
    {
      n: "03",
      color: C.yellow,
      title: "Hybrid Validation",
      desc: "CI/CD webhook signals and GROQ scoring compute pass/fail with weighted logic.",
    },
    {
      n: "04",
      color: C.black,
      title: "Release or Arbitrate",
      desc: "Passed + sanctions-cleared bounties auto-release; disputes route to multi-sig arbitration.",
    },
  ];

  return (
    <section
      id="how-it-works"
      style={{
        backgroundColor: C.black,
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
      }}
      className="py-16 md:py-24"
    >
      <div className="mx-auto max-w-7xl px-5 md:px-12">
        <p className="mb-4 text-xs font-black uppercase tracking-widest" style={{ color: C.yellow }}>
          The Process
        </p>
        <h2 className="mb-14 text-4xl font-black uppercase leading-[0.9] tracking-tighter text-white md:text-5xl">
          Four Steps.
          <br />
          <span style={{ color: C.red }}>No Friction.</span>
        </h2>

        <div className="relative grid gap-6 sm:grid-cols-2 md:grid-cols-4">
          {steps.map((s, i) => (
            <div key={i} className="relative">
              {i < steps.length - 1 ? (
                <div className="absolute left-full top-10 z-10 hidden h-[3px] w-6 md:block" style={{ backgroundColor: C.yellow }} />
              ) : null}
              <div className="h-full p-6" style={{ border: `3px solid ${s.color}`, boxShadow: `6px 6px 0px 0px ${s.color}` }}>
                <div
                  className="mb-5 flex h-16 w-16 rotate-45 items-center justify-center text-2xl font-black"
                  style={{
                    backgroundColor: s.color,
                    border: `2px solid ${s.color === C.yellow ? C.black : "transparent"}`,
                  }}
                >
                  <span className="-rotate-45" style={{ color: s.color === C.yellow ? C.black : C.white }}>
                    {s.n}
                  </span>
                </div>
                <h3 className="mb-2 text-lg font-black uppercase tracking-tight text-white">{s.title}</h3>
                <p className="text-sm font-medium leading-relaxed text-[#AAA]">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function MarketingBenefits() {
  const benefits = [
    "Escrow cannot release unless validation is approved",
    "Client and freelancer identity separation is enforced",
    "Wallet sanctions checks are required before payout",
    "Disputes stay locked until multi-sig arbitration",
    "GitHub CI/CD webhooks feed release decisions",
    "Inngest retries orchestrate critical background jobs",
    "Socket.io streams real-time bounty state",
    "Typed API layer and JWT-based access control",
  ];

  return (
    <section
      style={{
        backgroundColor: C.red,
        borderBottom: `4px solid ${C.black}`,
        fontFamily: "'Outfit', sans-serif",
      }}
      className="py-16 md:py-24"
    >
      <div className="mx-auto grid max-w-7xl items-center gap-16 px-5 md:px-12 lg:grid-cols-2">
        <div>
          <p className="mb-4 text-xs font-black uppercase tracking-widest" style={{ color: C.yellow }}>
            Why It Matters
          </p>
          <h2 className="mb-6 text-4xl font-black uppercase leading-[0.9] tracking-tighter text-white md:text-5xl">
            Escrow
            <br />
            Without
            <br />
            Rule Drift.
          </h2>
          <p className="max-w-md text-lg font-medium leading-relaxed" style={{ color: "rgba(255,255,255,0.8)" }}>
            This workflow keeps escrow deterministic by combining smart contracts, CI evidence, AI scoring, and compliance gates.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {benefits.map((b, i) => (
            <div
              key={i}
              className="flex items-start gap-3 p-4"
              style={{
                backgroundColor: "rgba(0,0,0,0.2)",
                border: "2px solid rgba(255,255,255,0.3)",
              }}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: C.yellow, border: `2px solid ${C.black}` }}>
                <Check size={14} color={C.black} strokeWidth={3} />
              </div>
              <span className="text-sm font-bold leading-snug text-white">{b}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
