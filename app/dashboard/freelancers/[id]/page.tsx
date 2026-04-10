"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getFreelancerRequest } from "../../../../lib/api";
import { useAuthStore } from "../../../../store/auth-store";
import { Button, Card, PageIntro, Pill, ProgressBar } from "../../../../components/ui/primitives";

type FreelancerDetail = {
  id: string;
  name: string;
  email?: string | null;
  rating: number;
  trustScore: number;
  experience?: string;
  skills?: string[];
  createdAt: string;
  isSanctionsFlagged: boolean;
  isBanned: boolean;
  stats: {
    totalSubmissions: number;
    passedSubmissions: number;
    disputedSubmissions: number;
    activeBounties: number;
  };
  recentWork: Array<{
    bountyId: string;
    title: string;
    submissionStatus: string;
    submittedAt: string;
    finalScore: number | null;
  }>;
};

export default function FreelancerDetailPage() {
  const params = useParams<{ id: string }>();
  const freelancerId = params.id;
  const { hydrate } = useAuthStore();

  const [freelancer, setFreelancer] = useState<FreelancerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadFreelancer = useCallback(async () => {
    if (!freelancerId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = (await getFreelancerRequest(freelancerId)) as FreelancerDetail;
      setFreelancer(data);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [freelancerId]);

  useEffect(() => {
    void loadFreelancer();
  }, [loadFreelancer]);

  const completionRate = useMemo(() => {
    if (!freelancer || freelancer.stats.totalSubmissions === 0) {
      return 0;
    }

    return Math.round((freelancer.stats.passedSubmissions / freelancer.stats.totalSubmissions) * 100);
  }, [freelancer]);

  if (loading) {
    return <p className="text-sm text-[#4b4b4b]">Loading freelancer profile...</p>;
  }

  if (error) {
    return <p className="text-sm text-[#8f1515]">{error}</p>;
  }

  if (!freelancer) {
    return <p className="text-sm text-[#4b4b4b]">Freelancer not found.</p>;
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageIntro
          title={freelancer.name}
          subtitle="Freelancer profile, trust stats, and recent bounty work."
        />
        <Button asChild variant="secondary">
          <Link href="/dashboard/freelancers">Back to Freelancers</Link>
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm text-[#4b4b4b]">Freelancer ID {freelancer.id}</p>
            <p className="text-sm text-[#4b4b4b]">Joined {new Date(freelancer.createdAt).toLocaleDateString()}</p>
            {freelancer.email ? <p className="text-sm text-[#4b4b4b]">Email {freelancer.email}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill text={`rating ${freelancer.rating}`} />
            <Pill text={`trust ${freelancer.trustScore}`} />
            {freelancer.isBanned ? <Pill text="banned" /> : null}
            {freelancer.isSanctionsFlagged ? <Pill text="sanctions flagged" /> : null}
          </div>
        </div>

        <div className="mt-4 rounded-none border border-[#121212] bg-[#f5f5f5] p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-[#4b4b4b]">Experience</p>
          <p className="mt-1 text-sm text-[#2a2a2a]">{freelancer.experience || "No experience added yet."}</p>
        </div>

        <div className="mt-3 rounded-none border border-[#121212] bg-white p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-[#4b4b4b]">Skills</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(freelancer.skills ?? []).length > 0 ? (
              (freelancer.skills ?? []).map((skill) => (
                <span
                  key={skill}
                  className="inline-flex border border-[#121212] bg-[#f0c020] px-2 py-1 text-xs font-semibold uppercase tracking-wide"
                >
                  {skill}
                </span>
              ))
            ) : (
              <p className="text-sm text-[#4b4b4b]">No skills listed yet.</p>
            )}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Active Bounties</p>
          <p className="mt-2 text-3xl font-semibold">{freelancer.stats.activeBounties}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Total Submissions</p>
          <p className="mt-2 text-3xl font-semibold">{freelancer.stats.totalSubmissions}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Passed Submissions</p>
          <p className="mt-2 text-3xl font-semibold">{freelancer.stats.passedSubmissions}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#4b4b4b]">Disputed</p>
          <p className="mt-2 text-3xl font-semibold">{freelancer.stats.disputedSubmissions}</p>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Completion Quality</h2>
          <Pill text={`${completionRate}%`} />
        </div>
        <div className="mt-3">
          <ProgressBar value={completionRate} />
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Recent Work</h2>
        <div className="mt-4 space-y-3">
          {freelancer.recentWork.map((work) => (
            <div key={`${work.bountyId}-${work.submittedAt}`} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-[#121212]">{work.title}</p>
                <Pill text={work.submissionStatus} />
              </div>
              <p className="mt-1 text-xs text-[#4b4b4b]">Submitted {new Date(work.submittedAt).toLocaleString()}</p>
              <p className="mt-1 text-xs text-[#4b4b4b]">Final score {work.finalScore ?? "pending"}</p>
              <div className="mt-3">
                <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                  <Link href={`/bounties/${work.bountyId}`}>Open Bounty</Link>
                </Button>
              </div>
            </div>
          ))}

          {freelancer.recentWork.length === 0 ? (
            <p className="text-sm text-[#4b4b4b]">No recent submissions yet.</p>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
