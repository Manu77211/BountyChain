import { MarketingFaq } from "../../components/marketing/conversion-sections";
import { MarketingPageShell } from "../../components/marketing/page-shell";

export default function FaqPage() {
  return (
    <MarketingPageShell
      title="FAQ"
      subtitle="Answers for escrow flow, validation process, payout rules, and collaboration policies."
    >
      <MarketingFaq />
    </MarketingPageShell>
  );
}
