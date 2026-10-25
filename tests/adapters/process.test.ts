import { describe, expect, it } from "vitest";
import { ProcessError, run } from "../../src/adapters/process.ts";

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
