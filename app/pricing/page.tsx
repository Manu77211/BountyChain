import { MarketingPricing } from "../../components/marketing/conversion-sections";
import { MarketingPageShell } from "../../components/marketing/page-shell";

export default function PricingPage() {
  return (
    <MarketingPageShell
      title="Pricing"
      subtitle="Transparent platform pricing for clients and teams running validation-gated bounty escrow."
    >
      <MarketingPricing />
    </MarketingPageShell>
  );
}
