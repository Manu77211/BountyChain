import { Card, PageIntro } from "../../../components/ui/primitives";

export default function DashboardNotificationsPage() {
  return (
    <section className="space-y-6">
      <PageIntro title="Notifications" subtitle="Platform events, submissions, and payout updates." />
      <Card>
        <p className="text-sm text-[#4b4b4b]">No new notifications yet. Activity will appear here.</p>
      </Card>
    </section>
  );
}
