// Tests against a real PostgreSQL database.
//
// Run them with: APP_DATABASE_URL=... npm run test:integration
// They fail, rather than skip, when no database is configured. Each run works
// in a new schema that is dropped afterwards, so the tables and data already
// in that database are never touched.
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/db/database.ts";
import * as schema from "../../src/db/schema.ts";
import { databaseProbe } from "../../src/health.ts";
import { testApp } from "../support.ts";

const url = process.env.APP_DATABASE_URL ?? "";
const schemaName = `test_${randomUUID().replaceAll("-", "")}`;
let pool: pg.Pool;

beforeAll(async () => {
  if (!url.startsWith("postgresql")) {
    throw new Error("integration tests need APP_DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  await admin.end();
  // Every connection sees only the new schema.
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schemaName}` });
});

afterAll(async () => {
  await pool?.end();
  if (!url.startsWith("postgresql")) return;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await admin.end();
});

describe("against PostgreSQL", () => {
  it("applies the migrations and serves the API", async () => {
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS, migrationsSchema: schemaName });
    const app = await testApp(db, { probe: databaseProbe(url, 2) });
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/items",
      payload: { name: "from integration" },
    });
    expect(created.statusCode).toBe(201);
    await app.close();
  });
});
