import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializerEnv, LocalInitializer } from "../../src/adapters/initializer.ts";

let work: string;
let home: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-initializer-test-"));
  home = mkdtempSync(path.join(tmpdir(), "liftoff-initializer-home-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const ENV_KEYS = [
  "CI",
  "DO_NOT_TRACK",
  "OPENSPEC_TELEMETRY",
  "HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];
const node = (script: string) => ({ command: process.execPath, args: ["-e", script] });
const limit = { timeoutMs: 60_000 };

describe("PROJ-020 initializers run apart from the user's configuration", () => {
  it("gives them a scratch home, telemetry off, and the user's settings and caches to read", () => {
    const user = path.join("/users", "ada");
    const present = new Set([path.join(user, ".npmrc"), path.join(user, ".gitconfig")]);
    const env = initializerEnv(
      { PATH: "/bin", DO_NOT_TRACK: "0" },
      "/scratch",
      user,
      "darwin",
      (file) => present.has(file),
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      CI: "1",
      DO_NOT_TRACK: "1",
      OPENSPEC_TELEMETRY: "0",
      npm_config_update_notifier: "false",
      HOME: path.join("/scratch", "home"),
      USERPROFILE: path.join("/scratch", "home"),
      CODEX_HOME: path.join("/scratch", "codex"),
      XDG_CONFIG_HOME: path.join("/scratch", "config"),
      XDG_DATA_HOME: path.join("/scratch", "data"),
      XDG_CACHE_HOME: path.join(user, ".cache"),
      npm_config_cache: path.join(user, ".npm"),
      npm_config_userconfig: path.join(user, ".npmrc"),
      GIT_CONFIG_GLOBAL: path.join(user, ".gitconfig"),
    });
    // Windows keeps its caches under LOCALAPPDATA, which is left alone.
    const windows = initializerEnv(
      { XDG_CACHE_HOME: "C:\\cache" },
      "C:\\s",
      "C:\\u",
      "win32",
      () => false,
    );
    expect(windows.XDG_CACHE_HOME).toBe("C:\\cache");
    expect(windows).not.toHaveProperty("npm_config_cache");
    expect(windows).not.toHaveProperty("npm_config_userconfig");
    expect(windows).not.toHaveProperty("GIT_CONFIG_GLOBAL");
  });

  it("runs a step in the directory and removes its scratch directory afterwards", async () => {
    const outcome = await new LocalInitializer(home).run(
      node(
        `console.log(process.cwd()); for (const k of ${JSON.stringify(ENV_KEYS)}) console.log(k + "=" + process.env[k]); process.exitCode = 4`,
      ),
      work,
      limit,
    );
    expect(outcome).toMatchObject({ started: true, exitCode: 4, timedOut: false });
    const lines = outcome.output.split(/\r?\n/);
    expect(realpathSync.native(lines[0] ?? "")).toBe(realpathSync.native(work));
    expect(lines).toContain("CI=1");
    expect(lines).toContain("DO_NOT_TRACK=1");
    expect(lines).toContain("OPENSPEC_TELEMETRY=0");
    const scratchHome = lines.find((line) => line.startsWith("HOME="))?.slice(5) ?? "";
    expect(path.basename(path.dirname(scratchHome))).toMatch(/^liftoff-initializer-/);
    expect(existsSync(scratchHome)).toBe(false);
  });

  it("leaves the user's global files alone, such as Codex's prompts", async () => {
    const prompts = path.join(home, ".codex", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(path.join(prompts, "opsx-propose.md"), "mine");
    // What OpenSpec's clean-up of old Codex prompts, and its telemetry, do.
    const outcome = await new LocalInitializer(home).run(
      node(`
        const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
        const codex = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
        fs.rmSync(path.join(codex, "prompts"), { recursive: true, force: true });
        fs.mkdirSync(path.join(os.homedir(), ".config", "openspec"), { recursive: true });
        fs.writeFileSync(path.join(os.homedir(), ".config", "openspec", "telemetry.json"), "{}");
      `),
      work,
      limit,
    );
    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(path.join(prompts, "opsx-propose.md"), "utf8")).toBe("mine");
    expect(readdirSync(home).sort()).toEqual([".codex"]);
  });

  it("stops a step at its time limit", async () => {
    const outcome = await new LocalInitializer(home).run(
      node("setTimeout(() => {}, 60_000)"),
      work,
      { timeoutMs: 200 },
    );
    expect(outcome).toMatchObject({ started: true, timedOut: true });
  });

  it("keeps the end of a long output, where a failure is explained", async () => {
    const outcome = await new LocalInitializer(home).run(
      node(
        "process.stderr.write('x'.repeat(2 * 1024 * 1024)); console.error('the real reason'); process.exitCode = 1",
      ),
      work,
      limit,
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.output.endsWith("the real reason")).toBe(true);
    expect(outcome.output.length).toBeLessThanOrEqual(4000);
  });

  it("reports a command that cannot start instead of throwing", async () => {
    const outcome = await new LocalInitializer(home).run(
      { command: "liftoff-no-such-initializer", args: [] },
      work,
      limit,
    );
    expect(outcome).toMatchObject({ started: false, exitCode: null });
    expect(outcome.output).toMatch(/could not start liftoff-no-such-initializer/);
  });

  it("names the home and temporary directories as paths files must not contain", () => {
    expect(new LocalInitializer(home).machinePaths()).toEqual([home, tmpdir()]);
  });
});
