// The release steps of a generated GitFlow project, bundled into
// .github/liftoff/release.mjs and run by its release workflows:
//
// - candidate: checks a develop commit may be released: CI and the build
//   passed, and the version is new. Staging is deployed and qualified with it
//   before open-release when the project has a staging environment.
// - open-release: cuts release/X.Y.Z at that commit and opens its pull
//   request into main.
// - production: finds a published release on main for a production deploy,
//   and checks its lineage again.
// - identify: on a push to main, finds the release or hotfix pull request it
//   merged, and checks main now has exactly that candidate's tree.
// - manifest: writes the release manifest: the commit, its tree, the
//   candidate and each image by digest.
// - publish: tags vX.Y.Z on main and creates the GitHub release.
// - sync: opens the pull request that brings main back into develop.
//
// Each step can be re-run after a failure: it finishes what an earlier run
// started at the same commit (a branch, a tag, a release, a pull request)
// rather than refusing it or doing it twice.
//
// GitHub starts no workflows for pull requests opened with the workflow
// token. With DISPATCH=true, open-release and sync start CI, CodeQL and the
// review policy for the new pull request themselves, at its exact head
// commit; they never report a check as passed.
import { randomUUID } from "node:crypto";
import { GitHubClient, GitHubError } from "../adapters/github.ts";
import {
  isVersion,
  parseImages,
  parseReleaseManifest,
  RELEASE_MANIFEST_PREDICATE,
  type ReleaseManifest,
  releaseManifest,
  subjectChecksums,
} from "../domain/governance/release.ts";
import {
  compare,
  dispatch,
  find,
  type PullRequest,
  refExists,
  refSha,
  treeOf,
  WORKFLOWS,
  workflowPassed,
} from "./gitflow-github.ts";

export const COMMANDS = [
  "candidate",
  "open-release",
  "identify",
  "manifest",
  "publish",
  "sync",
  "production",
] as const;
export type Command = (typeof COMMANDS)[number];

export interface ReleaseEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, text: string) => void;
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface Context {
  readonly client: GitHubClient;
  readonly repository: string;
  readonly env: ReleaseEnvironment["env"];
  readonly io: ReleaseEnvironment;
  readonly summary: (text: string) => void;
  readonly output: (name: string, value: string) => void;
}

/** Runs one release step and returns the process exit code: 0 done, 1 failed. */
export async function main(command: Command, io: ReleaseEnvironment): Promise<number> {
  const { env } = io;
  const summary = (text: string) => {
    if (env.GITHUB_STEP_SUMMARY) io.appendFile(env.GITHUB_STEP_SUMMARY, text);
    io.log(text);
  };
  try {
    const context: Context = {
      client: new GitHubClient({
        token: required(env, "GITHUB_TOKEN"),
        ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
        ...(io.fetch ? { fetch: io.fetch } : {}),
      }),
      repository: required(env, "GITHUB_REPOSITORY"),
      env,
      io,
      summary,
      output: (name, value) => {
        if (!env.GITHUB_OUTPUT) return;
        // A value over several lines needs a delimiter it cannot contain,
        // one nobody can guess and write into the value beforehand.
        const delimiter = `LIFTOFF_${randomUUID()}`;
        if (value.includes(delimiter)) throw new Error(`the ${name} output cannot be written`);
        io.appendFile(
          env.GITHUB_OUTPUT,
          value.includes("\n")
            ? `${name}<<${delimiter}\n${value}\n${delimiter}\n`
            : `${name}=${value}\n`,
        );
      },
    };
    const steps: Record<Command, (context: Context) => Promise<void>> = {
      candidate: async (c) => {
        const { version, commit } = await checkCandidate(c);
        c.output("commit", commit);
        c.summary(`## Release ${version}\n\n${commit} may be released.\n`);
      },
      "open-release": openRelease,
      production,
      identify,
      manifest: writeManifest,
      publish,
      sync,
    };
    await steps[command](context);
    return 0;
  } catch (error) {
    summary(`## Release: failed\n\n${(error as Error).message}\n`);
    return 1;
  }
}

/** Checks a develop commit may be released as the version, and returns them. */
async function checkCandidate(
  context: Context,
): Promise<{ version: string; branch: string; commit: string; cut: string | undefined }> {
  const { client, repository, env } = context;
  if (env.GITHUB_REF !== "refs/heads/develop") {
    throw new Error("run the release workflow from develop");
  }
  const version = required(env, "VERSION").trim();
  if (!isVersion(version)) throw new Error(`${version} is not a version such as 1.2.0`);
  const branch = `release/${version}`;
  if (await refExists(client, repository, `tags/v${version}`)) {
    throw new Error(`v${version} is already released; choose the next version`);
  }
  // A re-run resumes the release an earlier run cut, at the same commit.
  const cut = await refSha(client, repository, `heads/${branch}`);
  const commit =
    env.COMMIT?.trim() ||
    cut ||
    (await client.get<{ object: { sha: string } }>(`/repos/${repository}/git/ref/heads/develop`))
      .object.sha;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${commit} is not a full commit SHA`);
  if (cut !== undefined && cut !== commit) {
    throw new Error(`${branch} already exists at ${cut}; finish or delete that release first`);
  }
  if ((await compare(client, repository, "develop", commit)).ahead_by > 0) {
    throw new Error(`${commit} is not on develop; a release is an exact develop commit`);
  }
  for (const [what, workflow] of [
    ["CI", WORKFLOWS.ci],
    ["The build", WORKFLOWS.build],
  ] as const) {
    if (!(await workflowPassed(client, repository, commit, workflow, "develop"))) {
      throw new Error(`${what} has not passed on develop for ${commit}`);
    }
  }
  return { version, branch, commit, cut };
}

/** Cuts release/X.Y.Z at a develop commit that passed CI and the build, and opens its pull request. */
async function openRelease(context: Context): Promise<void> {
  const { client, repository } = context;
  const { version, branch, commit, cut } = await checkCandidate(context);
  if (cut === undefined) {
    await client.post(`/repos/${repository}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit,
    });
  }
  const pr = await openPullRequest(context, {
    title: `Release ${version}`,
    head: branch,
    base: "main",
    body: [
      `Releases ${commit}, a develop commit whose CI and build passed.`,
      ...(context.env.QUALIFIED === undefined
        ? []
        : [
            "",
            context.env.QUALIFIED === "true"
              ? "Staging qualified it."
              : "It was not qualified on staging: Azure deployments are off.",
          ]),
      "",
      "Merge it with a merge commit once its checks pass. The release workflow then tags it, publishes its manifest and opens the pull request that brings main back into develop.",
    ].join("\n"),
  });
  await startChecks(context, pr.number, branch, "main");
  context.output("pull-request", String(pr.number));
  context.summary(
    `## Release ${version}\n\nIts pull request is [#${pr.number}](${pr.html_url}), for ${commit}.\n`,
  );
}

/** Finds the release or hotfix that a push to main merged, and checks its lineage. */
async function identify(context: Context): Promise<void> {
  const { client, repository, env } = context;
  const sha = required(env, "GITHUB_SHA");
  const pulls = await client.get<PullRequest[]>(`/repos/${repository}/commits/${sha}/pulls`);
  const merged = pulls.find(
    (pr) => pr.base.ref === "main" && pr.merged_at && pr.merge_commit_sha === sha,
  );
  const match = /^(release|hotfix)\/(.+)$/.exec(merged?.head.ref ?? "");
  if (!merged || !match || !isVersion(match[2] ?? "")) {
    context.output("release", "false");
    context.summary("## Release\n\nThis push to main did not merge a release or hotfix.\n");
    return;
  }
  const [, kind = "", version = ""] = match;
  if (
    (await treeOf(client, repository, sha)) !== (await treeOf(client, repository, merged.head.sha))
  ) {
    throw new Error(
      `main at ${sha} does not have exactly the tree of ${merged.head.sha}, the candidate CI qualified`,
    );
  }
  for (const [name, value] of [
    ["release", "true"],
    ["kind", kind],
    ["version", version],
    ["candidate", merged.head.sha],
    ["pull-request", String(merged.number)],
  ] as const) {
    context.output(name, value);
  }
  context.summary(
    `## Release ${version}\n\n#${merged.number} merged ${merged.head.sha} into main.\n`,
  );
}

/** Writes the release manifest and the image subjects to attest it for. */
async function writeManifest(context: Context): Promise<void> {
  const { client, repository, env, io } = context;
  const commit = required(env, "GITHUB_SHA");
  const kind = required(env, "KIND");
  if (kind !== "release" && kind !== "hotfix") throw new Error(`unknown kind ${kind}`);
  const manifest = releaseManifest({
    repository,
    version: required(env, "VERSION"),
    kind,
    pullRequest: Number(required(env, "PULL_REQUEST")),
    source: {
      commit,
      tree: await treeOf(client, repository, commit),
      candidate: required(env, "CANDIDATE"),
    },
    images: parseImages(io.readFile(required(env, "IMAGES_FILE"))),
  });
  const manifestFile = env.MANIFEST_FILE ?? "release-manifest.json";
  const subjectsFile = env.SUBJECTS_FILE ?? "release-subjects.txt";
  io.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  io.writeFile(subjectsFile, `${subjectChecksums(manifest)}\n`);
  context.output("manifest", manifestFile);
  context.output("subjects", subjectsFile);
  context.output("predicate-type", RELEASE_MANIFEST_PREDICATE);
}

/** Tags vX.Y.Z on main and creates the GitHub release with its manifest. */
async function publish(context: Context): Promise<void> {
  const { client, repository, env, io } = context;
  const sha = required(env, "GITHUB_SHA");
  const manifest = JSON.parse(io.readFile(required(env, "MANIFEST_FILE"))) as ReleaseManifest;
  const tag = `v${manifest.version}`;
  if (manifest.source.commit !== sha) {
    throw new Error(`the manifest is for ${manifest.source.commit}, not ${sha}`);
  }
  const tagged = await refSha(client, repository, `tags/${tag}`);
  if (tagged !== undefined && tagged !== sha) {
    throw new Error(`${tag} already exists at ${tagged}; a version is released once`);
  }
  // A re-run finishes a release an earlier run tagged on this commit.
  if (tagged === undefined) {
    await client.post(`/repos/${repository}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  }
  const recorded = JSON.stringify(manifest, null, 2);
  const published = await find<{ html_url: string; body: string | null }>(
    client,
    `/repos/${repository}/releases/tags/${tag}`,
  );
  if (published && !published.body?.includes(recorded)) {
    throw new Error(
      `the GitHub release for ${tag} exists without this manifest; check it and delete it to publish again`,
    );
  }
  const release =
    published ??
    (await client.post<{ html_url: string }>(`/repos/${repository}/releases`, {
      tag_name: tag,
      target_commitish: sha,
      name: tag,
      generate_release_notes: true,
      body: [
        `The ${manifest.kind} of ${manifest.source.candidate}, merged by #${manifest.pullRequest}. Its images, by digest:`,
        "",
        ...manifest.images.map((image) => `- \`${image.reference}@${image.digest}\``),
        "",
        "The manifest below is also attested for each image. Verify one with",
        `\`gh attestation verify oci://IMAGE@DIGEST --repo ${repository} --predicate-type ${RELEASE_MANIFEST_PREDICATE}\`.`,
        "",
        "```json",
        recorded,
        "```",
      ].join("\n"),
    }));
  context.summary(
    `## Release ${manifest.version}\n\n${published ? "Already published" : "Published"} [${tag}](${release.html_url}).\n`,
  );
}

/** Opens the pull request that brings main back into develop. */
async function sync(context: Context): Promise<void> {
  const { client, repository, env } = context;
  const sha = required(env, "GITHUB_SHA");
  const version = required(env, "VERSION");
  const branch = `sync/main-into-develop-${version}`;
  const diverged = await compare(client, repository, "develop", sha);
  if (diverged.ahead_by === 0) {
    context.summary("## Sync\n\ndevelop already has everything on main.\n");
    return;
  }
  if (!(await refExists(client, repository, `heads/${branch}`))) {
    await client.post(`/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  // When develop moved on, the branch also takes it in: it is then up to
  // date with develop, and its checks cover exactly what merging gives.
  let conflicts = false;
  if (diverged.behind_by > 0) {
    try {
      await client.post(`/repos/${repository}/merges`, {
        base: branch,
        head: "develop",
        commit_message: `Merge develop into ${branch}`,
      });
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 409)) throw error;
      conflicts = true;
    }
  }
  // GitHub holds a pull request's own workflows for a maintainer's approval
  // when its newest commit is the workflow token's, as a merge of develop
  // made here, now or by an earlier run, is; the required checks wait on
  // those runs, not on the ones started for it. A branch whose newest commit
  // a person made, such as one where they resolved a conflict, is not held.
  const held =
    env.DISPATCH === "true" && !conflicts && (await newestCommitByWorkflow(context, branch));
  const approve =
    "Its newest commit is the release workflow's merge of develop, so GitHub holds this pull request's own workflows until a maintainer approves them: choose \"Approve workflows to run\" on the pull request, and its required checks report once they pass.";
  const pr = await openPullRequest(context, {
    title: `Bring ${version} back into develop`,
    head: branch,
    base: "develop",
    body: [
      `Merges main at ${sha}, after ${version}, back into develop. Merge it with a merge commit, never a squash, so develop keeps main's history.`,
      ...(conflicts
        ? [
            "",
            "develop has changes that conflict with main. Merge develop into this branch, resolve them and push.",
          ]
        : []),
      ...(held ? ["", approve] : []),
    ].join("\n"),
  });
  // A pull request an earlier run opened gets the note too, added once.
  if (held && !(pr.body ?? "").includes(approve)) {
    await client.patch(`/repos/${repository}/pulls/${pr.number}`, {
      body: `${pr.body ?? ""}\n\n${approve}`,
    });
  }
  await startChecks(context, pr.number, branch, "develop");
  context.summary(
    `## Sync\n\nThe pull request into develop is [#${pr.number}](${pr.html_url}).${conflicts ? " develop conflicts with main; resolve that in the pull request." : ""}${held ? ` ${approve}` : ""}\n`,
  );
}

/** Whether a branch's newest commit is the workflow token's, made by github-actions[bot]. */
async function newestCommitByWorkflow(context: Context, branch: string): Promise<boolean> {
  const { client, repository } = context;
  const sha = await refSha(client, repository, `heads/${branch}`);
  if (sha === undefined) return false;
  const commit = await client.get<{ author?: { login?: string } | null }>(
    `/repos/${repository}/commits/${sha}`,
  );
  return commit.author?.login === "github-actions[bot]";
}

interface OpenedPullRequest {
  number: number;
  html_url: string;
  body?: string | null;
}

/** Opens a pull request, or finds the one an earlier run opened from the same branch. */
async function openPullRequest(
  context: Context,
  request: { title: string; head: string; base: string; body: string },
): Promise<OpenedPullRequest> {
  const { client, repository } = context;
  const owner = repository.split("/")[0] ?? "";
  const [open] = await client.get<OpenedPullRequest[]>(
    `/repos/${repository}/pulls?head=${encodeURIComponent(`${owner}:${request.head}`)}&base=${encodeURIComponent(request.base)}&state=open`,
  );
  if (open) return open;
  try {
    return await client.post(`/repos/${repository}/pulls`, request);
  } catch (error) {
    // New repositories do not let the workflow token open pull requests.
    if (error instanceof GitHubError && error.status === 403 && context.env.DISPATCH === "true") {
      throw new Error(
        `GitHub does not let workflows open pull requests in ${repository}: turn on "Allow GitHub Actions to create and approve pull requests" in its Settings > Actions > General, or set up a release app (RELEASE_APP_CLIENT_ID and RELEASE_APP_PRIVATE_KEY), then run this again; it resumes from ${request.head}`,
      );
    }
    throw error;
  }
}

/**
 * Finds the release to deploy to production: its tag must be on main, and
 * main's history at the tag must have exactly the tree of the candidate CI
 * qualified, as its manifest records. Outputs the candidate and its images.
 */
async function production(context: Context): Promise<void> {
  const { client, repository, env } = context;
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("deploy to production from main only");
  }
  const version = required(env, "VERSION").trim();
  if (!isVersion(version)) throw new Error(`${version} is not a version such as 1.2.0`);
  const release = await client.get<{ body: string | null }>(
    `/repos/${repository}/releases/tags/v${version}`,
  );
  const json = /```json\n([\s\S]*?)\n```/.exec(release.body ?? "")?.[1];
  if (json === undefined) throw new Error(`the v${version} release has no manifest`);
  // Anyone who can edit the release can edit this, so it is checked in full.
  const manifest = parseReleaseManifest(json);
  if (manifest.version !== version || manifest.repository !== repository) {
    throw new Error(`the v${version} release's manifest is for another release`);
  }
  const names = required(env, "IMAGES").split(/\s+/).filter(Boolean).sort();
  if (
    manifest.images
      .map((image) => image.name)
      .sort()
      .join() !== names.join()
  ) {
    throw new Error(
      `the v${version} release's manifest does not list exactly the images ${names.join(", ")}`,
    );
  }
  const tag = (
    await client.get<{ object: { sha: string } }>(`/repos/${repository}/git/ref/tags/v${version}`)
  ).object.sha;
  if (tag !== manifest.source.commit) {
    throw new Error(
      `v${version} points at ${tag}, not ${manifest.source.commit} as its manifest says`,
    );
  }
  if ((await compare(client, repository, "main", tag)).ahead_by > 0) {
    throw new Error(`v${version} is not on main`);
  }
  const trees = [
    await treeOf(client, repository, tag),
    await treeOf(client, repository, manifest.source.candidate),
  ];
  if (trees.some((tree) => tree !== manifest.source.tree)) {
    throw new Error(
      `v${version} does not have exactly the tree of ${manifest.source.candidate}, the candidate CI qualified`,
    );
  }
  // The manifest as read, for the attestations to be compared with.
  context.io.writeFile(required(env, "MANIFEST_FILE"), `${JSON.stringify(manifest, null, 2)}\n`);
  context.output("commit", manifest.source.commit);
  context.output("candidate", manifest.source.candidate);
  context.output(
    "expected",
    manifest.images.map((image) => `${image.name} ${image.digest}`).join("\n"),
  );
  context.summary(
    `## Production ${version}\n\nDeploying ${manifest.source.candidate}'s images by digest.\n`,
  );
}

/**
 * Starts CI on the pull request's branch and the review policy on its base,
 * when it was opened with the workflow token and so started nothing itself.
 */
async function startChecks(context: Context, pr: number, head: string, base: string) {
  if (context.env.DISPATCH !== "true") return;
  const { client, repository } = context;
  const inputs = { pull_request: String(pr) };
  await dispatch(client, repository, WORKFLOWS.ci, head, inputs);
  await dispatch(client, repository, WORKFLOWS.codeql, head, inputs);
  await dispatch(client, repository, WORKFLOWS.reviewPolicy, base, inputs);
  context.summary(
    `Started CI, CodeQL and the review policy for #${pr}: pull requests opened with the workflow token start no workflows themselves.\n\n`,
  );
}

function required(env: ReleaseEnvironment["env"], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
