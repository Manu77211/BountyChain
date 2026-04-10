import { connection } from "next/server";
import CreateBountyClientPage from "./create-bounty-client";

export default async function CreateBountyPage() {
  await connection();
  return <CreateBountyClientPage />;
}
