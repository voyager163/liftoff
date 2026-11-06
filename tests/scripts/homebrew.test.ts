import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { verifyProblems } from "../../scripts/release/check-homebrew-install.ts";
import { bumpCask, render, TEMPLATES } from "../../scripts/release/homebrew.ts";

const repository = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(repository, file), "utf8");
const SUM = "a".repeat(64);
const OTHER = "b".repeat(64);
const cask = render(read(TEMPLATES.cask), { version: "0.1.0", sha256: SUM });
const formula = render(read(TEMPLATES.formula), { version: "0.1.0", sha256: SUM });

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  environment?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
const jobs = (file: string) =>
  (parse(read(`.github/workflows/${file}`)) as { jobs: Record<string, Job> }).jobs;
const scripts = (job: Job | undefined) =>
  (job?.steps ?? [])
    .map((step) => step.run ?? "")
    .join("\n")
    .replace(/\\\n\s*/g, "");

const work = mkdtempSync(path.join(tmpdir(), "liftoff-tap-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("CHAN-001 Mac users install the signed bundle with a Homebrew cask", () => {
  it("installs the release's macOS bundle at its checksum and links its liftoff", () => {
    expect(cask).toMatch(/^cask "liftoff" do\n/);
    expect(cask).toContain('  version "0.1.0"\n');
    expect(cask).toContain(`  sha256 "${SUM}"\n`);
    expect(cask).toContain(
      '  url "https://github.com/voyager163/liftoff/releases/download/v#{version}/liftoff-package-aarch64-apple-darwin.tar.gz"\n',
    );
    expect(cask).toContain('  binary "liftoff-package-aarch64-apple-darwin/bin/liftoff"\n');
    // The comment saying where it came from stays in this repository.
    expect(cask).not.toMatch(/^\s*#/m);
  });

  it("needs Apple Silicon and macOS 15, follows GitHub releases, and runs nothing of its own", () => {
    expect(cask).toContain("  depends_on arch: :arm64\n");
    expect(cask).toContain("  depends_on macos: :sequoia\n");
    expect(cask).toContain("    strategy :github_latest\n");
    expect(cask).not.toMatch(/preflight|postflight|uninstall_|installer /);
  });

  it("is checked, installed, verified and uninstalled from a local tap on macOS CI", () => {
    const ci = jobs("ci.yml");
    const job = ci.homebrew;
    expect(job?.needs).toBe("package");
    expect(job?.["runs-on"]).toMatch(/^macos-/);
    const run = scripts(job);
    expect(run).toContain('brew trust --tap "$TAP"');
    expect(run).toContain('brew style "$TAP"');
    expect(run).toContain('brew audit --strict --cask "$TAP/liftoff"');
    expect(run).toContain('brew install --cask "$TAP/liftoff"');
    expect(run).toContain("node scripts/release/check-homebrew-install.ts homebrew-cask");
    expect(run).toContain('brew uninstall --cask "$TAP/liftoff"');
    expect(ci["ci-gate"]?.needs).toContain("homebrew");
  });

  it("fills in only a release version and a checksum", () => {
    const template = read(TEMPLATES.cask);
    expect(() => render(template, { version: "0.1", sha256: SUM })).toThrow(
      "not a release version",
    );
    expect(() => render(template, { version: "0.1.0", sha256: "ABC" })).toThrow("checksum");
    expect(() => render("{{other}}", { version: "0.1.0", sha256: SUM })).toThrow("not filled in");
    expect(() =>
      render("cask", { version: "0.1.0", sha256: SUM, url: "file:///a.tar.gz" }),
    ).toThrow("no url line");
    expect(
      render(template, { version: "0.1.0", sha256: SUM, url: "file:///tmp/$1/a.tar.gz" }),
    ).toContain('  url "file:///tmp/$1/a.tar.gz"\n');
  });
});

describe("CHAN-001 an install is checked against what liftoff upgrade --verify reports", () => {
  const prefix = "/opt/homebrew";
  const installed = {
    channel: "homebrew-cask",
    location: "/opt/homebrew/Caskroom/liftoff/0.1.0/liftoff-package-aarch64-apple-darwin",
  };

  it("accepts a verified install, with or without a newer release on GitHub", () => {
    const report = { outcome: "success", verified: true, installed };
    expect(verifyProblems("homebrew-cask", prefix, 0, report)).toEqual([]);
    expect(verifyProblems("homebrew-cask", prefix, 3, { ...report, outcome: "attention" })).toEqual(
      [],
    );
  });

  it("refuses an install whose record or PATH did not verify, or another channel's", () => {
    expect(
      verifyProblems("homebrew-cask", prefix, 1, {
        outcome: "failure",
        verified: false,
        installed,
      }),
    ).toEqual(["it exited 1 with outcome failure", "it did not verify the install"]);
    expect(
      verifyProblems("homebrew-cask", prefix, 3, {
        outcome: "attention",
        verified: false,
        installed,
      }),
    ).toEqual(["it did not verify the install"]);
    expect(
      verifyProblems("homebrew-formula", prefix, 0, {
        outcome: "success",
        verified: true,
        installed,
      }),
    ).toEqual([
      "it reports homebrew-cask, not homebrew-formula",
      `it reports ${installed.location}, outside /opt/homebrew/Cellar/liftoff`,
    ]);
    expect(
      verifyProblems("homebrew-cask", prefix, 0, {
        outcome: "attention",
        verified: true,
        installed,
      }),
    ).toEqual(["it exited 0 with outcome attention"]);
  });
});

describe("CHAN-002 a formula for homebrew/core is ready to submit", () => {
  it("builds the release's package tarball with Homebrew's Node and tests a project", () => {
    expect(formula).toMatch(/^class Liftoff < Formula\n/);
    expect(formula).toContain(
      '  url "https://github.com/voyager163/liftoff/releases/download/v0.1.0/voyager163-liftoff-0.1.0.tgz"\n',
    );
    expect(formula).toContain(`  sha256 "${SUM}"\n`);
    expect(formula).toContain('  license "GPL-3.0-only"\n');
    expect(formula).toContain('  depends_on "node"\n');
    expect(formula).toContain('system "npm", "install", *std_npm_args');
    expect(formula).toMatch(/test do[\s\S]*"init"[\s\S]*"validate"/);
    expect(formula).not.toMatch(/Co-Authored-By/i);
  });

  it("is audited, built from source, tested and uninstalled from a local tap on macOS CI", () => {
    const run = scripts(jobs("ci.yml").homebrew);
    expect(run).toContain('brew audit --strict --formula "$TAP/liftoff"');
    expect(run).toContain('brew install --build-from-source --formula "$TAP/liftoff"');
    expect(run).toContain('brew test "$TAP/liftoff"');
    expect(run).toContain("node scripts/release/check-homebrew-install.ts homebrew-formula");
    expect(run).toContain('brew uninstall --formula "$TAP/liftoff"');
  });
});

describe("CHAN-003 a stable release updates the tap through a reviewed pull request", () => {
  const older = cask
    .replace('version "0.1.0"', 'version "0.0.9"')
    .replace("\nend\n", '\n  caveats "kept"\nend\n');

  it("changes only the version and checksum lines", () => {
    const { text, changed } = bumpCask(older, "0.1.0", OTHER);
    expect(changed).toBe(true);
    expect(text).toBe(older.replace('version "0.0.9"', 'version "0.1.0"').replace(SUM, OTHER));
    expect(text).toContain('caveats "kept"');
  });

  it("leaves the same version and checksum alone, and refuses anything else", () => {
    expect(bumpCask(cask, "0.1.0", SUM)).toEqual({ text: cask, changed: false });
    expect(() => bumpCask(cask, "0.1.0", OTHER)).toThrow("another checksum");
    expect(() => bumpCask(cask, "0.0.9", SUM)).toThrow("newer than 0.0.9");
    expect(() => bumpCask(cask, "0.2.0-rc.1", SUM)).not.toThrow();
    expect(() => bumpCask(`${cask}  version "0.3.0"\n`, "0.2.0", SUM)).toThrow("exactly one");
    expect(() => bumpCask(cask.replace("0.1.0", "latest"), "0.2.0", SUM)).toThrow(
      "not a release version",
    );
  });

  it("writes and stages the cask in a Git tap that has none, so Promote commits it", {
    timeout: 60_000,
  }, () => {
    const script = path.join(repository, "scripts", "release", "homebrew.ts");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        {
          encoding: "utf8",
        },
      );
    git("init", "--quiet");
    git("commit", "--quiet", "--allow-empty", "-m", "empty tap");
    const update = () =>
      execFileSync(process.execPath, [script, "update-tap", "0.1.0", SUM, work], {
        encoding: "utf8",
      });
    // Promote's own test: a staged change means a pull request.
    const staged = () => git("diff", "--cached", "--name-only").trim();
    expect(update()).toContain("Casks/liftoff.rb is now 0.1.0");
    expect(readFileSync(path.join(work, "Casks", "liftoff.rb"), "utf8")).toBe(cask);
    expect(staged()).toBe("Casks/liftoff.rb");
    git("commit", "--quiet", "-m", "liftoff 0.1.0");
    expect(git("ls-files").trim()).toBe("Casks/liftoff.rb");
    expect(update()).toContain("the tap already has 0.1.0");
    expect(staged()).toBe("");
    writeFileSync(path.join(work, "Casks", "liftoff.rb"), older);
    git("commit", "--quiet", "-am", "liftoff 0.0.9");
    expect(update()).toContain("is now 0.1.0");
    expect(staged()).toBe("Casks/liftoff.rb");
    expect(
      execFileSync(process.execPath, [script, "render", "formula", "0.1.0", SUM], {
        encoding: "utf8",
      }),
    ).toBe(formula);
  });

  it("runs after a stable release is published, in its own approved job, with the tap's token alone", () => {
    const promote = jobs("promote.yml");
    const tap = promote.tap;
    expect(tap?.needs).toBe("publish");
    expect(tap?.if).toBe("inputs.stable");
    expect(tap?.environment).toBe("release");
    expect(tap?.permissions).toEqual({ contents: "read" });
    expect(tap?.env?.CASK_SHA256).toContain("needs.publish.outputs.cask-sha256");
    expect(promote.publish?.outputs?.["cask-sha256"]).toContain("steps.cask.outputs.sha256");
    const publishNames = (promote.publish?.steps ?? []).map((step) => step.name);
    expect(publishNames.indexOf("Read the macOS bundle's checksum for the Homebrew cask")).toBe(
      publishNames.indexOf("Check the checksums and attestations again") + 1,
    );
    for (const step of tap?.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) {
        expect(step.with?.["persist-credentials"]).toBe(false);
      }
      const secret = JSON.stringify(step).includes("secrets.HOMEBREW_TAP_TOKEN");
      const tokened = /Require the tap's token|Push the change|voyager163\/homebrew-tap/.test(
        `${step.name} ${JSON.stringify(step.with ?? {})}`,
      );
      expect(secret, step.name ?? step.uses).toBe(tokened);
    }
    const run = scripts(tap);
    expect(run).toContain(
      'node scripts/release/homebrew.ts update-tap "$VERSION" "$CASK_SHA256" tap',
    );
    expect(run).toContain("set HOMEBREW_TAP_TOKEN in the release environment");
    expect(run).toContain('gh pr create --repo "$TAP_REPOSITORY"');
    // update-tap stages the cask, so a new one counts and is committed.
    expect(run).toContain("if git diff --cached --quiet; then");
    expect(run).toContain('git commit -m "liftoff $VERSION"');
    expect(run).not.toMatch(/git diff --quiet|git commit -a/);
  });
});
