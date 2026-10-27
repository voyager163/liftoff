/**
 * Unified diffs, as `git diff` writes them, read strictly so that a reviewed
 * patch applies exactly as it was reviewed or not at all: every hunk must
 * match the file at the line it names, with no fuzz and no search for
 * another place. Renames, copies, mode changes and binary patches are
 * refused.
 */

/** One hunk: the lines it replaces and the lines that replace them, each with its line ending. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** What a patch does to one file. */
export interface FilePatch {
  readonly path: string;
  readonly kind: "change" | "add" | "remove";
  /** For a new file, whether the patch makes it executable (mode 100755). */
  readonly executable: boolean;
  readonly hunks: readonly Hunk[];
}

export class PatchError extends Error {
  override readonly name = "PatchError";
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** The line git format-patch puts before its signature. */
const SIGNATURE = "-- ";
/** Extended header lines git writes that change only what the patch already says. */
const KEPT_HEADERS = [/^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/];
const REFUSED_HEADERS: readonly [RegExp, string][] = [
  [/^(old|new) mode /, "changes a file's mode"],
  [
    /^(similarity|dissimilarity) index /,
    "renames or copies a file (make it with git diff --no-renames)",
  ],
  [/^(rename|copy) (from|to) /, "renames or copies a file (make it with git diff --no-renames)"],
  [/^Binary files /, "changes a binary file"],
  [/^GIT binary patch/, "changes a binary file"],
];

/** The path a `---` or `+++` line names, or null for /dev/null. */
function headerPath(line: string, prefix: "a/" | "b/", lineNumber: number): string | null {
  // A tab may follow the name, with a timestamp after it.
  const named = line.slice(4).split("\t")[0] ?? "";
  if (named === "/dev/null") return null;
  if (named.startsWith('"')) {
    throw new PatchError(
      `line ${lineNumber} names a file in quotes, which Liftoff does not read; make the patch with git diff and plainer file names`,
    );
  }
  if (!named.startsWith(prefix)) {
    throw new PatchError(
      `line ${lineNumber} names ${named}, without the ${prefix} that git diff puts before each path`,
    );
  }
  return named.slice(prefix.length);
}

/**
 * The files a unified diff changes. Text before the first file, such as a
 * commit message, is ignored; anything else that is not part of a file's
 * changes is refused.
 */
export function parsePatch(text: string): FilePatch[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const patches: FilePatch[] = [];
  let at = 0;
  const next = () => lines[at];
  const isFileStart = (line: string | undefined) =>
    line !== undefined && (line.startsWith("diff --git ") || line.startsWith("--- "));
  while (at < lines.length && !isFileStart(next())) at++;

  while (at < lines.length) {
    const startLine = at + 1;
    let marked: "add" | "remove" | undefined;
    let executable = false;
    let gitHeader: string | undefined;
    if (next()?.startsWith("diff --git ")) {
      gitHeader = next()?.slice("diff --git ".length);
      at++;
      while (at < lines.length && !next()?.startsWith("--- ") && !isFileStart(next())) {
        const line = next() ?? "";
        const refused = REFUSED_HEADERS.find(([pattern]) => pattern.test(line));
        if (refused) throw new PatchError(`line ${at + 1} ${refused[1]}, which repair does not do`);
        const mode = /^(new|deleted) file mode (100644|100755)$/.exec(line);
        if (mode) {
          marked = mode[1] === "new" ? "add" : "remove";
          executable = mode[2] === "100755";
        } else if (!KEPT_HEADERS.some((pattern) => pattern.test(line))) {
          throw new PatchError(
            `line ${at + 1} is not part of a unified diff Liftoff reads: ${line}`,
          );
        }
        at++;
      }
      if (!next()?.startsWith("--- ")) {
        // An empty file added or removed has no hunks, so its name is only in the git header.
        const path = sameOnBothSides(gitHeader ?? "");
        if (marked === undefined || path === undefined) {
          throw new PatchError(`the changes at line ${startLine} name no file and no lines`);
        }
        patches.push({ path, kind: marked, executable, hunks: [] });
        continue;
      }
    }
    const oldPath = headerPath(next() ?? "", "a/", at + 1);
    at++;
    if (!next()?.startsWith("+++ ")) {
      throw new PatchError(`line ${at + 1} should be the +++ line that follows ---`);
    }
    const newPath = headerPath(next() ?? "", "b/", at + 1);
    at++;
    if (oldPath === null && newPath === null) {
      throw new PatchError(`the changes at line ${startLine} name no file`);
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      throw new PatchError(
        `the changes at line ${startLine} rename ${oldPath} to ${newPath}, which repair does not do`,
      );
    }
    const kind = oldPath === null ? "add" : newPath === null ? "remove" : "change";
    if (marked !== undefined && marked !== kind) {
      throw new PatchError(`the changes at line ${startLine} contradict their git header`);
    }
    const path = (newPath ?? oldPath) as string;
    if (gitHeader !== undefined && sameOnBothSides(gitHeader) !== undefined) {
      if (sameOnBothSides(gitHeader) !== path) {
        throw new PatchError(`the changes at line ${startLine} name two different files`);
      }
    }
    const hunks: Hunk[] = [];
    while (at < lines.length && !isFileStart(next()) && next() !== SIGNATURE) {
      hunks.push(readHunk());
    }
    if (hunks.length === 0) {
      throw new PatchError(`the changes to ${path} at line ${startLine} have no hunks`);
    }
    patches.push({ path, kind, executable: kind === "add" && executable, hunks });
    // What follows git format-patch's signature line is not part of the changes.
    if (next() === SIGNATURE) break;
  }

  if (patches.length === 0) throw new PatchError("the patch changes no file");
  return patches;

  function readHunk(): Hunk {
    const header = next() ?? "";
    const headerAt = at + 1;
    const match = HUNK.exec(header);
    if (!match) throw new PatchError(`line ${headerAt} should start a hunk with @@: ${header}`);
    const oldStart = Number(match[1]);
    const oldLines = match[2] === undefined ? 1 : Number(match[2]);
    const newLines = match[4] === undefined ? 1 : Number(match[4]);
    at++;
    const before: string[] = [];
    const after: string[] = [];
    let last: "both" | "old" | "new" | undefined;
    // The counts in the header say where the hunk ends: a removed line that
    // reads like a header, such as an SQL comment, is still part of it.
    while (before.length < oldLines || after.length < newLines || next()?.startsWith("\\")) {
      const line = next();
      if (line === undefined) {
        throw new PatchError(`the hunk at line ${headerAt} ends before its last line`);
      }
      at++;
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" applies to the line before it.
        if (last === undefined) throw new PatchError(`line ${at} follows no line`);
        if (last !== "new") before[before.length - 1] = (before.at(-1) ?? "").slice(0, -1);
        if (last !== "old") after[after.length - 1] = (after.at(-1) ?? "").slice(0, -1);
        if (!(before.length < oldLines || after.length < newLines)) break;
        continue;
      }
      // An empty line is an empty context line whose space was trimmed.
      const marker = line === "" ? " " : line[0];
      const content = `${line.slice(1)}\n`;
      if (marker === " ") {
        before.push(content);
        after.push(content);
        last = "both";
      } else if (marker === "-") {
        before.push(content);
        last = "old";
      } else if (marker === "+") {
        after.push(content);
        last = "new";
      } else {
        throw new PatchError(`line ${at} is not part of the hunk before it: ${line}`);
      }
      if (before.length > oldLines || after.length > newLines) {
        throw new PatchError(`the hunk at line ${headerAt} has more lines than it says`);
      }
    }
    return { oldStart, oldLines, before, after };
  }
}

/** The path a git header names twice, as `a/<path> b/<path>`, when it is one path. */
function sameOnBothSides(header: string): string | undefined {
  const length = (header.length - 5) / 2;
  if (!Number.isInteger(length) || length < 1) return undefined;
  const path = header.slice(2, 2 + length);
  return header === `a/${path} b/${path}` ? path : undefined;
}

/**
 * The file once patched. Each hunk must match the file exactly at the line
 * it names, in order and without overlapping another.
 */
export function applyFilePatch(original: string, patch: FilePatch): string {
  const units = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: string[] = [];
  let cursor = 0;
  for (const [index, hunk] of patch.hunks.entries()) {
    // A hunk that only adds lines names the line it adds them after.
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const found = units.slice(start, start + hunk.oldLines);
    if (
      start < cursor ||
      found.length !== hunk.before.length ||
      found.some((unit, line) => unit !== hunk.before[line])
    ) {
      throw new PatchError(
        `hunk ${index + 1} for ${patch.path} does not match the file at line ${hunk.oldStart}; make the patch against the project as it is now`,
      );
    }
    result.push(...units.slice(cursor, start), ...hunk.after);
    cursor = start + hunk.oldLines;
  }
  result.push(...units.slice(cursor));
  return result.join("");
}
