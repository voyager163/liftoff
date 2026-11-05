// Refuses to publish a release unless DIST-004's rules hold:
//
//   node scripts/release/check-promote.ts <version> <stable: true|false> <assets directory>
//
// The assets directory holds the release's downloaded assets, whose
// bundles' release.json files say how each was signed and from which commit.
// Run with a token that can see drafts (contents: write).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { onMain, releaseOf, runOf, stableVersionsOf, tagCommitOf } from "./github-facts.ts";
import { promoteProblems } from "./release-rules.ts";

const [version = "", stable = "", assets = ""] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
if (repository === undefined) throw new Error("GITHUB_REPOSITORY must be set");
if (stable !== "true" && stable !== "false") throw new Error("stable must be true or false");

const release = releaseOf(repository, version);
// The Release workflow names its run in the notes it writes.
const runId = /\bby run (\d+)\b/.exec(release?.body ?? "")?.[1];

// Each bundle archive holds liftoff-package-<target>/release.json.
const bundles = readdirSync(assets)
  .map((name) => /^liftoff-package-(.+)\.(tar\.gz|zip)$/.exec(name))
  .filter((match) => match !== null)
  .map(([name = "", target = "", kind]) => {
    const entry = `liftoff-package-${target}/release.json`;
    const text = execFileSync(
      kind === "zip" ? "unzip" : "tar",
      kind === "zip" ? ["-p", name, entry] : ["-xzOf", name, entry],
      {
        cwd: assets,
        encoding: "utf8",
      },
    );
    const identity = JSON.parse(text) as {
      version: string;
      target: string;
      commit: string;
      signed: { macos: string | null; windows: string | null };
    };
    if (identity.version !== version || identity.target !== target) {
      throw new Error(
        `${name} is ${identity.target} ${identity.version}, not ${target} ${version}`,
      );
    }
    return { target, commit: identity.commit, signed: identity.signed };
  });
const problems = promoteProblems({
  version,
  stable: stable === "true",
  release,
  run: runId === undefined ? null : runOf(repository, runId),
  targetOnMain:
    release !== null && /^[0-9a-f]{40}$/.test(release.target) && onMain(repository, release.target),
  tagCommit: tagCommitOf(repository, version),
  stableVersions: stableVersionsOf(repository),
  assets: readdirSync(assets).sort(),
  // "<sha256>  <name>" per line, as sha256sum writes it.
  summed: readFileSync(path.join(assets, "SHA256SUMS"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^[0-9a-f]{64} [ *]/, "")),
  bundles,
});
for (const problem of problems) console.error(`::error::${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`v${version} may be published${stable === "true" ? " as stable" : " as a prerelease"}`);
