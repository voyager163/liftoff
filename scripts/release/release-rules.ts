// The rules a Liftoff release must meet before anything is built or
// published (DIST-003, DIST-004). Pure, so the workflows' scripts and the
// tests share them.

/** X.Y.Z, or X.Y.Z-<prerelease> such as 0.2.0-rc.1; never a leading v. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

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
  // GitHub creates a missing environment unprotected on first use, which
  // would hand the release's credentials to anyone who can dispatch it.
  if (facts.environment === null) {
    problems.push("the release environment does not exist; create it with a required reviewer");
  } else {
    if (facts.environment.reviewers === 0) {
      problems.push("the release environment has no required reviewer");
    }
    if (!facts.environment.mainOnly) {
      problems.push("the release environment is not limited to the main branch");
    }
  }
  if (facts.tagExists) problems.push(`the tag v${facts.version} already exists`);
  if (facts.releaseExists) problems.push(`a release v${facts.version} already exists`);
  return problems;
}

export interface PromoteFacts {
  readonly version: string;
  readonly stable: boolean;
  /** The release as GitHub reports it, or null when there is none. */
  readonly release: { readonly draft: boolean; readonly prerelease: boolean } | null;
  /** What each bundle's release.json records. */
  readonly bundles: readonly {
    readonly target: string;
    readonly signed: { readonly macos: string | null; readonly windows: string | null };
  }[];
}

/** Why this release must not be published as asked; empty when it may. */
export function promoteProblems(facts: PromoteFacts): string[] {
  const problems: string[] = [];
  if (!SEMVER.test(facts.version)) problems.push(`${facts.version} is not a version`);
  if (facts.release === null) {
    problems.push(`there is no release v${facts.version}; build it with the Release workflow`);
    return problems;
  }
  // A published release can be published again as the same thing, which
  // finishes a promotion that stopped part way, or a prerelease made stable;
  // a stable release never goes back to being a prerelease.
  if (!facts.release.draft && !facts.release.prerelease && !facts.stable) {
    problems.push(`v${facts.version} is already published as stable`);
  }
  if (facts.stable) {
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

const osOf = (target: string): "macos" | "windows" | undefined =>
  target.endsWith("-apple-darwin")
    ? "macos"
    : target.endsWith("-pc-windows-msvc")
      ? "windows"
      : undefined;
