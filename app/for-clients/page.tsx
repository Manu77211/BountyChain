import Link from "next/link";
import { MarketingPageShell } from "../../components/marketing/page-shell";

export default function ForClientsPage() {
  return (
    <MarketingPageShell
      title="For Clients"
      subtitle="Post bounties, lock Algorand escrow, and release only after CI/CD + AI validation and sanctions checks."
    >
      <section className="bg-[#f0f0f0] py-16" style={{ borderBottom: "4px solid #121212" }}>
        <div className="mx-auto grid max-w-7xl gap-6 px-5 md:grid-cols-3 md:px-12">
          {[
            "Create bounty scopes with clear acceptance criteria",
            "Fund escrow and lock milestone amounts upfront",
            "Review submissions with hybrid AI + CI + client scoring",
          ].map((item) => (
            <div key={item} className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
              <p className="text-sm font-bold uppercase tracking-wide text-[#121212]">{item}</p>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-8 max-w-7xl px-5 md:px-12">
          <div className="flex flex-wrap gap-3">
            <Link
              href="/register?role=CLIENT"
              className="inline-flex border-2 border-[#121212] bg-[#1040c0] px-6 py-3 text-sm font-black uppercase tracking-wide text-white shadow-[4px_4px_0_#121212]"
            >
              Register as Client
            </Link>
            <Link
              href="/marketplace"
              className="inline-flex border-2 border-[#121212] bg-white px-6 py-3 text-sm font-black uppercase tracking-wide text-[#121212] shadow-[4px_4px_0_#121212]"
            >
              Open Global Marketplace
            </Link>
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
