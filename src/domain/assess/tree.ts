import path from "node:path";

/**
 * What an assessment saw of a project, and what it left out and why. Paths
 * are POSIX paths relative to the project; "." is the project itself.
 */

/** The bounds of a walk. Past them, what is left is reported, never read. */
export const LIMITS = {
  /** Entries listed in the whole project. */
  entries: 50_000,
  /** Entries listed in one directory. */
  directoryEntries: 10_000,
  /** Directories below the project. */
  depth: 12,
  /** Files read. */
  reads: 300,
  /** Bytes read from one file. */
  bytes: 512 * 1024,
} as const;

/**
 * Directories of installed dependencies, caches and build output. They are
 * not walked: they are not the project's own source, and can be huge.
 */
const SKIPPED = new Set([
  ".git",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".pytest_cache",
  ".ruff_cache",
  ".terraform",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "htmlcov",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

export const isSkippedDirectory = (name: string): boolean => SKIPPED.has(name);

/** Files named for the credentials they hold, wherever they are. */
const CREDENTIAL_FILES = new Set([
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".dockercfg",
  ".htpasswd",
  ".terraformrc",
  "terraform.rc",
  "kubeconfig",
]);

/** Extensions of files that hold data rather than code, for names that say what the data is. */
const DATA = /\.(json|ya?ml|toml|ini|env|txt|xml|conf|cfg|properties|plist)$/;

/**
 * Files that may hold secrets or state, such as `.env`, `.envrc`, a
 * `.tfstate`, `credentials.json`, `secrets.local.toml` or a SQLite
 * database. They are noted as present, never read, and never copied.
 * Examples meant to be committed, with "example", "sample" or "template" in
 * their name, are not; nor is code named for secrets, such as
 * `credentials_test.py`.
 */
export function holdsSecretsOrState(file: string): boolean {
  const name = path.posix.basename(file).toLowerCase();
  if (/(^|[._-])(example|sample|template)([._-]|$)/.test(name)) return false;
  const secretName = /^(secrets?|credentials?|client[-_]secrets?|service[-_]account)([._-]|$)/;
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    CREDENTIAL_FILES.has(name) ||
    (secretName.test(name) && (DATA.test(name) || !name.includes("."))) ||
    /\.(secrets?)$/.test(name) ||
    /\.tfstate(\.backup)?$/.test(name) ||
    /\.tfvars(\.json)?$/.test(name) ||
    /\.(pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) ||
    // A database, and the journal, write-ahead log or shared memory beside it.
    /\.(sqlite3?|db)(-wal|-shm|-journal)?$/.test(name)
  );
}

/**
 * The only files an assessment reads: the declarations it interprets. Any
 * other file is only seen by name, so its contents, secrets included, are
 * never read. Liftoff's own tooling under `.github/liftoff` is not the
 * project's.
 */
export function isDeclaration(file: string): boolean {
  if (file.startsWith(".github/")) {
    return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file);
  }
  const name = path.posix.basename(file);
  return (
    [
      "pyproject.toml",
      "package.json",
      "go.mod",
      "compose.yaml",
      "compose.yml",
      "docker-compose.yaml",
      "docker-compose.yml",
      ".terraform.lock.hcl",
      // Where a coverage threshold may be declared.
      ".coveragerc",
      "setup.cfg",
      "tox.ini",
      "pytest.ini",
      "pytest.toml",
      ".pytest.toml",
    ].includes(name) || /^(vitest|vite|jest)\.config\.([cm]?[jt]s|json)$/.test(name)
  );
}

export type EntryKind = "file" | "directory" | "other";

/** Why part of a project was not walked or read. */
export type GapKind =
  /** Installed dependencies, caches or build output. */
  | "skipped"
  /** A link, which is never followed. */
  | "link"
  /** Closed to this user. */
  | "inaccessible"
  /** Changed while it was being read. */
  | "changed"
  /** Past a bound of the walk. */
  | "limit"
  /** May hold secrets or state, so only its name is seen. */
  | "not-read"
  /** A declaration over the size Liftoff reads. */
  | "too-large"
  /** GitHub, which is read only with --live. */
  | "not-checked";

export interface Gap {
  readonly kind: GapKind;
  readonly path?: string;
  readonly detail: string;
}

/** A declaration's text, or why there is none. */
export type Declaration =
  | { readonly text: string }
  | { readonly status: "inaccessible" | "unknown"; readonly reason: string };

export interface Tree {
  /** Everything walked, by path. */
  readonly entries: ReadonlyMap<string, EntryKind>;
  /** Directories every entry of which is in `entries`. */
  readonly listed: ReadonlySet<string>;
  /** The declarations read, by path. */
  readonly declarations: ReadonlyMap<string, Declaration>;
  readonly gaps: readonly Gap[];
}

/** Whether a path is there, as far as the walk can tell. */
export type Presence =
  | { readonly found: true; readonly path: string }
  | { readonly found: false }
  | {
      readonly found: "unknown";
      readonly status: "inaccessible" | "unknown";
      readonly why: string;
    };

const parentOf = (file: string) => {
  const parent = path.posix.dirname(file);
  return parent === "" ? "." : parent;
};

/** The gap that hides a path, if any: at it, or at a directory above it. */
function gapOver(tree: Tree, file: string): Gap | undefined {
  for (let at = file; ; at = parentOf(at)) {
    const gap = tree.gaps.find(
      (candidate) => candidate.path === at && candidate.kind !== "not-read",
    );
    if (gap !== undefined) return gap;
    if (at === ".") return undefined;
  }
}

function unknownFrom(gap: Gap | undefined, file: string): Presence {
  return {
    found: "unknown",
    status: gap?.kind === "inaccessible" ? "inaccessible" : "unknown",
    why: gap ? `${gap.path ?? file}: ${gap.detail}` : `${file} was not walked`,
  };
}

/** Each directory's entries, by the directory's path; built once per tree. */
const childrenOf = new WeakMap<Tree, Map<string, string[]>>();

function children(tree: Tree, directory: string): readonly string[] {
  let index = childrenOf.get(tree);
  if (index === undefined) {
    index = new Map();
    for (const known of tree.entries.keys()) {
      const parent = parentOf(known);
      index.set(parent, [...(index.get(parent) ?? []), known]);
    }
    childrenOf.set(tree, index);
  }
  return index.get(directory) ?? [];
}

/**
 * Whether a file or directory is in the project. Names are compared ignoring
 * letter case, as macOS, Windows and GitHub mostly do. A path in a directory
 * that was not listed in full, or behind a link, is unknown unless it was
 * seen.
 */
export function presence(tree: Tree, file: string): Presence {
  let at = ".";
  const parent = parentOf(file);
  if (parent !== ".") {
    const above = presence(tree, parent);
    if (above.found !== true) return above;
    // Nothing is inside a file.
    if (tree.entries.get(above.path) === "file") return { found: false };
    at = above.path;
  }
  const wanted = path.posix.basename(file).toLowerCase();
  const seen = children(tree, at).find(
    (known) => path.posix.basename(known).toLowerCase() === wanted,
  );
  if (seen !== undefined) return { found: true, path: seen };
  return tree.listed.has(at) && tree.entries.get(at) !== "other"
    ? { found: false }
    : unknownFrom(gapOver(tree, at), file);
}

/**
 * Whether a regular file is in the project. A directory by that name is not
 * one; a link is never followed, so what it is cannot be told.
 */
export function fileAt(tree: Tree, file: string): Presence {
  const found = presence(tree, file);
  if (found.found !== true) return found;
  const kind = tree.entries.get(found.path);
  if (kind === "file") return found;
  return kind === "other"
    ? {
        found: "unknown",
        status: "unknown",
        why: `${found.path} is a link or special file, never followed`,
      }
    : { found: false };
}

/** The first of several regular files that is there, or why none can be known to be. */
export function firstFile(tree: Tree, files: readonly string[]): Presence {
  let unknown: Presence | undefined;
  for (const file of files) {
    const found = fileAt(tree, file);
    if (found.found === true) return found;
    if (found.found === "unknown") unknown ??= found;
  }
  return unknown ?? { found: false };
}

/** The first of several paths that is there, or why none can be known to be. */
export function firstPresent(tree: Tree, files: readonly string[]): Presence {
  let unknown: Presence | undefined;
  for (const file of files) {
    const found = presence(tree, file);
    if (found.found === true) return found;
    if (found.found === "unknown") unknown ??= found;
  }
  return unknown ?? { found: false };
}

/**
 * Files under a directory that match, and whether that is all of them: it
 * is not when a directory in it was not listed in full, other than one
 * skipped by rule, or a link in it was not followed.
 */
export function filesUnder(
  tree: Tree,
  directory: string,
  matches: (file: string) => boolean,
): { readonly files: readonly string[]; readonly hidden?: Presence } {
  let root = ".";
  if (directory !== ".") {
    const there = presence(tree, directory);
    if (there.found === "unknown") return { files: [], hidden: there };
    if (there.found === false || tree.entries.get(there.path) === "file") return { files: [] };
    root = there.path;
  }
  const prefix = root === "." ? "" : `${root}/`;
  const inside = (file: string) => file === root || file.startsWith(prefix);
  const files = [...tree.entries]
    .filter(([file, kind]) => kind === "file" && inside(file) && matches(file))
    .map(([file]) => file);
  const skipped = (file: string) =>
    tree.gaps.some((gap) => gap.kind === "skipped" && gap.path === file);
  const unlisted = [root, ...tree.entries.keys()].find(
    (file) =>
      inside(file) &&
      tree.entries.get(file) !== "file" &&
      (tree.entries.get(file) === "other" || !tree.listed.has(file)) &&
      !skipped(file),
  );
  return unlisted === undefined
    ? { files }
    : { files, hidden: unknownFrom(gapOver(tree, unlisted), unlisted) };
}
