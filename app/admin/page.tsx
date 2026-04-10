"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  API_BASE_URL,
  adminBanWalletRequest,
  adminBountyActionRequest,
  adminConsistencyAlertsRequest,
  adminDeadLettersRequest,
  adminListBountiesRequest,
  adminListDisputesRequest,
  adminListUsersRequest,
  adminManualResolveDisputeRequest,
  adminOverviewRequest,
  adminRemoveBanRequest,
  adminRetryDeadLetterRequest,
  adminChangeRoleRequest,
} from "../../lib/api";
import { AppShell } from "../../src/components/layout/AppShell";
import { Protected } from "../../components/protected";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { Button, Card, Input, PageIntro, Pill, Select, Textarea } from "../../components/ui/primitives";
import { useAuthStore } from "../../store/auth-store";

type AdminTab = "overview" | "bounties" | "users" | "disputes" | "deadletters" | "health";

type OverviewData = {
  stats: {
    total_bounties: number;
    total_algo_locked: string;
    active_disputes: number;
    flagged_submissions: number;
    sanctions_flags: number;
    dead_letter_jobs_count: number;
  };
  consistency: Array<{ issue_type: string; issue_count: number }>;
};

type ConsistencyAlert = {
  id: string;
  type: string;
  reference: string;
  occurred_at: string;
};

type AdminBounty = {
  id: string;
  title: string;
  status: string;
  total_amount: string;
  creator_wallet: string;
  creator_email: string | null;
  deadline: string;
  updated_at: string;
};

type AdminUser = {
  id: string;
  wallet_address: string;
  email: string | null;
  role: "client" | "freelancer" | "arbitrator" | "admin";
  reputation_score: number;
  is_sanctions_flagged: boolean;
  is_banned: boolean;
  created_at: string;
};

type AdminDispute = {
  id: string;
  bounty_id: string;
  bounty_title: string;
  dispute_type: string;
  status: string;
  raised_at: string;
  sla_days: number;
};

type DeadLetter = {
  id: number;
  event_name: string;
  error: string;
  job_name: string | null;
  failed_at: string;
  payload?: unknown;
};

type HealthResponse = {
  status: "ok" | "degraded" | "down";
  services: Record<string, "ok" | "error" | "rate_limited">;
  uptime_seconds: number;
  version: string;
};

function asAlgo(value: string | null | undefined) {
  return Number(value ?? "0") / 1_000_000;
}

export default function AdminPage() {
  useRequireRole(["ADMIN"]);
  const { token, hydrate } = useAuthStore();

  const [tab, setTab] = useState<AdminTab>("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [consistencyAlerts, setConsistencyAlerts] = useState<ConsistencyAlert[]>([]);

  const [bounties, setBounties] = useState<AdminBounty[]>([]);
  const [bountyStatusFilter, setBountyStatusFilter] = useState("");
  const [bountyCreatorFilter, setBountyCreatorFilter] = useState("");

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersQuery, setUsersQuery] = useState("");
  const [usersRoleFilter, setUsersRoleFilter] = useState("");
  const [banWalletAddress, setBanWalletAddress] = useState("");
  const [banReason, setBanReason] = useState("");
  const [banMfa, setBanMfa] = useState("");

  const [disputes, setDisputes] = useState<AdminDispute[]>([]);
  const [disputeStatusFilter, setDisputeStatusFilter] = useState("");
  const [manualOutcome, setManualOutcome] = useState<"freelancer_wins" | "client_wins" | "split">("split");
  const [manualSplitShare, setManualSplitShare] = useState(50);
  const [manualJustification, setManualJustification] = useState("");
  const [manualTargetId, setManualTargetId] = useState("");

  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthCheckedAt, setHealthCheckedAt] = useState<string | null>(null);
  const [healthLatencyMs, setHealthLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const loadOverview = useCallback(async () => {
    if (!token) {
      return;
    }
    const [overviewData, consistencyData] = await Promise.all([
      adminOverviewRequest(token) as Promise<OverviewData>,
      adminConsistencyAlertsRequest(token) as Promise<{ data: ConsistencyAlert[] }>,
    ]);
    setOverview(overviewData);
    setConsistencyAlerts(consistencyData.data ?? []);
  }, [token]);

  const loadBounties = useCallback(async () => {
    if (!token) {
      return;
    }
    const response = (await adminListBountiesRequest(token, {
      status: bountyStatusFilter || undefined,
      creator: bountyCreatorFilter || undefined,
      limit: 80,
    })) as { data?: AdminBounty[] };
    setBounties(response.data ?? []);
  }, [bountyCreatorFilter, bountyStatusFilter, token]);

  const loadUsers = useCallback(async () => {
    if (!token) {
      return;
    }
    const response = (await adminListUsersRequest(token, {
      query: usersQuery || undefined,
      role: (usersRoleFilter || undefined) as "client" | "freelancer" | "arbitrator" | "admin" | undefined,
      limit: 80,
    })) as { data?: AdminUser[] };
    setUsers(response.data ?? []);
  }, [token, usersQuery, usersRoleFilter]);

  const loadDisputes = useCallback(async () => {
    if (!token) {
      return;
    }
    const response = (await adminListDisputesRequest(token, {
      status: disputeStatusFilter || undefined,
      limit: 80,
    })) as { data?: AdminDispute[] };
    setDisputes(response.data ?? []);
  }, [disputeStatusFilter, token]);

  const loadDeadLetters = useCallback(async () => {
    if (!token) {
      return;
    }
    const response = (await adminDeadLettersRequest(token, { limit: 100 })) as { data?: DeadLetter[] };
    setDeadLetters(response.data ?? []);
  }, [token]);

  const loadHealth = useCallback(async () => {
    const startedAt = performance.now();
    const response = await fetch(`${API_BASE_URL}/health`);
    if (!response.ok) {
      throw new Error("Failed to load health status");
    }
    setHealth((await response.json()) as HealthResponse);
    setHealthCheckedAt(new Date().toISOString());
    setHealthLatencyMs(Math.round(performance.now() - startedAt));
  }, []);

  const refreshByTab = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "overview") {
        await loadOverview();
      }
      if (tab === "bounties") {
        await loadBounties();
      }
      if (tab === "users") {
        await loadUsers();
      }
      if (tab === "disputes") {
        await loadDisputes();
      }
      if (tab === "deadletters") {
        await loadDeadLetters();
      }
      if (tab === "health") {
        await loadHealth();
      }
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadBounties, loadDeadLetters, loadDisputes, loadHealth, loadOverview, loadUsers, tab]);

  useEffect(() => {
    void refreshByTab();
  }, [refreshByTab]);

  useEffect(() => {
    if (tab !== "health") {
      return;
    }
    const interval = window.setInterval(() => {
      void loadHealth().catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [loadHealth, tab]);

  const healthBadge = useMemo(() => {
    if (!health) {
      return "unknown";
    }
    return health.status;
  }, [health]);

  async function runBountyAction(
    bountyId: string,
    action: "force-expire" | "force-refund" | "override-scoring" | "cancel",
  ) {
    if (!token) {
      return;
    }
    setError(null);
    try {
      await adminBountyActionRequest(token, bountyId, action);
      await loadBounties();
      await loadOverview();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onChangeRole(userId: string, role: AdminUser["role"]) {
    if (!token) {
      return;
    }
    setError(null);
    try {
      await adminChangeRoleRequest(token, userId, role);
      await loadUsers();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onRemoveBan(userId: string) {
    if (!token) {
      return;
    }
    setError(null);
    try {
      await adminRemoveBanRequest(token, userId);
      await loadUsers();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onBanWallet() {
    if (!token) {
      return;
    }
    setError(null);
    try {
      const confirmed = window.confirm("Ban this wallet? This should only be used for serious policy violations.");
      if (!confirmed) {
        return;
      }
      await adminBanWalletRequest(token, {
        wallet_address: banWalletAddress.trim(),
        reason: banReason.trim(),
        mfa_token: banMfa.trim(),
      });
      setBanWalletAddress("");
      setBanReason("");
      setBanMfa("");
      await loadUsers();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onManualResolveDispute() {
    if (!token || !manualTargetId) {
      return;
    }
    setError(null);
    try {
      await adminManualResolveDisputeRequest(token, manualTargetId, {
        outcome: manualOutcome,
        freelancer_share_percent: manualOutcome === "split" ? manualSplitShare : undefined,
        justification: manualJustification.trim(),
      });
      setManualJustification("");
      await loadDisputes();
      await loadOverview();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  async function onRetryDeadLetter(id: number) {
    if (!token) {
      return;
    }
    setError(null);
    try {
      await adminRetryDeadLetterRequest(token, id);
      await loadDeadLetters();
      await loadOverview();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro title="Admin" subtitle="Operational controls for bounties, users, disputes, retries, and system health." />

          <Card>
            <div className="flex flex-wrap gap-2">
              <Button variant={tab === "overview" ? "primary" : "secondary"} onClick={() => setTab("overview")}>Overview</Button>
              <Button variant={tab === "bounties" ? "primary" : "secondary"} onClick={() => setTab("bounties")}>Bounties</Button>
              <Button variant={tab === "users" ? "primary" : "secondary"} onClick={() => setTab("users")}>Users</Button>
              <Button variant={tab === "disputes" ? "primary" : "secondary"} onClick={() => setTab("disputes")}>Disputes</Button>
              <Button variant={tab === "deadletters" ? "primary" : "secondary"} onClick={() => setTab("deadletters")}>Dead Letters</Button>
              <Button variant={tab === "health" ? "primary" : "secondary"} onClick={() => setTab("health")}>System Health</Button>
              <Button className="ml-auto" variant="secondary" onClick={() => void refreshByTab()}>Refresh</Button>
            </div>
          </Card>

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading admin data...</p> : null}

          {tab === "overview" ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Total Bounties</p>
                  <p className="mt-1 text-2xl font-black">{overview?.stats.total_bounties ?? 0}</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">ALGO Locked</p>
                  <p className="mt-1 text-2xl font-black">{asAlgo(overview?.stats.total_algo_locked).toFixed(3)}</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Active Disputes</p>
                  <p className="mt-1 text-2xl font-black">{overview?.stats.active_disputes ?? 0}</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Flagged Submissions</p>
                  <p className="mt-1 text-2xl font-black">{overview?.stats.flagged_submissions ?? 0}</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Sanctions Flags</p>
                  <p className="mt-1 text-2xl font-black">{overview?.stats.sanctions_flags ?? 0}</p>
                </Card>
                <Card>
                  <p className="text-xs text-[#4b4b4b]">Dead Letter Jobs</p>
                  <p className="mt-1 text-2xl font-black">{overview?.stats.dead_letter_jobs_count ?? 0}</p>
                </Card>
              </div>

              <Card>
                <h3 className="text-lg font-semibold">Consistency Counters</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {(overview?.consistency ?? []).map((item) => (
                    <div key={item.issue_type} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                      <p className="text-sm font-semibold">{item.issue_type}</p>
                      <p className="text-xl font-black">{item.issue_count}</p>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Consistency Alerts</h3>
                <div className="mt-3 space-y-2">
                  {consistencyAlerts.map((alert) => (
                    <div key={alert.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">{alert.type}</p>
                          <p className="text-xs text-[#4b4b4b]">Ref: {alert.reference}</p>
                          <p className="text-xs text-[#4b4b4b]">{new Date(alert.occurred_at).toLocaleString()}</p>
                        </div>
                        <Button className="h-8 px-3 text-xs" variant="secondary">Investigate</Button>
                      </div>
                    </div>
                  ))}
                  {consistencyAlerts.length === 0 ? <p className="text-sm text-[#4b4b4b]">No consistency alerts.</p> : null}
                </div>
              </Card>
            </div>
          ) : null}

          {tab === "bounties" ? (
            <Card>
              <div className="grid gap-2 sm:grid-cols-3">
                <Input value={bountyStatusFilter} onChange={(event) => setBountyStatusFilter(event.target.value)} placeholder="Status filter" />
                <Input value={bountyCreatorFilter} onChange={(event) => setBountyCreatorFilter(event.target.value)} placeholder="Creator wallet/email" />
                <Button variant="secondary" onClick={() => void loadBounties()}>Apply Filters</Button>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                      <th className="py-2 pr-4">Bounty</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Amount</th>
                      <th className="py-2 pr-4">Creator</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bounties.map((item) => (
                      <tr key={item.id} className="border-b border-[#ececec] align-top">
                        <td className="py-3 pr-4">
                          <p className="font-semibold">{item.title}</p>
                          <p className="text-xs text-[#4b4b4b]">{item.id.slice(0, 8)}</p>
                        </td>
                        <td className="py-3 pr-4"><Pill text={item.status} /></td>
                        <td className="py-3 pr-4">{asAlgo(item.total_amount).toFixed(4)} ALGO</td>
                        <td className="py-3 pr-4">{item.creator_wallet.slice(0, 10)}</td>
                        <td className="py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button asChild className="h-8 px-3 text-xs" variant="secondary">
                              <Link href={`/bounties/${item.id}`}>View</Link>
                            </Button>
                            <Button className="h-8 px-3 text-xs" variant="secondary" onClick={() => void runBountyAction(item.id, "force-expire")}>Force Expire</Button>
                            <Button className="h-8 px-3 text-xs" variant="secondary" onClick={() => void runBountyAction(item.id, "force-refund")}>Force Refund</Button>
                            <Button className="h-8 px-3 text-xs" variant="secondary" onClick={() => void runBountyAction(item.id, "override-scoring")}>Override Scoring</Button>
                            <Button className="h-8 px-3 text-xs" onClick={() => void runBountyAction(item.id, "cancel")}>Cancel</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {bounties.length === 0 ? <p className="mt-2 text-sm text-[#4b4b4b]">No bounties for current filter.</p> : null}
              </div>
            </Card>
          ) : null}

          {tab === "users" ? (
            <div className="space-y-4">
              <Card>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input value={usersQuery} onChange={(event) => setUsersQuery(event.target.value)} placeholder="Search wallet/email" />
                  <Select value={usersRoleFilter} onChange={(event) => setUsersRoleFilter(event.target.value)}>
                    <option value="">All roles</option>
                    <option value="client">client</option>
                    <option value="freelancer">freelancer</option>
                    <option value="arbitrator">arbitrator</option>
                    <option value="admin">admin</option>
                  </Select>
                  <Button variant="secondary" onClick={() => void loadUsers()}>Apply Filters</Button>
                </div>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Ban Wallet</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  <Input value={banWalletAddress} onChange={(event) => setBanWalletAddress(event.target.value)} placeholder="Wallet address" />
                  <Input value={banReason} onChange={(event) => setBanReason(event.target.value)} placeholder="Reason" />
                  <Input value={banMfa} onChange={(event) => setBanMfa(event.target.value)} placeholder="MFA token" />
                  <Button
                    onClick={() => void onBanWallet()}
                    disabled={banWalletAddress.trim().length < 58 || banReason.trim().length < 10 || banMfa.trim().length < 6}
                  >
                    Ban Wallet
                  </Button>
                </div>
              </Card>

              <Card>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                        <th className="py-2 pr-4">User</th>
                        <th className="py-2 pr-4">Role</th>
                        <th className="py-2 pr-4">Reputation</th>
                        <th className="py-2 pr-4">Flags</th>
                        <th className="py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((item) => (
                        <tr key={item.id} className="border-b border-[#ececec] align-top">
                          <td className="py-3 pr-4">
                            <p className="font-semibold">{item.wallet_address.slice(0, 12)}</p>
                            <p className="text-xs text-[#4b4b4b]">{item.email ?? "No email"}</p>
                          </td>
                          <td className="py-3 pr-4">
                            <Select value={item.role} onChange={(event) => void onChangeRole(item.id, event.target.value as AdminUser["role"])}>
                              <option value="client">client</option>
                              <option value="freelancer">freelancer</option>
                              <option value="arbitrator">arbitrator</option>
                              <option value="admin">admin</option>
                            </Select>
                          </td>
                          <td className="py-3 pr-4">{item.reputation_score}</td>
                          <td className="py-3 pr-4">
                            <div className="flex gap-2">
                              {item.is_banned ? <Pill text="banned" /> : null}
                              {item.is_sanctions_flagged ? <Pill text="sanctions" /> : null}
                            </div>
                          </td>
                          <td className="py-3">
                            {item.is_banned ? (
                              <Button className="h-8 px-3 text-xs" variant="secondary" onClick={() => void onRemoveBan(item.id)}>
                                Remove Ban
                              </Button>
                            ) : (
                              <span className="text-xs text-[#4b4b4b]">No direct action</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {users.length === 0 ? <p className="mt-2 text-sm text-[#4b4b4b]">No users found.</p> : null}
                </div>
              </Card>
            </div>
          ) : null}

          {tab === "disputes" ? (
            <div className="space-y-4">
              <Card>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input value={disputeStatusFilter} onChange={(event) => setDisputeStatusFilter(event.target.value)} placeholder="Filter by status" />
                  <Button variant="secondary" onClick={() => void loadDisputes()}>Apply Filter</Button>
                </div>
              </Card>

              <Card>
                <h3 className="text-lg font-semibold">Manual Resolve</h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  <Select value={manualTargetId} onChange={(event) => setManualTargetId(event.target.value)}>
                    <option value="">Select dispute</option>
                    {disputes.map((item) => (
                      <option key={item.id} value={item.id}>{item.id.slice(0, 8)} | {item.status}</option>
                    ))}
                  </Select>
                  <Select value={manualOutcome} onChange={(event) => setManualOutcome(event.target.value as "freelancer_wins" | "client_wins" | "split")}>
                    <option value="freelancer_wins">freelancer_wins</option>
                    <option value="client_wins">client_wins</option>
                    <option value="split">split</option>
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={manualSplitShare}
                    onChange={(event) => setManualSplitShare(Number(event.target.value))}
                    placeholder="Split %"
                    disabled={manualOutcome !== "split"}
                  />
                  <Button
                    onClick={() => void onManualResolveDispute()}
                    disabled={!manualTargetId || manualJustification.trim().length < 10}
                  >
                    Manual Resolve
                  </Button>
                </div>
                <Textarea
                  className="mt-2"
                  rows={3}
                  value={manualJustification}
                  onChange={(event) => setManualJustification(event.target.value)}
                  placeholder="Justification (min 10 chars)"
                />
              </Card>

              <Card>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                        <th className="py-2 pr-4">Dispute</th>
                        <th className="py-2 pr-4">Bounty</th>
                        <th className="py-2 pr-4">Type</th>
                        <th className="py-2 pr-4">Status</th>
                        <th className="py-2 pr-4">SLA</th>
                        <th className="py-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {disputes.map((item) => (
                        <tr key={item.id} className="border-b border-[#ececec]">
                          <td className="py-3 pr-4">{item.id.slice(0, 8)}</td>
                          <td className="py-3 pr-4">{item.bounty_title}</td>
                          <td className="py-3 pr-4">{item.dispute_type}</td>
                          <td className="py-3 pr-4"><Pill text={item.status} /></td>
                          <td className="py-3 pr-4">
                            {item.sla_days > 3 ? <Pill text={`SLA Breached — ${item.sla_days} days old`} /> : <span>{item.sla_days} days</span>}
                          </td>
                          <td className="py-3">
                            <Button className="h-8 px-3 text-xs" variant="secondary" onClick={() => setManualTargetId(item.id)}>
                              Manual Resolve
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {disputes.length === 0 ? <p className="mt-2 text-sm text-[#4b4b4b]">No disputes found.</p> : null}
                </div>
              </Card>
            </div>
          ) : null}

          {tab === "deadletters" ? (
            <Card>
              <div className="space-y-2">
                {deadLetters.map((item) => (
                  <div key={item.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">#{item.id} {item.event_name}</p>
                        <p className="text-xs text-[#4b4b4b]">{item.error}</p>
                        <p className="text-xs text-[#4b4b4b]">{new Date(item.failed_at).toLocaleString()}</p>
                      </div>
                      <Button className="h-8 px-3 text-xs" onClick={() => void onRetryDeadLetter(item.id)}>
                        Retry
                      </Button>
                    </div>
                    {typeof item.payload !== "undefined" ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-semibold">View payload</summary>
                        <pre className="mt-2 max-h-[220px] overflow-auto rounded-xl border border-[#121212] bg-white p-2 text-xs">
                          {JSON.stringify(item.payload, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ))}
                {deadLetters.length === 0 ? <p className="text-sm text-[#4b4b4b]">No dead-letter jobs.</p> : null}
              </div>
            </Card>
          ) : null}

          {tab === "health" ? (
            <div className="space-y-4">
              <Card>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold">System Health</h3>
                  <Pill text={healthBadge} />
                </div>
                <p className="mt-2 text-xs text-[#4b4b4b]">Auto-refreshes every 30 seconds while this tab is active.</p>
                {health?.status === "degraded" || health?.status === "down" ? (
                  <p className="mt-3 border border-[#be8b00] bg-[#fff4d6] p-2 text-sm text-[#7a5a00]">
                    System is currently {health.status}. Investigate service cards below.
                  </p>
                ) : null}
              </Card>
              <div className="grid gap-3 md:grid-cols-3">
                {Object.entries(health?.services ?? {}).map(([service, serviceState]) => (
                  <Card key={service}>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{
                          backgroundColor:
                            serviceState === "ok" ? "#0f7b44" : serviceState === "rate_limited" ? "#be8b00" : "#b42318",
                        }}
                      />
                      <p className="text-xs text-[#4b4b4b]">{service}</p>
                    </div>
                    <p className="mt-1 text-2xl font-black uppercase">{serviceState}</p>
                    <p className="mt-2 text-xs text-[#4b4b4b]">Last checked: {healthCheckedAt ? new Date(healthCheckedAt).toLocaleTimeString() : "n/a"}</p>
                    <p className="text-xs text-[#4b4b4b]">Latency: {healthLatencyMs ?? "n/a"} ms</p>
                  </Card>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </AppShell>
    </Protected>
  );
}
