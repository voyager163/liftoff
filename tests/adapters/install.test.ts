import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalInstall, windowsStart, withPathFirst } from "../../src/adapters/install.ts";

let work: string;
let server: Server;
let base: string;
beforeAll(async () => {
  work = realpathSync.native(mkdtempSync(path.join(tmpdir(), "liftoff-install-")));
  server = createServer((request, response) => {
    if (request.url === "/missing") {
      response.writeHead(404).end();
    } else if (request.url === "/broken") {
      response.writeHead(500).end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agent: request.headers["user-agent"] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

describe("UPGRADE-001 the running copy and the channels' tools", () => {
  it("finds the running package and executable, with links followed", async () => {
    const install = new LocalInstall();
    const { app, executable } = await install.running();
    expect(await install.exists(path.join(app, "package.json"))).toBe(true);
    expect(executable).toBe(realpathSync.native(process.execPath));
    expect(install.platform).toBe(process.platform === "win32" ? "win32" : "darwin");
  });

  it("reads files and paths, and says when they are not there", async () => {
    const install = new LocalInstall();
    const file = path.join(work, "release.json");
    writeFileSync(file, "{}");
    expect(await install.readText(file)).toBe("{}");
    expect(await install.readText(path.join(work, "missing"))).toBeUndefined();
    expect(await install.realPath(file)).toBe(file);
    expect(await install.realPath(path.join(work, "missing"))).toBeUndefined();
    expect(await install.exists(path.join(work, "missing"))).toBe(false);
  });

  it("runs a query with PATH extended, and gives nothing for a program that cannot start", async () => {
    const install = new LocalInstall();
    const result = await install.query(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PATH ?? process.env.Path ?? '')"],
      [work],
    );
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout.startsWith(`${work}${path.delimiter}`)).toBe(true);
    expect(await install.query(path.join(work, "no-such-program"), [])).toBeUndefined();
  });

  it("puts entries first on PATH whatever the variable's case", () => {
    expect(withPathFirst({ Path: "b" }, ["a"])).toEqual({ Path: `a${path.delimiter}b` });
    expect(withPathFirst({}, ["a"])).toEqual({ PATH: "a" });
    const env = { PATH: "b" };
    expect(withPathFirst(env, undefined)).toBe(env);
  });
});

describe("UPGRADE-002 the latest release is read without credentials", () => {
  it("reads JSON, gives undefined for 404, and fails on anything else", async () => {
    const install = new LocalInstall();
    expect(await install.fetchJson(`${base}/latest`)).toEqual({ agent: "liftoff-cli" });
    expect(await install.fetchJson(`${base}/missing`)).toBeUndefined();
    await expect(install.fetchJson(`${base}/broken`)).rejects.toThrow("answered 500");
  });
});

describe("UPGRADE-003 a channel's upgrade runs as the channel's own program", () => {
  it("is stopped, with what it started, when Liftoff is stopped", async () => {
    const controller = new AbortController();
    const install = new LocalInstall({ signal: controller.signal });
    const running = install.delegate(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    setTimeout(() => controller.abort(), 200);
    expect(await running).not.toBe(0);
    expect(await install.query(process.execPath, ["-e", "1"])).toBeUndefined();
  });

  it("returns its exit code, or null when it cannot start", async () => {
    const install = new LocalInstall();
    expect(await install.delegate(process.execPath, ["-e", "process.exit(3)"], [work])).toBe(3);
    expect(await install.delegate(path.join(work, "no-such-program"), [])).toBeNull();
  });
});

describe("UPGRADE-004 WinGet's upgrade is handed over", () => {
  it("starts WinGet in a window of its own through cmd.exe's start", () => {
    const winget = "C:\\Users\\r\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
    expect(
      windowsStart(winget, ["upgrade", "--id", "voyager163.liftoff"], { SystemRoot: "D:\\Win" }),
    ).toEqual({
      command: "D:\\Win\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `"start "Liftoff upgrade" "${winget}" upgrade --id voyager163.liftoff"`,
      ],
    });
    expect(() => windowsStart(winget, ["a b"], {})).toThrow("in its own window");
    expect(() => windowsStart("C:\\%x%\\winget.exe", [], {})).toThrow("in its own window");
  });

  it("starts the program on its own and does not wait for it", async () => {
    const install = new LocalInstall();
    const marker = path.join(work, "handed-off");
    await install.handOff(process.execPath, [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
    ]);
    await expect(install.handOff(path.join(work, "no-such-program"), [])).rejects.toThrow(
      "could not start",
    );
    await expect.poll(() => install.exists(marker), { timeout: 10_000 }).toBe(true);
  });
});
