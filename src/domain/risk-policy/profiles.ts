import type { ProfileId, Tier } from "./policy.ts";

export interface ApprovalProfile {
  readonly id: ProfileId;
  /** Independent human approvals required for each risk tier. */
  readonly approvals: Readonly<Record<Tier, number>>;
  /** Minimum independent human approvals when an always-human path changes. */
  readonly alwaysHumanMinimum: number;
  readonly summary: string;
}

/**
 * One mechanism, four approval maps. Single-maintainer never requires an
 * approval: the maintainer cannot approve their own pull request, so the tier
 * only changes how deep the automated review goes.
 */
export const PROFILES: Readonly<Record<ProfileId, ApprovalProfile>> = {
  "single-maintainer-gitflow": {
    id: "single-maintainer-gitflow",
    approvals: { low: 0, medium: 0, high: 0 },
    alwaysHumanMinimum: 0,
    summary: "No required approvals; the tier sets automated review depth.",
  },
  "team-gitflow": {
    id: "team-gitflow",
    approvals: { low: 1, medium: 1, high: 2 },
    alwaysHumanMinimum: 1,
    summary: "At least one independent human approval; two for high-risk changes.",
  },
  "risk-tiered-gitflow": {
    id: "risk-tiered-gitflow",
    approvals: { low: 0, medium: 1, high: 2 },
    alwaysHumanMinimum: 1,
    summary: "Approvals set by the change: low 0, medium 1, high 2.",
  },
  none: {
    id: "none",
    approvals: { low: 0, medium: 0, high: 0 },
    alwaysHumanMinimum: 0,
    summary: "No governance requirement.",
  },
};
