import { describe, expect, it } from "vitest";
import { applyFilePatch, PatchError, parsePatch } from "../../src/domain/change/patch.ts";

/** Applies every file in a patch to its original, by path. */
const applied = (patch: string, originals: Record<string, string>) =>
  Object.fromEntries(
    parsePatch(patch).map((file) => [file.path, applyFilePatch(originals[file.path] ?? "", file)]),
  );

describe("REPAIR-003 a patch applies exactly as git diff wrote it", () => {
  it("changes, adds and removes files, as git would", () => {
    const patch = [
      "diff --git a/db/001.sql b/db/001.sql",
      "index 1111111..2222222 100644",
      "--- a/db/001.sql",
      "+++ b/db/001.sql",
      "@@ -1,4 +1,3 @@",
      "--- first",
      " select 1;",
      "--- second",
      "+-- second, kept",
      " select 2;",
      "diff --git a/run.sh b/run.sh",
      "new file mode 100755",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/run.sh",
      "@@ -0,0 +1,2 @@",
      "+#!/bin/sh",
      "+echo hi",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files.map(({ path, kind, executable }) => [path, kind, executable])).toEqual([
      ["db/001.sql", "change", false],
      ["run.sh", "add", true],
      ["gone.txt", "remove", false],
      ["empty.txt", "add", false],
    ]);
    expect(
      applied(patch, {
        "db/001.sql": "-- first\nselect 1;\n-- second\nselect 2;\n",
        "gone.txt": "bye\n",
      }),
    ).toEqual({
      "db/001.sql": "select 1;\n-- second, kept\nselect 2;\n",
      "run.sh": "#!/bin/sh\necho hi\n",
      "gone.txt": "",
      "empty.txt": "",
    });
  });

  it("keeps a last line without a newline, and applies hunks at the lines they name", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const original = `${lines.join("\n")}`;
    const patch = [
      "--- a/notes.txt\t2026-10-27 12:00:00",
      "+++ b/notes.txt\t2026-10-27 12:01:00",
      "@@ -2,2 +2,3 @@",
      " line 2",
      "+inserted",
      " line 3",
      "@@ -11,2 +12,2 @@",
      " line 11",
      "-line 12",
      "\\ No newline at end of file",
      "+line twelve",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(applied(patch, { "notes.txt": original })["notes.txt"]).toBe(
      original.replace("line 2\n", "line 2\ninserted\n").replace("line 12", "line twelve"),
    );
  });

  it("reads a blank context line whose space was trimmed, and stops at a signature", () => {
    const patch = [
      "From 0123 Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH] Fix",
      "",
      "---",
      " a.txt | 1 +",
      "",
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "",
      "-three",
      "+3",
      "-- ",
      "2.43.0",
      "",
    ].join("\n");
    expect(applied(patch, { "a.txt": "one\n\nthree\n" })).toEqual({ "a.txt": "one\n\n3\n" });
  });

  it.each<[string, string[], RegExp]>([
    [
      "renames a file",
      ["diff --git a/a b/b", "similarity index 90%", "rename from a", "rename to b"],
      /renames or copies a file \(make it with git diff --no-renames\)/,
    ],
    [
      "changes a mode",
      ["diff --git a/a b/a", "old mode 100644", "new mode 100755"],
      /changes a file's mode/,
    ],
    [
      "changes a binary file",
      ["diff --git a/a b/a", "Binary files a/a and b/a differ"],
      /binary file/,
    ],
    [
      "has an unknown header line",
      ["diff --git a/a b/a", "what is this"],
      /not part of a unified diff/,
    ],
    [
      "names no lines",
      ["diff --git a/a b/a", "index 1111111..2222222 100644"],
      /name no file and no lines/,
    ],
    [
      "quotes a path",
      ['--- "a/\\303\\251t\\303\\251"', '+++ "b/\\303\\251t\\303\\251"'],
      /in quotes/,
    ],
    ["has no a/ prefix", ["--- a.txt", "+++ b/a.txt"], /without the a\//],
    ["has no +++ line", ["--- a/a.txt", "@@ -1 +1 @@"], /should be the \+\+\+ line/],
    ["names no file", ["--- /dev/null", "+++ /dev/null"], /name no file/],
    [
      "renames between --- and +++",
      ["--- a/one", "+++ b/two", "@@ -1 +1 @@", "-a", "+b"],
      /rename one to two/,
    ],
    [
      "contradicts its git header",
      [
        "diff --git a/a b/a",
        "new file mode 100644",
        "--- a/a",
        "+++ b/a",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ],
      /contradict their git header/,
    ],
    [
      "names two files",
      ["diff --git a/a b/a", "--- a/b", "+++ b/b", "@@ -1 +1 @@", "-a", "+b"],
      /name two different files/,
    ],
    ["has no hunks", ["--- a/a", "+++ b/a"], /have no hunks/],
    ["has a bad hunk header", ["--- a/a", "+++ b/a", "@@ one @@"], /should start a hunk/],
    [
      "ends a hunk early",
      ["--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", " a"],
      /ends before its last line/,
    ],
    [
      "has a line that is not in a hunk",
      ["--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", " a", "*b"],
      /not part of the hunk before it/,
    ],
    [
      "marks no line",
      ["--- a/a", "+++ b/a", "@@ -1 +1 @@", "\\ No newline at end of file"],
      /follows no line/,
    ],
    ["changes nothing", ["just text"], /changes no file/],
  ])("refuses a patch that %s", (_, lines, message) => {
    expect(() => parsePatch(lines.join("\n"))).toThrow(PatchError);
    expect(() => parsePatch(lines.join("\n"))).toThrow(message);
  });

  it("refuses a hunk with more lines than its header says", () => {
    expect(() => parsePatch(["--- a/a", "+++ b/a", "@@ -1 +1 @@", " a", " b"].join("\n"))).toThrow(
      /should start a hunk/,
    );
    expect(() => parsePatch(["--- a/a", "+++ b/a", "@@ -1,1 +1,0 @@", " a"].join("\n"))).toThrow(
      /more lines than it says/,
    );
  });

  it("refuses a hunk that does not match exactly where it says, or overlaps another", () => {
    const patch = (start: number, before: string) =>
      parsePatch(
        ["--- a/a", "+++ b/a", `@@ -${start} +${start} @@`, `-${before}`, "+new"].join("\n"),
      );
    const [file] = patch(2, "two");
    if (file === undefined) throw new Error("no file");
    expect(applyFilePatch("one\ntwo\n", file)).toBe("one\nnew\n");
    expect(() => applyFilePatch("one\nTWO\n", file)).toThrow(
      "hunk 1 for a does not match the file at line 2; make the patch against the project as it is now",
    );
    // The same line, one place off, is not looked for.
    expect(() => applyFilePatch("zero\none\ntwo\n", file)).toThrow(/does not match/);
    const overlapping = parsePatch(
      ["--- a/a", "+++ b/a", "@@ -2 +2 @@", "-two", "+2", "@@ -1 +1 @@", "-one", "+1"].join("\n"),
    )[0];
    if (overlapping === undefined) throw new Error("no file");
    expect(() => applyFilePatch("one\ntwo\n", overlapping)).toThrow("hunk 2 for a does not match");
  });
});
