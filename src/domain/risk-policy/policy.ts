import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { en } from "zod/locales";
import * as z from "zod/mini";

z.config(en());

/** Where a review policy lives in a repository. */
export const POLICY_PATH = ".github/review-policy.yml";

export const TIERS = ["low", "medium", "high"] as const;
export type Tier = (typeof TIERS)[number];

export const DEPTHS = ["quick", "standard", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];

export const PROFILE_IDS = [
  "single-maintainer-gitflow",
  "team-gitflow",
  "risk-tiered-gitflow",
  "none",
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/** Generated files whose size says nothing about how much there is to review. */
export const DEFAULT_LINE_COUNT_IGNORE: readonly string[] = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/uv.lock",
  "**/go.sum",
  "**/*.lock",
  "**/.terraform.lock.hcl",
  ".github/liftoff/**",
];

const tier = z.enum(TIERS);
const depth = z.enum(DEPTHS);
const text = z.string().check(z.minLength(1));

const globList = z.array(text).check(
  z.minLength(1),
  z.refine((globs) => globs.every((glob) => !glob.startsWith("/") && !glob.includes("\\")), {
    message: "globs must be repository-relative POSIX paths",
  }),
);

const rule = z.strictObject({
  paths: globList,
  tier,
  always_human: z._default(z.boolean(), false),
  reason: text,
});

const policySchema = z.strictObject({
  version: z.literal(1),
  profile: z.enum(PROFILE_IDS),
  default_tier: z._default(tier, "medium"),
  untrusted_author_tier: z._default(tier, "medium"),
  trusted_authors: z._default(z.array(text), []),
  large_change: z._default(
    z.strictObject({
      lines: z.number().check(z.int(), z.positive()),
      tier,
      ignore: z.optional(globList),
    }),
    { lines: 1000, tier: "high" },
  ),
  depth: z._default(z.strictObject({ low: depth, medium: depth, high: depth }), {
    low: "quick",
    medium: "standard",
    high: "deep",
  }),
  rules: z._default(z.array(rule), []),
});

type ParsedPolicy = z.output<typeof policySchema>;

export type ReviewPolicy = Omit<ParsedPolicy, "large_change"> & {
  readonly large_change: Omit<ParsedPolicy["large_change"], "ignore"> & {
    readonly ignore: readonly string[];
  };
};
export type PolicyRule = ReviewPolicy["rules"][number];

/**
 * Rules every policy gets, ahead of the repository's own rules. Changing the
 * policy, the check that enforces it, or the instructions AI reviewers read
 * can weaken every other control, so these always need deliberate review.
 */
export const BUILTIN_RULES: readonly PolicyRule[] = [
  {
    paths: [POLICY_PATH, ".github/liftoff/**"],
    tier: "high",
    always_human: true,
    reason: "changes the review policy or the check that enforces it",
  },
  {
    paths: [".github/workflows/**", ".github/actions/**", ".github/rulesets/**"],
    tier: "high",
    always_human: true,
    reason: "changes CI or repository rules, which can disable other checks",
  },
  {
    paths: [
      "REVIEW.md",
      "**/REVIEW.md",
      "AGENTS.md",
      "**/AGENTS.md",
      "CLAUDE.md",
      "**/CLAUDE.md",
      ".github/copilot-instructions.md",
      ".github/instructions/**",
      ".github/skills/**",
      ".github/agents/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".github/CODEOWNERS",
    ],
    tier: "high",
    always_human: true,
    reason: "changes what AI reviewers read or who owns review",
  },
];

export class PolicyError extends Error {
  override readonly name = "PolicyError";
}

/** Parses and validates review policy YAML. Unknown fields are rejected. */
export function parsePolicy(text: string): ReviewPolicy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new PolicyError(`review policy is not valid YAML: ${(error as Error).message}`);
  }
  const result = z.safeParse(policySchema, raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PolicyError(`review policy is invalid: ${issues}`);
  }
  const policy: ReviewPolicy = {
    ...result.data,
    large_change: {
      ...result.data.large_change,
      ignore: result.data.large_change.ignore ?? DEFAULT_LINE_COUNT_IGNORE,
    },
  };
  for (const [index, entry] of policy.rules.entries()) {
    for (const glob of entry.paths) {
      try {
        picomatch(glob);
      } catch {
        throw new PolicyError(`review policy is invalid: rules.${index}.paths: bad glob "${glob}"`);
      }
    }
  }
  return policy;
}
