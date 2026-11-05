import { GitCli } from "../../adapters/git.ts";
import { LocalWorkspace } from "../../adapters/workspace.ts";
import type { GitPort, WorkspacePort } from "../../application/ports.ts";
import { classifyChange } from "../../application/review/classify-change.ts";
import type { CommandSpec } from "../command.ts";

export interface ReviewPorts {
  git: GitPort;
  workspace: WorkspacePort;
}

export const defaultReviewPorts = (cwd: string): ReviewPorts => ({
  git: new GitCli(cwd),
  workspace: new LocalWorkspace(cwd),
});

/** Builds the command with injectable ports so tests can use a fake repository. */
export function makeReviewClassifyCommand(
  portsFor: (cwd: string) => ReviewPorts = defaultReviewPorts,
): CommandSpec {
  return {
    path: ["review", "classify"],
    summary: "Show the review tier and required approvals for the current change.",
    description:
      "Classifies the change on this branch against its base with the repository's review policy (.github/review-policy.yml, read from the base branch). Reports the risk tier, review depth, required human approvals and why. It is the same check CI runs, so the result predicts what the pull request will need.",
    readOnly: true,
    reportSchema: "liftoff.review-classification/v1",
    options: {
      base: {
        type: "string",
        valueName: "branch",
        default: "develop",
        description: "Branch the change will merge into.",
      },
      author: {
        type: "string",
        valueName: "login",
        description: "GitHub login of the author. Without it, a trusted author is assumed.",
      },
      committed: {
        type: "boolean",
        description: "Only count committed changes, not the working tree.",
      },
    },
    examples: [
      "liftoff review classify",
      "liftoff review classify --base main --json",
      "liftoff review classify --author octocat --committed",
    ],
    async run(args, { io }) {
      const author = args.options.author as string | undefined;
      const result = await classifyChange(portsFor(io.cwd), {
        base: args.options.base as string,
        committedOnly: args.options.committed === true,
        ...(author === undefined ? {} : { author }),
      });
      const c = result.classification;
      const lines = [
        `Tier: ${c.tier} (review depth: ${c.depth})`,
        `Required human approvals: ${c.requiredApprovals} under ${c.profile}`,
        `Changed: ${result.fileCount} files, ${c.changedLines} lines against ${result.base.ref}`,
      ];
      if (c.alwaysHuman) lines.push(`Always needs a person: ${c.alwaysHumanPaths.join(", ")}`);
      if (c.reasons.length > 0) {
        lines.push("", "Why:");
        for (const reason of c.reasons) {
          const where = reason.paths.length > 0 ? ` (${summarizePaths(reason.paths)})` : "";
          lines.push(`  ${reason.tier.padEnd(6)} ${reason.reason}${where}`);
        }
      }
      if (result.policySource === "working-tree") {
        lines.push(
          "",
          `Unverified: ${result.base.ref} has no review policy, so the working-tree copy was used.`,
        );
      }
      if (result.author.assumedTrusted) {
        lines.push(
          "",
          "No --author given, so a trusted author was assumed. CI uses the real author.",
        );
      }
      return {
        outcome: "success",
        report: {
          base: result.base,
          policySource: result.policySource,
          verified: result.policySource === "base",
          author: result.author,
          fileCount: result.fileCount,
          ...c,
        },
        text: `${lines.join("\n")}\n`,
      };
    },
  };
}

function summarizePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}
