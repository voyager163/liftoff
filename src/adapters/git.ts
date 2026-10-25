import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitPort } from "../application/ports.ts";
import type { ChangedFile } from "../domain/risk-policy/classify.ts";
import { ProcessError, type RunOptions, type RunResult, run } from "./process.ts";

export type Runner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

export class GitError extends Error {
  override readonly name = "GitError";
}

/** Git access through the git executable on PATH. Never writes. */
export class GitCli implements GitPort {
  private readonly cwd: string;
  private readonly runner: Runner;

  constructor(cwd: string, runner: Runner = run) {
    this.cwd = cwd;
    this.runner = runner;
  }

  async resolveCommit(ref: string): Promise<string | undefined> {
    if (ref.startsWith("-")) throw new GitError(`invalid ref "${ref}"`);
    const result = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  async mergeBase(a: string, b: string): Promise<string> {
    const result = await this.git(["merge-base", a, b]);
    return result.stdout.trim();
  }

  async changedFiles(fromCommit: string, includeWorkingTree: boolean): Promise<ChangedFile[]> {
    const range = includeWorkingTree ? [fromCommit] : [fromCommit, "HEAD"];
    const diff = await this.git(["diff", "--numstat", "-z", "-M", "--no-color", ...range, "--"]);
    const files = parseNumstat(diff.stdout);
    if (!includeWorkingTree) return files;

    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const relative of untracked.stdout.split("\0").filter(Boolean)) {
      const text = await readFile(path.join(this.cwd, relative), "utf8").catch(() => "");
      files.push({ path: relative, additions: countLines(text), deletions: 0 });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async showFile(ref: string, file: string): Promise<string | undefined> {
    const result = await this.git(["show", `${ref}:${file}`], true);
    return result.exitCode === 0 ? result.stdout : undefined;
  }

  private async git(args: string[], allowFailure = false): Promise<RunResult> {
    let result: RunResult;
    try {
      result = await this.runner("git", ["-c", "core.quotepath=off", ...args], {
        cwd: this.cwd,
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof ProcessError)
        throw new GitError(`git is not available: ${error.message}`);
      throw error;
    }
    if (result.timedOut) throw new GitError(`git ${args[0]} timed out`);
    if (result.truncated) throw new GitError(`git ${args[0]} produced too much output`);
    if (result.exitCode !== 0 && !allowFailure) {
      throw new GitError(
        `git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    return result;
  }
}

/**
 * Parses `git diff --numstat -z -M`. Each record is `added\tdeleted\tpath\0`,
 * or `added\tdeleted\t\0old\0new\0` for a rename. Binary files report `-`.
 */
export function parseNumstat(output: string): ChangedFile[] {
  const tokens = output.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (!record) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) throw new GitError(`unexpected git diff output: ${JSON.stringify(record)}`);
    const additions = match[1] === "-" ? 0 : Number(match[1]);
    const deletions = match[2] === "-" ? 0 : Number(match[2]);
    if (match[3]) {
      files.push({ path: match[3], additions, deletions });
      continue;
    }
    const previousPath = tokens[i + 1];
    const nextPath = tokens[i + 2];
    if (!previousPath || !nextPath) throw new GitError("truncated rename in git diff output");
    files.push({ path: nextPath, previousPath, additions, deletions });
    i += 2;
  }
  return files;
}

function countLines(text: string): number {
  if (text === "") return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}
