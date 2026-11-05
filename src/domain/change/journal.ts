import { en } from "zod/locales";
import * as z from "zod/mini";
import {
  CHANGE_JOURNAL_FILE,
  CHANGE_OPERATIONS,
  type ChangePlan,
  pathsProblem,
} from "../plan/change-plan.ts";
import { repositoryPathProblem } from "../project/paths.ts";

z.config(en());

export const JOURNAL_SCHEMA = "liftoff.change-journal/v1";

const sha256 = z.string().check(z.regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"));

const journalSchema = z.strictObject({
  schema: z.literal(JOURNAL_SCHEMA),
  operation: z.enum(CHANGE_OPERATIONS),
  /** The hash of the plan being applied. */
  plan: sha256,
  /** When the change began, as the person's clock had it. */
  started: z.string(),
  /**
   * The directory beside the project holding the new files and the originals,
   * by name only, so a journal can never point anywhere else.
   */
  staging: z
    .string()
    .check(z.regex(/^\.[^/\\]+\.liftoff-staging-[^/\\]+$/, "must be a staging directory's name")),
  changes: z.array(
    z.strictObject({
      path: z.string(),
      before: z.nullable(sha256),
      after: z.nullable(sha256),
      executable: z.optional(z.boolean()),
    }),
  ),
  /**
   * The files the change rests on without changing them, as its plan lists
   * them: finishing it needs each still as it was.
   */
  unchanged: z._default(
    z.array(z.strictObject({ path: z.string(), sha256: z.nullable(sha256) })),
    [],
  ),
});

export type ChangeJournal = z.output<typeof journalSchema>;

export class JournalError extends Error {
  override readonly name = "JournalError";
}

/** The journal written before a plan's first file is changed. */
export function journalFor(plan: ChangePlan, staging: string, started: string): ChangeJournal {
  return {
    schema: JOURNAL_SCHEMA,
    operation: plan.operation,
    plan: plan.hash,
    started,
    staging,
    changes: plan.changes.map((change) => ({
      path: change.path,
      before: change.before,
      after: change.after,
      ...(change.executable === undefined ? {} : { executable: change.executable }),
    })),
    unchanged: plan.unchanged.map(({ path, sha256 }) => ({ path, sha256 })),
  };
}

export function serializeJournal(journal: ChangeJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

export function parseJournal(text: string): ChangeJournal {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new JournalError(`${CHANGE_JOURNAL_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = z.safeParse(journalSchema, raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new JournalError(`${CHANGE_JOURNAL_FILE} is invalid: ${issues.join("; ")}`);
  }
  // The same rules as the plan's, so a journal cannot name a path outside the project.
  const problem =
    pathsProblem(parsed.data.changes) ??
    parsed.data.unchanged.map((file) => repositoryPathProblem(file.path)).find(Boolean);
  if (problem !== undefined)
    throw new JournalError(`${CHANGE_JOURNAL_FILE} is invalid: ${problem}`);
  return parsed.data;
}

/**
 * The file in a staging directory that says which project and plan it
 * belongs to, so a journal copied with its project, or edited, cannot send
 * recovery to another project's staging.
 */
export const STAGING_MARKER = "change.json";

const markerSchema = z.strictObject({
  schema: z.literal("liftoff.change-staging/v1"),
  plan: sha256,
  /** The project directory's identity, which a copy of the project does not share. */
  project: z.string().check(z.minLength(1)),
});

export type StagingMarker = z.output<typeof markerSchema>;

export function stagingMarker(plan: string, project: string): StagingMarker {
  return { schema: "liftoff.change-staging/v1", plan, project };
}

/** The marker's content, or undefined when it is not one. */
export function parseStagingMarker(text: string): StagingMarker | undefined {
  try {
    const parsed = z.safeParse(markerSchema, JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** What is at a changed path now: no file, a regular file with this content, or something else. */
export type FileNow =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly sha256: string }
  | { readonly kind: "other" };

/**
 * One step to finish or undo an interrupted change:
 * - done: the file is already as wanted;
 * - change: it is still as it was before the change, so it gets its new content;
 * - restore: it already has its new content, so it gets its original back;
 * - conflict: it is neither, so something else changed it; it is left alone.
 */
export interface RecoveryStep {
  readonly path: string;
  readonly step: "done" | "change" | "restore" | "conflict";
  /** The content wanted: its sha256, or null for no file. */
  readonly wanted: string | null;
}

/** Whether a file is as wanted: absent for null, or with exactly this content. */
export const fileMatches = (now: FileNow, sha: string | null): boolean =>
  sha === null ? now.kind === "absent" : now.kind === "file" && now.sha256 === sha;

/**
 * Decides each file's step from what is there now, not from what the
 * journal last recorded, so a change that stopped between replacing a file
 * and noting it is recovered the same way.
 */
export function recoverySteps(
  journal: ChangeJournal,
  now: ReadonlyMap<string, FileNow>,
  mode: "finish" | "undo",
): RecoveryStep[] {
  return journal.changes.map((change) => {
    const current = now.get(change.path) ?? { kind: "other" };
    const [wanted, from] =
      mode === "finish" ? [change.after, change.before] : [change.before, change.after];
    const step = fileMatches(current, wanted)
      ? "done"
      : fileMatches(current, from)
        ? mode === "finish"
          ? "change"
          : "restore"
        : "conflict";
    return { path: change.path, step, wanted };
  });
}
