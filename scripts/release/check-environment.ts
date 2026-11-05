// Refuses to go on unless the release environment can guard a release:
//
//   node scripts/release/check-environment.ts
//
// Run in a job of its own before any job that uses the environment, since
// GitHub creates a missing one, unprotected, when a job first uses it.
import { environmentOf } from "./github-facts.ts";
import { environmentProblems } from "./release-rules.ts";

const repository = process.env.GITHUB_REPOSITORY;
if (repository === undefined) throw new Error("GITHUB_REPOSITORY must be set");
const problems = environmentProblems(environmentOf(repository, "release"));
for (const problem of problems) console.error(`::error::${problem}`);
if (problems.length > 0) process.exit(1);
console.log("the release environment has a required reviewer and allows only main");
