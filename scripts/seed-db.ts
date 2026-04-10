import "../lib/load-env";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dbPool } from "../lib/db/client";

const SEED_PATH = path.resolve(process.cwd(), "db", "seeds", "0001_seed.sql");

export async function seedDatabase() {
  if (!dbPool) {
    throw new Error("DATABASE_URL is required to seed the database.");
  }

  const sql = await readFile(SEED_PATH, "utf8");
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  await seedDatabase();
  if (dbPool) {
    await dbPool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
