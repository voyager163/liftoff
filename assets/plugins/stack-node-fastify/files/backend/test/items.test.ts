import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.ts";
import { testApp, testDatabase } from "./support.ts";

let db: Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await testDatabase()));
afterAll(() => close());

describe("items", () => {
  it("creates and lists items", async () => {
    const app = await testApp(db);
    const created = await app.inject({ method: "POST", url: "/items", payload: { name: "first" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 1, name: "first" });
    expect(Date.parse(created.json().created_at)).not.toBeNaN();

    const listed = await app.inject({ url: "/items" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((item: { name: string }) => item.name)).toEqual(["first"]);
    await app.close();
  });

  it.each([{}, { name: "" }, { name: "x".repeat(201) }])("rejects %j", async (payload) => {
    const app = await testApp(db);
    const response = await app.inject({ method: "POST", url: "/items", payload });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
