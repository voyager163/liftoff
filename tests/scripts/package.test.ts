import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
/** A checkout with sources that compile, as Liftoff's do. */
const compilable = () =>
  checkout({
    "assets/templates/common/_gitignore": "committed\n",
    "src/index.ts": "export const shipped = 1;\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "nodenext", target: "es2024", types: [], noEmit: true },
      include: ["src"],
    }),
    "tsconfig.build.json": JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: false, rootDir: "src", outDir: "dist" },
      include: ["src"],
    }),
  });
const run = (args: string[]) =>
  new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stderr }));
  });
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

  it("compiles and packs the commit, never untracked or uncommitted files", {
    timeout: 120_000,
  }, () => {
    const repository = compilable();
    // Committed with LF; a host that converts line endings must not change them.
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: repository });
    write(repository, "src/local-secret.ts", "export const secret = 'local';\n");
    write(repository, "assets/templates/common/_gitignore", "uncommitted\n");
    const result = spawnSync(process.execPath, [pack, "--root", repository], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("packed out/packed-1.2.3.tgz".replaceAll("/", path.sep));
    const tarball = path.join(repository, "out", "packed-1.2.3.tgz");
    const listing = execFileSync("tar", ["-tzf", "packed-1.2.3.tgz"], {
      cwd: path.dirname(tarball),
      encoding: "utf8",
    });
    expect(listing).toContain("package/dist/index.js");
    expect(listing).not.toContain("local-secret");
    expect(listing).not.toContain("package/src/");
    const read = (file: string) =>
      execFileSync("tar", ["-xzOf", "packed-1.2.3.tgz", file], {
        cwd: path.dirname(tarball),
        encoding: "utf8",
      });
    expect(read("package/assets/templates/common/_gitignore")).toBe("committed\n");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
    expect(JSON.parse(read("package/package.json")).gitHead).toBe(head.trim());
  });

  it("lets packs run at once without touching each other's files", {
    timeout: 120_000,
  }, async () => {
    const repository = compilable();
    const results = await Promise.all([
      run([pack, "--root", repository]),
      run([pack, "--dry-run", "--root", repository]),
      run([pack, "--dry-run", "--root", repository]),
    ]);
    expect(results).toEqual(results.map(() => ({ status: 0, stderr: "" })));
    const listing = execFileSync("tar", ["-tzf", "packed-1.2.3.tgz"], {
      cwd: path.join(repository, "out"),
      encoding: "utf8",
    });
    expect(listing).toContain("package/dist/index.js");
    // Each stage is removed once its pack is done.
    expect(readdirSync(path.join(repository, "out"))).toEqual(["packed-1.2.3.tgz"]);
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
  it("names the version, target, Node.js, the built commit and its tree, and no signer while unsigned", () => {
    const repository = checkout({});
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
    const built = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");
    // A commit made while the bundle builds changes nothing in its identity.
    write(repository, "LICENSE", "changed\n");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "later");
    expect(git("rev-parse", "HEAD")).not.toBe(built);
    const identity = releaseIdentity(repository, built, {
      version: "1.2.3",
      target: "aarch64-apple-darwin",
      node: "v26.12.1",
    });
    expect(identity).toEqual({
      schema: "liftoff.release/v1",
      version: "1.2.3",
      target: "aarch64-apple-darwin",
      node: "v26.12.1",
      commit: built,
      tree,
      signed: { macos: null, windows: null },
    });
    expect(Object.keys(identity)).not.toContain("channel");
  });
});
