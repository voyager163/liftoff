// Shared test helpers: an in-process PostgreSQL, so unit tests need no server.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { type Database, MIGRATIONS } from "../src/db/database.ts";
import * as schema from "../src/db/schema.ts";
import type { DatabaseProbe } from "../src/health.ts";

/** node-postgres accepts both URL schemes. */
export const isPostgresUrl = (url: string): boolean => /^postgres(ql)?:\/\//.test(url);

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  ...loadConfig({}),
  logLevel: "fatal",
  ...overrides,
});

/** A migrated, empty database that lives only in this process. */
export async function testDatabase(): Promise<{ db: Database; close(): Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => client.close() };
}

export async function testApp(
  db: Database,
  options: { config?: Partial<Config>; probe?: DatabaseProbe } = {},
): Promise<FastifyInstance> {
  return buildApp({
    config: testConfig(options.config),
    db,
    probe: options.probe ?? (async () => undefined),
  });
}
