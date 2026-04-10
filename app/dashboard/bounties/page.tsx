"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { listBountiesRequest, listMyBountiesRequest } from "../../../lib/api";
import { useRealtimeChannel } from "../../../lib/realtime-client";
import { useAuthStore } from "../../../store/auth-store";
import { Button, Card, PageIntro, Pill } from "../../../components/ui/primitives";

type BountyListItem = {
	id: string;
	creator_id?: string;
	title: string;
	status: string;
	total_amount: string;
	scoring_mode: string;
	deadline: string;
};

export default function DashboardBountiesPage() {
	const { token, user, hydrate } = useAuthStore();
	const isClient = String(user?.role ?? "").toUpperCase() === "CLIENT";
	const isFreelancer = String(user?.role ?? "").toUpperCase() === "FREELANCER";
	const [bounties, setBounties] = useState<BountyListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

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
			const response = isClient
				? (await listMyBountiesRequest(token, { limit: 50 })) as { data?: BountyListItem[] }
				: (await listBountiesRequest({ status: "open", limit: 50 })) as { data?: BountyListItem[] };
			setBounties(response.data ?? []);
		} catch (requestError) {
			setError((requestError as Error).message);
		} finally {
			setLoading(false);
		}
	}, [isClient, token]);

	useEffect(() => {
		void loadBounties();
	}, [loadBounties]);

	useRealtimeChannel({
		token,
		onEvent: () => {
			void loadBounties();
		},
	});

	return (
		<section className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<PageIntro
					title="Bounties"
					subtitle="Browse active bounties and open details for realtime CI, scoring, payout, and disputes."
				/>
				{isClient ? (
					<Button asChild>
						<Link href="/bounties/create">Create Bounty</Link>
					</Button>
				) : null}
			</div>

			{error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
			{loading ? <p className="text-sm text-[#4b4b4b]">Loading bounties...</p> : null}

			<div className="grid gap-4 lg:grid-cols-2">
				{bounties.map((bounty) => (
					<Card key={bounty.id}>
						<div className="flex items-start justify-between gap-2">
							<div>
								<p className="text-lg font-semibold">{bounty.title}</p>
								<p className="text-xs text-[#4b4b4b]">Amount {bounty.total_amount} microALGO | {bounty.scoring_mode}</p>
								<p className="text-xs text-[#4b4b4b]">Deadline {new Date(bounty.deadline).toLocaleString()}</p>
							</div>
							<Pill text={bounty.status} />
						</div>
						<div className="mt-4 flex gap-2">
							<Button asChild variant="secondary">
								<Link href={`/bounties/${bounty.id}`}>View Details</Link>
							</Button>
							{isFreelancer ? (
								<Button asChild>
									<Link href={`/bounties/${bounty.id}`}>Apply for Bounty</Link>
								</Button>
							) : null}
						</div>
					</Card>
				))}
			</div>

			{!loading && bounties.length === 0 ? (
				<Card>
					<p className="text-sm text-[#4b4b4b]">No bounties found yet.</p>
				</Card>
			) : null}
		</section>
	);
}
