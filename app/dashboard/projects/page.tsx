"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  discoverOpenProjectsRequest,
  listMyProjectApplicationsRequest,
  listProjectsRequest,
} from "../../../lib/api";
import { useAuthStore } from "../../../store/auth-store";
import { Button, Card, Input, PageIntro, Pill, Select } from "../../../components/ui/primitives";

type BountyApplication = {
  application: {
    id: string;
    status: string;
    message?: string;
    proposedAmount?: number;
    estimatedDays?: number;
    createdAt?: string;
  };
  project: {
    id: string;
    title: string;
    status: string;
    client?: {
      name?: string;
    };
    criteria?: {
      deadline?: string;
      totalAmountMicroAlgo?: number;
    };
  };
};

type ClientBounty = {
  id: string;
  title: string;
  status: string;
  _count?: {
    applications?: number;
  };
  criteria?: {
    deadline?: string;
  };
};

type OpenBounty = {
  id: string;
  title: string;
  status: string;
  criteria?: {
    totalAmountMicroAlgo?: number;
    deadline?: string;
  };
  client?: {
    name?: string;
  };
};

function asDate(value?: string) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function filterByText<T>(items: T[], readText: (item: T) => string, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items;
  }
  return items.filter((item) => readText(item).toLowerCase().includes(normalized));
}

export default function DashboardApplicationsPage() {
  const { token, user, hydrate } = useAuthStore();
  const role = String(user?.role ?? "").toUpperCase();
  const isFreelancer = role === "FREELANCER";

  const [applications, setApplications] = useState<BountyApplication[]>([]);
  const [openBounties, setOpenBounties] = useState<OpenBounty[]>([]);
  const [clientBounties, setClientBounties] = useState<ClientBounty[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const load = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (isFreelancer) {
        const [applied, market] = await Promise.all([
          listMyProjectApplicationsRequest(token),
          discoverOpenProjectsRequest(token),
        ]);

        setApplications((applied as BountyApplication[]) ?? []);
        setOpenBounties((market as OpenBounty[]) ?? []);
        setClientBounties([]);
      } else {
        const data = await listProjectsRequest(token);
        setClientBounties((data as ClientBounty[]) ?? []);
        setApplications([]);
        setOpenBounties([]);
      }
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [isFreelancer, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredApplications = useMemo(() => {
    const byStatus = statusFilter
      ? applications.filter(
          (entry) => String(entry.application.status ?? "").toUpperCase() === statusFilter,
        )
      : applications;

    return filterByText(byStatus, (entry) => `${entry.project.title} ${entry.project.client?.name ?? ""}`, query);
  }, [applications, query, statusFilter]);

  const filteredClientBounties = useMemo(() => {
    return filterByText(clientBounties, (entry) => entry.title, query);
  }, [clientBounties, query]);

  const openBountyPreview = useMemo(() => {
    return filterByText(openBounties, (entry) => `${entry.title} ${entry.client?.name ?? ""}`, query).slice(0, 8);
  }, [openBounties, query]);

  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageIntro
        title={isFreelancer ? "My Bounty Applications" : "Bounty Application Pipeline"}
        subtitle={
          isFreelancer
            ? "See every bounty you applied to and track status in realtime."
            : "Monitor all applications across your bounties."
        }
      />

      <Card>
        <div className="grid gap-2 sm:grid-cols-[1fr_200px_auto]">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={isFreelancer ? "Search by bounty title or client" : "Search by bounty title"}
          />
          {isFreelancer ? (
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="SELECTED">Selected</option>
              <option value="REJECTED">Rejected</option>
            </Select>
          ) : (
            <div />
          )}
          <Button variant="secondary" onClick={() => void load()}>Refresh</Button>
        </div>
      </Card>

      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
      {loading ? <p className="text-sm text-[#4b4b4b]">Loading application status...</p> : null}

      {isFreelancer ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                  <th className="py-2 pr-4">Bounty</th>
                  <th className="py-2 pr-4">Client</th>
                  <th className="py-2 pr-4">Applied</th>
                  <th className="py-2 pr-4">Application Status</th>
                  <th className="py-2 pr-4">Bounty Status</th>
                  <th className="py-2 pr-4">Proposed</th>
                  <th className="py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredApplications.map((entry) => (
                  <tr key={entry.application.id} className="border-b border-[#ececec] align-top">
                    <td className="py-3 pr-4">
                      <p className="font-semibold">{entry.project.title}</p>
                      <p className="text-xs text-[#4b4b4b]">Deadline: {asDate(entry.project.criteria?.deadline)}</p>
                    </td>
                    <td className="py-3 pr-4">{entry.project.client?.name ?? "Unknown"}</td>
                    <td className="py-3 pr-4">{asDate(entry.application.createdAt)}</td>
                    <td className="py-3 pr-4"><Pill text={entry.application.status} /></td>
                    <td className="py-3 pr-4"><Pill text={entry.project.status} /></td>
                    <td className="py-3 pr-4">
                      {entry.application.proposedAmount ? `${entry.application.proposedAmount} microALGO` : "-"}
                    </td>
                    <td className="py-3">
                      <div className="flex gap-2">
                        <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                          <Link href={`/bounties/${entry.project.id}`}>View Bounty</Link>
                        </Button>
                        {String(entry.application.status).toUpperCase() === "SELECTED" ? (
                          <Button asChild className="h-8 px-3 text-xs">
                            <Link href={`/dashboard/chat/${entry.project.id}`}>Open Chat</Link>
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!loading && filteredApplications.length === 0 ? (
            <p className="mt-3 text-sm text-[#4b4b4b]">No applications found for the current filter.</p>
          ) : null}
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                  <th className="py-2 pr-4">Bounty</th>
                  <th className="py-2 pr-4">Bounty Status</th>
                  <th className="py-2 pr-4">Applications</th>
                  <th className="py-2 pr-4">Deadline</th>
                  <th className="py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredClientBounties.map((entry) => (
                  <tr key={entry.id} className="border-b border-[#ececec] align-top">
                    <td className="py-3 pr-4 font-semibold">{entry.title}</td>
                    <td className="py-3 pr-4"><Pill text={entry.status} /></td>
                    <td className="py-3 pr-4">{entry._count?.applications ?? 0}</td>
                    <td className="py-3 pr-4">{asDate(entry.criteria?.deadline)}</td>
                    <td className="py-3">
                      <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                        <Link href={`/dashboard/projects/${entry.id}`}>Manage</Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!loading && filteredClientBounties.length === 0 ? (
            <p className="mt-3 text-sm text-[#4b4b4b]">No bounties found.</p>
          ) : null}
        </Card>
      )}

      {isFreelancer ? (
        <Card>
          <h3 className="text-lg font-semibold">Open Bounties to Apply</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {openBountyPreview.map((item) => (
              <div key={item.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">{item.title}</p>
                  <Pill text={item.status} />
                </div>
                <p className="mt-1 text-xs text-[#4b4b4b]">Client {item.client?.name ?? "Unknown"}</p>
                <p className="mt-1 text-xs text-[#4b4b4b]">Budget {item.criteria?.totalAmountMicroAlgo ?? 0} microALGO</p>
                <div className="mt-3">
                  <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                    <Link href={`/bounties/${item.id}`}>Open Bounty</Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </motion.section>
  );
}
