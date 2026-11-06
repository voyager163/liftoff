// Liftoff's Homebrew cask and draft core formula (CHAN-001, CHAN-002), and
// the tap update a stable promotion opens (CHAN-003).
//
//   node scripts/release/homebrew.ts render <cask|formula> <version> <sha256> [<url>]
//   node scripts/release/homebrew.ts update-tap <version> <sha256> <tap directory>
//
// render prints the Ruby, with the release's URL unless one is given (as CI
// gives a local file). update-tap writes and stages Casks/liftoff.rb in a
// Git checkout of the tap, and prints whether it changed it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareVersions, parseVersion } from "../../src/domain/install/version.ts";

const root = path.resolve(import.meta.dirname, "../..");
export const TEMPLATES = {
  cask: "distribution/homebrew/liftoff.rb",
  formula: "distribution/homebrew/core/liftoff.rb",
} as const;
export type Kind = keyof typeof TEMPLATES;

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION_LINE = /^(\s*version ")([^"]*)(")$/m;
const SHA256_LINE = /^(\s*sha256 ")([^"]*)(")$/m;
const URL_LINE = /^(\s*url ")([^"]*)(")$/m;

const checked = (version: string, sha256: string): void => {
  if (parseVersion(version) === undefined) throw new Error(`${version} is not a release version`);
  if (!SHA256.test(sha256)) throw new Error(`${sha256} is not a SHA-256 checksum`);
};

/**
 * The template with its version and checksum filled in, and without the
 * comment that says where it came from, which belongs to this repository.
 * A URL given replaces the release's.
 */
export function render(
  template: string,
  values: { version: string; sha256: string; url?: string },
): string {
  checked(values.version, values.sha256);
  let ruby = template
    .replace(/^(#[^\n]*\n)+/, "")
    .replaceAll("{{version}}", values.version)
    .replaceAll("{{sha256}}", values.sha256);
  if (values.url !== undefined) {
    if (!URL_LINE.test(ruby)) throw new Error("the template has no url line");
    ruby = ruby.replace(URL_LINE, `$1${values.url.replaceAll("$", "$$$$")}$3`);
  }
  if (/\{\{\w+\}\}/.test(ruby)) throw new Error("the template has a value that is not filled in");
  return ruby;
}

/**
 * The tap's cask at a new version: only its version and sha256 lines change,
 * so whatever else its maintainers or Homebrew's tools changed stays. It is
 * never moved to an older version, nor to the same version with other bytes.
 */
export function bumpCask(
  cask: string,
  version: string,
  sha256: string,
): { text: string; changed: boolean } {
  checked(version, sha256);
  const current = VERSION_LINE.exec(cask)?.[2];
  const sum = SHA256_LINE.exec(cask)?.[2];
  const lines = (pattern: RegExp) => cask.match(new RegExp(pattern.source, "gm"))?.length ?? 0;
  if (
    current === undefined ||
    sum === undefined ||
    lines(VERSION_LINE) !== 1 ||
    lines(SHA256_LINE) !== 1
  ) {
    throw new Error("the cask must have exactly one version line and one sha256 line");
  }
  const installed = parseVersion(current);
  const next = parseVersion(version);
  if (installed === undefined || next === undefined) {
    throw new Error(`the cask's version ${current} is not a release version`);
  }
  const order = compareVersions(next, installed);
  if (order < 0) throw new Error(`the tap already has ${current}, newer than ${version}`);
  if (order === 0) {
    if (sum !== sha256) throw new Error(`the tap has ${version} with another checksum, ${sum}`);
    return { text: cask, changed: false };
  }
  return {
    text: cask.replace(VERSION_LINE, `$1${version}$3`).replace(SHA256_LINE, `$1${sha256}$3`),
    changed: true,
  };
}

const readIfThere = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const template = (kind: Kind) => readFileSync(path.join(root, TEMPLATES[kind]), "utf8");

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "render") {
    const [kind = "", version = "", sha256 = "", url] = args;
    if (kind !== "cask" && kind !== "formula") throw new Error("render cask or formula");
    process.stdout.write(
      render(template(kind), { version, sha256, ...(url === undefined ? {} : { url }) }),
    );
  } else if (command === "update-tap") {
    const [version = "", sha256 = "", tap = ""] = args;
    if (tap === "") throw new Error("usage: update-tap <version> <sha256> <tap directory>");
    const file = path.join(tap, "Casks", "liftoff.rb");
    // Read once, so what is bumped is what was there.
    const current = readIfThere(file);
    const next =
      current === undefined
        ? { text: render(template("cask"), { version, sha256 }), changed: true }
        : bumpCask(current, version, sha256);
    if (next.changed) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, next.text);
      // Staged, so a cask new to the tap is committed as a changed one is.
      execFileSync("git", ["-C", tap, "add", "--", path.join("Casks", "liftoff.rb")]);
    }
    console.log(
      next.changed ? `Casks/liftoff.rb is now ${version}` : `the tap already has ${version}`,
    );
  } else {
    throw new Error("usage: homebrew.ts render|update-tap …");
  }
}
