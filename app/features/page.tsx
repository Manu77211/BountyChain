import { MarketingFeatures } from "../../components/marketing/hero-and-core";
import { MarketingPageShell } from "../../components/marketing/page-shell";

export default function FeaturesPage() {
  return (
    <MarketingPageShell
      title="Features"
      subtitle="Explore Algorand escrow automation, GitHub CI/CD validation, GROQ hybrid scoring, sanctions checks, and dispute arbitration."
    >
      <MarketingFeatures />
    </MarketingPageShell>
  );
}
