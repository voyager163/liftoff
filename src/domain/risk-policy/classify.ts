import picomatch from "picomatch";
import {
  BUILTIN_RULES,
  type Depth,
  type PolicyRule,
  type ReviewPolicy,
  TIERS,
  type Tier,
} from "./policy.ts";
import { PROFILES } from "./profiles.ts";

export interface ChangedFile {
  /** Repository-relative POSIX path after the change. */
  readonly path: string;
  /** Path before a rename, so moving a file out of a sensitive area still counts. */
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ClassifyInput {
  readonly policy: ReviewPolicy;
  readonly files: readonly ChangedFile[];
  readonly author: string;
}

export interface Reason {
  readonly tier: Tier;
  readonly reason: string;
  readonly paths: readonly string[];
}

export interface Classification {
  readonly tier: Tier;
  readonly depth: Depth;
  readonly profile: ReviewPolicy["profile"];
  readonly requiredApprovals: number;
  readonly alwaysHuman: boolean;
  readonly alwaysHumanPaths: readonly string[];
  readonly trustedAuthor: boolean;
  readonly changedLines: number;
  readonly reasons: readonly Reason[];
}

const rank = (tier: Tier): number => TIERS.indexOf(tier);
const higher = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b);

interface CompiledRule {
  readonly rule: PolicyRule;
  readonly matches: (path: string) => boolean;
}

function compile(rules: readonly PolicyRule[]): CompiledRule[] {
  return rules.map((rule) => ({ rule, matches: picomatch(rule.paths, { dot: true }) }));
}

/**
 * Classifies a change by what it touches, never by who wrote it or how it is
 * labelled. Each file takes the highest tier of every rule it matches (or the
 * default tier when none match), and the change takes the highest file tier.
 */
export function classify(input: ClassifyInput): Classification {
  const { policy, files, author } = input;
  const rules = compile([...BUILTIN_RULES, ...policy.rules]);
  const reasons = new Map<string, { tier: Tier; paths: Set<string> }>();
  const alwaysHumanPaths = new Set<string>();
  const addReason = (tier: Tier, reason: string, path?: string) => {
    const entry = reasons.get(reason) ?? { tier, paths: new Set<string>() };
    entry.tier = higher(entry.tier, tier);
    if (path !== undefined) entry.paths.add(path);
    reasons.set(reason, entry);
  };

  let tier: Tier = "low";
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.path, file.previousPath];
    let fileTier: Tier | undefined;
    for (const { rule, matches } of rules) {
      if (!paths.some((path) => matches(path))) continue;
      fileTier = fileTier === undefined ? rule.tier : higher(fileTier, rule.tier);
      addReason(rule.tier, rule.reason, file.path);
      if (rule.always_human) alwaysHumanPaths.add(file.path);
    }
    if (fileTier === undefined) {
      fileTier = policy.default_tier;
      addReason(fileTier, "matches no rule, so it takes the default tier", file.path);
    }
    tier = higher(tier, fileTier);
  }

  const ignored = picomatch([...policy.large_change.ignore], { dot: true });
  const changedLines = files
    .filter((file) => !ignored(file.path))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (changedLines > policy.large_change.lines) {
    tier = higher(tier, policy.large_change.tier);
    addReason(
      policy.large_change.tier,
      `changes ${changedLines} lines, more than ${policy.large_change.lines}`,
    );
  }

  const trustedAuthor = policy.trusted_authors.includes(author);
  if (!trustedAuthor) {
    tier = higher(tier, policy.untrusted_author_tier);
    addReason(policy.untrusted_author_tier, `author ${author} is not on the trusted list`);
  }

  const profile = PROFILES[policy.profile];
  const alwaysHuman = alwaysHumanPaths.size > 0;
  const requiredApprovals = Math.max(
    profile.approvals[tier],
    alwaysHuman ? profile.alwaysHumanMinimum : 0,
  );

  return {
    tier,
    depth: policy.depth[tier],
    profile: policy.profile,
    requiredApprovals,
    alwaysHuman,
    alwaysHumanPaths: [...alwaysHumanPaths].sort(),
    trustedAuthor,
    changedLines,
    reasons: [...reasons.entries()]
      .map(([reason, entry]) => ({ tier: entry.tier, reason, paths: [...entry.paths].sort() }))
      .sort((a, b) => rank(b.tier) - rank(a.tier) || a.reason.localeCompare(b.reason)),
  };
}
