/** A release version as SemVer 2.0.0 orders them, without build metadata. */
export interface ReleaseVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** The version in `text`, such as a tag's "v1.2.0", or undefined when it is not one. */
export function parseVersion(text: string): ReleaseVersion | undefined {
  const match = SEMVER.exec(text.trim().replace(/^v/, ""));
  if (match === null) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

const compareIdentifiers = (a: string, b: string): number => {
  const numeric = (value: string) => /^\d+$/.test(value);
  if (numeric(a) && numeric(b)) return Math.sign(Number(a) - Number(b));
  if (numeric(a)) return -1;
  if (numeric(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** Negative, zero or positive as `a` comes before, with or after `b` in SemVer precedence. */
export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (const index of [0, 1, 2] as const) {
    const difference = a.core[index] - b.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length === 0 ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const difference = compareIdentifiers(a.prerelease[index] ?? "", b.prerelease[index] ?? "");
    if (difference !== 0) return difference;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

/** True when `candidate` is a version newer than `installed`; false when either is not a version. */
export function isNewer(candidate: string | undefined, installed: string): boolean {
  const a = candidate === undefined ? undefined : parseVersion(candidate);
  const b = parseVersion(installed);
  return a !== undefined && b !== undefined && compareVersions(a, b) > 0;
}
