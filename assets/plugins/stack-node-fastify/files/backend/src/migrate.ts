// Applies the migrations in drizzle/ to the configured database: node src/migrate.ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { type Config, loadConfig } from "./config.ts";
import { connect, MIGRATIONS } from "./db/database.ts";

export async function runMigrations(config: Config): Promise<void> {
  const { db, close } = connect(config.databaseUrl, config.databaseTimeoutSeconds);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS });
  } finally {
    await close();
  }
}

if (import.meta.main) await runMigrations(loadConfig());
