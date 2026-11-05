// Refuses to build a release unless DIST-003's rules hold for this commit:
//
//   node scripts/release/check-build.ts <version>
//
// Reads GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_REF from the workflow.
import { execFileSync } from "node:child_process";
import { ciGateOf, environmentOf, releaseOf, tagExists } from "./github-facts.ts";
import { buildProblems } from "./release-rules.ts";

const [version = ""] = process.argv.slice(2);
const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF: ref } = process.env;
if (repository === undefined || sha === undefined || ref === undefined) {
  throw new Error("GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_REF must be set");
}
const packageVersion = (
  JSON.parse(execFileSync("git", ["show", `${sha}:package.json`], { encoding: "utf8" })) as {
    version: string;
  }
).version;
const problems = buildProblems({
  environment: environmentOf(repository, "release"),
  version,
  ref,
  packageVersion,
  ciGate: ciGateOf(repository, sha),
  tagExists: tagExists(repository, version),
  releaseExists: releaseOf(repository, version) !== null,
});
for (const problem of problems) console.error(`::error::${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`v${version} may be built from ${sha}`);
