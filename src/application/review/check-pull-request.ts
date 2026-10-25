import {
  type ApprovalResult,
  evaluateApprovals,
  type Review,
} from "../../domain/risk-policy/approvals.ts";
import {
  type ChangedFile,
  type Classification,
  classify,
} from "../../domain/risk-policy/classify.ts";
import { parsePolicy } from "../../domain/risk-policy/policy.ts";

export interface PullRequestFacts {
  readonly number: number;
  readonly author: string;
  readonly headSha: string;
  readonly files: readonly ChangedFile[];
  readonly reviews: readonly Review[];
}

/** What the check needs from GitHub. Implementations only read. */
export interface PullRequestSource {
  facts(number: number, headSha: string, author: string): Promise<PullRequestFacts>;
}

export interface PullRequestCheck {
  readonly classification: Classification;
  readonly approvals: ApprovalResult;
  readonly passed: boolean;
}

/**
 * The review-policy check for one pull request. The policy text must come from
 * the base branch; the files and reviews come from GitHub.
 */
export async function checkPullRequest(
  source: PullRequestSource,
  request: { number: number; headSha: string; author: string; basePolicyText: string },
): Promise<PullRequestCheck> {
  const policy = parsePolicy(request.basePolicyText);
  const facts = await source.facts(request.number, request.headSha, request.author);
  const classification = classify({ policy, files: facts.files, author: facts.author });
  const approvals = evaluateApprovals({
    required: classification.requiredApprovals,
    author: facts.author,
    headSha: facts.headSha,
    reviews: facts.reviews,
  });
  return { classification, approvals, passed: approvals.satisfied };
}

/** Markdown for the job summary: the tier, why, and what is still needed. */
export function renderCheckSummary(check: PullRequestCheck): string {
  const { classification: c, approvals: a } = check;
  const lines = [
    `## Review policy: ${check.passed ? "passed" : "needs approval"}`,
    "",
    `| Tier | Review depth | Profile | Approvals |`,
    `| --- | --- | --- | --- |`,
    `| **${c.tier}** | ${c.depth} | ${c.profile} | ${a.approvers.length} of ${a.required} |`,
    "",
  ];
  if (c.alwaysHuman) {
    lines.push(
      `Always needs a person: ${c.alwaysHumanPaths.map((p) => `\`${p}\``).join(", ")}`,
      "",
    );
  }
  lines.push("### Why", "");
  for (const reason of c.reasons) {
    const where =
      reason.paths.length > 0
        ? ` — ${reason.paths
            .slice(0, 5)
            .map((p) => `\`${p}\``)
            .join(", ")}${reason.paths.length > 5 ? ` and ${reason.paths.length - 5} more` : ""}`
        : "";
    lines.push(`- **${reason.tier}**: ${reason.reason}${where}`);
  }
  if (a.ignored.length > 0) {
    lines.push("", "### Approvals that did not count", "");
    for (const item of a.ignored) lines.push(`- @${item.reviewer}: ${item.why}`);
  }
  if (!check.passed) {
    const missing = a.required - a.approvers.length;
    lines.push(
      "",
      `Needs ${missing} more approval${missing === 1 ? "" : "s"} on the current commit from someone other than the author with write access. Bot approvals never count.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
