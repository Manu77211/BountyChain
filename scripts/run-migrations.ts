import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { dbPool } from "../lib/db/client";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");

export async function runMigrations() {
  const files = await listMigrationFiles();
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGSERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const appliedSet = new Set(applied.rows.map((item) => item.filename));

    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = await readFile(filePath, "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    const detail = error instanceof Error ? error.message : "Unknown migration error";
    throw new Error(`DB-003: Migration rollback on failure (${detail})`);
  } finally {
    client.release();
  }
}

async function listMigrationFiles() {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((file) => file.endsWith(".sql")).sort();
}

async function main() {
  await runMigrations();
  await dbPool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
