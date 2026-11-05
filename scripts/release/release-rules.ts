// The rules a Liftoff release must meet before anything is built or
// published (DIST-003, DIST-004). Pure, so the workflows' scripts and the
// tests share them.

/**
 * X.Y.Z, or X.Y.Z-<prerelease> such as 0.2.0-rc.1, as SemVer 2.0.0 has them:
 * no leading v, and no leading zero in a number, prerelease numbers included.
 */
const IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`,
);

export interface BuildFacts {
  /** The release environment's protection, or null when it does not exist. */
  readonly environment: { readonly reviewers: number; readonly mainOnly: boolean } | null;
  readonly version: string;
  readonly ref: string;
  /** The version in package.json at the commit being released. */
  readonly packageVersion: string;
  /** The conclusion of ci-gate on that commit, or null when it never ran. */
  readonly ciGate: string | null;
  readonly tagExists: boolean;
  readonly releaseExists: boolean;
}

/** Why a release of this commit must not be built; empty when it may. */
export function buildProblems(facts: BuildFacts): string[] {
  const problems: string[] = [];
  if (!SEMVER.test(facts.version)) {
    problems.push(`${facts.version} is not a version such as 1.2.3 or 1.2.3-rc.1`);
  }
  if (facts.ref !== "refs/heads/main") {
    problems.push(`releases are built from main only, not ${facts.ref}`);
  }
  if (facts.packageVersion !== facts.version) {
    problems.push(`package.json says ${facts.packageVersion}, not ${facts.version}`);
  }
  if (facts.ciGate !== "success") {
    problems.push(
      facts.ciGate === null
        ? "ci-gate has not run on this commit"
        : `ci-gate on this commit ended ${facts.ciGate}, not success`,
    );
  }
  problems.push(...environmentProblems(facts.environment));
  if (facts.tagExists) problems.push(`the tag v${facts.version} already exists`);
  if (facts.releaseExists) problems.push(`a release v${facts.version} already exists`);
  return problems;
}

/**
 * Why the release environment cannot guard a release. GitHub creates a
 * missing environment unprotected on first use, which would hand the
 * release's credentials to anyone who can start a workflow, so both
 * workflows check it before any job uses it.
 */
export function environmentProblems(environment: BuildFacts["environment"]): string[] {
  if (environment === null) {
    return ["the release environment does not exist; create it with a required reviewer"];
  }
  const problems: string[] = [];
  if (environment.reviewers === 0)
    problems.push("the release environment has no required reviewer");
  if (!environment.mainOnly) {
    problems.push("the release environment is not limited to the main branch");
  }
  return problems;
}

export interface PromoteFacts {
  readonly version: string;
  readonly stable: boolean;
  /** The release as GitHub reports it, or null when there is none. */
  readonly release: {
    readonly draft: boolean;
    readonly prerelease: boolean;
    /** The commit the release was made at. */
    readonly target: string;
  } | null;
  /** The Release workflow run the release names, or null when it names none. */
  readonly run: {
    readonly path: string;
    readonly event: string;
    readonly headBranch: string;
    readonly headSha: string;
    readonly conclusion: string | null;
  } | null;
  /** Whether main contains the release's commit. */
  readonly targetOnMain: boolean;
  /** The commit the tag v<version> points at, or null while there is no tag. */
  readonly tagCommit: string | null;
  /** The versions of the published stable releases, this one's included. */
  readonly stableVersions: readonly string[];
  /** The release's asset names, and the names its SHA256SUMS lists. */
  readonly assets: readonly string[];
  readonly summed: readonly string[];
  /** What each bundle's release.json records. */
  readonly bundles: readonly {
    readonly target: string;
    readonly commit: string;
    readonly signed: { readonly macos: string | null; readonly windows: string | null };
  }[];
}

/** Why this release must not be published as asked; empty when it may. */
export function promoteProblems(facts: PromoteFacts): string[] {
  const problems: string[] = [];
  if (!SEMVER.test(facts.version)) problems.push(`${facts.version} is not a version`);
  const { release, run } = facts;
  if (release === null) {
    problems.push(`there is no release v${facts.version}; build it with the Release workflow`);
    return problems;
  }
  // A published release can be published again as the same thing, which
  // finishes a promotion that stopped part way, or a prerelease made stable;
  // a stable release never goes back to being a prerelease.
  if (!release.draft && !release.prerelease && !facts.stable) {
    problems.push(`v${facts.version} is already published as stable`);
  }
  // Only a draft the Release workflow built on main, at the release's commit,
  // and then verified in the same run, may be published.
  if (run === null) {
    problems.push(`v${facts.version} names no Release run, so nothing shows it was verified`);
  } else {
    if (run.path !== ".github/workflows/release.yml" || run.event !== "workflow_dispatch") {
      problems.push(`the run v${facts.version} names is not a Release workflow run`);
    }
    if (run.headBranch !== "main" || run.headSha !== release.target) {
      problems.push(
        `the Release run built ${run.headBranch} at ${run.headSha}, not main at ${release.target}`,
      );
    }
    if (run.conclusion !== "success") {
      problems.push(
        `the Release run ended ${run.conclusion ?? "unfinished"}, so its draft was not verified`,
      );
    }
  }
  if (!facts.targetOnMain) problems.push(`main does not contain ${release.target}`);
  // Publishing takes an existing tag as it is, so it must be the release's.
  if (facts.tagCommit !== null && facts.tagCommit !== release.target) {
    problems.push(`the tag v${facts.version} points at ${facts.tagCommit}, not ${release.target}`);
  }
  for (const bundle of facts.bundles) {
    if (bundle.commit !== release.target) {
      problems.push(
        `the ${bundle.target} bundle was built from ${bundle.commit}, not ${release.target}`,
      );
    }
  }
  // Exactly what Release makes, each with a checksum: anything added to the
  // draft afterwards has neither a checksum nor an attestation.
  const expected = releaseAssets(facts.version);
  const extra = facts.assets.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !facts.assets.includes(name));
  if (extra.length > 0)
    problems.push(`the release has assets Release did not make: ${extra.join(", ")}`);
  if (missing.length > 0) problems.push(`the release is missing ${missing.join(", ")}`);
  const unsummed = expected.filter((name) => name !== "SHA256SUMS" && !facts.summed.includes(name));
  const oddSums = facts.summed.filter((name) => !expected.includes(name) || name === "SHA256SUMS");
  if (unsummed.length > 0 || oddSums.length > 0 || facts.summed.length !== expected.length - 1) {
    problems.push("SHA256SUMS does not list exactly the release's other assets");
  }
  if (facts.stable) {
    // The latest release only ever moves forward, on GitHub and on npm.
    const newer = facts.stableVersions.filter((other) => compareStable(other, facts.version) > 0);
    if (newer.length > 0) {
      problems.push(
        `v${newer.sort(compareStable).at(-1)} is a newer stable release; v${facts.version} cannot become the latest`,
      );
    }
    if (facts.version.includes("-")) {
      problems.push(`${facts.version} is a prerelease version, so it can never be stable`);
    }
    for (const os of ["macos", "windows"] as const) {
      const bundle = facts.bundles.find((each) => osOf(each.target) === os);
      if (bundle === undefined) problems.push(`there is no ${os} bundle`);
      else if (bundle.signed[os] === null) {
        problems.push(`the ${bundle.target} bundle is unsigned; a stable release is signed`);
      }
    }
  }
  return problems;
}

/** The assets the Release workflow makes for a version, and nothing else. */
export const releaseAssets = (version: string): string[] => [
  "SHA256SUMS",
  `liftoff-${version}.cdx.json`,
  "liftoff-package-aarch64-apple-darwin.tar.gz",
  "liftoff-package-x86_64-pc-windows-msvc.zip",
  `voyager163-liftoff-${version}.tgz`,
];

/** Orders X.Y.Z versions; anything else sorts first and never counts as newer. */
const compareStable = (left: string, right: string): number => {
  const parts = (version: string) =>
    /^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : [-1, -1, -1];
  const [a, b] = [parts(left), parts(right)];
  for (let at = 0; at < 3; at++) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const osOf = (target: string): "macos" | "windows" | undefined =>
  target.endsWith("-apple-darwin")
    ? "macos"
    : target.endsWith("-pc-windows-msvc")
      ? "windows"
      : undefined;
