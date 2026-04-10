"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { listProjectMessagesRequest, listProjectsRequest, meRequest } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { Button, Card, PageIntro, Pill, ProgressBar } from "../../components/ui/primitives";

export default function DashboardPage() {
  const { token, user, hydrate } = useAuthStore();
  const [bounties, setBounties] = useState<any[]>([]);
  const [recentMessages, setRecentMessages] = useState<any[]>([]);
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    async function load() {
      if (!token) {
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const [profileData, bountyList] = await Promise.all([
          meRequest(token),
          listProjectsRequest(token),
        ]);

        setProfile(profileData);
        setBounties(bountyList);

        if (bountyList.length > 0) {
          const firstProjectMessages = await listProjectMessagesRequest(token, bountyList[0].id);
          setRecentMessages(firstProjectMessages.slice(-5).reverse());
        } else {
          setRecentMessages([]);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [token]);

  const activeProjects = bounties.filter((item) => item.status === "IN_PROGRESS").length;
  const completedProjects = bounties.filter((item) => item.status === "COMPLETED").length;
  const pendingApprovals = bounties.filter((item) => item.status === "IN_PROGRESS" && !item.draftApproved).length;
  const pendingSubmissions = bounties.filter((item) =>
    (item.milestones ?? []).some((milestone: any) => milestone.status === "SUBMITTED" || milestone.status === "PENDING"),
  ).length;
  const avgTrustScore = profile?.trustScore ?? user?.trustScore ?? 0;
  const escrowFunds = bounties.reduce((sum, item) => {
    const total = (item.milestones ?? []).reduce((inner: number, milestone: any) => inner + (milestone.amount ?? 0), 0);
    return sum + total;
  }, 0);
  const earningsEstimate = bounties.reduce((sum, item) => {
    const approved = (item.milestones ?? [])
      .filter((milestone: any) => milestone.status === "APPROVED")
      .reduce((inner: number, milestone: any) => inner + (milestone.amount ?? 0), 0);
    return sum + approved;
  }, 0);

  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-6">
      <PageIntro
        title={user?.role === "FREELANCER" ? "Freelancer Bounty Overview" : "Client Bounty Overview"}
        subtitle={
          user?.role === "FREELANCER"
            ? "Track assigned milestones, delivery quality signals, and payout readiness across active bounties."
            : "Fund escrow safely, monitor delivery quality, and release payment only through objective validation."
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">{user?.role === "FREELANCER" ? "Assigned Bounties" : "Active Bounties"}</p>
          <p className="mt-2 text-3xl font-semibold">{activeProjects}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">{user?.role === "FREELANCER" ? "Earnings" : "Funds In Escrow"}</p>
          <p className="mt-2 text-3xl font-semibold">${(user?.role === "FREELANCER" ? earningsEstimate : escrowFunds).toFixed(2)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">{user?.role === "FREELANCER" ? "Pending Submissions" : "Pending Approvals"}</p>
          <p className="mt-2 text-3xl font-semibold">{user?.role === "FREELANCER" ? pendingSubmissions : pendingApprovals}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Trust Score</p>
          <p className="mt-2 text-3xl font-semibold">{avgTrustScore.toFixed(1)}</p>
          <div className="mt-3">
            <ProgressBar value={Math.min(100, avgTrustScore)} />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Workflow Snapshot</h2>
            <Pill text={user?.role === "FREELANCER" ? "Delivery Lens" : "Escrow Lens"} />
          </div>
          {loading ? <p className="mt-4 text-[#4b4b4b]">Loading summary...</p> : null}
          {error ? <p className="mt-4 text-sm text-[#8f1515]">{error}</p> : null}
          {!loading && !error ? (
            <div className="mt-4 space-y-3">
              {bounties.slice(0, 4).map((project) => {
                const milestones = project.milestones ?? [];
                const approvedCount = milestones.filter((item: any) => item.status === "APPROVED").length;
                const progress = milestones.length > 0 ? (approvedCount / milestones.length) * 100 : 0;
                return (
                  <div key={project.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{project.title}</p>
                      <Pill text={project.status} />
                    </div>
                    <p className="mt-1 text-xs text-[#4b4b4b]">
                      {project.client?.name ? `Client ${project.client.name}` : ""}
                      {project.freelancer?.name ? ` | Freelancer ${project.freelancer.name}` : ""}
                    </p>
                    <div className="mt-3">
                      <ProgressBar value={progress} />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                        <Link href={`/dashboard/bounties/${project.id}`}>View Details</Link>
                      </Button>
                      <Button asChild className="h-8 px-3 text-xs">
                        <Link href={`/dashboard/chat/${project.id}`}>Open Chat</Link>
                      </Button>
                    </div>
                  </div>
                );
              })}
              {bounties.length === 0 ? <p className="text-sm text-[#4b4b4b]">No bounties to show yet.</p> : null}
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="text-lg font-semibold">Recent Activity</h2>
          <p className="mt-1 text-sm text-[#4b4b4b]">Latest chat updates and bounty actions.</p>
          <div className="mt-4 space-y-3">
            {recentMessages.map((message) => (
              <div key={message.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                <p className="text-xs text-[#4b4b4b]">
                  {message.sender.name} ({message.sender.role})
                </p>
                <p className="mt-1 text-sm text-[#2a2a2a]">{message.content}</p>
              </div>
            ))}
            {!loading && recentMessages.length === 0 ? (
              <p className="text-sm text-[#4b4b4b]">No activity yet. Start a project conversation to populate updates.</p>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/dashboard/bounties">{user?.role === "FREELANCER" ? "Go to My Bounties" : "Manage Bounties"}</Link>
            </Button>
            {user?.role === "CLIENT" ? (
              <Button asChild variant="secondary">
                <Link href="/dashboard/freelancers">Find Freelancer</Link>
              </Button>
            ) : null}
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-[#4b4b4b]">Completed Bounties</p>
            <p className="mt-1 text-2xl font-semibold">{completedProjects}</p>
          </div>
          <Button asChild variant="secondary">
            <Link href="/dashboard/wallet">Open Wallet</Link>
          </Button>
        </div>
      </Card>
    </motion.section>
  );
}

