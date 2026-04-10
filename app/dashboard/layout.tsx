import { AppShell } from "../../src/components/layout/AppShell";
import { connection } from "next/server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return <AppShell>{children}</AppShell>;
}

