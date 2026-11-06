// Checks a Liftoff that Homebrew just installed, from the cask or the
// formula (CHAN-001, CHAN-002), as a user would meet it:
//
//   node scripts/release/check-homebrew-install.ts <homebrew-cask|homebrew-formula>
//
// liftoff on Homebrew's PATH is this version, generates and validates a
// project, and `liftoff upgrade --verify` finds that the channel asked for
// installed it (UPGRADE-001, UPGRADE-004).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type Channel = "homebrew-cask" | "homebrew-formula";
export interface VerifyReport {
  outcome?: string;
  verified?: boolean;
  installed?: { channel?: string; location?: string };
}

/**
 * What is wrong with `liftoff upgrade --verify`'s answer for a copy the
 * channel installed under `prefix`, or nothing. A newer release on GitHub
 * makes it exit 3 with "attention", which says nothing against the install.
 */
export function verifyProblems(
  channel: Channel,
  prefix: string,
  status: number | null,
  report: VerifyReport,
): string[] {
  const problems: string[] = [];
  const attention = report.outcome === "attention" && status === 3;
  if (!(report.outcome === "success" && status === 0) && !attention) {
    problems.push(`it exited ${status} with outcome ${report.outcome}`);
  }
  if (report.verified !== true) problems.push("it did not verify the install");
  if (report.installed?.channel !== channel) {
    problems.push(`it reports ${report.installed?.channel}, not ${channel}`);
  }
  const place = path.posix.join(
    prefix,
    channel === "homebrew-cask" ? "Caskroom" : "Cellar",
    "liftoff",
  );
  if (!String(report.installed?.location).startsWith(`${place}/`)) {
    problems.push(`it reports ${report.installed?.location}, outside ${place}`);
  }
  return problems;
}

if (import.meta.main) {
  const channel = process.argv[2];
  if (channel !== "homebrew-cask" && channel !== "homebrew-formula") {
    throw new Error("usage: check-homebrew-install.ts <homebrew-cask|homebrew-formula>");
  }
  const root = path.resolve(import.meta.dirname, "../..");
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const prefix = execFileSync("brew", ["--prefix"], { encoding: "utf8" }).trim();
  const liftoff = path.join(prefix, "bin", "liftoff");
  // A new terminal's PATH, with Homebrew's bin and none of the runner's Node.
  const env = { ...process.env, PATH: [path.join(prefix, "bin"), "/usr/bin", "/bin"].join(":") };
  const smoke = realpathSync(mkdtempSync(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "brew-")));
  const run = (...args: string[]) =>
    execFileSync(liftoff, args, { cwd: smoke, encoding: "utf8", env }).trim();
  const fail = (message: string): never => {
    throw new Error(message);
  };

  const resolved = execFileSync("/bin/sh", ["-c", "command -v liftoff"], { encoding: "utf8", env });
  if (resolved.trim() !== liftoff) fail(`liftoff resolves to ${resolved.trim()}, not ${liftoff}`);
  if (run("--version") !== version) fail(`liftoff --version is not ${version}`);
  run("init", "--name", "smoke", "--workflow", "manual", "--agents", "claude", "--yes");
  run("validate", "--dir", "smoke");

  const verify = spawnSync(liftoff, ["upgrade", "--verify", "--json"], {
    cwd: smoke,
    encoding: "utf8",
    env,
  });
  const problems = verifyProblems(channel, prefix, verify.status, JSON.parse(verify.stdout));
  if (problems.length > 0) {
    fail(`liftoff upgrade --verify: ${problems.join("; ")}\n${verify.stdout}${verify.stderr}`);
  }
  console.log(`${channel} installed Liftoff ${version}, and it runs from ${liftoff}`);
}
