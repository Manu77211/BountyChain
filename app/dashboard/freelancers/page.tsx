"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { discoverOpenProjectsRequest, listBountiesRequest, listFreelancersRequest } from "../../../lib/api";
import { formatAlgoWithMicro } from "../../../lib/algo";
import { useAuthStore } from "../../../store/auth-store";
import { Button, Card, Input, PageIntro, Pill } from "../../../components/ui/primitives";

type FreelancerListItem = {
  id: string;
  name: string;
  rating: number;
  trustScore: number;
  experience?: string;
  skills?: string[];
};

type MarketplaceBounty = {
  id: string;
  title: string;
  status: string;
  total_amount?: string;
  scoring_mode?: string;
  deadline?: string;
};

type OpenProject = {
  id: string;
  title: string;
  status: string;
  client?: {
    name?: string;
  };
};

export default function DashboardFreelancersPage() {
  const { token, user, hydrate } = useAuthStore();
  const role = String(user?.role ?? "").toUpperCase();
  const isFreelancer = role === "FREELANCER";

  const [skills, setSkills] = useState("");
  const [rating, setRating] = useState("0");
  const [marketQuery, setMarketQuery] = useState("");
  const [freelancers, setFreelancers] = useState<FreelancerListItem[]>([]);
  const [marketBounties, setMarketBounties] = useState<MarketplaceBounty[]>([]);
  const [openProjects, setOpenProjects] = useState<OpenProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadFreelancers = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = (await listFreelancersRequest({
        skills: skills.trim() ? skills : undefined,
        rating: Number(rating),
      })) as FreelancerListItem[];

      setFreelancers(data);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [skills, rating]);

  const loadMarketplace = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [openBountyResponse, openProjectResponse] = await Promise.all([
        listBountiesRequest({ status: "open", limit: 50 }),
        discoverOpenProjectsRequest(token),
      ]);

      setMarketBounties((openBountyResponse as { data?: MarketplaceBounty[] }).data ?? []);
      setOpenProjects((openProjectResponse as OpenProject[]) ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!user) {
      return;
    }

    if (isFreelancer) {
      void loadMarketplace();
      return;
    }

    void loadFreelancers();
  }, [isFreelancer, loadFreelancers, loadMarketplace, user]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isFreelancer) {
      await loadMarketplace();
      return;
    }
    await loadFreelancers();
  }

  const averageRating = useMemo(() => {
    if (freelancers.length === 0) {
      return 0;
    }

    const total = freelancers.reduce((sum, item) => sum + Number(item.rating ?? 0), 0);
    return Number((total / freelancers.length).toFixed(2));
  }, [freelancers]);

  const filteredBounties = useMemo(() => {
    const text = marketQuery.trim().toLowerCase();
    if (!text) {
      return marketBounties;
    }
    return marketBounties.filter((item) => item.title.toLowerCase().includes(text));
  }, [marketBounties, marketQuery]);

  const filteredProjects = useMemo(() => {
    const text = marketQuery.trim().toLowerCase();
    if (!text) {
      return openProjects;
    }
    return openProjects.filter((item) => item.title.toLowerCase().includes(text));
  }, [openProjects, marketQuery]);

  if (isFreelancer) {
    return (
      <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
        <PageIntro
          title="Marketplace"
          subtitle="See all client-hosted bounty opportunities currently open for freelancers."
        />

        <Card>
          <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[1fr_auto]">
            <Input
              value={marketQuery}
              onChange={(event) => setMarketQuery(event.target.value)}
              placeholder="Search open bounties"
            />
            <div className="flex gap-2">
              <Button type="submit">Refresh</Button>
              <Button asChild variant="secondary">
                <Link href="/dashboard/projects">My Applications</Link>
              </Button>
            </div>
          </form>

          <div className="mt-4 flex flex-wrap gap-2">
            <Pill text={`${filteredBounties.length} open bounties`} />
            <Pill text={`${filteredProjects.length} open bounties from board`} />
          </div>

          {error ? <p className="mt-3 text-sm text-[#8f1515]">{error}</p> : null}
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Open Bounties</h2>
            {loading ? <p className="text-sm text-[#4b4b4b]">Loading bounties...</p> : null}
            <div className="space-y-3">
              {filteredBounties.map((item) => (
                <div key={item.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-[#121212]">{item.title}</p>
                    <Pill text={item.status} />
                  </div>
                  <p className="mt-1 text-xs text-[#4b4b4b]">
                    Amount {formatAlgoWithMicro(item.total_amount)} | {item.scoring_mode ?? "hybrid"}
                  </p>
                  <p className="mt-1 text-xs text-[#4b4b4b]">
                    Deadline {item.deadline ? new Date(item.deadline).toLocaleString() : "Not specified"}
                  </p>
                  <div className="mt-3">
                    <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                      <Link href={`/bounties/${item.id}`}>View Details</Link>
                    </Button>
                  </div>
                </div>
              ))}
              {!loading && filteredBounties.length === 0 ? (
                <p className="text-sm text-[#4b4b4b]">No open bounties found.</p>
              ) : null}
            </div>
          </Card>

          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Bounties from Board</h2>
            {loading ? <p className="text-sm text-[#4b4b4b]">Loading board bounties...</p> : null}
            <div className="space-y-3">
              {filteredProjects.map((item) => (
                <div key={item.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-[#121212]">{item.title}</p>
                    <Pill text={item.status} />
                  </div>
                  <p className="mt-1 text-xs text-[#4b4b4b]">Client {item.client?.name ?? "Unknown"}</p>
                  <div className="mt-3">
                    <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                      <Link href={`/bounties/${item.id}`}>Open Bounty</Link>
                    </Button>
                  </div>
                </div>
              ))}
              {!loading && filteredProjects.length === 0 ? (
                <p className="text-sm text-[#4b4b4b]">No additional board bounties found.</p>
              ) : null}
            </div>
          </Card>
        </div>
      </motion.section>
    );
  }

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageIntro
        title="Freelancers"
        subtitle="View all freelancers, filter by minimum rating or keywords, and inspect individual profiles."
      />

      <Card>
        <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
          <Input
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
            placeholder="Search by name keyword"
          />
          <Input
            value={rating}
            onChange={(event) => setRating(event.target.value)}
            type="number"
            min="0"
            max="5"
            step="0.1"
            placeholder="Minimum rating"
          />
          <Button type="submit">{loading ? "Loading..." : "Apply Filters"}</Button>
        </form>

        <div className="mt-4 flex flex-wrap gap-2">
          <Pill text={`${freelancers.length} freelancers`} />
          <Pill text={`avg rating ${averageRating}`} />
        </div>

        {error ? <p className="mt-3 text-sm text-[#8f1515]">{error}</p> : null}
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading ? <p className="text-sm text-[#4b4b4b]">Fetching freelancers...</p> : null}

        {freelancers.map((item) => (
          <Card key={item.id} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-semibold text-[#121212]">{item.name}</p>
              <Pill text={`rating ${item.rating}`} />
            </div>
            <p className="text-xs text-[#4b4b4b]">Trust score {item.trustScore}</p>
            <p className="text-sm text-[#2a2a2a]">{item.experience || "No experience added yet."}</p>
            <div className="flex flex-wrap gap-2">
              {(item.skills ?? []).length > 0 ? (
                (item.skills ?? []).map((skill) => (
                  <span
                    key={skill}
                    className="inline-flex border border-[#121212] bg-[#f0c020] px-2 py-1 text-xs font-semibold uppercase tracking-wide"
                  >
                    {skill}
                  </span>
                ))
              ) : (
                <p className="text-xs text-[#4b4b4b]">No skills listed.</p>
              )}
            </div>
            <Button asChild variant="secondary" className="h-8 px-3 text-xs">
              <Link href={`/dashboard/freelancers/${item.id}`}>Open Freelancer Profile</Link>
            </Button>
          </Card>
        ))}

        {!loading && freelancers.length === 0 ? (
          <Card>
            <p className="text-sm text-[#4b4b4b]">No freelancers found for the selected filters.</p>
          </Card>
        ) : null}
      </div>
    </motion.section>
  );
}
