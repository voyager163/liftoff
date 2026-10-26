import { describe, expect, it } from "vitest";
import { type Command, main } from "../../src/ci/release.ts";
import { RELEASE_MANIFEST_PREDICATE } from "../../src/domain/governance/release.ts";

const COMMIT = "c".repeat(40);
const MAIN = "d".repeat(40);
const TREE = "e".repeat(40);
const DIGEST = `sha256:${"f".repeat(64)}`;
/** The commit a merge of develop into a sync branch makes, as the workflow token. */
const MERGED = "a".repeat(40);

interface Repo {
  /** Refs such as "tags/v1.2.0", and the commit each points at. */
  refs?: Record<string, string>;
  /** GitHub releases' bodies, by tag. */
  releases?: Record<string, string>;
  /** Open pull requests, by head branch. */
  open?: Record<string, number>;
  /** Open pull requests' descriptions, by number. */
  bodies?: Record<number, string>;
  /** Commits' authors' logins, by commit. */
  authors?: Record<string, string>;
  /** Whether merging develop into a sync branch conflicts. */
  conflict?: boolean;
  /** Whether a sync branch already has develop, so merging it does nothing. */
  hasDevelop?: boolean;
  /** Whether the token may not open pull requests, as in a new repository. */
  forbidPulls?: boolean;
  develop?: string;
  /** compare/<base>...<sha> answers, by base. */
  compare?: Record<string, { ahead_by: number; behind_by: number }>;
  /** Workflow files that passed. */
  passed?: string[];
  pulls?: unknown[];
  trees?: Record<string, string>;
}

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** Answers the GitHub REST routes the release steps use, and records every call. */
function fakeGitHub(repo: Repo, calls: Call[]) {
  // Branches the steps create or merge into move, within one run.
  const refs: Record<string, string> = { ...repo.refs };
  const authors: Record<string, string> = { ...repo.authors, [MERGED]: "github-actions[bot]" };
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
    const json = (value: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(value), { status });
    const path = url.pathname;
    if (method === "POST" && path.endsWith("/dispatches")) return json(null, 204);
    if (method === "POST" && path.endsWith("/git/refs")) {
      refs[String(body?.ref).replace(/^refs\//, "")] = String(body?.sha);
      return json({}, 201);
    }
    if (method === "POST" && path.endsWith("/merges")) {
      if (repo.conflict) return json({ message: "Merge conflict" }, 409);
      if (repo.hasDevelop) return json(null, 204);
      refs[`heads/${String(body?.base)}`] = MERGED;
      return json({ sha: MERGED }, 201);
    }
    if (method === "PATCH" && /\/pulls\/\d+$/.test(path)) return json({});
    if (method === "POST" && path.endsWith("/pulls")) {
      if (repo.forbidPulls) {
        return json(
          { message: "GitHub Actions is not permitted to create or approve pull requests." },
          403,
        );
      }
      return json({ number: 21, html_url: "https://github.com/o/r/pull/21" }, 201);
    }
    if (method === "POST" && path.endsWith("/releases")) {
      return json({ html_url: "https://github.com/o/r/releases/tag/v1.2.0" }, 201);
    }
    if (path.endsWith("/git/ref/heads/develop") && repo.develop) {
      return json({ object: { sha: repo.develop } });
    }
    const ref = /\/git\/ref\/(.+)$/.exec(path)?.[1];
    if (ref !== undefined) {
      const sha = refs[ref];
      return sha === undefined ? json({}, 404) : json({ object: { sha } });
    }
    if (method === "GET" && path === "/repos/o/r/pulls") {
      const head = url.searchParams.get("head")?.replace(/^o:/, "") ?? "";
      const number = repo.open?.[head];
      return json(
        number === undefined
          ? []
          : [{ number, html_url: `https://x/pull/${number}`, body: repo.bodies?.[number] ?? "" }],
      );
    }
    const release = /\/releases\/tags\/(.+)$/.exec(path)?.[1];
    if (release !== undefined) {
      const body = repo.releases?.[release];
      return body === undefined
        ? json({}, 404)
        : json({ html_url: `https://x/releases/${release}`, body });
    }
    const compare = /\/compare\/([^.]+)\.\.\./.exec(path)?.[1];
    if (compare !== undefined)
      return json(repo.compare?.[compare] ?? { ahead_by: 0, behind_by: 0 });
    const workflow = /\/actions\/workflows\/([^/]+)\/runs$/.exec(path)?.[1];
    if (workflow !== undefined) {
      return json({
        total_count: (repo.passed ?? []).filter((file) => file.endsWith(`/${workflow}`)).length,
      });
    }
    if (/\/commits\/\w+\/pulls$/.test(path)) return json(repo.pulls ?? []);
    const authored = /\/repos\/o\/r\/commits\/(\w+)$/.exec(path)?.[1];
    if (authored !== undefined) {
      return json({ author: { login: authors[authored] ?? "maintainer" } });
    }
    const commit = /\/git\/commits\/(\w+)$/.exec(path)?.[1];
    if (commit !== undefined) return json({ tree: { sha: repo.trees?.[commit] ?? TREE } });
    return json({ message: "not found" }, 404);
  };
}

const run = async (
  command: Command,
  env: Record<string, string>,
  repo: Repo = {},
  files: Record<string, string> = {},
) => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const outputs: string[] = [];
  const written: Record<string, string> = {};
  const code = await main(command, {
    env: {
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_OUTPUT: "out",
      ...env,
    },
    readFile: (path) => written[path] ?? files[path] ?? "",
    writeFile: (path, text) => {
      written[path] = text;
    },
    appendFile: (path, text) => {
      if (path === "out") outputs.push(text.trim());
    },
    log: (text) => logs.push(text),
    fetch: fakeGitHub(repo, calls),
  });
  return { code, calls, log: logs.join(""), outputs, written };
};

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");
const BUILT = [".github/workflows/01-pr-ci.yml", ".github/workflows/10-build.yml"];
const OPEN = { GITHUB_REF: "refs/heads/develop", VERSION: "1.2.0" };

describe("FLOW-004 cutting a release", () => {
  it("cuts release/X.Y.Z at develop's head and opens its pull request, starting its checks", async () => {
    const { code, calls, outputs } = await run(
      "open-release",
      { ...OPEN, DISPATCH: "true" },
      { develop: COMMIT, passed: BUILT },
    );
    expect(code).toBe(0);
    expect(writes(calls)).toEqual([
      {
        method: "POST",
        path: "/repos/o/r/git/refs",
        body: { ref: "refs/heads/release/1.2.0", sha: COMMIT },
      },
      expect.objectContaining({
        path: "/repos/o/r/pulls",
        body: expect.objectContaining({
          head: "release/1.2.0",
          base: "main",
          title: "Release 1.2.0",
        }),
      }),
      {
        method: "POST",
        path: "/repos/o/r/actions/workflows/01-pr-ci.yml/dispatches",
        body: { ref: "release/1.2.0", inputs: { pull_request: "21" } },
      },
      {
        method: "POST",
        path: "/repos/o/r/actions/workflows/02-codeql.yml/dispatches",
        body: { ref: "release/1.2.0", inputs: { pull_request: "21" } },
      },
      {
        method: "POST",
        path: "/repos/o/r/actions/workflows/03-review-policy.yml/dispatches",
        body: { ref: "main", inputs: { pull_request: "21" } },
      },
    ]);
    expect(outputs).toContain("pull-request=21");
  });

  it("starts no checks itself when a release app opened the pull request", async () => {
    const { calls } = await run(
      "open-release",
      { ...OPEN, DISPATCH: "false", COMMIT },
      { passed: BUILT },
    );
    expect(writes(calls).map((call) => call.path)).toEqual([
      "/repos/o/r/git/refs",
      "/repos/o/r/pulls",
    ]);
  });

  it("says what to turn on when GitHub will not let the workflow open the pull request", async () => {
    const { code, log } = await run(
      "open-release",
      { ...OPEN, DISPATCH: "true" },
      { develop: COMMIT, passed: BUILT, forbidPulls: true },
    );
    expect(code).toBe(1);
    expect(log).toContain('turn on "Allow GitHub Actions to create and approve pull requests"');
    expect(log).toContain("it resumes from release/1.2.0");
  });

  it("resumes a release an earlier run cut, without a second branch or pull request", async () => {
    const branch = { refs: { "heads/release/1.2.0": COMMIT }, passed: BUILT };
    const resumed = await run("open-release", { ...OPEN, DISPATCH: "false" }, branch);
    expect(resumed.code).toBe(0);
    expect(writes(resumed.calls).map((call) => call.path)).toEqual(["/repos/o/r/pulls"]);
    expect(resumed.calls.some((call) => call.path.endsWith("/git/ref/heads/develop"))).toBe(false);

    const both = await run(
      "open-release",
      { ...OPEN, DISPATCH: "true" },
      { ...branch, open: { "release/1.2.0": 30 } },
    );
    expect(both.code).toBe(0);
    expect(writes(both.calls).map((call) => call.path)).toEqual([
      "/repos/o/r/actions/workflows/01-pr-ci.yml/dispatches",
      "/repos/o/r/actions/workflows/02-codeql.yml/dispatches",
      "/repos/o/r/actions/workflows/03-review-policy.yml/dispatches",
    ]);
    expect(both.outputs).toContain("pull-request=30");
  });

  it.each<[string, Record<string, string>, Repo, string]>([
    ["off develop", { GITHUB_REF: "refs/heads/main" }, {}, "run the release workflow from develop"],
    ["with a version that is not X.Y.Z", { VERSION: "1.2" }, {}, "1.2 is not a version"],
    [
      "of a version already released",
      {},
      { refs: { "tags/v1.2.0": MAIN } },
      "v1.2.0 is already released",
    ],
    [
      "while its branch is at another commit",
      { COMMIT },
      { refs: { "heads/release/1.2.0": MAIN }, passed: BUILT },
      `release/1.2.0 already exists at ${MAIN}`,
    ],
    ["of a commit that is not a full SHA", { COMMIT: "abc" }, {}, "abc is not a full commit SHA"],
    [
      "of a commit not on develop",
      { COMMIT },
      { compare: { develop: { ahead_by: 1, behind_by: 0 } }, passed: BUILT },
      "is not on develop",
    ],
    ["before CI passed", { COMMIT }, { passed: [] }, "CI has not passed on develop"],
    [
      "before the build passed",
      { COMMIT },
      { passed: [".github/workflows/01-pr-ci.yml"] },
      "The build has not passed on develop",
    ],
  ])("refuses to cut a release %s", async (_case, env, repo, message) => {
    const { code, calls, log } = await run("open-release", { ...OPEN, ...env }, repo);
    expect(code).toBe(1);
    expect(log).toContain(message);
    expect(writes(calls)).toEqual([]);
  });
});

describe("FLOW-005 after a release merges into main", () => {
  const merged = (head: string, mergeSha = MAIN) => ({
    number: 21,
    base: { ref: "main" },
    head: { ref: head, sha: COMMIT },
    merged_at: "2026-10-25T00:00:00Z",
    merge_commit_sha: mergeSha,
    body: null,
  });

  it("finds the release and checks main has exactly its tree", async () => {
    const { code, outputs } = await run(
      "identify",
      { GITHUB_SHA: MAIN },
      { pulls: [merged("release/1.2.0")] },
    );
    expect(code).toBe(0);
    expect(outputs).toEqual([
      "release=true",
      "kind=release",
      "version=1.2.0",
      `candidate=${COMMIT}`,
      "pull-request=21",
    ]);
    const hotfix = await run("identify", { GITHUB_SHA: MAIN }, { pulls: [merged("hotfix/1.2.1")] });
    expect(hotfix.outputs).toContain("kind=hotfix");
  });

  it("has nothing to do for other pushes to main", async () => {
    for (const pulls of [
      [],
      [merged("sync/x")],
      [merged("release/1.2.0", "a".repeat(40))],
      [merged("hotfix/01.2.3")],
    ]) {
      const { code, outputs } = await run("identify", { GITHUB_SHA: MAIN }, { pulls });
      expect(code).toBe(0);
      expect(outputs).toEqual(["release=false"]);
    }
  });

  it("fails when main's tree differs from the candidate's", async () => {
    const { code, log } = await run(
      "identify",
      { GITHUB_SHA: MAIN },
      { pulls: [merged("release/1.2.0")], trees: { [MAIN]: TREE, [COMMIT]: "1".repeat(40) } },
    );
    expect(code).toBe(1);
    expect(log).toContain("does not have exactly the tree");
  });

  const MANIFEST_ENV = {
    GITHUB_SHA: MAIN,
    VERSION: "1.2.0",
    KIND: "release",
    CANDIDATE: COMMIT,
    PULL_REQUEST: "21",
    IMAGES_FILE: "images.txt",
  };

  it("writes the manifest and the image subjects to attest it for", async () => {
    const { code, written, outputs } = await run(
      "manifest",
      MANIFEST_ENV,
      {},
      {
        "images.txt": `api ghcr.io/o/r/api ${DIGEST}\n`,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(written["release-manifest.json"] ?? "")).toEqual({
      schema: "liftoff.release-manifest/v1",
      repository: "o/r",
      version: "1.2.0",
      kind: "release",
      pullRequest: 21,
      source: { commit: MAIN, tree: TREE, candidate: COMMIT },
      images: [{ name: "api", reference: "ghcr.io/o/r/api", digest: DIGEST }],
    });
    expect(written["release-subjects.txt"]).toBe(`${"f".repeat(64)}  ghcr.io/o/r/api\n`);
    expect(outputs).toContain(`predicate-type=${RELEASE_MANIFEST_PREDICATE}`);
  });

  it("refuses an image without a digest", async () => {
    const { code, log } = await run(
      "manifest",
      MANIFEST_ENV,
      {},
      { "images.txt": "api ghcr.io/o/r/api latest" },
    );
    expect(code).toBe(1);
    expect(log).toContain('expected "name reference sha256:digest"');
  });

  const manifest = JSON.stringify({
    version: "1.2.0",
    kind: "release",
    pullRequest: 21,
    source: { commit: MAIN, tree: TREE, candidate: COMMIT },
    images: [{ name: "api", reference: "ghcr.io/o/r/api", digest: DIGEST }],
  });

  it("tags vX.Y.Z on main and publishes the release with its manifest", async () => {
    const { code, calls } = await run(
      "publish",
      { GITHUB_SHA: MAIN, MANIFEST_FILE: "m.json" },
      {},
      { "m.json": manifest },
    );
    expect(code).toBe(0);
    const [tag, release] = writes(calls);
    expect(tag?.body).toEqual({ ref: "refs/tags/v1.2.0", sha: MAIN });
    expect(release?.body).toMatchObject({ tag_name: "v1.2.0", target_commitish: MAIN });
    expect(String(release?.body?.body)).toContain(`ghcr.io/o/r/api@${DIGEST}`);
  });

  it("finishes a publish an earlier run started on the same commit", async () => {
    const env = { GITHUB_SHA: MAIN, MANIFEST_FILE: "m.json" };
    const tagged = await run(
      "publish",
      env,
      { refs: { "tags/v1.2.0": MAIN } },
      { "m.json": manifest },
    );
    expect(tagged.code).toBe(0);
    expect(writes(tagged.calls).map((call) => call.path)).toEqual(["/repos/o/r/releases"]);

    // GitHub adds its generated notes after the body it was given.
    const body = `${String(writes(tagged.calls)[0]?.body?.body)}\n\n## What's Changed\n`;
    const done = await run(
      "publish",
      env,
      { refs: { "tags/v1.2.0": MAIN }, releases: { "v1.2.0": body } },
      { "m.json": manifest },
    );
    expect(done.code).toBe(0);
    expect(writes(done.calls)).toEqual([]);
    expect(done.log).toContain("Already published");

    const other = await run(
      "publish",
      env,
      { refs: { "tags/v1.2.0": MAIN }, releases: { "v1.2.0": "Written by hand." } },
      { "m.json": manifest },
    );
    expect(other.code).toBe(1);
    expect(other.log).toContain("the GitHub release for v1.2.0 exists without this manifest");
    expect(writes(other.calls)).toEqual([]);
  });

  it("never publishes a version twice, or a manifest for another commit", async () => {
    const twice = await run(
      "publish",
      { GITHUB_SHA: MAIN, MANIFEST_FILE: "m.json" },
      { refs: { "tags/v1.2.0": COMMIT } },
      { "m.json": manifest },
    );
    expect(twice.log).toContain(`v1.2.0 already exists at ${COMMIT}`);
    const other = await run(
      "publish",
      { GITHUB_SHA: COMMIT, MANIFEST_FILE: "m.json" },
      {},
      { "m.json": manifest },
    );
    expect(other.log).toContain(`the manifest is for ${MAIN}`);
    expect([...writes(twice.calls), ...writes(other.calls)]).toEqual([]);
  });

  it("opens the pull request that brings main back into develop", async () => {
    const { code, calls } = await run(
      "sync",
      { GITHUB_SHA: MAIN, VERSION: "1.2.0", DISPATCH: "true" },
      { compare: { develop: { ahead_by: 1, behind_by: 0 } } },
    );
    expect(code).toBe(0);
    expect(writes(calls).map((call) => [call.path, call.body?.ref ?? call.body?.base])).toEqual([
      ["/repos/o/r/git/refs", "refs/heads/sync/main-into-develop-1.2.0"],
      ["/repos/o/r/pulls", "develop"],
      ["/repos/o/r/actions/workflows/01-pr-ci.yml/dispatches", "sync/main-into-develop-1.2.0"],
      ["/repos/o/r/actions/workflows/02-codeql.yml/dispatches", "sync/main-into-develop-1.2.0"],
      ["/repos/o/r/actions/workflows/03-review-policy.yml/dispatches", "develop"],
    ]);
  });

  it("says when GitHub will hold the sync pull request's workflows for approval", async () => {
    const diverged = { compare: { develop: { ahead_by: 1, behind_by: 2 } } };
    const body = async (env: Record<string, string>, repo: Repo) =>
      String(
        writes(
          (await run("sync", { GITHUB_SHA: MAIN, VERSION: "1.2.0", ...env }, repo)).calls,
        ).find((call) => call.path === "/repos/o/r/pulls")?.body?.body,
      );
    // The workflow token's merge of develop is the newest commit.
    expect(await body({ DISPATCH: "true" }, diverged)).toContain('"Approve workflows to run"');
    // Not with a release app, nor without a merge.
    expect(await body({ DISPATCH: "false" }, diverged)).not.toContain("Approve workflows");
    const ahead = { compare: { develop: { ahead_by: 1, behind_by: 0 } } };
    expect(await body({ DISPATCH: "true" }, ahead)).not.toContain("Approve workflows");
    // Nor once a person resolved a conflict there, so the merge has nothing to do.
    const resolved = {
      ...diverged,
      hasDevelop: true,
      refs: { "heads/sync/main-into-develop-1.2.0": COMMIT },
      authors: { [COMMIT]: "maintainer" },
    };
    expect(await body({ DISPATCH: "true" }, resolved)).not.toContain("Approve workflows");
  });

  it("adds the approval note once to a sync pull request an earlier run opened", async () => {
    const earlier = {
      compare: { develop: { ahead_by: 1, behind_by: 2 } },
      refs: { "heads/sync/main-into-develop-1.2.0": MERGED },
      open: { "sync/main-into-develop-1.2.0": 31 },
      hasDevelop: true,
    };
    const env = { GITHUB_SHA: MAIN, VERSION: "1.2.0", DISPATCH: "true" };
    const rerun = await run("sync", env, { ...earlier, bodies: { 31: "Merges main." } });
    expect(rerun.code).toBe(0);
    const patched = writes(rerun.calls).filter((call) => call.method === "PATCH");
    expect(patched.map((call) => call.path)).toEqual(["/repos/o/r/pulls/31"]);
    expect(String(patched[0]?.body?.body)).toMatch(
      /^Merges main\.\n\n.*"Approve workflows to run"/s,
    );
    expect(rerun.log).toContain("Approve workflows to run");

    const noted = String(patched[0]?.body?.body);
    const again = await run("sync", env, { ...earlier, bodies: { 31: noted } });
    expect(writes(again.calls).filter((call) => call.method === "PATCH")).toEqual([]);
  });

  it("merges develop into the sync branch when develop moved on", async () => {
    const diverged = { compare: { develop: { ahead_by: 1, behind_by: 2 } } };
    const env = { GITHUB_SHA: MAIN, VERSION: "1.2.0", DISPATCH: "false" };
    const merged = await run("sync", env, diverged);
    expect(merged.code).toBe(0);
    expect(
      writes(merged.calls).map((call) => [call.path, call.body?.base ?? call.body?.ref]),
    ).toEqual([
      ["/repos/o/r/git/refs", "refs/heads/sync/main-into-develop-1.2.0"],
      ["/repos/o/r/merges", "sync/main-into-develop-1.2.0"],
      ["/repos/o/r/pulls", "develop"],
    ]);
    expect(writes(merged.calls)[1]?.body?.head).toBe("develop");
    expect(String(writes(merged.calls)[2]?.body?.body)).not.toContain("conflict");

    const conflicting = await run("sync", env, { ...diverged, conflict: true });
    expect(conflicting.code).toBe(0);
    expect(String(writes(conflicting.calls).at(-1)?.body?.body)).toContain(
      "develop has changes that conflict with main",
    );
    expect(conflicting.log).toContain("resolve that in the pull request");
  });

  it("reuses the sync branch and pull request an earlier run opened", async () => {
    const { code, calls } = await run(
      "sync",
      { GITHUB_SHA: MAIN, VERSION: "1.2.0", DISPATCH: "false" },
      {
        compare: { develop: { ahead_by: 1, behind_by: 0 } },
        refs: { "heads/sync/main-into-develop-1.2.0": MAIN },
        open: { "sync/main-into-develop-1.2.0": 31 },
      },
    );
    expect(code).toBe(0);
    expect(writes(calls)).toEqual([]);
  });

  it("opens no sync when develop already has main", async () => {
    const { code, calls, log } = await run("sync", { GITHUB_SHA: MAIN, VERSION: "1.2.0" });
    expect(code).toBe(0);
    expect(writes(calls)).toEqual([]);
    expect(log).toContain("develop already has everything on main");
  });

  it("fails without its configuration", async () => {
    const { code, log } = await run("identify", { GITHUB_TOKEN: "" });
    expect(code).toBe(1);
    expect(log).toContain("GITHUB_TOKEN is not set");
  });
});

describe("FLOW-007 checking a candidate, and a release for production", () => {
  it("checks a candidate without cutting anything", async () => {
    const { code, calls, outputs } = await run("candidate", { ...OPEN, COMMIT }, { passed: BUILT });
    expect(code).toBe(0);
    expect(outputs).toEqual([`commit=${COMMIT}`]);
    expect(writes(calls)).toEqual([]);
    const unbuilt = await run("candidate", { ...OPEN, COMMIT }, { passed: [] });
    expect(unbuilt.code).toBe(1);
  });

  it("says in the release whether staging qualified it", async () => {
    for (const [qualified, text] of [
      ["true", "Staging qualified it."],
      ["false", "It was not qualified on staging: Azure deployments are off."],
    ]) {
      const { calls } = await run(
        "open-release",
        { ...OPEN, COMMIT, QUALIFIED: qualified ?? "" },
        {
          passed: BUILT,
        },
      );
      const pr = writes(calls).find((call) => call.path.endsWith("/pulls"));
      expect(String(pr?.body?.body)).toContain(text);
    }
  });

  const manifest = {
    schema: "liftoff.release-manifest/v1",
    repository: "o/r",
    version: "1.2.0",
    kind: "release",
    pullRequest: 21,
    source: { commit: MAIN, tree: TREE, candidate: COMMIT },
    images: [
      { name: "api", reference: "ghcr.io/o/r/api", digest: DIGEST },
      { name: "web", reference: "ghcr.io/o/r/web", digest: DIGEST },
    ],
  };
  const published = (body = manifest): Repo => ({
    releases: { "v1.2.0": `Notes\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`` },
    refs: { "tags/v1.2.0": MAIN },
  });
  const PRODUCTION = {
    GITHUB_REF: "refs/heads/main",
    VERSION: "1.2.0",
    IMAGES: "api web",
    MANIFEST_FILE: "m.json",
  };

  it("finds a release on main with its qualified tree, and its images", async () => {
    const { code, outputs, written } = await run("production", PRODUCTION, published());
    expect(code).toBe(0);
    expect(outputs.slice(0, 2)).toEqual([`commit=${MAIN}`, `candidate=${COMMIT}`]);
    // A delimiter nobody can know beforehand.
    const [, delimiter] = /^expected<<(LIFTOFF_[0-9a-f-]{36})\n/.exec(outputs[2] ?? "") ?? [];
    expect(outputs[2]).toBe(`expected<<${delimiter}\napi ${DIGEST}\nweb ${DIGEST}\n${delimiter}`);
    // The manifest as read, for the attestations to be compared with.
    expect(JSON.parse(written["m.json"] ?? "")).toEqual(manifest);
  });

  it("refuses a manifest anyone could have edited into something else", async () => {
    const injected = {
      ...manifest,
      images: [
        {
          name: `api\nLIFTOFF_EOF\ncandidate=${"e".repeat(40)}\nexpected<<LIFTOFF_EOF\napi`,
          reference: "ghcr.io/o/r/api",
          digest: DIGEST,
        },
      ],
    };
    for (const [body, message] of [
      [injected, "the release manifest is invalid: images.0.name"],
      [{ ...manifest, source: { ...manifest.source, candidate: "main" } }, "source.candidate"],
      [{ ...manifest, images: [...manifest.images, manifest.images[0]] }, "lists an image twice"],
      [{ ...manifest, extra: true }, "the release manifest is invalid"],
      [
        { ...manifest, images: manifest.images.slice(0, 1) },
        "does not list exactly the images api, web",
      ],
    ] as const) {
      const { code, log, outputs, written } = await run(
        "production",
        PRODUCTION,
        published(body as typeof manifest),
      );
      expect(code).toBe(1);
      expect(log).toContain(message);
      expect(outputs).toEqual([]);
      expect(written["m.json"]).toBeUndefined();
    }
  });

  it.each<[string, Record<string, string>, Repo, string]>([
    ["off main", { GITHUB_REF: "refs/heads/develop" }, published(), "from main only"],
    ["of a release that does not exist", { VERSION: "9.9.9" }, published(), "HTTP 404"],
    [
      "of a release without a manifest",
      {},
      { ...published(), releases: { "v1.2.0": "Notes" } },
      "has no manifest",
    ],
    [
      "whose manifest is for another release",
      {},
      published({ ...manifest, version: "1.1.0" }),
      "manifest is for another release",
    ],
    ["whose tag moved", {}, { ...published(), refs: { "tags/v1.2.0": COMMIT } }, "points at"],
    [
      "not on main",
      {},
      { ...published(), compare: { main: { ahead_by: 1, behind_by: 0 } } },
      "is not on main",
    ],
    [
      "whose tree differs from the candidate's",
      {},
      { ...published(), trees: { [COMMIT]: "1".repeat(40) } },
      "does not have exactly the tree",
    ],
  ])("refuses a production deploy %s", async (_case, env, repo, message) => {
    const { code, log } = await run("production", { ...PRODUCTION, ...env }, repo);
    expect(code).toBe(1);
    expect(log).toContain(message);
  });
});
