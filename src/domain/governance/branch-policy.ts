/**
 * Which branches may open pull requests into `develop` and `main` under the
 * GitFlow profiles. Pure: the lineage of a release or hotfix is checked
 * against GitHub separately.
 */

/** Prefixes of branches that carry everyday work into `develop`. */
export const WORK_PREFIXES = ["feature", "fix", "chore", "docs", "ci"] as const;

export type BranchKind = "work" | "sync" | "automation" | "release" | "hotfix" | "other";

export interface BranchDecision {
  readonly allowed: boolean;
  readonly kind: BranchKind;
  /** X.Y.Z of a release or hotfix branch. */
  readonly version?: string;
  readonly reason: string;
}

export interface BranchRequest {
  readonly head: string;
  readonly base: string;
  /** The pull request's description, where a hotfix names its incident. */
  readonly body: string;
  /** Prefixes of branches that tools open, such as "dependabot". */
  readonly automation: readonly string[];
}

const NAME = "[A-Za-z0-9][A-Za-z0-9._/-]*";
const VERSION = /^(?:release|hotfix)\/(\d+\.\d+\.\d+)$/;
/** A line such as "Incident: INC-123" or "Incident: https://…". */
const INCIDENT = /^\s*Incident:\s*\S+/im;

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prefixed = (prefixes: readonly string[], head: string) =>
  prefixes.some((prefix) => new RegExp(`^${literal(prefix)}/${NAME}$`).test(head));

export function checkBranch(request: BranchRequest): BranchDecision {
  const { head, base } = request;
  if (base === "develop") {
    if (prefixed(WORK_PREFIXES, head)) {
      return { allowed: true, kind: "work", reason: `${head} carries work into develop` };
    }
    if (prefixed(["sync"], head)) {
      return { allowed: true, kind: "sync", reason: `${head} brings main back into develop` };
    }
    if (prefixed(request.automation, head)) {
      return { allowed: true, kind: "automation", reason: `${head} was opened by a tool` };
    }
    return {
      allowed: false,
      kind: "other",
      reason: `${head} cannot merge into develop: name it ${WORK_PREFIXES.map((p) => `${p}/…`).join(", ")}, or sync/… to bring main back`,
    };
  }
  if (base === "main") {
    const version = VERSION.exec(head)?.[1];
    if (version !== undefined && head.startsWith("release/")) {
      return { allowed: true, kind: "release", version, reason: `${head} releases ${version}` };
    }
    if (version !== undefined) {
      return INCIDENT.test(request.body)
        ? {
            allowed: true,
            kind: "hotfix",
            version,
            reason: `${head} fixes an incident in ${version}`,
          }
        : {
            allowed: false,
            kind: "hotfix",
            version,
            reason: `${head} needs an "Incident: <reference>" line in the pull request description`,
          };
    }
    return {
      allowed: false,
      kind: "other",
      reason: `${head} cannot merge into main: only release/X.Y.Z and hotfix/X.Y.Z branches can`,
    };
  }
  return { allowed: true, kind: "other", reason: `${base} is not a protected branch` };
}
