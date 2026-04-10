"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { listFreelancersRequest } from "../../../lib/api";
import { Button, Card, Input, PageIntro, Pill } from "../../../components/ui/primitives";

type FreelancerListItem = {
  id: string;
  name: string;
  rating: number;
  trustScore: number;
  experience?: string;
  skills?: string[];
};

export default function DashboardFreelancersPage() {
  const [skills, setSkills] = useState("");
  const [rating, setRating] = useState("0");
  const [freelancers, setFreelancers] = useState<FreelancerListItem[]>([]);
  const [selectedFreelancer, setSelectedFreelancer] = useState<FreelancerListItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFreelancers = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = (await listFreelancersRequest({
        skills: skills.trim() ? skills : undefined,
        rating: Number(rating),
      })) as FreelancerListItem[];

      setFreelancers(data);
      setSelectedFreelancer((current) => {
        if (!data.length) {
          return null;
        }

        if (!current) {
          return data[0];
        }

        const match = data.find((item) => item.id === current.id);
        return match ?? data[0];
      });
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [skills, rating]);

  useEffect(() => {
    void loadFreelancers();
  }, [loadFreelancers]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadFreelancers();
  }

  const averageRating = useMemo(() => {
    if (freelancers.length === 0) {
      return 0;
    }

    const total = freelancers.reduce((sum, item) => sum + Number(item.rating ?? 0), 0);
    return Number((total / freelancers.length).toFixed(2));
  }, [freelancers]);

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

      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">All Freelancers</h2>
          {loading ? <p className="text-sm text-[#4b4b4b]">Fetching freelancers...</p> : null}

          <div className="max-h-[62vh] space-y-2 overflow-y-auto pr-1">
            {freelancers.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedFreelancer(item)}
                className="w-full rounded-none border-2 border-[#121212] bg-[#f5f5f5] p-3 text-left hover:bg-[#e8f0ff]"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-[#121212]">{item.name}</p>
                  <Pill text={`rating ${item.rating}`} />
                </div>
                <p className="mt-1 text-xs text-[#4b4b4b]">Trust score: {item.trustScore}</p>
              </button>
            ))}

            {!loading && freelancers.length === 0 ? (
              <p className="text-sm text-[#4b4b4b]">No freelancers found for the selected filters.</p>
            ) : null}
          </div>
        </Card>

        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Freelancer Details</h2>

          {selectedFreelancer ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xl font-black uppercase tracking-tight">{selectedFreelancer.name}</p>
                <Pill text={`trust ${selectedFreelancer.trustScore}`} />
              </div>

              <div className="grid gap-2 text-sm text-[#2f2f2f]">
                <p><span className="font-semibold">Freelancer ID:</span> {selectedFreelancer.id}</p>
                <p><span className="font-semibold">Rating:</span> {selectedFreelancer.rating}</p>
                <p><span className="font-semibold">Trust Score:</span> {selectedFreelancer.trustScore}</p>
              </div>

              <div className="rounded-none border border-[#121212] bg-[#f5f5f5] p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-[#4b4b4b]">Experience</p>
                <p className="mt-1 text-sm text-[#2a2a2a]">{selectedFreelancer.experience || "No experience added yet."}</p>
              </div>

              <div className="rounded-none border border-[#121212] bg-white p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-[#4b4b4b]">Skills</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(selectedFreelancer.skills ?? []).length > 0 ? (
                    (selectedFreelancer.skills ?? []).map((skill) => (
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
            </>
          ) : (
            <p className="text-sm text-[#4b4b4b]">Select a freelancer to view details.</p>
          )}
        </Card>
      </div>
    </motion.section>
  );
}
