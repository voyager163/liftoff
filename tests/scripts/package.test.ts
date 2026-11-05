import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseIdentity } from "../../scripts/package/release-identity.ts";
import { PackageAssets } from "../../src/adapters/assets.ts";

const root = path.resolve(import.meta.dirname, "../..");
const pack = path.join(root, "scripts", "package", "pack.ts");
const temporary: string[] = [];
const scratch = () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "liftoff-package-")));
  temporary.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const write = (base: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  writeFileSync(path.join(base, file), text);
};

/** A checkout with the files packing needs, committed so Git tracks them. */
const checkout = (assets: Record<string, string>) => {
  const repository = scratch();
  write(
    repository,
    "package.json",
    JSON.stringify({
      name: "packed",
      version: "1.2.3",
      files: ["dist", "assets", ".github/liftoff"],
    }),
  );
  write(repository, "LICENSE", "license\n");
  write(repository, "README.md", "readme\n");
  write(repository, ".github/liftoff/check.mjs", "export {};\n");
  for (const [file, text] of Object.entries(assets)) write(repository, file, text);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "c");
  return repository;
};
const packing = (repository: string) =>
  spawnSync(process.execPath, [pack, "--dry-run", "--root", repository], { encoding: "utf8" });

describe("DIST-001 one npm package carries every file Liftoff ships", () => {
  it("packs every file Git tracks under assets and .github/liftoff", { timeout: 60_000 }, () => {
    const result = spawnSync(process.execPath, [pack, "--dry-run"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+ files would be packed/);
  });

  it("fails and names a tracked asset that npm would leave out", { timeout: 60_000 }, () => {
    const repository = checkout({
      "assets/templates/common/_gitignore": "kept\n",
      "assets/templates/common/.gitignore": "dropped\n",
    });
    const result = packing(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("left out of the package: assets/templates/common/.gitignore");
    expect(result.stderr).not.toContain("_gitignore");
  });

  it("packs a checkout whose assets npm keeps whole", { timeout: 60_000 }, () => {
    const result = packing(checkout({ "assets/templates/common/_gitignore": "kept\n" }));
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("files would be packed for version 1.2.3");
  });

  it("packs only what the commit tracks, never untracked or ignored files", {
    timeout: 60_000,
  }, () => {
    const repository = checkout({ "assets/templates/common/_gitignore": ".env\n" });
    write(repository, ".gitignore", "*.env\n");
    write(repository, "assets/templates/common/secret.env", "TOKEN=1\n");
    write(repository, "assets/templates/common/backend/.venv/pyvenv.cfg", "home = x\n");
    const result = packing(repository);
    expect(result.stderr).toBe("");
    // package.json, LICENSE, README.md, the _gitignore and check.mjs.
    expect(result.stdout).toContain("5 files would be packed");
  });

  it("refuses to pack a checkout with uncommitted changes to tracked files", () => {
    const repository = checkout({ "assets/templates/common/_gitignore": "kept\n" });
    write(repository, "assets/templates/common/_gitignore", "changed\n");
    const result = spawnSync(process.execPath, [pack, "--root", repository], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to pack: commit or discard the changes");
  });

  it("reads an asset kept as _gitignore under its real name", async () => {
    const assets = scratch();
    write(assets, "templates/common/_gitignore", ".venv/\n");
    write(assets, "templates/common/README.md", "readme\n");
    const reader = new PackageAssets(assets, assets);
    expect(await reader.listTree("templates")).toEqual([
      "templates/common/.gitignore",
      "templates/common/README.md",
    ]);
    expect(await reader.list("templates/common")).toEqual([".gitignore", "README.md"]);
    expect(await reader.readText("templates/common/.gitignore")).toBe(".venv/\n");
    expect(await reader.readText("templates/common/README.md")).toBe("readme\n");
  });

  it("keeps no asset under a name npm leaves out of packages", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "assets", ".github/liftoff"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n");
    const dropped = /(^|\/)(\.gitignore|\.npmignore|\.npmrc|\.DS_Store|node_modules\/.*)$/;
    expect(tracked.filter((file) => dropped.test(file))).toEqual([]);
  });
});

describe("DIST-002 each bundle says what it is", () => {
  it("names the version, target, Node.js, commit and tree, and no signer while unsigned", () => {
    const repository = checkout({});
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    const identity = releaseIdentity(repository, {
      version: "1.2.3",
      target: "aarch64-apple-darwin",
      node: "v26.12.1",
    });
    expect(identity).toEqual({
      schema: "liftoff.release/v1",
      version: "1.2.3",
      target: "aarch64-apple-darwin",
      node: "v26.12.1",
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      signed: { macos: null, windows: null },
    });
    expect(Object.keys(identity)).not.toContain("channel");
  });
});
