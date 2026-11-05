// The governance drift check, run on a schedule by GitHub Actions. It reads
// the committed desired rulesets in .github/rulesets/ and compares them with
// the rules GitHub reports as active on each branch. A committed ruleset is
// not proof of enforcement; this readback is.
import { GitHubClient } from "../adapters/github.ts";
import {
  compareRuleset,
  type DesiredRuleset,
  type EffectiveRule,
  targetedBranches,
} from "../domain/governance/ruleset-drift.ts";

export interface DriftEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly listRulesetFiles: () => string[];
  readonly readFile: (path: string) => string;
  readonly appendFile: (path: string, text: string) => void;
  readonly log: (text: string) => void;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export async function main(context: DriftEnvironment): Promise<number> {
  const { env } = context;
  const summary = (text: string) => {
    if (env.GITHUB_STEP_SUMMARY) context.appendFile(env.GITHUB_STEP_SUMMARY, text);
    context.log(text);
  };
  try {
    const repository = env.GITHUB_REPOSITORY;
    const token = env.GITHUB_TOKEN;
    if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
    const files = context.listRulesetFiles();
    if (files.length === 0) throw new Error("no desired rulesets in .github/rulesets/");
    const client = new GitHubClient({
      token,
      ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });

    const lines = ["## Governance drift", ""];
    let drift = 0;
    for (const file of files) {
      const desired = JSON.parse(context.readFile(file)) as DesiredRuleset;
      const effective: Record<string, EffectiveRule[]> = {};
      for (const branch of targetedBranches(desired)) {
        effective[branch] = await client.list<EffectiveRule>(
          `/repos/${repository}/rules/branches/${encodeURIComponent(branch)}`,
          500,
        );
      }
      const differences = compareRuleset(desired, effective);
      drift += differences.length;
      if (differences.length === 0) {
        lines.push(`- ✅ **${desired.name}** (${file}): enforced as committed`);
      } else {
        lines.push(`- ❌ **${desired.name}** (${file}):`);
        for (const d of differences)
          lines.push(`  - \`${d.branch}\` ${d.rule}: ${d.kind}: ${d.detail}`);
      }
    }
    lines.push(
      "",
      drift === 0
        ? "Live branch rules match the committed rulesets."
        : `${drift} difference${drift === 1 ? "" : "s"}. Apply the committed rulesets or update them to match a deliberate change.`,
    );
    summary(`${lines.join("\n")}\n`);
    return drift === 0 ? 0 : 1;
  } catch (error) {
    summary(`## Governance drift: error\n\n${(error as Error).message}\n`);
    return 1;
  }
}
