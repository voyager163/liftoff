import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/database.ts";
import { databaseProbe } from "../src/health.ts";
import { testApp, testDatabase } from "./support.ts";

let db: Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await testDatabase()));
afterAll(() => close());

describe("health", () => {
  it("is live without touching dependencies", async () => {
    const app = await testApp(db, { probe: () => Promise.reject(new Error("down")) });
    const response = await app.inject({ url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("is ready when the database answers", async () => {
    const app = await testApp(db);
    const response = await app.inject({ url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", checks: { database: "ok" } });
    await app.close();
  });

  it("is not ready when the database is unavailable", async () => {
    const app = await testApp(db, { probe: () => Promise.reject(new Error("down")) });
    const response = await app.inject({ url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not-ready", checks: { database: "unavailable" } });
    await app.close();
  });
});

describe("the database probe", () => {
  // Accepts connections and reads what it is sent, but never answers, like a
  // database that was paused.
  let frozen: Server;
  let port: number;
  beforeAll(async () => {
    frozen = createServer((socket) => socket.resume());
    await new Promise<void>((resolve) => frozen.listen(0, "127.0.0.1", resolve));
    port = (frozen.address() as { port: number }).port;
  });
  afterAll(() => new Promise((resolve) => frozen.close(resolve)));

  it("gives up on a database that stopped answering and closes its connection", async () => {
    const probe = databaseProbe(`postgresql://app:unused@127.0.0.1:${port}/app`, 1);
    const started = Date.now();
    await expect(probe()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    const open = () =>
      new Promise<number>((resolve, reject) =>
        frozen.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      );
    await vi.waitFor(async () => expect(await open()).toBe(0));
  });
});
