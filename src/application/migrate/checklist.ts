import type { Component } from "../../domain/project/config.ts";
import type { ComponentPlugin } from "../../plugins/contracts/project-plugin.ts";
import type { Selection } from "../../plugins/registry.ts";

/** Where the new project keeps the old project's copy. */
export const COPY_DIRECTORY = "legacy";

/** The checklist a migration writes into the new project, which is the project's own. */
export const CHECKLIST_FILE = "MIGRATION.md";

/** Why something was left out of the copy, which decides what the person does about it. */
export type LeftOutKind =
  /** Git's own data: the history stays with the old project. */
  | "git"
  /** Installed dependencies, caches or build output. */
  | "dependencies"
  /** A file that may hold secrets or state. */
  | "secrets"
  /** A record a Liftoff release before the rebuild left. */
  | "records"
  /** A link or special file, never followed. */
  | "link"
  /** A file over the size Liftoff copies. */
  | "large"
  /** A path not every system can hold, or that macOS and Windows take for another. */
  | "name";

export interface LeftOut {
  readonly path: string;
  readonly kind: LeftOutKind;
  readonly why: string;
}

/** A part found in the old project, and where the new project keeps it, if anywhere. */
export interface MigratedPart {
  /** Its directory in the old project; "." is the project itself. */
  readonly path: string;
  /** A kind of part the new project may have, or "application" for one of no such kind. */
  readonly component: Component | "application";
  readonly stack: string;
  /** The new project's directory for its kind of part, when it has one. */
  readonly to?: string;
  /** What moving it involves, or why it has no place. */
  readonly note: string;
}

export interface ChecklistInput {
  readonly liftoffVersion: string;
  /** The old project's directory name. */
  readonly source: string;
  readonly selection: Selection;
  readonly parts: readonly MigratedPart[];
  readonly left: readonly LeftOut[];
  /** The old project's files the copy holds, by their path in the old project. */
  readonly copied: readonly string[];
  /** The Liftoff release before the rebuild that the old project's records are from, if known. */
  readonly release?: string;
  /** Whether the old project has records from a Liftoff release before the rebuild. */
  readonly records: boolean;
}

/**
 * Text from the old project, such as a file name or a stack's name, with
 * every control character and character that changes the direction of text
 * written as an escape, so it stays on its own line and reads as it is: no
 * name can add a step or a heading of its own to the checklist.
 */
function plain(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it escapes.
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/** Text as a Markdown code span, whatever backticks it holds, escaped as plain() does. */
function code(raw: string): string {
  const text = plain(raw);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Where a path of the old project is in the copy. */
const inCopy = (path: string) =>
  path === "." ? `${COPY_DIRECTORY}/` : `${COPY_DIRECTORY}/${path}`;

/** The coding-agent instruction files and directories a project may have, at its root. */
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const INSTRUCTION_DIRECTORIES = [
  ".agents/",
  ".claude/",
  ".codex/",
  ".github/agents/",
  ".github/instructions/",
  ".github/skills/",
];

/** The new project's plugins for each kind of part, whose layouts say what goes where. */
function pluginsFor(
  selection: Selection,
  component: MigratedPart["component"],
): readonly ComponentPlugin[] {
  switch (component) {
    case "application":
      return [];
    case "backend":
      return selection.pattern === undefined
        ? [selection.stack]
        : [selection.stack, selection.pattern];
    case "frontend":
      return selection.frontend === undefined ? [] : [selection.frontend];
    case "infrastructure":
      return selection.infrastructure === undefined ? [] : [selection.infrastructure];
  }
}

/**
 * MIGRATION.md: what to move from the copy of the old project, and how to
 * check the result. Everything in it comes from what the migration found,
 * so the same old project and choices give the same checklist.
 */
export function renderChecklist(input: ChecklistInput): string {
  const { selection, parts, left, copied, source } = input;
  const lines: string[] = [
    `# Migrating ${plain(source)}`,
    "",
    `Liftoff ${input.liftoffVersion} made this project from ${code(source)} and copied that project's files into ${code(`${COPY_DIRECTORY}/`)}, leaving out what is listed below. Nothing in ${code(source)} was changed, and its Git history stays there.`,
    "",
    `Work through each step, then delete ${code(`${COPY_DIRECTORY}/`)} and this file. They are the project's own: Liftoff does not manage them.`,
    "",
    "## Start",
    "",
    `- [ ] Make the project a Git repository with ${code("git init --initial-branch=develop")}, then add the line ${code(`${COPY_DIRECTORY}/`)} to ${code(".git/info/exclude")} in a text editor, so Git leaves the copy out.`,
    "",
  ];

  const moved = parts.filter((part) => part.to !== undefined);
  const apart = parts.filter((part) => part.to === undefined);
  lines.push("## Move the application", "");
  if (moved.length === 0) {
    lines.push(
      `- [ ] Nothing in ${code(source)} was found to move into the new project's parts. Build the application from its starter, using what ${code(`${COPY_DIRECTORY}/`)} holds.`,
    );
  }
  for (const part of moved) {
    const to = part.to ?? "";
    lines.push(
      `- [ ] The ${part.component} on ${plain(part.stack)} in ${code(inCopy(part.path))}: move it into ${code(`${to}/`)}. ${plain(part.note)}`,
    );
    const layout = pluginsFor(selection, part.component).flatMap((plugin) => plugin.layout);
    if (layout.length > 0) {
      lines.push("  The new project keeps there:", "");
      for (const entry of layout) lines.push(`  - ${code(entry.path)}: ${entry.purpose}`);
    }
  }
  for (const part of apart) {
    lines.push(
      `- [ ] The ${part.component} on ${plain(part.stack)} in ${code(inCopy(part.path))}: ${plain(part.note)}`,
    );
  }
  lines.push(
    `- [ ] Everything else in ${code(`${COPY_DIRECTORY}/`)} the project still needs, such as documentation and specifications: move it in.`,
    "",
  );

  const compare: string[] = [];
  const workflows = copied.filter((file) => file.startsWith(".github/workflows/"));
  if (workflows.length > 0) {
    compare.push(
      `- [ ] The old project's workflows, in ${code(inCopy(".github/workflows/"))}: Liftoff's own are in ${code(".github/workflows/")}. Carry over only what they do not do, as a reviewed change.`,
    );
  }
  const instructions = [
    ...INSTRUCTIONS.filter((file) => copied.includes(file)),
    ...INSTRUCTION_DIRECTORIES.filter((directory) =>
      copied.some((file) => file.startsWith(directory)),
    ),
  ];
  if (instructions.length > 0) {
    compare.push(
      `- [ ] The old project's coding-agent instructions: ${instructions.map((file) => code(inCopy(file))).join(", ")}. Carry what still applies into the new project's ${code("AGENTS.md")} and skills.`,
    );
  }
  if (compare.length > 0) lines.push("## Compare with Liftoff's own files", "", ...compare, "");

  const of = (kind: LeftOutKind) =>
    left.filter((item) => item.kind === kind).map((item) => code(item.path));
  const steps: [LeftOutKind, string][] = [
    [
      "secrets",
      "Files that may hold secrets or state, never copied: {}. Recreate what the new project needs outside Git, as its `.env.example` and README describe.",
    ],
    [
      "dependencies",
      "Directories never copied because of their names, which usually hold installed dependencies, caches or build output: {}. Install the new project's dependencies with its own tools, and copy any of these that hold the project's own files by hand.",
    ],
    ["link", "Links and special files, never followed: {}. Recreate any the project needs."],
    ["large", "Files over 64 MiB: {}. Copy any the project needs by hand."],
    [
      "name",
      "Paths not every system can hold, or that macOS and Windows take for another file: {}. Rename and copy any the project needs.",
    ],
  ];
  const leftOut: string[] = [];
  for (const [kind, text] of steps) {
    const paths = of(kind);
    if (paths.length > 0) leftOut.push(`- [ ] ${text.replace("{}", paths.join(", "))}`);
  }
  const git = of("git");
  if (git.length > 0) {
    leftOut.push(`- Git's data: ${git.join(", ")}. The history stays with ${code(source)}.`);
  }
  if (input.records) {
    leftOut.push(
      `- Records from a Liftoff release before the rebuild${input.release === undefined ? "" : ` (${plain(input.release)})`}: ${of("records").join(", ")}. They stay with ${code(source)} as its history, and are not proof of anything about this project.`,
    );
  }
  if (leftOut.length > 0) lines.push("## What the copy left out", "", ...leftOut, "");

  lines.push(
    "## Check the result",
    "",
    "- [ ] `liftoff validate` reports no problem.",
    ...selection.components.flatMap(({ quickStart }) =>
      quickStart === undefined
        ? []
        : [`- [ ] In ${code(quickStart.directory)}, the tests pass: ${code(quickStart.command)}`],
    ),
    `- [ ] If nothing more is needed from ${code(source)}, run ${code("liftoff migrate --cleanup")} in it, before deleting the copy: it removes from it each file this project holds a byte-for-byte copy of, after asking, and keeps the rest. Name this project with ${code("--to")} if it is not ${code(`${source}-liftoff`)} beside it.`,
    `- [ ] Delete ${code(`${COPY_DIRECTORY}/`)} and this file, and commit.`,
    "",
  );
  return lines.join("\n");
}
