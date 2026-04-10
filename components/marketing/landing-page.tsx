import { MarketingCta, MarketingFaq, MarketingFooter, MarketingPricing } from "./conversion-sections";
import { MarketingBenefits, MarketingFeatures, MarketingHero, MarketingHowItWorks, MarketingStatsBar } from "./hero-and-core";
import { MarketingNav } from "./nav";

export function MarketingLandingPage() {
  return (
    <>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700;900&display=swap');"}</style>
      <MarketingNav />
      <MarketingHero />
      <MarketingStatsBar />
      <MarketingFeatures />
      <MarketingHowItWorks />
      <MarketingBenefits />
      <MarketingPricing />
      <MarketingFaq />
      <MarketingCta />
      <MarketingFooter />
    </>
  );
}
