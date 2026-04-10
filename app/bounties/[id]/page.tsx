"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card } from "../../../components/ui/primitives";

export default function BountyDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const bountyId = params.id;

  useEffect(() => {
    if (!bountyId) {
      return;
    }
    router.replace(`/dashboard/projects/${bountyId}`);
  }, [bountyId, router]);

  return (
    <section className="space-y-4">
      <Card>
        <p className="text-sm text-[#4b4b4b]">Redirecting to the project workspace...</p>
        {bountyId ? (
          <Link className="mt-2 inline-block text-xs underline" href={`/dashboard/projects/${bountyId}`}>
            Open Workspace
          </Link>
        ) : null}
      </Card>
    </section>
  );
}