"use client";

import { useCallback, useEffect, useState } from "react";
import { listProfileActivitiesRequest } from "../../../lib/api";
import { useAuthStore } from "../../../store/auth-store";
import { Button, Card, PageIntro } from "../../../components/ui/primitives";

type ActivityType = "bounties" | "submissions" | "payouts" | "disputes";

type NotificationItem = {
  id: string;
  title?: string;
  bounty_title?: string;
  status?: string;
  created_at?: string;
  raised_at?: string;
};

export default function DashboardNotificationsPage() {
  const { token, hydrate } = useAuthStore();
  const [tab, setTab] = useState<ActivityType>("bounties");
  const [items, setItems] = useState<NotificationItem[]>([]);
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
      const response = (await listProfileActivitiesRequest(token, {
        type: tab,
        page: 1,
        page_size: 30,
      })) as { data?: NotificationItem[] };
      setItems(response.data ?? []);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab, token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-6">
      <PageIntro title="Notifications" subtitle="Platform events, submissions, and payout updates." />

      <Card>
        <div className="flex flex-wrap gap-2">
          <Button variant={tab === "bounties" ? "primary" : "secondary"} onClick={() => setTab("bounties")}>Bounties</Button>
          <Button variant={tab === "submissions" ? "primary" : "secondary"} onClick={() => setTab("submissions")}>Submissions</Button>
          <Button variant={tab === "payouts" ? "primary" : "secondary"} onClick={() => setTab("payouts")}>Payouts</Button>
          <Button variant={tab === "disputes" ? "primary" : "secondary"} onClick={() => setTab("disputes")}>Disputes</Button>
          <Button className="ml-auto" variant="secondary" onClick={() => void load()}>Refresh</Button>
        </div>
      </Card>

      <Card>
        {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
        {loading ? <p className="text-sm text-[#4b4b4b]">Loading notifications...</p> : null}

        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-xl border border-[#121212] bg-[#f5f5f5] p-3">
              <p className="text-sm font-semibold">{String(item.title ?? item.bounty_title ?? item.id)}</p>
              <p className="text-xs text-[#4b4b4b]">Status: {String(item.status ?? "n/a")}</p>
              <p className="text-xs text-[#4b4b4b]">{new Date(String(item.created_at ?? item.raised_at ?? Date.now())).toLocaleString()}</p>
            </div>
          ))}
        </div>

        {!loading && items.length === 0 ? (
          <p className="text-sm text-[#4b4b4b]">No notifications found for this category.</p>
        ) : null}
      </Card>
    </section>
  );
}
