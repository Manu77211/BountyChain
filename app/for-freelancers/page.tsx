import Link from "next/link";
import { MarketingPageShell } from "../../components/marketing/page-shell";

export default function ForFreelancersPage() {
  return (
    <MarketingPageShell
      title="For Freelancers"
      subtitle="Accept bounty terms, submit milestone evidence, and get paid only after objective validation passes."
    >
      <section className="bg-[#f0f0f0] py-16" style={{ borderBottom: "4px solid #121212" }}>
        <div className="mx-auto grid max-w-7xl gap-6 px-5 md:grid-cols-3 md:px-12">
          {[
            "Discover open bounties matched to your skill set",
            "Submit proof and deliverable evidence per milestone",
            "Track validation, sanctions status, and payout release",
          ].map((item) => (
            <div key={item} className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
              <p className="text-sm font-bold uppercase tracking-wide text-[#121212]">{item}</p>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-8 max-w-7xl px-5 md:px-12">
          <Link
            href="/register?role=FREELANCER"
            className="inline-flex border-2 border-[#121212] bg-[#d02020] px-6 py-3 text-sm font-black uppercase tracking-wide text-white shadow-[4px_4px_0_#121212]"
          >
            Register as Freelancer
          </Link>
        </div>
      </section>
    </MarketingPageShell>
  );
}
