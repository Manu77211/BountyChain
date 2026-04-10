import { ReactNode } from "react";
import { MarketingCta, MarketingFooter } from "./conversion-sections";
import { MarketingNav } from "./nav";
import { MARKETING_COLORS as C } from "./theme";

export function MarketingPageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700;900&display=swap');"}</style>
      <MarketingNav />
      <section
        style={{
          backgroundColor: C.bg,
          borderBottom: `4px solid ${C.black}`,
          fontFamily: "'Outfit', sans-serif",
        }}
        className="py-16 md:py-20"
      >
        <div className="mx-auto max-w-7xl px-5 md:px-12">
          <p className="text-xs font-black uppercase tracking-widest" style={{ color: C.blue }}>
            BountyEscrow AI
          </p>
          <h1 className="mt-3 text-5xl font-black uppercase tracking-tight text-[#121212]">{title}</h1>
          <p className="mt-4 max-w-3xl text-base font-medium text-[#3f3f3f]">{subtitle}</p>
        </div>
      </section>
      {children}
      <MarketingCta />
      <MarketingFooter />
    </>
  );
}
