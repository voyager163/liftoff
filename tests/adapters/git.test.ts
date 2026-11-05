import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCli, GitError, parseNumstat } from "../../src/adapters/git.ts";
import type { RunResult } from "../../src/adapters/process.ts";
import { ProcessError } from "../../src/adapters/process.ts";
import { LocalWorkspace } from "../../src/adapters/workspace.ts";
import { TempRepo } from "../helpers/git-repo.ts";

describe("REVIEW-002 parsing git numstat", () => {
  it("parses plain, binary and renamed entries", () => {
    const output = ["3\t1\tsrc/a.ts", "-\t-\tlogo.png", "2\t0\t", "old/b.ts", "new/b.ts", ""].join(
      "\0",
    );
    expect(parseNumstat(output)).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "logo.png", additions: 0, deletions: 0 },
      { path: "new/b.ts", previousPath: "old/b.ts", additions: 2, deletions: 0 },
    ]);
  });

  it("keeps tabs and newlines inside file names", () => {
    expect(parseNumstat("1\t0\tweird\tname\nhere\0")).toEqual([
      { path: "weird\tname\nhere", additions: 1, deletions: 0 },
    ]);
  });

  it("rejects malformed and truncated output", () => {
    expect(() => parseNumstat("nonsense\0")).toThrow(GitError);
    expect(() => parseNumstat("1\t1\t\0only-old\0")).toThrow(/truncated rename/);
  });
});

describe("REVIEW-008 reading a real repository", () => {
  let repo: TempRepo;
  let git: GitCli;

  beforeEach(() => {
    repo = new TempRepo();
    git = new GitCli(repo.root);
    repo.write("README.md", "hello\n");
    repo.write(".github/review-policy.yml", "version: 1\nprofile: none\n");
    repo.commit("base");
    repo.git("checkout", "--quiet", "-b", "feature");
  });

  afterEach(() => repo.dispose());

  it("resolves commits and rejects option-like refs", async () => {
    expect(await git.resolveCommit("develop")).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.resolveCommit("no-such-branch")).toBeUndefined();
    await expect(git.resolveCommit("--all")).rejects.toThrow(/invalid ref/);
  });

  it("lists committed, working-tree and untracked changes", async () => {
    repo.write("src/committed.ts", "a\nb\n");
    repo.commit("feature work");
    repo.git("mv", "README.md", "GUIDE.md");
    repo.commit("rename");
    repo.write("src/committed.ts", "a\nb\nc\n");
    repo.write("notes/untracked.txt", "one\ntwo");

    const base = await git.mergeBase("develop", "HEAD");
    const committed = await git.changedFiles(base, false);
    expect(committed).toEqual([
      { path: "GUIDE.md", previousPath: "README.md", additions: 0, deletions: 0 },
      { path: "src/committed.ts", additions: 2, deletions: 0 },
    ]);

    const everything = await git.changedFiles(base, true);
    expect(everything).toEqual([
      { path: "GUIDE.md", previousPath: "README.md", additions: 0, deletions: 0 },
      { path: "notes/untracked.txt", additions: 2, deletions: 0 },
      { path: "src/committed.ts", additions: 3, deletions: 0 },
    ]);
  });

  it("shows a file at a ref, or undefined when it is absent", async () => {
    expect(await git.showFile("develop", ".github/review-policy.yml")).toBe(
      "version: 1\nprofile: none\n",
    );
    expect(await git.showFile("develop", "missing.txt")).toBeUndefined();
  });

  it("reports git failures and missing git as GitError", async () => {
    await expect(git.mergeBase("develop", "no-such-ref")).rejects.toThrow(/merge-base failed/);

    const missing = new GitCli(repo.root, async () => {
      throw new ProcessError("spawn git ENOENT");
    });
    await expect(missing.mergeBase("a", "b")).rejects.toThrow(/git is not available/);

    const result = (overrides: Partial<RunResult>): RunResult => ({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      truncated: false,
      ...overrides,
    });
    await expect(
      new GitCli(repo.root, async () => result({ timedOut: true })).mergeBase("a", "b"),
    ).rejects.toThrow(/timed out/);
    await expect(
      new GitCli(repo.root, async () => result({ truncated: true })).mergeBase("a", "b"),
    ).rejects.toThrow(/too much output/);
    await expect(
      new GitCli(repo.root, async () => result({ exitCode: 1 })).mergeBase("a", "b"),
    ).rejects.toThrow(/exit 1/);
    await expect(
      new GitCli(repo.root, async () => {
        throw new TypeError("boom");
      }).mergeBase("a", "b"),
    ).rejects.toThrow(TypeError);
  });

  it("reads workspace files and refuses to escape the root", async () => {
    const workspace = new LocalWorkspace(repo.root);
    expect(await workspace.readText("README.md")).toBe("hello\n");
    expect(await workspace.readText("nope.txt")).toBeUndefined();
    await expect(workspace.readText("../outside.txt")).rejects.toThrow(/outside the workspace/);
    await expect(workspace.readText("src")).resolves.toBeUndefined();
  });
});
