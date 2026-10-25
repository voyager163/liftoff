import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideReview,
  type PullRequestForReview,
  publishReview,
  ReviewIncompleteError,
} from "../../src/application/ai-review/review-pull-request.ts";
import { main, type PipelineEnvironment } from "../../src/ci/ai-review.ts";
import { fingerprint, JSON_END, JSON_START } from "../../src/domain/ai-review/findings.ts";

const POLICY = `
version: 1
profile: single-maintainer-gitflow
trusted_authors: [alice]
rules:
  - paths: ["docs/**"]
    tier: low
    reason: docs
  - paths: ["src/auth/**"]
    tier: high
    reason: auth
`;

const block = (value: unknown) => `${JSON_START}\n${JSON.stringify(value)}\n${JSON_END}`;
const candidate = {
  file: "src/app.ts",
  line: 2,
  title: "Retry repeats payment",
  scenario: "A timeout makes the retry pay twice.",
};

interface FakeState {
  files: { filename: string; additions: number; deletions: number; patch?: string }[];
  reviews: { user: { login: string } | null; body: string | null }[];
  comments: { user: { login: string } | null; body: string | null }[];
  draft?: boolean;
  head?: string;
  posted: {
    commit_id: string;
    event: string;
    body: string;
    comments: { path: string; line: number; side: string; body: string }[];
  }[];
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeGitHub(state: FakeState): Promise<string> {
  const instance = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const base = "/repos/acme/app/pulls/5";
    if (req.method === "POST" && url.pathname === `${base}/reviews`) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        state.posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        send({ id: 1 });
      });
      return;
    }
    if (url.pathname === base) {
      return send({
        number: 5,
        title: "Add retries",
        body: "Retries payments on timeout.",
        draft: state.draft ?? false,
        user: { login: "alice" },
        head: { sha: state.head ?? "bbb" },
        base: { ref: "develop" },
      });
    }
    if (url.pathname === `${base}/files`) return send(state.files);
    if (url.pathname === `${base}/reviews`) return send(state.reviews);
    if (url.pathname === `${base}/comments`) return send(state.comments);
    send({ message: "Not Found" }, 404);
  });
  server = instance;
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}

const highRiskFiles = [
  {
    filename: "src/app.ts",
    additions: 3,
    deletions: 0,
    patch: "@@ -1,1 +1,3 @@\n keep\n+one\n+two",
  },
];

const DIFF = "diff --git a/src/app.ts b/src/app.ts\n@@ -1,1 +1,3 @@\n keep\n+one\n+two\n";

function pipeline(
  url: string,
  extra: Record<string, string> = {},
  gitFiles: Record<string, string> = {},
) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  files.set(
    "event.json",
    JSON.stringify({ pull_request: { number: 5, head: { repo: { full_name: "acme/app" } } } }),
  );
  const git: Record<string, string> = {
    "show origin/develop:.github/review-policy.yml": POLICY,
    "show origin/develop:.claude/skills/liftoff-code-review/SKILL.md":
      "---\nname: x\ndescription: y\n---\n# Method\nFind bugs.",
    "show origin/develop:.github/agents/liftoff-verifier.agent.md":
      "---\nname: v\n---\nYou verify one finding.",
    "-C pr diff origin/develop...bbb": DIFF,
    ...gitFiles,
  };
  const context: PipelineEnvironment = {
    env: {
      GITHUB_EVENT_PATH: "event.json",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_TOKEN: "t",
      GITHUB_API_URL: url,
      GITHUB_OUTPUT: "out.txt",
      LIFTOFF_AGENT_CONFIGURED: "true",
      LIFTOFF_AGENT_SECRET: "COPILOT_GITHUB_TOKEN",
      LIFTOFF_BASE_REF: "develop",
      LIFTOFF_REVIEW_TREE: "pr",
      ...extra,
    },
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    writeFile: (path, text) => files.set(path, text),
    listFiles: (directory) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${directory}/`))
        .map((p) => p.slice(directory.length + 1)),
    appendFile: (path, text) => files.set(path, (files.get(path) ?? "") + text),
    log: (text) => logs.push(text),
    git: async (args) => git[args.join(" ")],
  };
  const outputs = () =>
    Object.fromEntries(
      (files.get("out.txt") ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  return { context, files, logs, outputs };
}

const bot = (body: string) => ({ user: { login: "github-actions[bot]" }, body });

describe("AIREVIEW-001 deciding how deep to review", () => {
  const pr = (overrides: Partial<PullRequestForReview> = {}): PullRequestForReview => ({
    number: 5,
    title: "t",
    body: "",
    author: "alice",
    draft: false,
    headSha: "bbb",
    baseRef: "develop",
    files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
    previous: { rounds: 0, fingerprints: new Set() },
    ...overrides,
  });

  it("runs two passes for medium risk and three for high", () => {
    expect(decideReview(pr(), POLICY)).toMatchObject({
      run: true,
      passes: 2,
      round: 1,
      range: "origin/develop...bbb",
    });
    const high = decideReview(
      pr({ files: [{ path: "src/auth/x.ts", additions: 1, deletions: 0 }] }),
      POLICY,
    );
    expect(high).toMatchObject({ run: true, passes: 3 });
  });

  it("leaves low risk, drafts and already-reviewed commits to the managed reviewer", () => {
    expect(
      decideReview(pr({ files: [{ path: "docs/a.md", additions: 1, deletions: 0 }] }), POLICY),
    ).toMatchObject({
      run: false,
      reason: "low risk: the managed reviewer covers it",
    });
    expect(decideReview(pr({ draft: true }), POLICY).reason).toBe("draft pull request");
    expect(
      decideReview(
        pr({ previous: { rounds: 1, fingerprints: new Set(), lastHead: "bbb" } }),
        POLICY,
      ).reason,
    ).toBe("this commit was already reviewed");
  });
});

describe("AIREVIEW-003 rounds", () => {
  it("reviews only new commits from the third round and stops after three", () => {
    const base = {
      number: 5,
      title: "t",
      body: "",
      author: "alice",
      draft: false,
      headSha: "ccc",
      baseRef: "develop",
      files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
    };
    expect(
      decideReview(
        { ...base, previous: { rounds: 2, fingerprints: new Set(), lastHead: "bbb" } },
        POLICY,
      ),
    ).toMatchObject({
      round: 3,
      range: "bbb..ccc",
    });
    expect(
      decideReview(
        { ...base, previous: { rounds: 3, fingerprints: new Set(), lastHead: "bbb" } },
        POLICY,
      ),
    ).toMatchObject({
      run: false,
      round: 4,
      reason: "stopped after 3 rounds",
    });
  });

  it("only trusts round markers and fingerprints posted by the review bot", async () => {
    const print = fingerprint("src/app.ts", candidate.title);
    const url = await fakeGitHub({
      files: highRiskFiles,
      reviews: [
        bot("<!-- liftoff-ai-review round=1 head=aaa -->"),
        { user: { login: "mallory" }, body: "<!-- liftoff-ai-review round=9 head=fff -->" },
      ],
      comments: [
        bot(`x <!-- liftoff-finding:${"0".repeat(16)} -->`),
        { user: { login: "mallory" }, body: `<!-- liftoff-finding:${print} -->` },
        { user: null, body: null },
      ],
      posted: [],
    });
    const { context, files, outputs } = pipeline(url);
    expect(await main("prepare", context)).toBe(0);
    expect(outputs()).toMatchObject({ run: "true", round: "2", passes: "[0,1]" });
    const saved = JSON.parse(files.get("ai-review/pr.json") ?? "{}");
    expect(saved.previous).toEqual({ rounds: 1, lastHead: "aaa", fingerprints: ["0".repeat(16)] });
  });
});

describe("AIREVIEW-004 the pipeline protects itself", () => {
  it.each([
    [{ LIFTOFF_AGENT_CONFIGURED: "false" }, "add a COPILOT_GITHUB_TOKEN repository secret"],
  ])("does not run without the Copilot token %#", async (env, reason) => {
    const url = await fakeGitHub({ files: highRiskFiles, reviews: [], comments: [], posted: [] });
    const { context, outputs } = pipeline(url, env);
    expect(await main("prepare", context)).toBe(0);
    expect(outputs()).toMatchObject({ run: "false", stop: "false" });
    expect(outputs().reason).toContain(reason);
  });

  it("does not run for a fork", async () => {
    const url = await fakeGitHub({ files: highRiskFiles, reviews: [], comments: [], posted: [] });
    const { context, files, outputs } = pipeline(url);
    files.set(
      "event.json",
      JSON.stringify({ pull_request: { number: 5, head: { repo: { full_name: "fork/app" } } } }),
    );
    await main("prepare", context);
    expect(outputs().reason).toContain("fork");
  });

  it("writes the diff for the agents, which only read files in the head checkout", async () => {
    const url = await fakeGitHub({ files: highRiskFiles, reviews: [], comments: [], posted: [] });
    const { context, files } = pipeline(url);
    expect(await main("prepare", context)).toBe(0);
    expect(files.get("ai-review/diff.patch")).toBe(DIFF);
    const prompt = files.get("ai-review/finder-0.md") ?? "";
    expect(prompt).toContain("the diff in `ai-review/diff.patch`");
    expect(prompt).toContain("under `pr/`");
    expect(prompt).toContain("there is no shell");
    expect(prompt).not.toContain("git diff");
  });

  it("reviews the whole change when a force push removed the last reviewed commit", async () => {
    const url = await fakeGitHub({
      files: highRiskFiles,
      reviews: [1, 2].map((round) =>
        bot(`<!-- liftoff-ai-review round=${round} head=a${round} -->`),
      ),
      comments: [],
      posted: [],
    });
    const { context, files, logs } = pipeline(url);
    expect(await main("prepare", context)).toBe(0);
    expect(files.get("ai-review/diff.patch")).toBe(DIFF);
    expect(logs.join("")).toContain("over `origin/develop...bbb`");
  });

  it("fails when the diff cannot be computed", async () => {
    const url = await fakeGitHub({ files: highRiskFiles, reviews: [], comments: [], posted: [] });
    const { context, logs } = pipeline(
      url,
      {},
      { "-C pr diff origin/develop...bbb": undefined as never },
    );
    expect(await main("prepare", context)).toBe(1);
    expect(logs.join("")).toContain("cannot compute the diff origin/develop...bbb in pr");
  });
});

describe("AIREVIEW-002 the end-to-end pipeline", () => {
  it("prepares prompts, merges candidates, votes and posts one review", async () => {
    const state: FakeState = { files: highRiskFiles, reviews: [], comments: [], posted: [] };
    const url = await fakeGitHub(state);
    const { context, files, outputs, logs } = pipeline(url);

    expect(await main("prepare", context)).toBe(0);
    expect(files.get("ai-review/finder-0.md")).toContain("Find bugs.");
    expect(files.get("ai-review/finder-1.md")).toContain("Failure and recovery");

    files.set("ai-review/finders/finder-0.txt", block({ candidates: [candidate] }));
    files.set(
      "ai-review/finders/finder-1.txt",
      block({ candidates: [{ ...candidate, line: 3, title: "Payment retried twice" }] }),
    );
    expect(await main("verifier-prompt", context)).toBe(0);
    expect(outputs()["has-candidates"]).toBe("true");
    expect(files.get("ai-review/verifier.md")).toContain("You verify one finding.");
    expect(files.get("ai-review/verifier.md")).toContain("### c1: src/app.ts:2");
    expect(files.get("ai-review/verifier.md")).toContain("`ai-review/diff.patch`");

    files.set(
      "ai-review/verifiers/verifier-0.txt",
      block({ verdicts: [{ id: "c1", verdict: "confirmed", tag: "important" }] }),
    );
    files.set(
      "ai-review/verifiers/verifier-1.txt",
      block({ verdicts: [{ id: "c1", verdict: "confirmed" }] }),
    );
    files.set("ai-review/verifiers/verifier-2.txt", "the model rambled and printed no JSON");
    expect(await main("publish", context)).toBe(0);

    expect(state.posted).toHaveLength(1);
    const review = state.posted[0];
    expect(review).toMatchObject({ commit_id: "bbb", event: "COMMENT" });
    expect(review?.body).toContain("1 finding: 1 Important, 0 Nit, 0 Pre-existing.");
    expect(review?.body).toContain("1 verifier run(s) returned no usable result");
    expect(review?.comments).toEqual([
      expect.objectContaining({ path: "src/app.ts", line: 2, side: "RIGHT" }),
    ]);
    expect(logs.join("")).toContain("AI review, round 1");
  });

  it("publishes a clean result when no finder found anything", async () => {
    const state: FakeState = { files: highRiskFiles, reviews: [], comments: [], posted: [] };
    const url = await fakeGitHub(state);
    const { context, files, outputs } = pipeline(url);
    await main("prepare", context);
    files.set("ai-review/finders/finder-0.txt", block({ candidates: [] }));
    expect(await main("verifier-prompt", context)).toBe(0);
    expect(outputs()["has-candidates"]).toBe("false");
    expect(await main("publish", context)).toBe(0);
    expect(state.posted[0]?.body).toContain("No findings. Nothing to fix.");
  });

  it("posts the stop note once the round cap is reached", async () => {
    const state: FakeState = {
      files: highRiskFiles,
      reviews: [1, 2, 3].map((round) =>
        bot(`<!-- liftoff-ai-review round=${round} head=a${round} -->`),
      ),
      comments: [],
      posted: [],
    };
    const url = await fakeGitHub(state);
    const prepared = pipeline(url);
    await main("prepare", prepared.context);
    expect(prepared.outputs()).toMatchObject({ run: "false", stop: "true" });

    // The publish job receives the prepared pull request as an artifact.
    const publish = pipeline(url, { LIFTOFF_STOP: "true" });
    publish.files.set("ai-review/pr.json", prepared.files.get("ai-review/pr.json") ?? "");
    expect(await main("publish", publish.context)).toBe(0);
    expect(state.posted.at(-1)?.body).toContain("stopped after 3 rounds");
  });

  it("writes no prompts when the review does not run", async () => {
    const url = await fakeGitHub({
      files: [{ filename: "docs/a.md", additions: 1, deletions: 0 }],
      reviews: [],
      comments: [],
      posted: [],
    });
    const { context, files, outputs } = pipeline(url);
    await main("prepare", context);
    expect(outputs().run).toBe("false");
    expect([...files.keys()].some((key) => key.startsWith("ai-review/finder-"))).toBe(false);
  });
});

describe("AIREVIEW-005 incomplete reviews fail visibly", () => {
  it("fails when no finder pass produced a usable result", async () => {
    const url = await fakeGitHub({ files: highRiskFiles, reviews: [], comments: [], posted: [] });
    const { context, files, logs } = pipeline(url);
    await main("prepare", context);
    files.set("ai-review/finders/finder-0.txt", "error: rate limited");
    expect(await main("verifier-prompt", context)).toBe(1);
    expect(logs.join("")).toContain("no finder pass produced a usable result");
  });

  it("refuses to publish candidates with fewer than two usable verifier runs", async () => {
    const gateway = { load: async () => ({}) as never, publish: async () => undefined };
    const pr: PullRequestForReview = {
      number: 5,
      title: "t",
      body: "",
      author: "a",
      draft: false,
      headSha: "h",
      baseRef: "develop",
      files: [],
      previous: { rounds: 0, fingerprints: new Set() },
    };
    await expect(
      publishReview(gateway, pr, {
        finderOutputs: [block({ candidates: [candidate] })],
        verifierOutputs: [block({ verdicts: [{ id: "c1", verdict: "confirmed" }] }), "garbage"],
      }),
    ).rejects.toThrow(ReviewIncompleteError);
  });

  it("rejects unknown commands and missing configuration", async () => {
    const { context, logs } = pipeline("http://unused");
    expect(await main("explode", context)).toBe(1);
    expect(logs.join("")).toContain('unknown command "explode"');
    const bare = pipeline("http://unused", { GITHUB_TOKEN: "" });
    expect(await main("prepare", bare.context)).toBe(1);
    expect(bare.logs.join("")).toContain("GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
    const noSkill = pipeline(
      await fakeGitHub({ files: highRiskFiles, reviews: [], comments: [], posted: [] }),
      {},
      {
        "show origin/develop:.claude/skills/liftoff-code-review/SKILL.md": undefined as never,
      },
    );
    expect(await main("prepare", noSkill.context)).toBe(1);
    expect(noSkill.logs.join("")).toContain("the base branch has none of");
  });

  it("fails when the event has no pull request", async () => {
    const { context, files, logs } = pipeline("http://unused");
    files.set("event.json", "{}");
    expect(await main("prepare", context)).toBe(1);
    expect(logs.join("")).toContain("the event has no pull request");
  });
});
