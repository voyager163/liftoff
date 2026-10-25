// The release steps of a generated GitFlow project, bundled into
// .github/liftoff/release.mjs and run by its release workflows:
//
// - open-release: cuts release/X.Y.Z at a develop commit whose CI and build
//   passed, and opens its pull request into main.
// - identify: on a push to main, finds the release or hotfix pull request it
//   merged, and checks main now has exactly that candidate's tree.
// - manifest: writes the release manifest: the commit, its tree, the
//   candidate and each image by digest.
// - publish: tags vX.Y.Z on main and creates the GitHub release.
// - sync: opens the pull request that brings main back into develop.
//
// GitHub starts no workflows for pull requests opened with the workflow
// token. With DISPATCH=true, open-release and sync start CI and the review
// policy for the new pull request themselves, at its exact head commit; they
// never report a check as passed.
import { GitHubClient } from "../adapters/github.ts";
import {
  isVersion,
  parseImages,
  RELEASE_MANIFEST_PREDICATE,
  type ReleaseManifest,
  releaseManifest,
  subjectChecksums,
} from "../domain/governance/release.ts";
import {
  compare,
  dispatch,
  type PullRequest,
  refExists,
  treeOf,
  WORKFLOWS,
  workflowPassed,
} from "./gitflow-github.ts";

export const COMMANDS = ["open-release", "identify", "manifest", "publish", "sync"] as const;
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
        if (env.GITHUB_OUTPUT) io.appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`);
      },
    };
    const steps: Record<Command, (context: Context) => Promise<void>> = {
      "open-release": openRelease,
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

/** Cuts release/X.Y.Z at a develop commit that passed CI and the build, and opens its pull request. */
async function openRelease(context: Context): Promise<void> {
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
  if (await refExists(client, repository, `heads/${branch}`)) {
    throw new Error(`${branch} already exists; finish or delete that release first`);
  }
  const commit =
    env.COMMIT?.trim() ||
    (await client.get<{ object: { sha: string } }>(`/repos/${repository}/git/ref/heads/develop`))
      .object.sha;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${commit} is not a full commit SHA`);
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
  await client.post(`/repos/${repository}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: commit,
  });
  const pr = await client.post<{ number: number; html_url: string }>(`/repos/${repository}/pulls`, {
    title: `Release ${version}`,
    head: branch,
    base: "main",
    body: [
      `Releases ${commit}, a develop commit whose CI and build passed.`,
      "",
      "Merge it with a merge commit once its checks pass. The release workflow then tags it, publishes its manifest and opens the pull request that brings main back into develop.",
    ].join("\n"),
  });
  await startChecks(context, pr.number, branch, "main");
  context.output("pull-request", String(pr.number));
  context.summary(
    `## Release ${version}\n\nOpened [#${pr.number}](${pr.html_url}) for ${commit}.\n`,
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
  const match = /^(release|hotfix)\/(\d+\.\d+\.\d+)$/.exec(merged?.head.ref ?? "");
  if (!merged || !match) {
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
  if (await refExists(client, repository, `tags/${tag}`)) {
    throw new Error(`${tag} already exists; a version is released once`);
  }
  await client.post(`/repos/${repository}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  const release = await client.post<{ html_url: string }>(`/repos/${repository}/releases`, {
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
      JSON.stringify(manifest, null, 2),
      "```",
    ].join("\n"),
  });
  context.summary(`## Release ${manifest.version}\n\nPublished [${tag}](${release.html_url}).\n`);
}

/** Opens the pull request that brings main back into develop. */
async function sync(context: Context): Promise<void> {
  const { client, repository, env } = context;
  const sha = required(env, "GITHUB_SHA");
  const version = required(env, "VERSION");
  const branch = `sync/main-into-develop-${version}`;
  if ((await compare(client, repository, "develop", sha)).ahead_by === 0) {
    context.summary("## Sync\n\ndevelop already has everything on main.\n");
    return;
  }
  if (!(await refExists(client, repository, `heads/${branch}`))) {
    await client.post(`/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  const pr = await client.post<{ number: number; html_url: string }>(`/repos/${repository}/pulls`, {
    title: `Bring ${version} back into develop`,
    head: branch,
    base: "develop",
    body: `Merges main at ${sha}, after ${version}, back into develop. Merge it with a merge commit, never a squash, so develop keeps main's history.`,
  });
  await startChecks(context, pr.number, branch, "develop");
  context.summary(`## Sync\n\nOpened [#${pr.number}](${pr.html_url}) into develop.\n`);
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
  await dispatch(client, repository, WORKFLOWS.reviewPolicy, base, inputs);
  context.summary(
    `Started CI and the review policy for #${pr}: pull requests opened with the workflow token start no workflows themselves.\n\n`,
  );
}

function required(env: ReleaseEnvironment["env"], name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
