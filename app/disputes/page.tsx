"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listDisputesRequest } from "../../lib/api";
import { AppShell } from "../../src/components/layout/AppShell";
import { Protected } from "../../components/protected";
import { Button, Card, Input, PageIntro, Pill } from "../../components/ui/primitives";
import { useAuthStore } from "../../store/auth-store";

export const dynamic = "force-dynamic";

type DisputeListItem = {
  id: string;
  bounty_title: string;
  dispute_type: string;
  status: string;
  raised_at: string;
  your_role: "client" | "freelancer" | "arbitrator" | "observer";
  pending_vote: boolean;
  votes_in: number;
  total_votes: number;
};

type Scope = "my" | "arbitrator";

export default function DisputesPage() {
  const { token, user, hydrate } = useAuthStore();
  const [scope, setScope] = useState<Scope>("my");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<DisputeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const isArbitrator = useMemo(() => {
    const role = String(user?.role ?? "").toLowerCase();
    return role === "arbitrator" || role === "admin";
  }, [user?.role]);

  const load = useCallback(async () => {
    if (!token) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = (await listDisputesRequest(token, {
        scope,
        status: status.trim() || undefined,
        limit: 50,
      })) as { data?: DisputeListItem[] };

      setItems(response.data ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scope, status, token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Protected>
      <AppShell>
        <section className="space-y-6">
          <PageIntro title="Disputes" subtitle="Track dispute status, outstanding votes, and direct actions by role." />

          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant={scope === "my" ? "primary" : "secondary"} onClick={() => setScope("my")}>
                My Disputes
              </Button>
              <Button
                variant={scope === "arbitrator" ? "primary" : "secondary"}
                onClick={() => setScope("arbitrator")}
                disabled={!isArbitrator}
              >
                As Arbitrator
              </Button>
              <div className="ml-auto flex w-full gap-2 sm:w-auto">
                <Input
                  className="sm:w-[220px]"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  placeholder="Filter by status"
                />
                <Button variant="secondary" onClick={() => void load()}>Refresh</Button>
              </div>
            </div>
            {!isArbitrator && scope === "arbitrator" ? (
              <p className="mt-3 text-sm text-[#8f1515]">Arbitrator tab is available only to arbitrator/admin roles.</p>
            ) : null}
          </Card>

          {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
          {loading ? <p className="text-sm text-[#4b4b4b]">Loading disputes...</p> : null}

          <Card>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[#d8d8d8] text-xs uppercase tracking-wide text-[#4b4b4b]">
                    <th className="py-2 pr-4">Dispute ID</th>
                    <th className="py-2 pr-4">Bounty</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Role</th>
                    <th className="py-2 pr-4">Votes</th>
                    <th className="py-2 pr-4">Raised</th>
                    <th className="py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-[#ececec] align-top">
                      <td className="py-3 pr-4 font-semibold">#{item.id.slice(0, 8)}</td>
                      <td className="py-3 pr-4">
                        <p className="font-semibold text-[#121212]">{item.bounty_title}</p>
                      </td>
                      <td className="py-3 pr-4">{item.dispute_type}</td>
                      <td className="py-3 pr-4"><Pill text={item.status} /></td>
                      <td className="py-3 pr-4">{item.your_role}</td>
                      <td className="py-3 pr-4">{item.votes_in}/{item.total_votes}</td>
                      <td className="py-3 pr-4">{new Date(item.raised_at).toLocaleString()}</td>
                      <td className="py-3">
                        <Button asChild variant={item.pending_vote ? "primary" : "secondary"} className="h-8 px-3 text-xs">
                          <Link href={`/disputes/${item.id}`}>{item.pending_vote ? "Vote" : "View"}</Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!loading && items.length === 0 ? (
              <p className="mt-3 text-sm text-[#4b4b4b]">No disputes found for this filter scope.</p>
            ) : null}
          </Card>
        </section>
      </AppShell>
    </Protected>
  );
}
