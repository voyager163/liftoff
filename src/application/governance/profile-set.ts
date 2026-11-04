import type { ChangePlan } from "../../domain/plan/change-plan.ts";
import type { ProfileId } from "../../domain/risk-policy/policy.ts";
import { PROFILES } from "../../domain/risk-policy/profiles.ts";
import { GOVERNANCE } from "../../plugins/registry.ts";
import type { NewContent } from "../change/apply-changes.ts";
import {
  planTransition,
  type TransitionFile,
  TransitionOptionError,
} from "../change/config-transition.ts";
import { sealProjectChange } from "../change/project-change.ts";
import type { AssetPort, ProjectFsPort } from "../ports.ts";

export interface ProfilePlan {
  readonly directory: string;
  readonly from: string;
  readonly to: string;
  /** Each of Liftoff's files the switch writes, or would, sorted by path. */
  readonly files: readonly TransitionFile[];
  /** Whether the new profile asks for fewer approvals, at any tier, than the old. */
  readonly weaker: boolean;
  /** The change, or undefined when the project already has the profile. */
  readonly plan?: ChangePlan;
  readonly contents: ReadonlyMap<string, NewContent>;
}

/** Whether `to` requires fewer approvals than `from` anywhere. */
function weakens(from: ProfileId, to: ProfileId): boolean {
  const was = PROFILES[from];
  const now = PROFILES[to];
  return (
    now.alwaysHumanMinimum < was.alwaysHumanMinimum ||
    (Object.keys(was.approvals) as (keyof typeof was.approvals)[]).some(
      (tier) => now.approvals[tier] < was.approvals[tier],
    )
  );
}

/**
 * Plans switching a Liftoff project's governance profile (PROFILE-001). It
 * only reads, and changes only the project's files: what is applied on
 * GitHub stays as it is (PROFILE-002).
 */
export async function planProfileSet(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  profile: string,
): Promise<ProfilePlan> {
  if (!Object.hasOwn(GOVERNANCE, profile)) {
    throw new TransitionOptionError(
      `unknown governance profile "${profile}"; available: ${Object.keys(GOVERNANCE).join(", ")}`,
    );
  }
  const transition = await planTransition(ports, directory, liftoffVersion, "profile-set", {
    name: "governance profile",
    field: "governance",
    to: profile,
  });
  const base = { directory, to: profile, contents: new Map() };
  if (transition === undefined) return { ...base, from: profile, files: [], weaker: false };
  const { project, changes, contents, manifest } = transition;
  const from = project.config.governance;
  const sealed = sealProjectChange(
    project,
    "profile-set",
    liftoffVersion,
    changes,
    contents,
    manifest,
  );
  return {
    ...base,
    from,
    files: transition.files,
    weaker: weakens(from as ProfileId, profile as ProfileId),
    plan: sealed.plan,
    contents: sealed.contents,
  };
}
