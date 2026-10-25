import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializerEnv, LocalInitializer } from "../../src/adapters/initializer.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-initializer-test-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const ENV_KEYS = ["CI", "DO_NOT_TRACK", "OPENSPEC_TELEMETRY", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];

describe("PROJ-020 initializers run apart from the user's configuration", () => {
  it("turns telemetry off and points configuration at a scratch directory", () => {
    const env = initializerEnv({ PATH: "/bin", DO_NOT_TRACK: "0" }, "/scratch");
    expect(env).toMatchObject({
      PATH: "/bin",
      CI: "1",
      DO_NOT_TRACK: "1",
      OPENSPEC_TELEMETRY: "0",
      npm_config_update_notifier: "false",
      XDG_CONFIG_HOME: path.join("/scratch", "config"),
      XDG_DATA_HOME: path.join("/scratch", "data"),
    });
  });

  it("runs a step in the directory and removes its scratch directory afterwards", async () => {
    const outcome = await new LocalInitializer().run(
      {
        command: process.execPath,
        args: [
          "-e",
          `console.log(process.cwd()); for (const k of ${JSON.stringify(ENV_KEYS)}) console.log(k + "=" + process.env[k]); process.exit(4)`,
        ],
      },
      work,
    );
    expect(outcome).toMatchObject({ started: true, exitCode: 4, timedOut: false });
    const lines = outcome.output.split(/\r?\n/);
    expect(realpathSync.native(lines[0] ?? "")).toBe(realpathSync.native(work));
    expect(lines).toContain("CI=1");
    expect(lines).toContain("DO_NOT_TRACK=1");
    expect(lines).toContain("OPENSPEC_TELEMETRY=0");
    const config = lines.find((line) => line.startsWith("XDG_CONFIG_HOME="))?.slice(16) ?? "";
    expect(path.basename(path.dirname(config))).toMatch(/^liftoff-initializer-/);
    expect(existsSync(config)).toBe(false);
  });

  it("reports a command that cannot start instead of throwing", async () => {
    const outcome = await new LocalInitializer().run(
      { command: "liftoff-no-such-initializer", args: [] },
      work,
    );
    expect(outcome).toMatchObject({ started: false, exitCode: null });
    expect(outcome.output).toMatch(/could not start liftoff-no-such-initializer/);
  });

  it("names the home directory as a path files must not contain", () => {
    expect(new LocalInitializer().machinePaths()).toContain(homedir());
  });
});
