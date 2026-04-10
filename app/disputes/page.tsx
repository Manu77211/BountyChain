import { connection } from "next/server";
import DisputesClientPage from "./disputes-client";

export default async function DisputesPage() {
  await connection();
  return <DisputesClientPage />;
}
