import "../lib/load-env";
import { withTransaction } from "../lib/db/client";

function getEmailArg() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith("--email=")) {
      return arg.slice("--email=".length).trim();
    }
  }

  const first = args[0]?.trim();
  return first ?? "";
}

async function main() {
  const email = getEmailArg().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Usage: npm run db:delete-user -- --email=user@example.com");
  }

  const result = await withTransaction(async (client) => {
    const userRes = await client.query<{ id: string; email: string | null }>(
      `SELECT id, email FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email],
    );

    if (userRes.rowCount === 0) {
      return {
        found: false,
        email,
      };
    }

    const userId = userRes.rows[0].id;

    const apply = async (label: string, sql: string, params: unknown[]) => {
      const res = await client.query(sql, params);
      return {
        label,
        count: res.rowCount ?? 0,
      };
    };

    const operations = await Promise.all([
      apply(
        "updated_submissions_approved_for_payout_by",
        `UPDATE submissions SET approved_for_payout_by = NULL WHERE approved_for_payout_by = $1`,
        [userId],
      ),
      apply(
        "deleted_dispute_votes",
        `DELETE FROM dispute_votes WHERE arbitrator_id = $1 OR challenged_by = $1`,
        [userId],
      ),
      apply("deleted_disputes", `DELETE FROM disputes WHERE raised_by = $1`, [userId]),
      apply("deleted_banned_wallets", `DELETE FROM banned_wallets WHERE banned_by = $1`, [userId]),
      apply("deleted_notifications", `DELETE FROM notifications WHERE user_id = $1`, [userId]),
      apply("deleted_payouts", `DELETE FROM payouts WHERE freelancer_id = $1`, [userId]),
      apply("deleted_submissions", `DELETE FROM submissions WHERE freelancer_id = $1`, [userId]),
      apply("deleted_bounties", `DELETE FROM bounties WHERE creator_id = $1`, [userId]),
      apply("deleted_auth_sessions", `DELETE FROM auth_sessions WHERE user_id = $1`, [userId]),
    ]);

    const deletedUser = await apply("deleted_users", `DELETE FROM users WHERE id = $1`, [userId]);

    return {
      found: true,
      userId,
      email,
      operations,
      deletedUsers: deletedUser.count,
    };
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : "Unknown error";
  console.error(`Failed to delete user: ${detail}`);
  process.exit(1);
});
