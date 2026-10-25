import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../../src/adapters/github.ts";
import { GitHubPullRequestSource } from "../../src/adapters/github-pull-request.ts";
import { startFakeGitHub } from "../helpers/fake-github.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("REVIEW-006 reading reviews from GitHub", () => {
  it("pages through files and reviews and looks up write access", async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      additions: i,
      deletions: 1,
    }));
    files.push({
      filename: "new.ts",
      previous_filename: "old.ts",
      additions: 0,
      deletions: 0,
    } as never);
    const server = await startFakeGitHub(
      "o/r",
      7,
      {
        files,
        reviews: [
          {
            user: { login: "bob", type: "User" },
            state: "APPROVED",
            commit_id: "h",
            submitted_at: "2026-10-01T00:00:00Z",
          },
          {
            user: { login: "bob", type: "User" },
            state: "APPROVED",
            commit_id: "h",
            submitted_at: "2026-10-01T00:00:01Z",
          },
          { user: { login: "bot", type: "Bot" }, state: "APPROVED", commit_id: "h" },
          { user: { login: "eve", type: "User" }, state: "COMMENTED", commit_id: "h" },
          { user: null, state: "APPROVED", commit_id: "h" },
        ],
        permissions: { bob: "maintain", bot: "write" },
      },
      2,
    );
    close = server.close;
    const client = new GitHubClient({ token: "t0ken", apiUrl: `${server.url}/` });
    const facts = await new GitHubPullRequestSource(client, "o/r").facts(7, "h", "alice");

    expect(facts.files).toHaveLength(6);
    expect(facts.files[5]).toEqual({
      path: "new.ts",
      previousPath: "old.ts",
      additions: 0,
      deletions: 0,
    });
    expect(facts.reviews.map((r) => [r.reviewer, r.isBot, r.hasWriteAccess])).toEqual([
      ["bob", false, true],
      ["bob", false, true],
      ["bot", true, true],
      ["eve", false, false],
    ]);
    expect(facts.reviews[0]?.submittedAt).toBeLessThan(facts.reviews[1]?.submittedAt ?? 0);
    expect(server.requests.every((r) => r.startsWith("Bearer t0ken "))).toBe(true);
    // Write access is looked up once per approving reviewer.
    expect(server.requests.filter((r) => r.includes("/permission"))).toHaveLength(2);
  });

  it("refuses more items than allowed", async () => {
    const server = await startFakeGitHub("o/r", 1, {
      files: Array.from({ length: 3 }, (_, i) => ({
        filename: `${i}`,
        additions: 0,
        deletions: 0,
      })),
      reviews: [],
      permissions: {},
    });
    close = server.close;
    const client = new GitHubClient({ token: "t", apiUrl: server.url });
    await expect(client.list("/repos/o/r/pulls/1/files", 2)).rejects.toThrow(/more than 2 items/);
  });

  it("reports HTTP errors with the route and status", async () => {
    const server = await startFakeGitHub("o/r", 1, { files: [], reviews: [], permissions: {} });
    close = server.close;
    const client = new GitHubClient({ token: "t", apiUrl: server.url });
    const error = await client.get("/repos/o/r/missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(404);
    expect((error as Error).message).toBe("GitHub /repos/o/r/missing returned HTTP 404");
  });

  it("wraps network failures and rejects non-list pages", async () => {
    const failing = new GitHubClient({
      token: "t",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(failing.get("/x")).rejects.toThrow(/GitHub request failed: ECONNREFUSED/);

    const notList = new GitHubClient({
      token: "t",
      fetch: async () => new Response(JSON.stringify({ message: "x" }), { status: 200 }),
    });
    await expect(notList.list("/x", 10)).rejects.toThrow(/expected a list/);
  });

  it("requires a token and a valid repository", () => {
    expect(() => new GitHubClient({ token: "" })).toThrow(/token is required/);
    const client = new GitHubClient({ token: "t" });
    expect(() => new GitHubPullRequestSource(client, "not a repo")).toThrow(/invalid repository/);
  });
});
