import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.ts";
import { testApp, testDatabase } from "./support.ts";

let db: Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await testDatabase()));
afterAll(() => close());

describe("API documentation", () => {
  it("serves OpenAPI and the Scalar reference", async () => {
    const app = await testApp(db);
    const openapi = await app.inject({ url: "/openapi.json" });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().openapi).toBe("3.1.0");
    expect(Object.keys(openapi.json().paths)).toEqual(
      expect.arrayContaining(["/health/live", "/health/ready", "/items"]),
    );
    const docs = await app.inject({ url: "/docs/" });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  it("can be turned off", async () => {
    const app = await testApp(db, { config: { docsEnabled: false } });
    expect((await app.inject({ url: "/openapi.json" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/docs/" })).statusCode).toBe(404);
    await app.close();
  });
});
