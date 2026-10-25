import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway Git repository for tests that need real git behavior. */
export class TempRepo {
  readonly root: string;

  constructor() {
    this.root = realpathSync(mkdtempSync(path.join(tmpdir(), "liftoff-test-")));
    this.git("init", "--quiet", "--initial-branch=develop");
    this.git("config", "user.email", "test@example.invalid");
    this.git("config", "user.name", "Test");
    this.git("config", "commit.gpgsign", "false");
    this.git("config", "core.autocrlf", "false");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" });
  }

  write(relative: string, content: string): void {
    const target = path.join(this.root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  commit(message: string): void {
    this.git("add", "--all");
    this.git("commit", "--quiet", "--allow-empty", "-m", message);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
