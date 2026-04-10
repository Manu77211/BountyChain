"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyToProjectRequest,
  discoverOpenProjectsRequest,
  listProjectsRequest,
} from "../../../lib/api";
import { formatAlgoWithMicro } from "../../../lib/algo";
import { useRealtimeChannel } from "../../../lib/realtime-client";
import { useAuthStore } from "../../../store/auth-store";
import { Button, Card, Input, PageIntro, Pill } from "../../../components/ui/primitives";

type BountyCard = {
  id: string;
  title: string;
  description?: string;
  status: string;
  criteria?: {
    totalAmountMicroAlgo?: number;
    deadline?: string;
    scoringMode?: string;
    acceptanceCriteria?: string;
    requiredSkills?: string[];
  };
  client?: {
    id?: string;
    name?: string;
    walletAddress?: string;
    trustScore?: number;
  };
  _count?: {
    applications?: number;
  };
  applicantsPreview?: Array<{
    freelancer_name: string;
    status: string;
  }>;
  myApplicationStatus?: string | null;
  canApply?: boolean;
};

function shortWallet(value?: string) {
  if (!value) {
    return "unknown";
  }
  if (value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function canApplyNow(item: BountyCard) {
  const state = String(item.myApplicationStatus ?? "").toUpperCase();
  if (state === "SELECTED") {
    return false;
  }
  if (state === "PENDING") {
    return false;
  }
  return Boolean(item.canApply || state === "REJECTED");
}

export default function DashboardBountiesPage() {
  const { token, user, hydrate } = useAuthStore();
  const role = String(user?.role ?? "").toUpperCase();
  const isFreelancer = role === "FREELANCER";
  const isClient = role === "CLIENT";

  const [marketItems, setMarketItems] = useState<BountyCard[]>([]);
  const [ongoingItems, setOngoingItems] = useState<BountyCard[]>([]);
  const [viewMode, setViewMode] = useState<"discover" | "ongoing">("discover");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [proposalMessage, setProposalMessage] = useState<Record<string, string>>({});

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadBounties = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (isFreelancer) {
        const [market, ongoing] = await Promise.all([
          discoverOpenProjectsRequest(token),
          listProjectsRequest(token),
        ]);
        setMarketItems((market as BountyCard[]) ?? []);
        setOngoingItems((ongoing as BountyCard[]) ?? []);
      } else {
        const response = await listProjectsRequest(token);
        setMarketItems((response as BountyCard[]) ?? []);
        setOngoingItems([]);
      }
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [isFreelancer, token]);

  useEffect(() => {
    void loadBounties();
  }, [loadBounties]);

  useRealtimeChannel({
    token,
    onEvent: () => {
      void loadBounties();
    },
  });

  const filtered = useMemo(() => {
    const sourceItems = isFreelancer
      ? viewMode === "ongoing"
        ? ongoingItems
        : marketItems
      : marketItems;

    const text = query.trim().toLowerCase();
    if (!text) {
      return sourceItems;
    }

    return sourceItems.filter((item) => {
      const fields = [
        item.title,
        item.description ?? "",
        item.client?.name ?? "",
        item.status,
      ]
        .join(" ")
        .toLowerCase();
      return fields.includes(text);
    });
  }, [isFreelancer, marketItems, ongoingItems, query, viewMode]);

  async function onApply(item: BountyCard) {
    if (!token) {
      return;
    }

    setActionLoadingId(item.id);
    setError(null);
    try {
      await applyToProjectRequest(token, item.id, {
        message:
          proposalMessage[item.id]?.trim() ||
          "Applying from dashboard bounty board. Ready to deliver against acceptance criteria.",
      });
      setProposalMessage((current) => ({ ...current, [item.id]: "" }));
      await loadBounties();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setActionLoadingId(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageIntro
          title={
            isFreelancer
              ? viewMode === "ongoing"
                ? "My Ongoing Bounties"
                : "Open Bounties"
              : "Bounty Pipeline"
          }
          subtitle={
            isFreelancer
              ? viewMode === "ongoing"
                ? "Track only bounties where you are already selected and actively delivering."
                : "Review client trust, payout amount, status, and apply directly."
              : "Track all your bounties with applicants, status, and operational controls."
          }
        />
        {isClient ? (
          <Button asChild>
            <Link href="/bounties/create">Create Bounty</Link>
          </Button>
        ) : null}
      </div>

      {isFreelancer ? (
        <Card>
          <div className="flex flex-wrap gap-2">
            <Button variant={viewMode === "discover" ? "primary" : "secondary"} onClick={() => setViewMode("discover")}>
              Discover Open
            </Button>
            <Button variant={viewMode === "ongoing" ? "primary" : "secondary"} onClick={() => setViewMode("ongoing")}>
              My Ongoing
            </Button>
          </div>
          <p className="mt-2 text-xs text-[#4b4b4b]">
            My Work tracks submission/CI/payout workflow after your PR is submitted. This page handles bounty discovery and ongoing bounty visibility.
          </p>
        </Card>
      ) : null}

      <Card>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search bounties, clients, statuses"
          />
          <Button variant="secondary" onClick={() => void loadBounties()}>Refresh</Button>
        </div>
      </Card>

      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
      {loading ? <p className="text-sm text-[#4b4b4b]">Loading bounties...</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {filtered.map((item) => {
          const microAmount = Number(item.criteria?.totalAmountMicroAlgo ?? 0);
          const applyAllowed = canApplyNow(item);
          const applicationStatus = String(item.myApplicationStatus ?? "").toUpperCase();

          return (
            <Card key={item.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold">{item.title}</p>
                  <p className="mt-1 text-xs text-[#4b4b4b]">{item.description ?? "No description provided."}</p>
                </div>
                <Pill text={item.status} />
              </div>

              <div className="mt-3 grid gap-2 text-xs text-[#4b4b4b] sm:grid-cols-2">
                <p>Amount: {formatAlgoWithMicro(microAmount)}</p>
                <p>Scoring: {item.criteria?.scoringMode ?? "hybrid"}</p>
                <p>Deadline: {item.criteria?.deadline ? new Date(item.criteria.deadline).toLocaleString() : "Not set"}</p>
                <p>Applications: {item._count?.applications ?? item.applicantsPreview?.length ?? 0}</p>
                <p>Client: {item.client?.name ?? "Unknown"}</p>
                <p>Client Trust Score: {item.client?.trustScore ?? "n/a"}</p>
                <p>Client Wallet: {shortWallet(item.client?.walletAddress)}</p>
                <p>Application Status: {applicationStatus || "Not Applied"}</p>
              </div>

              {(item.criteria?.requiredSkills ?? []).length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1">
                  {(item.criteria?.requiredSkills ?? []).slice(0, 5).map((skill) => (
                    <span key={skill} className="inline-flex border border-[#121212] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase">
                      {skill}
                    </span>
                  ))}
                </div>
              ) : null}

              {(item.applicantsPreview ?? []).length > 0 ? (
                <div className="mt-3 rounded-xl border border-[#121212] bg-[#f5f5f5] p-2">
                  <p className="text-xs font-semibold">Recent Applicants</p>
                  <div className="mt-1 space-y-1 text-xs text-[#4b4b4b]">
                    {(item.applicantsPreview ?? []).slice(0, 3).map((entry, index) => (
                      <p key={`${entry.freelancer_name}-${index}`}>{entry.freelancer_name} - {String(entry.status).toUpperCase()}</p>
                    ))}
                  </div>
                </div>
              ) : null}

              {isFreelancer ? (
                <div className="mt-3 space-y-2">
                  <Input
                    value={proposalMessage[item.id] ?? ""}
                    onChange={(event) => setProposalMessage((current) => ({ ...current, [item.id]: event.target.value }))}
                    placeholder="Optional proposal message"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                      <Link href={`/bounties/${item.id}`}>Open Bounty</Link>
                    </Button>
                    {applicationStatus === "SELECTED" ? (
                      <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                        <Link href={`/dashboard/projects/${item.id}`}>Open Delivery Workspace</Link>
                      </Button>
                    ) : null}
                    <Button
                      className="h-8 px-3 text-xs"
                      disabled={!applyAllowed || actionLoadingId === item.id}
                      onClick={() => void onApply(item)}
                    >
                      {actionLoadingId === item.id
                        ? "Applying..."
                        : applicationStatus === "SELECTED"
                          ? "Selected"
                          : applicationStatus === "PENDING"
                            ? "Applied"
                            : "Apply"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                    <Link href={`/bounties/${item.id}`}>View Bounty</Link>
                  </Button>
                  <Button asChild className="h-8 px-3 text-xs">
                    <Link href={`/dashboard/projects/${item.id}`}>Manage Applications</Link>
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {!loading && filtered.length === 0 ? (
        <Card>
          <p className="text-sm text-[#4b4b4b]">No bounties found for this filter.</p>
        </Card>
      ) : null}

      <Card>
        <h3 className="text-lg font-semibold">Roadmap Ready</h3>
        <p className="mt-1 text-sm text-[#4b4b4b]">
          This page is wired for future elements like match scores, recommended applicants, fraud risk indicators,
          and payout forecast insights without changing the route contract.
        </p>
      </Card>
    </section>
  );
}
