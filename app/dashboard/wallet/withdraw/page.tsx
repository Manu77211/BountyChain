import Link from "next/link";
import { Button, Card, PageIntro } from "../../../../components/ui/primitives";

export default function WalletWithdrawPage() {
  return (
    <section className="space-y-6">
      <PageIntro title="Withdraw" subtitle="Move released earnings from wallet to your connected account." />
      <Card>
        <p className="text-sm text-[#4b4b4b]">Withdrawal flow is being integrated. This route is now fully mapped from wallet actions.</p>
        <Button asChild variant="secondary" className="mt-4">
          <Link href="/dashboard/wallet">Back to Wallet</Link>
        </Button>
      </Card>
    </section>
  );
}
