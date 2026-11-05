import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type BuildFacts,
  buildProblems,
  type PromoteFacts,
  promoteProblems,
  releaseAssets,
} from "../../scripts/release/release-rules.ts";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const workflow = (name: string) => {
  const text = readFileSync(
    path.resolve(import.meta.dirname, "../../.github/workflows", name),
    "utf8",
  );
  return { text, data: parse(text) as Workflow };
};
// Scripts as one line per command, with backslash continuations joined.
/** The job, which the workflow must have. */
const jobOf = (data: Workflow, name: string): Job => {
  const job = data.jobs[name];
  if (job === undefined) throw new Error(`the workflow has no ${name} job`);
  return job;
};
const runs = (job: Job) =>
  job.steps
    .map((step) => step.run ?? "")
    .join("\n")
    .replace(/\\\n\s*/g, "");
const uses = (job: Job) => job.steps.map((step) => step.uses ?? "");

const build: BuildFacts = {
  environment: { reviewers: 1, mainOnly: true },
  version: "0.1.0",
  ref: "refs/heads/main",
  packageVersion: "0.1.0",
  ciGate: "success",
  tagExists: false,
  releaseExists: false,
};

describe("DIST-003 a release is built once, from a checked commit, into a draft", () => {
  it("may build a version package.json has, on main, after ci-gate passed", () => {
    expect(buildProblems(build)).toEqual([]);
    for (const version of ["1.2.3-rc.1", "1.2.3-01a", "1.2.3-0", "1.2.3-alpha-2.x"]) {
      expect(buildProblems({ ...build, version, packageVersion: version }), version).toEqual([]);
    }
    expect(
      buildProblems({ ...build, version: "0.2.0-rc.1", packageVersion: "0.2.0-rc.1" }),
    ).toEqual([]);
  });

  it.each<[string, Partial<BuildFacts>, string]>([
    ["a leading v", { version: "v0.1.0" }, "is not a version"],
    ["a leading zero", { version: "01.2.3" }, "is not a version"],
    ["a numeric prerelease with a leading zero", { version: "1.2.3-01" }, "is not a version"],
    ["a later one with a leading zero", { version: "1.2.3-rc.01" }, "is not a version"],
    ["an empty prerelease", { version: "1.2.3-" }, "is not a version"],
    ["build metadata", { version: "1.2.3+build" }, "is not a version"],
    ["another branch", { ref: "refs/heads/develop" }, "from main only"],
    ["a different package.json", { packageVersion: "0.0.9" }, "package.json says 0.0.9"],
    ["a failed ci-gate", { ciGate: "failure" }, "ci-gate on this commit ended failure"],
    ["a ci-gate still running", { ciGate: "in_progress" }, "ended in_progress"],
    ["no ci-gate", { ciGate: null }, "ci-gate has not run"],
    ["an existing tag", { tagExists: true }, "tag v0.1.0 already exists"],
    ["an existing release", { releaseExists: true }, "release v0.1.0 already exists"],
    ["no environment", { environment: null }, "release environment does not exist"],
    ["no reviewer", { environment: { reviewers: 0, mainOnly: true } }, "no required reviewer"],
    ["any branch", { environment: { reviewers: 1, mainOnly: false } }, "not limited to the main"],
  ])("refuses %s", (_, change, problem) => {
    expect(buildProblems({ ...build, ...change }).join("\n")).toContain(problem);
  });

  const { data, text } = workflow("release.yml");
  const [check, pack, bundle, draft, verify] = [
    "check",
    "package",
    "bundle",
    "draft",
    "verify",
  ].map((name) => jobOf(data, name)) as [Job, Job, Job, Job, Job];

  it("runs only when started by hand, and checks before building", () => {
    expect(Object.keys(data.on)).toEqual(["workflow_dispatch"]);
    expect(runs(check)).toContain("scripts/release/check-build.ts");
    expect(pack.needs).toBe("check");
    expect(bundle.needs).toBe("package");
    // The version reaches scripts through the environment, never the script text.
    expect(text).not.toMatch(/run:[^\n]*\$\{\{\s*inputs\./);
    for (const job of Object.values(data.jobs)) expect(runs(job)).not.toContain("${{ inputs.");
  });

  it("packs the package once and builds every bundle from it", () => {
    const packing = Object.entries(data.jobs).filter(([, job]) =>
      runs(job).includes("scripts/package/pack.ts"),
    );
    expect(packing.map(([name]) => name)).toEqual(["package"]);
    expect(runs(bundle)).toContain(
      'build-bundle.ts --package "out/voyager163-liftoff-$VERSION.tgz"',
    );
    expect(runs(pack)).toContain("npm sbom --sbom-format cyclonedx --omit dev");
  });

  it("makes a draft prerelease, with checksums and attestations, in the release environment", () => {
    expect(draft.environment).toBe("release");
    expect(draft.needs).toEqual(["check", "package", "bundle"]);
    expect(draft.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
    expect(runs(draft)).toContain("sha256sum -- ");
    expect(runs(draft)).toMatch(
      /gh release create "v\$VERSION" assets\/\* [^\n]*--draft --prerelease --target "\$GITHUB_SHA"/,
    );
    expect(uses(draft).some((use) => use.startsWith("actions/attest-build-provenance@"))).toBe(
      true,
    );
    expect(uses(draft).some((use) => use.startsWith("actions/attest@"))).toBe(true);
    // A draft left by an earlier run is visible only to this job's token.
    const names = draft.steps.map((step) => step.name ?? step.uses ?? "");
    expect(names.indexOf("Check no release or draft of this version exists")).toBeLessThan(
      names.indexOf("Create the draft prerelease"),
    );
    expect(runs(draft)).toContain('grep -Fxq "v$VERSION"');
    const sbom = draft.steps.find((step) => step.uses?.startsWith("actions/attest@"));
    expect(sbom?.with?.["subject-path"]).toBe("assets/liftoff-package-*");
    // The only job that can write releases is the reviewed one.
    for (const [name, job] of Object.entries(data.jobs)) {
      if (name !== "draft") expect(runs(job)).not.toMatch(/gh release (create|edit|upload|delete)/);
    }
  });

  it("verifies the draft's own assets on macOS and Windows before anyone publishes them", () => {
    expect(verify.needs).toBe("draft");
    const steps = runs(verify);
    expect(steps).toContain('gh release download "v$VERSION"');
    expect(steps).toMatch(/sha256sum -c SHA256SUMS/);
    expect(steps).toContain("the draft's assets are not the five Release made");
    expect(steps).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"');
    expect(steps).toContain('--source-ref refs/heads/main --source-digest "$GITHUB_SHA"');
    expect(steps).toContain('gh attestation verify "$file" "${signer[@]}" --predicate-type');
    expect(steps).toContain("--predicate-type https://cyclonedx.org/bom");
    expect(steps).toContain('if command -v node; then echo "node is still on PATH"; exit 1; fi');
    expect(steps).toContain("npm install -g --prefix");
    expect(text).not.toContain("npm publish");
  });
});

const COMMIT = "a".repeat(40);
const mac = {
  target: "aarch64-apple-darwin",
  commit: COMMIT,
  signed: { macos: "Developer ID Application: X", windows: null },
};
const windows = {
  target: "x86_64-pc-windows-msvc",
  commit: COMMIT,
  signed: { macos: null, windows: "SignPath Foundation" },
};
const run = {
  path: ".github/workflows/release.yml",
  event: "workflow_dispatch",
  headBranch: "main",
  headSha: COMMIT,
  conclusion: "success",
};
const promote: PromoteFacts = {
  version: "0.1.0",
  stable: true,
  release: { draft: true, prerelease: true, target: COMMIT },
  run,
  targetOnMain: true,
  tagCommit: null,
  stableVersions: [],
  assets: releaseAssets("0.1.0"),
  summed: releaseAssets("0.1.0").filter((name) => name !== "SHA256SUMS"),
  bundles: [mac, windows],
};
const unsigned = promote.bundles.map((bundle) => ({
  ...bundle,
  signed: { macos: null, windows: null },
}));

describe("DIST-004 promotion publishes the verified assets without rebuilding", () => {
  it("refuses a version SemVer does not allow", () => {
    expect(promoteProblems({ ...promote, version: "1.2.3-rc.01", stable: false })).toContain(
      "1.2.3-rc.01 is not a version",
    );
  });

  it("publishes a signed draft as stable, and any draft as a prerelease", () => {
    expect(promoteProblems(promote)).toEqual([]);
    expect(promoteProblems({ ...promote, stable: false, bundles: unsigned })).toEqual([]);
  });

  it("finishes a stable promotion while it is still the newest stable release", () => {
    expect(promoteProblems({ ...promote, stableVersions: ["0.0.9", "0.1.0"] })).toEqual([]);
    expect(promoteProblems({ ...promote, stable: false, stableVersions: ["0.2.0"] })).toEqual([]);
  });

  it("takes a tag the release's own commit has", () => {
    expect(promoteProblems({ ...promote, tagCommit: COMMIT })).toEqual([]);
  });

  it("makes a published prerelease stable, and finishes a promotion run again", () => {
    expect(
      promoteProblems({ ...promote, release: { draft: false, prerelease: true, target: COMMIT } }),
    ).toEqual([]);
    expect(
      promoteProblems({ ...promote, release: { draft: false, prerelease: false, target: COMMIT } }),
    ).toEqual([]);
    expect(
      promoteProblems({
        ...promote,
        stable: false,
        release: { draft: false, prerelease: true, target: COMMIT },
      }),
    ).toEqual([]);
  });

  it.each<[string, Partial<PromoteFacts>, string]>([
    ["no release", { release: null }, "there is no release v0.1.0"],
    [
      "unsigned bundles as stable",
      { bundles: unsigned },
      "aarch64-apple-darwin bundle is unsigned",
    ],
    [
      "a bundle signed only for the other system",
      {
        bundles: [{ ...mac, signed: { macos: null, windows: "x" } }, windows],
      },
      "aarch64-apple-darwin bundle is unsigned",
    ],
    ["a missing bundle", { bundles: [mac] }, "there is no windows bundle"],
    ["a prerelease version as stable", { version: "0.2.0-rc.1" }, "can never be stable"],
    ["a release naming no run", { run: null }, "names no Release run"],
    [
      "a run whose verification failed",
      { run: { ...run, conclusion: "failure" } },
      "ended failure",
    ],
    ["a run still going", { run: { ...run, conclusion: null } }, "ended unfinished"],
    ["a run on another branch", { run: { ...run, headBranch: "topic" } }, "built topic"],
    ["a run at another commit", { run: { ...run, headSha: "b".repeat(40) } }, "not main at"],
    [
      "a run of another workflow",
      { run: { ...run, path: ".github/workflows/ci.yml" } },
      "not a Release workflow run",
    ],
    ["a commit main lacks", { targetOnMain: false }, "main does not contain"],
    ["a tag made at another commit", { tagCommit: "b".repeat(40) }, "points at bbbb"],
    [
      "an asset added to the draft",
      { assets: [...releaseAssets("0.1.0"), "liftoff-installer.exe"] },
      "assets Release did not make: liftoff-installer.exe",
    ],
    [
      "a missing asset",
      { assets: releaseAssets("0.1.0").filter((name) => !name.endsWith(".zip")) },
      "missing liftoff-package-x86_64-pc-windows-msvc.zip",
    ],
    [
      "checksums missing an asset",
      { summed: releaseAssets("0.1.0").filter((name) => name.endsWith(".tgz")) },
      "SHA256SUMS does not list exactly",
    ],
    [
      "checksums of something else",
      { summed: [...releaseAssets("0.1.0").slice(1), "other.exe"] },
      "SHA256SUMS does not list exactly",
    ],
    [
      "an older version as stable",
      { stableVersions: ["0.1.0", "0.1.1"] },
      "v0.1.1 is a newer stable release",
    ],
    [
      "a version behind a later major",
      { stableVersions: ["0.10.0", "0.9.9"] },
      "v0.10.0 is a newer",
    ],
    [
      "a bundle from another commit",
      { bundles: [{ ...mac, commit: "b".repeat(40) }, windows] },
      "bundle was built from bbbb",
    ],
    [
      "a stable release made a prerelease",
      { stable: false, release: { draft: false, prerelease: false, target: COMMIT } },
      "already published as stable",
    ],
  ])("refuses %s", (_, change, problem) => {
    expect(promoteProblems({ ...promote, ...change }).join("\n")).toContain(problem);
  });

  const { data, text } = workflow("promote.yml");
  const publish = jobOf(data, "publish");

  it("checks the release's assets and rules again before publishing anything", () => {
    expect(Object.keys(data.on)).toEqual(["workflow_dispatch"]);
    expect(publish.environment).toBe("release");
    const names = publish.steps.map((step) => step.name ?? step.uses ?? "");
    const at = (name: string) => names.indexOf(name);
    expect(at("Check the checksums and attestations again")).toBeGreaterThan(
      at("Download the release's assets"),
    );
    expect(at("Check the release may be published as asked")).toBeGreaterThan(
      at("Check the checksums and attestations again"),
    );
    expect(at("Publish the GitHub release")).toBeGreaterThan(
      at("Check the release may be published as asked"),
    );
    expect(runs(publish)).toContain('node scripts/release/check-promote.ts "$VERSION" "$STABLE"');
    expect(runs(publish)).toContain('--source-ref refs/heads/main --source-digest "$TARGET"');
    // The run comes from the assets' provenance, never the editable notes.
    expect(runs(publish)).toContain(".predicate.runDetails.metadata.invocationId");
    expect(runs(publish)).toContain('echo "RELEASE_RUN=$runs" >> "$GITHUB_ENV"');
    expect(runs(publish)).toContain('"${signer[@]}" --predicate-type https://cyclonedx.org/bom');
    expect(
      readFileSync(
        path.resolve(import.meta.dirname, "../../scripts/release/check-promote.ts"),
        "utf8",
      ),
    ).not.toMatch(/\.body\b/);
    expect(publish.permissions).toEqual({
      contents: "write",
      attestations: "read",
      actions: "read",
      "id-token": "write",
    });
  });

  it("checks the release environment in a job before the one that uses it", () => {
    const environment = jobOf(data, "environment");
    expect(environment.environment).toBeUndefined();
    expect(runs(environment)).toContain("node scripts/release/check-environment.ts");
    expect(publish.needs).toBe("environment");
  });

  it("gives the GitHub token only to the steps that call gh", () => {
    for (const [file, job] of [
      ["promote.yml", "publish"],
      ["release.yml", "verify"],
    ] as const) {
      const { data: parsed } = workflow(file);
      const found = jobOf(parsed, job) as Job & { env?: Record<string, string> };
      expect(found.env?.GH_TOKEN, `${file} ${job}`).toBeUndefined();
      for (const step of found.steps) {
        const env = (step as Step & { env?: Record<string, string> }).env ?? {};
        if ("GH_TOKEN" in env)
          expect(step.run, `${file} ${step.name}`).toMatch(/\bgh |check-promote/);
        else
          expect(step.run ?? "", `${file} ${step.name}`).not.toMatch(
            /\bgh (release|api|attestation)/,
          );
      }
    }
  });

  it("never shares a concurrency group with a Release run", () => {
    const groups = ["release.yml", "promote.yml"].map(
      (name) =>
        (workflow(name).data as unknown as { concurrency: { group: string } }).concurrency.group,
    );
    expect(new Set(groups).size).toBe(2);
  });

  it("publishes to npm only a stable release, as the release's own tarball", () => {
    const step = (name: string) => publish.steps.find((each) => each.name === name);
    const npm = step("Publish the package to npm");
    expect(npm?.if).toBe("inputs.stable && env.NPM_PUBLISHED == 'false'");
    expect(npm?.run).toBe(
      'npm publish "./voyager163-liftoff-$VERSION.tgz" --access public --tag latest --provenance',
    );
    expect(step("Check npm can take this release")?.run).toContain(
      "npm has $VERSION with a different tarball",
    );
    expect(step("Check npm can take this release")?.run).toContain(
      "npm had $VERSION once and will never take it again",
    );
  });

  it("finds an npm conflict before the GitHub release is public", () => {
    const names = publish.steps.map((each) => each.name ?? each.uses ?? "");
    expect(names.indexOf("Check npm can take this release")).toBeGreaterThan(
      names.indexOf("Check the release may be published as asked"),
    );
    expect(names.indexOf("Check npm can take this release")).toBeLessThan(
      names.indexOf("Publish the GitHub release"),
    );
    expect(names.indexOf("Publish the GitHub release")).toBeLessThan(
      names.indexOf("Publish the package to npm"),
    );
  });

  it("builds and packs nothing", () => {
    expect(text).not.toMatch(/pack\.ts|build-bundle|npm ci|npm pack|tsc/);
    expect(text).not.toContain("|| true");
  });
});
