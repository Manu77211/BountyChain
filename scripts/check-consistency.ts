import { dbPool } from "../lib/db/client";
import { findEscrowConsistencyIssues } from "../lib/db/queries";

async function main() {
  const issues = await findEscrowConsistencyIssues();
  if (issues.length === 0) {
    console.log("DB-004: No escrow consistency issues found.");
    await dbPool.end();
    return;
  }

  console.error("DB-004: Escrow consistency issues detected.");
  console.error(JSON.stringify(issues, null, 2));
  await dbPool.end();
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
