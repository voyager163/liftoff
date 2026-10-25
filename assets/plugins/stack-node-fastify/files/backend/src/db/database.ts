// Database access through Drizzle ORM.
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.ts";

/** The committed migrations, applied by `npm run migrate`. */
export const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Any Drizzle PostgreSQL database with this schema: node-postgres in production, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Connection {
  readonly db: NodePgDatabase<typeof schema>;
  close(): Promise<void>;
}

/**
 * A connection pool for the API. Connections are opened on first use. When
 * an idle connection fails, for example because the database restarted, the
 * pool drops it and opens a new one when next needed; the error goes to
 * `onIdleError`, because an unhandled pool error would stop the process.
 */
export function connect(
  url: string,
  timeoutSeconds: number,
  onIdleError: (error: Error) => void,
): Connection {
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: timeoutSeconds * 1000,
  });
  pool.on("error", onIdleError);
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
