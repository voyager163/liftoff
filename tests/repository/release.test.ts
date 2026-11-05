import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  type BuildFacts,
  buildProblems,
  type PromoteFacts,
  promoteProblems,
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
    expect(
      buildProblems({ ...build, version: "0.2.0-rc.1", packageVersion: "0.2.0-rc.1" }),
    ).toEqual([]);
  });

  it.each<[string, Partial<BuildFacts>, string]>([
    ["a leading v", { version: "v0.1.0" }, "is not a version"],
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
    expect(steps).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"');
    expect(steps).toContain("--predicate-type https://cyclonedx.org/bom");
    expect(steps).toContain('if command -v node; then echo "node is still on PATH"; exit 1; fi');
    expect(steps).toContain("npm install -g --prefix");
    expect(text).not.toContain("npm publish");
  });
});

const mac = {
  target: "aarch64-apple-darwin",
  signed: { macos: "Developer ID Application: X", windows: null },
};
const windows = {
  target: "x86_64-pc-windows-msvc",
  signed: { macos: null, windows: "SignPath Foundation" },
};
const promote: PromoteFacts = {
  version: "0.1.0",
  stable: true,
  release: { draft: true, prerelease: true },
  bundles: [mac, windows],
};
const unsigned = promote.bundles.map((bundle) => ({
  ...bundle,
  signed: { macos: null, windows: null },
}));

describe("DIST-004 promotion publishes the verified assets without rebuilding", () => {
  it("publishes a signed draft as stable, and any draft as a prerelease", () => {
    expect(promoteProblems(promote)).toEqual([]);
    expect(promoteProblems({ ...promote, stable: false, bundles: unsigned })).toEqual([]);
  });

  it("makes a published prerelease stable, and finishes a promotion run again", () => {
    expect(promoteProblems({ ...promote, release: { draft: false, prerelease: true } })).toEqual(
      [],
    );
    expect(promoteProblems({ ...promote, release: { draft: false, prerelease: false } })).toEqual(
      [],
    );
    expect(
      promoteProblems({ ...promote, stable: false, release: { draft: false, prerelease: true } }),
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
    [
      "a stable release made a prerelease",
      { stable: false, release: { draft: false, prerelease: false } },
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
  });

  it("publishes to npm only a stable release, as the release's own tarball", () => {
    const npm = publish.steps.find((step) => step.name === "Publish the package to npm");
    expect(npm?.if).toBe("inputs.stable");
    expect(npm?.run).toContain(
      'npm publish "./$tarball" --access public --tag latest --provenance',
    );
    expect(npm?.run).toContain("npm has $VERSION with a different tarball");
  });

  it("builds and packs nothing", () => {
    expect(text).not.toMatch(/pack\.ts|build-bundle|npm ci|npm pack|tsc/);
    expect(text).not.toContain("|| true");
  });
});
