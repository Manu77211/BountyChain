import Link from "next/link";
import { Button, Card, PageIntro } from "../../../../components/ui/primitives";

export default function WalletAddFundsPage() {
  return (
    <section className="space-y-6">
      <PageIntro title="Add Funds" subtitle="Top up client wallet to fund escrow-backed milestones." />
      <Card>
        <p className="text-sm text-[#4b4b4b]">Funding gateway is being integrated. Use this as the wallet funding entry point.</p>
        <Button asChild variant="secondary" className="mt-4">
          <Link href="/dashboard/wallet">Back to Wallet</Link>
        </Button>
      </Card>
    </section>
  );
}
