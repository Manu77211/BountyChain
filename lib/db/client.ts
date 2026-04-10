import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;

export const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
    })
  : null;

function assertDbPool() {
  if (!dbPool) {
    throw new Error("Database unavailable: DATABASE_URL is not configured.");
  }
  return dbPool;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : "";
}

function isReadOnlyQuery(text: string) {
  return /^\s*select\b/i.test(text);
}

function isTransientConnectionError(error: unknown) {
  const message = getErrorMessage(error);
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "").toUpperCase()
    : "";

  return (
    message.includes("connection terminated due to connection timeout") ||
    message.includes("connection timeout") ||
    message.includes("terminating connection") ||
    message.includes("connection reset") ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET"
  );
}

export async function dbQuery<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const pool = assertDbPool();

  try {
    return await pool.query<T>(text, params);
  } catch (error) {
    if (!isReadOnlyQuery(text) || !isTransientConnectionError(error)) {
      throw error;
    }

    return pool.query<T>(text, params);
  }
}

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await assertDbPool().connect();
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
