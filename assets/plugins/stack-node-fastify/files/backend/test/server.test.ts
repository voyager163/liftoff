import { describe, expect, it } from "vitest";
import { start } from "../src/server.ts";
import { testConfig } from "./support.ts";

describe("the server", () => {
  it("listens on the configured host and port, and closes cleanly", async () => {
    // Port 0 asks the system for a free port. No database is needed to start.
    const app = await start(testConfig({ port: 0 }));
    const address = app.server.address() as { address: string; port: number };
    expect(address.address).toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address.port}/health/live`);
    expect(response.status).toBe(200);
    await app.close();
  });
});
