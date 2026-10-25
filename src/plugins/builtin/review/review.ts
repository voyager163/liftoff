import { stringify } from "yaml";
import { renderTemplate } from "../../../generators/template.ts";
import type {
  Artifact,
  GenerationContext,
  ProjectPlugin,
  TemplateSet,
} from "../../contracts/project-plugin.ts";
import { chooseEngine, type ReviewEngine, reviewAgentScript } from "./engines.ts";

export const WORKFLOWS = "plugins/review-layered/workflows";

const REVIEW_MD = `# Review guide

Start every review with the number of findings. When there is nothing to
fix, say "No findings" and stop. Edit this file to say what matters most in
this project; reviewers read it on every pull request.

## What failure looks like here

- **It breaks the API contract**: a changed response shape, status code or
  error format that existing clients rely on, without a version change.
- **It loses or corrupts data**: a migration that cannot be rolled back, a
  delete without a guard, or a transaction that leaves partial state.
- **It trusts input**: missing validation, injection, or data from one user
  reachable by another.
- **It lies about health**: \`/health/ready\` reporting ready while a
  dependency is down, or \`/health/live\` failing because of a dependency.
- **It weakens a check**: skipped tests, lowered coverage, or a check that
  passes without running anything.

## Important

A finding is Important when the change introduces or exposes one of the
failures above, or any other defect a user would hit. Give the file and line,
the input and state that trigger it, and the wrong result.

## Nits

At most three per review. Skip anything the linter or formatter reports.

## Do not report

- Generated files in \`.github/liftoff/\` and the rendered skills and agents.
- Lockfile content, beyond whether it matches the manifest.

## Always check

- Every migration has a working downgrade.
- New endpoints have tests, including the failure cases.
- Secrets never appear in code, logs or configuration examples.
`;

const PR_TEMPLATE = `## What changed

<!-- The problem and how this change solves it. Link the issue. -->

## Testing

<!-- The checks you ran and their actual results. If a check was not run,
say why. -->

## Risk

<!-- The tier from \`liftoff review classify\`, what could go wrong after
merging, and who or what it would affect. -->

## How to revert

<!-- The exact steps, for example "revert this commit". Say so if reverting
needs more than a revert, such as a data migration. -->
`;

function reviewPolicy({ config, profile, stack }: GenerationContext): string {
  const body = {
    version: 1,
    profile,
    trusted_authors: config.owners,
    default_tier: "medium",
    untrusted_author_tier: "medium",
    rules: stack.reviewRules.map((rule) => ({
      paths: [...rule.paths],
      tier: rule.tier,
      ...(rule.always_human ? { always_human: true } : {}),
      reason: rule.reason,
    })),
  };
  return [
    "# Review policy: how much review a change needs, from what it touches.",
    "#",
    "# Each changed file takes the highest tier of the rules it matches (or",
    "# default_tier), and the pull request takes the highest file tier. Changes",
    "# to workflows, rulesets, CODEOWNERS, this file and AI-review instructions",
    "# are always high and always need a person, whatever the rules below say.",
    "# CI reads this file from the base branch. Check a change locally with:",
    "#   liftoff review classify",
    ...(config.owners.length === 0
      ? [
          "#",
          "# Add your GitHub login to trusted_authors so your own changes can take",
          "# the lighter paths.",
        ]
      : []),
    stringify(body, { lineWidth: 0 }),
  ].join("\n");
}

export interface ReviewWorkflowPaths {
  readonly policy: string;
  readonly refresh: string;
  readonly ai: string;
}

/** Generated projects number their workflows; Liftoff's own repository does not. */
export const PROJECT_WORKFLOW_PATHS: ReviewWorkflowPaths = {
  policy: ".github/workflows/03-review-policy.yml",
  refresh: ".github/workflows/03-review-policy-refresh.yml",
  ai: ".github/workflows/04-ai-review.yml",
};

/**
 * The review-policy workflows, and with an engine the verified AI review
 * workflow and its agent script. Shared by generated projects and Liftoff's
 * own repository, so both run the same files.
 */
export function reviewWorkflowFiles(
  templates: TemplateSet,
  paths: ReviewWorkflowPaths,
  engine: ReviewEngine | undefined,
): Artifact[] {
  const workflow = (name: string, values: Record<string, string>) =>
    renderTemplate(templates.read(`${WORKFLOWS}/${name}`), values, `${WORKFLOWS}/${name}`);
  const files: Artifact[] = [
    { path: paths.policy, ownership: "managed", content: workflow("review-policy.yml", {}) },
    {
      path: paths.refresh,
      ownership: "managed",
      content: workflow("review-policy-refresh.yml", {
        reviewPolicyWorkflow: paths.policy.split("/").pop() ?? "",
      }),
    },
  ];
  if (engine) {
    files.push(
      {
        path: ".github/liftoff/review-agent.sh",
        ownership: "managed",
        content: reviewAgentScript(engine),
      },
      {
        path: paths.ai,
        ownership: "managed",
        content: workflow("ai-review.yml", {
          agentHost: engine.host,
          agentCli: engine.cli,
          agentSecret: engine.secret,
        }),
      },
    );
  }
  return files;
}

/** The layered review model: policy, check, guide, template and the verified AI review. */
export const reviewPlugin: ProjectPlugin = {
  id: "review/layered",
  kind: "review",
  version: "1",
  summary: "Risk-tiered review policy, review guide and verified AI review",
  templateRoots: [WORKFLOWS],
  artifacts(context) {
    const { templates, ciBundles, config, hosts } = context;
    const bundle = (name: string): string => {
      const text = ciBundles[name];
      if (text === undefined) throw new Error(`this release does not ship the ${name} CI bundle`);
      return text;
    };
    const engine = config.review.ai ? chooseEngine(hosts, config.review.engine) : undefined;
    return [
      { path: "REVIEW.md", ownership: "seeded", content: REVIEW_MD },
      { path: ".github/PULL_REQUEST_TEMPLATE.md", ownership: "seeded", content: PR_TEMPLATE },
      { path: ".github/review-policy.yml", ownership: "seeded", content: reviewPolicy(context) },
      {
        path: ".github/liftoff/review-policy.mjs",
        ownership: "managed",
        content: bundle("review-policy.mjs"),
      },
      ...(engine
        ? [
            {
              path: ".github/liftoff/ai-review.mjs",
              ownership: "managed" as const,
              content: bundle("ai-review.mjs"),
            },
          ]
        : []),
      ...reviewWorkflowFiles(templates, PROJECT_WORKFLOW_PATHS, engine),
    ];
  },
};
