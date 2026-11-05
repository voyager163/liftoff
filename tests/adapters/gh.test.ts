import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhCli, GitHubApiError, githubRepository } from "../../src/adapters/gh.ts";

const fakeGh = path.resolve(import.meta.dirname, "../fixtures/fake-gh/gh.mjs");
const gh = () => new GhCli(process.cwd(), process.execPath, [fakeGh]);

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "liftoff-gh-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("GOV-001 GitHub through the person's own GitHub CLI login", () => {
  it("reads with gh api, pinning the API version", async () => {
    const answer = await gh().get<{ method: string; route: string; args: string[] }>("/repos/o/r");
    expect(answer).toMatchObject({ method: "GET", route: "/repos/o/r" });
    expect(answer.args).toContain("X-GitHub-Api-Version: 2022-11-28");
  });

  it("sends a body on stdin, and reads an empty answer as nothing", async () => {
    const answer = await gh().send<{ method: string; body: unknown; args: string[] }>(
      "POST",
      "/repos/o/r/git/refs",
      { ref: "refs/heads/develop", sha: "abc" },
    );
    expect(answer).toMatchObject({
      method: "POST",
      body: { ref: "refs/heads/develop", sha: "abc" },
    });
    expect(answer.args.slice(-2)).toEqual(["--input", "-"]);
    expect(await gh().send("POST", "/empty")).toBeUndefined();
  });

  it("answers a missing resource with nothing, and other failures with an error", async () => {
    expect(await gh().find("/missing")).toBeUndefined();
    await expect(gh().get("/missing")).rejects.toMatchObject({ status: 404 });
    await expect(gh().find("/broken")).rejects.toThrow(GitHubApiError);
    await expect(gh().find("/broken")).rejects.toThrow(/error connecting/);
  });

  it("reports a refusal with its status instead of throwing", async () => {
    expect(await gh().attempt("PATCH", "/refused", { sha: "abc" })).toMatchObject({
      ok: false,
      status: 422,
    });
    expect(await gh().attempt("DELETE", "/repos/o/r/git/refs/heads/x")).toEqual({ ok: true });
  });

  it("says how to get the GitHub CLI when it is missing", async () => {
    await expect(new GhCli(work, "liftoff-no-such-gh").get("/x")).rejects.toThrow(
      /install it from https:\/\/cli.github.com/,
    );
  });

  it("finds the repository from the origin remote", async () => {
    expect(await gh().repositoryOf(work)).toBeUndefined();
    execFileSync("git", ["init", "--quiet"], { cwd: work });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:octo/demo.git"], { cwd: work });
    expect(await gh().repositoryOf(work)).toBe("octo/demo");
  });

  it.each([
    ["https://github.com/octo/demo.git", "octo/demo"],
    ["https://github.com/octo/demo", "octo/demo"],
    ["git@github.com:octo/my.repo.git", "octo/my.repo"],
    ["ssh://git@github.com/octo/demo.git\n", "octo/demo"],
    ["https://gitlab.com/octo/demo.git", undefined],
    ["https://github.com/octo", undefined],
  ])("reads %s as %s", (url, repository) => {
    expect(githubRepository(url)).toBe(repository);
  });
});
