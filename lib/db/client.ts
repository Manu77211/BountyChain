import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Neon PostgreSQL connectivity.");
}

export const dbPool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

dbPool.on("connect", (client) => {
  void client.query("SET TIME ZONE 'UTC'");
});

export async function dbQuery<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return dbPool.query<T>(text, params);
}

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
