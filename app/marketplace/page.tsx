import Link from "next/link";
import { MarketingPageShell } from "../../components/marketing/page-shell";

export default function MarketplacePage() {
  return (
    <MarketingPageShell
      title="Global Marketplace"
      subtitle="One place for clients and freelancers: post bounties, discover projects, and collaborate in real-time conversations."
    >
      <section className="bg-[#f0f0f0] py-16" style={{ borderBottom: "4px solid #121212" }}>
        <div className="mx-auto max-w-7xl px-5 md:px-12">
          <div className="grid gap-5 md:grid-cols-2">
            <article className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
              <p className="text-xs font-black uppercase tracking-widest text-[#1040c0]">For Clients</p>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-tight text-[#121212]">Post and Manage Bounties</h2>
              <p className="mt-3 text-sm text-[#3f3f3f]">
                Create scoped bounties, raise amounts, assign applicants, and manage milestone delivery with chat and escrow controls.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link
                  href="/people"
                  className="inline-flex border-2 border-[#121212] bg-white px-4 py-2 text-xs font-bold uppercase tracking-wide text-[#121212]"
                >
                  People Feed
                </Link>
                <Link
                  href="/bounties/create"
                  className="inline-flex border-2 border-[#121212] bg-[#1040c0] px-4 py-2 text-xs font-bold uppercase tracking-wide text-white"
                >
                  Create Bounty
                </Link>
              </div>
            </article>

            <article className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
              <p className="text-xs font-black uppercase tracking-widest text-[#d02020]">For Freelancers</p>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-tight text-[#121212]">Discover and Apply</h2>
              <p className="mt-3 text-sm text-[#3f3f3f]">
                Browse bounties, join applicant conversations, upload photo/file evidence, and move from application to delivery.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link
                  href="/for-freelancers"
                  className="inline-flex border-2 border-[#121212] bg-white px-4 py-2 text-xs font-bold uppercase tracking-wide text-[#121212]"
                >
                  Bounties Board
                </Link>
                <Link
                  href="/dashboard/freelancers"
                  className="inline-flex border-2 border-[#121212] bg-[#f0c020] px-4 py-2 text-xs font-bold uppercase tracking-wide text-[#121212]"
                >
                  Open Dashboard Marketplace
                </Link>
              </div>
            </article>
          </div>

          <div className="mt-6 rounded-none border-2 border-[#121212] bg-[#fff8e6] p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-[#121212]">Conversation First Workflow</p>
            <p className="mt-2 text-sm text-[#3f3f3f]">
              Every application and project can have its own thread with WhatsApp-style messaging, profile identity, and photo/file sharing.
            </p>
            <div className="mt-3">
              <Link
                href="/dashboard/chat"
                className="inline-flex border-2 border-[#121212] bg-white px-4 py-2 text-xs font-bold uppercase tracking-wide text-[#121212]"
              >
                Open Conversations
              </Link>
            </div>
          </div>
        </div>
      </section>
    </MarketingPageShell>
  );
}
