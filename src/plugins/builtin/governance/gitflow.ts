import type { ProfileId } from "../../../domain/risk-policy/policy.ts";
import { PROFILES } from "../../../domain/risk-policy/profiles.ts";
import type { Artifact, GenerationContext, ProjectPlugin } from "../../contracts/project-plugin.ts";

const DRIFT_WORKFLOW = `# Managed by Liftoff. Change it through Liftoff rather than by hand.
#
# Reads back the branch rules GitHub actually enforces and compares them with
# the committed rulesets in .github/rulesets/. A committed ruleset is not
# proof of protection; this readback is. Fails on any difference.
name: Governance drift

on:
  schedule:
    - cron: "41 4 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  drift:
    name: Governance drift
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          sparse-checkout: |
            .github/rulesets
            .github/liftoff
          sparse-checkout-cone-mode: false
      - name: Compare live branch rules with the committed rulesets
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node .github/liftoff/governance-drift.mjs
`;

/**
 * Whether the rulesets require a code owner's approval: only when the profile
 * requires an approval for every change, and only with at least two owners,
 * because nobody can approve their own pull request and a single owner's
 * changes could then never be approved.
 */
function codeOwnerReviewRequired(profile: ProfileId, owners: readonly string[]): boolean {
  return PROFILES[profile].approvals.low > 0 && owners.length >= 2;
}

function ruleset(
  name: string,
  branch: string,
  methods: string[],
  context: GenerationContext,
  profile: ProfileId,
) {
  const approvals = PROFILES[profile].approvals.low;
  return {
    name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: methods,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: codeOwnerReviewRequired(profile, context.config.owners),
          require_last_push_approval: approvals > 0,
          required_approving_review_count: approvals,
          required_review_thread_resolution: true,
          required_reviewers: [],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          strict_required_status_checks_policy: true,
          required_status_checks: ["ci-gate", "review-policy"].map((check) => ({
            context: check,
            integration_id: 15368,
          })),
        },
      },
      {
        type: "code_scanning",
        parameters: {
          code_scanning_tools: [
            {
              tool: "CodeQL",
              security_alerts_threshold: "high_or_higher",
              alerts_threshold: "errors",
            },
          ],
        },
      },
      ...(context.hosts.includes("copilot")
        ? [
            {
              type: "copilot_code_review",
              parameters: { review_on_push: false, review_draft_pull_requests: false },
            },
          ]
        : []),
    ],
  };
}

function governanceMarkdown({ config, hosts }: GenerationContext, profile: ProfileId): string {
  const p = PROFILES[profile];
  const aiLines: string[] = [];
  if (hosts.includes("copilot")) {
    aiLines.push(
      "Copilot code review comments on every pull request once the rulesets are applied.",
    );
  }
  if (config.review.ai && hosts.length > 0) {
    aiLines.push(
      "Medium- and high-risk changes also get the verified AI review, which reports only findings independent verifiers confirm.",
    );
  }
  const aiStep = aiLines.length === 0 ? "" : `4. ${aiLines.join(" ")}\n`;
  const resolveStep = aiLines.length === 0 ? 4 : 5;
  return `# Governance

How changes reach \`develop\` and \`main\` in ${config.name}. Liftoff generated
this as a starting point under the \`${profile}\` profile: ${p.summary}

## Branches

| Change | From | Into | Merge |
| --- | --- | --- | --- |
| Feature, fix, chore, docs, CI | \`feature/…\`, \`fix/…\`, \`chore/…\`, \`docs/…\`, \`ci/…\` | \`develop\` | Squash |
| Release | \`release/X.Y.Z\` from a healthy \`develop\` commit | \`main\` | Merge commit |
| Hotfix | \`hotfix/X.Y.Z\` from \`main\`, with an incident reference | \`main\` | Merge commit |
| Back-merge after a release | \`sync/…\` from \`develop\` with \`main\` merged in | \`develop\` | Merge commit |

Dependabot's branches, and those of the coding agents this project uses, may
also open pull requests into \`develop\`. A release branch is an exact
\`develop\` commit whose CI passed, so what merges into \`main\` is what was
tested. CI's \`branch-policy\` job checks all of this, and its
\`release-lineage\` job checks that a pull request into \`main\` contains the
current \`main\`, so merging leaves exactly the tree CI qualified.

Never push directly to \`develop\` or \`main\`, force-push them or squash away
history being synchronized.

## Review

1. Before opening a pull request, run the checks in [AGENTS.md](AGENTS.md)
   and show their output.
2. CI must pass: \`ci-gate\` covers lint, tests with coverage, dependency
   review and the branch checks; CodeQL blocks merging on high or critical
   alerts.
3. \`review-policy\` sets the tier from what the change touches
   ([.github/review-policy.yml](.github/review-policy.yml)) and checks the
   required approvals: low ${p.approvals.low}, medium ${p.approvals.medium},
   high ${p.approvals.high}.
${aiStep}${resolveStep}. Every review thread is resolved before merging: fixed, or answered with a
   reason.
${approvalsSection(config.owners, profile)}
## Branch rules

The intended rules are in [.github/rulesets/](.github/rulesets/). They are
not active until you apply them, and they should only be applied after every
check they require (\`ci-gate\` and \`review-policy\`) has run successfully on a
real pull request, so a new rule never waits on a check that does not exist.

Apply one with the GitHub CLI, for example:

\`\`\`bash
gh api --method POST repos/OWNER/REPO/rulesets --input .github/rulesets/develop.json
\`\`\`

The Governance drift workflow then reads back what GitHub enforces and fails
if it differs from the committed rulesets.
`;
}

/** Who can approve, for profiles that require approvals. */
function approvalsSection(owners: readonly string[], profile: ProfileId): string {
  const p = PROFILES[profile];
  if (Math.max(p.approvals.low, p.approvals.medium, p.approvals.high) === 0) return "";
  const ownership = codeOwnerReviewRequired(profile, owners)
    ? "[.github/CODEOWNERS](.github/CODEOWNERS) names who reviews what. GitHub\nrequests those owners, and the branch rules require one of them to approve."
    : owners.length === 0
      ? "No code owners were given, so any collaborator with write access can\napprove. Add `.github/CODEOWNERS` to have GitHub request reviewers."
      : p.approvals.low === 0
        ? "[.github/CODEOWNERS](.github/CODEOWNERS) names who reviews what, and GitHub\nrequests those owners. Low-risk changes need no approval, so the branch rules\ndo not require a code owner's: any collaborator with write access can give\nthe approvals a change needs."
        : "[.github/CODEOWNERS](.github/CODEOWNERS) names one owner. Nobody can approve\ntheir own pull request, so the branch rules do not require a code owner's\napproval; add a second owner, then turn on `require_code_owner_review` in the\nrulesets.";
  return `
## Approvals

An approval counts only when it comes from someone with write access who is
not the author, is that person's latest decision on the pull request, and is
for its current head commit. Approvals from bots, AI reviewers included,
never count, and pushing a new commit dismisses earlier approvals. A change
to a path that always needs a person, listed in
[.github/review-policy.yml](.github/review-policy.yml), needs at least
${p.alwaysHumanMinimum} approval whatever its tier.

${ownership}

### What enforces these counts

The branch rules themselves enforce ${p.approvals.low === 0 ? "no approval" : `${p.approvals.low} approval`} on every change. The
higher counts by tier come from the \`review-policy\` check, which is a commit
status: anyone with write access could also publish it from a workflow of
their own. It stops mistakes, not a collaborator set on getting around it.
Where that matters, raise \`required_approving_review_count\` in
[.github/rulesets/](.github/rulesets/) to the count you need enforced on
every change.
`;
}

/** GitFlow governance handoff: generated policy and rules, applied later by a person. */
export function gitflowGovernance(profile: ProfileId): ProjectPlugin {
  return {
    id: `governance/${profile}`,
    kind: "governance",
    version: "1",
    summary: PROFILES[profile].summary,
    templateRoots: [],
    artifacts(context) {
      const bundle = (name: string) => {
        const text = context.ciBundles[name];
        if (text === undefined) throw new Error(`this release does not ship the ${name} CI bundle`);
        return text;
      };
      const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
      const files: Artifact[] = [
        {
          path: "GOVERNANCE.md",
          ownership: "seeded",
          content: governanceMarkdown(context, profile),
        },
        {
          path: ".github/rulesets/develop.json",
          ownership: "seeded",
          content: json(
            ruleset("Protect develop", "develop", ["merge", "squash"], context, profile),
          ),
        },
        {
          path: ".github/rulesets/main.json",
          ownership: "seeded",
          content: json(ruleset("Protect main", "main", ["merge"], context, profile)),
        },
        {
          path: ".github/liftoff/governance-drift.mjs",
          ownership: "managed",
          content: bundle("governance-drift.mjs"),
        },
        {
          path: ".github/liftoff/branch-policy.mjs",
          ownership: "managed",
          content: bundle("branch-policy.mjs"),
        },
        {
          path: ".github/workflows/90-governance-drift.yml",
          ownership: "managed",
          content: DRIFT_WORKFLOW,
        },
      ];
      if (context.config.owners.length > 0) {
        const owners = context.config.owners.map((login) => `@${login}`).join(" ");
        files.push({
          path: ".github/CODEOWNERS",
          ownership: "seeded",
          content: [
            "# Who reviews what. GitHub requests these owners on matching changes.",
            `* ${owners}`,
            "",
            "# Changes that can weaken every other check always need an owner.",
            `/.github/ ${owners}`,
            `/REVIEW.md ${owners}`,
            `/AGENTS.md ${owners}`,
            "",
          ].join("\n"),
        });
      }
      return files;
    },
  };
}

/** No governance: no branch rules or governance documents. */
export const noGovernance: ProjectPlugin = {
  id: "governance/none",
  kind: "governance",
  version: "1",
  summary: PROFILES.none.summary,
  templateRoots: [],
  artifacts: () => [],
};
