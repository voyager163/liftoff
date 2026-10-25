import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessError, run, windowsLaunch } from "../../src/adapters/process.ts";

const node = process.execPath;
const cwd = process.cwd();

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

describe("CLI-010 bounded child processes", () => {
  it("captures output and exit code", async () => {
    const result = await run(
      node,
      ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
      {
        cwd,
      },
    );
    expect(result).toMatchObject({
      exitCode: 3,
      stdout: "out\n",
      stderr: "err\n",
      timedOut: false,
      cancelled: false,
      truncated: false,
    });
  });

  it("passes input on stdin", async () => {
    const result = await run(node, ["-e", "process.stdin.pipe(process.stdout)"], {
      cwd,
      input: "hello",
    });
    expect(result.stdout).toBe("hello");
  });

  it("caps output", async () => {
    const result = await run(node, ["-e", "process.stdout.write('x'.repeat(5000))"], {
      cwd,
      maxOutputBytes: 100,
    });
    expect(result.stdout).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it("kills the whole process tree on timeout", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const result = await run(node, ["-e", script], { cwd, timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitFor(() => !isAlive(grandchild))).toBe(true);
  });

  it("cancels through an abort signal", async () => {
    const controller = new AbortController();
    const pending = run(node, ["-e", "setInterval(() => {}, 1000)"], {
      cwd,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.cancelled).toBe(true);
  });

  it("refuses to start when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(node, ["-e", ""], { cwd, signal: controller.signal })).rejects.toThrow(
      ProcessError,
    );
  });

  it("reports a missing program as a ProcessError", async () => {
    await expect(run("liftoff-no-such-program", [], { cwd })).rejects.toThrow(/could not start/);
  });
});

describe("CLI-010 batch files on Windows", () => {
  // Windows file names ignore case, and PATHEXT lists extensions in capitals.
  const files =
    (...present: string[]) =>
    (file: string) =>
      present.some((candidate) => candidate.toLowerCase() === file.toLowerCase());
  const env = { Path: "C:\\Tools;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("runs a batch file found on PATH through cmd.exe", () => {
    const launch = windowsLaunch(
      "npx",
      ["--yes", "@fission-ai/openspec@1.14.3", "--tools", "claude,codex", "."],
      { ...env, ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      files("C:\\Program Files\\nodejs\\npx.cmd"),
    );
    expect(launch).toEqual({
      command: "C:\\Windows\\system32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\npx.CMD" --yes @fission-ai/openspec@1.14.3 --tools claude,codex ."',
      ],
      verbatim: true,
    });
  });

  it("starts programs and explicit paths directly", () => {
    const direct = { command: "git", args: ["--version"], verbatim: false };
    expect(windowsLaunch("git", ["--version"], env, files("C:\\Tools\\git.exe"))).toEqual(direct);
    // The first directory with a match wins, as on Windows.
    expect(
      windowsLaunch(
        "git",
        ["--version"],
        env,
        files("C:\\Tools\\git.exe", "C:\\Program Files\\nodejs\\git.cmd"),
      ),
    ).toEqual(direct);
    expect(windowsLaunch("C:\\x\\npx", [], env, files()).command).toBe("C:\\x\\npx");
    expect(windowsLaunch("npx.cmd", [], env, files()).verbatim).toBe(false);
    expect(windowsLaunch("missing", [], env, files()).command).toBe("missing");
    expect(windowsLaunch("npx", [], {}, files()).command).toBe("npx");
  });

  it("refuses arguments cmd.exe would interpret", () => {
    const npx = files("C:\\Tools\\npx.cmd");
    for (const unsafe of ["two words", "a&b", "%PATH%", '"quoted"', "a|b", ""]) {
      expect(() => windowsLaunch("npx", [unsafe], env, npx)).toThrow(ProcessError);
    }
    expect(() =>
      windowsLaunch("npx", [], { Path: "C:\\100%" }, files("C:\\100%\\npx.cmd")),
    ).toThrow(/cmd.exe/);
  });

  it("finds a tool on PATH and passes its arguments unchanged", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "liftoff-bin-"));
    try {
      if (process.platform === "win32") {
        writeFileSync(path.join(bin, "liftoff-echo.cmd"), "@echo off\r\necho %*\r\n");
      } else {
        writeFileSync(path.join(bin, "liftoff-echo"), '#!/bin/sh\necho "$@"\n');
        chmodSync(path.join(bin, "liftoff-echo"), 0o755);
      }
      const result = await run("liftoff-echo", ["--tools", "claude,codex", "--x=1", "."], {
        cwd,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("--tools claude,codex --x=1 .");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
