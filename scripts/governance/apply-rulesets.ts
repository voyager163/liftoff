// Applies the committed rulesets in .github/rulesets/ to this repository with
// the GitHub CLI's existing login. Shows the plan by default; changes nothing
// without --apply. Run it yourself: it changes repository settings, and only
// after every required check named in a ruleset has run successfully, so a
// new rule never blocks merging on a check that does not exist yet.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const apply = process.argv.includes("--apply");
const repository =
  process.argv.find((arg) => /^[\w.-]+\/[\w.-]+$/.test(arg)) ??
  execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd: root,
    encoding: "utf8",
  }).trim();

const gh = (args: string[], input?: string) =>
  execFileSync("gh", args, { cwd: root, encoding: "utf8", ...(input ? { input } : {}) });

const existing = JSON.parse(gh(["api", `repos/${repository}/rulesets`, "--paginate"])) as {
  id: number;
  name: string;
}[];

const directory = path.join(root, ".github/rulesets");
for (const file of readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const body = readFileSync(path.join(directory, file), "utf8");
  const { name } = JSON.parse(body) as { name: string };
  const match = existing.find((ruleset) => ruleset.name === name);
  const args = match
    ? ["api", "--method", "PUT", `repos/${repository}/rulesets/${match.id}`, "--input", "-"]
    : ["api", "--method", "POST", `repos/${repository}/rulesets`, "--input", "-"];
  console.log(
    `${apply ? "Applying" : "Would apply"} ${file} as ${match ? `update of ruleset ${match.id}` : "a new ruleset"} "${name}"`,
  );
  if (apply) gh(args, body);
}
if (!apply) console.log("\nNothing changed. Re-run with --apply to update the repository.");
