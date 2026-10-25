import { createHash } from "node:crypto";
import * as z from "zod/mini";

/** Most severe first: the order findings are reported in. */
export const TAGS = ["important", "pre-existing", "nit"] as const;
export type Tag = (typeof TAGS)[number];

export const TAG_LABEL: Readonly<Record<Tag, string>> = {
  important: "Important",
  "pre-existing": "Pre-existing",
  nit: "Nit",
};

const text = z.string().check(z.minLength(1), z.maxLength(4000));

const candidateSchema = z.object({
  file: z.string().check(z.minLength(1), z.maxLength(500)),
  line: z.number().check(z.int(), z.positive()),
  title: z.string().check(z.minLength(1), z.maxLength(200)),
  scenario: text,
  fix: z.optional(text),
  bug_class: z.optional(z.string().check(z.maxLength(200))),
  tag: z.optional(z.enum(TAGS)),
});

const verdictSchema = z.object({
  id: z.string().check(z.minLength(1)),
  verdict: z.enum(["confirmed", "rejected", "uncertain"]),
  tag: z.optional(z.enum(TAGS)),
  reason: z.optional(z.string().check(z.maxLength(2000))),
});

export type RawCandidate = z.output<typeof candidateSchema>;
export type Verdict = z.output<typeof verdictSchema>;

/** A candidate finding after merging duplicates across finder passes. */
export interface Candidate extends RawCandidate {
  readonly id: string;
  readonly fingerprint: string;
}

/** A finding the verifiers confirmed, ready to report. */
export interface Finding extends Candidate {
  readonly tag: Tag;
  readonly confirmations: number;
  readonly verifiers: number;
}

export const JSON_START = "<<<LIFTOFF_JSON";
export const JSON_END = "LIFTOFF_JSON>>>";

export class AgentOutputError extends Error {
  override readonly name = "AgentOutputError";
}

/** Extracts and parses the JSON block an agent was asked to print between the markers. */
function extractJson(output: string): unknown {
  const start = output.lastIndexOf(JSON_START);
  const end = output.indexOf(JSON_END, start);
  if (start === -1 || end === -1) {
    throw new AgentOutputError(`agent output has no ${JSON_START} ... ${JSON_END} block`);
  }
  try {
    return JSON.parse(output.slice(start + JSON_START.length, end));
  } catch (error) {
    throw new AgentOutputError(`agent output is not valid JSON: ${(error as Error).message}`);
  }
}

export function parseCandidates(output: string): RawCandidate[] {
  const parsed = z.safeParse(
    z.object({ candidates: z.array(candidateSchema) }),
    extractJson(output),
  );
  if (!parsed.success)
    throw new AgentOutputError(`finder output is invalid: ${parsed.error.issues[0]?.message}`);
  return parsed.data.candidates;
}

export function parseVerdicts(output: string): Verdict[] {
  const parsed = z.safeParse(z.object({ verdicts: z.array(verdictSchema) }), extractJson(output));
  if (!parsed.success)
    throw new AgentOutputError(`verifier output is invalid: ${parsed.error.issues[0]?.message}`);
  return parsed.data.verdicts;
}

const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Stable identity for a finding, independent of line moves, used to avoid repeats. */
export function fingerprint(file: string, title: string): string {
  return createHash("sha256")
    .update(`${file}\n${normalizeTitle(title)}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Merges candidates from several finder passes. Two candidates are the same
 * when they share a fingerprint, or name the same file within three lines.
 */
export function mergeCandidates(passes: readonly (readonly RawCandidate[])[]): Candidate[] {
  const merged: Candidate[] = [];
  for (const candidate of passes.flat()) {
    const print = fingerprint(candidate.file, candidate.title);
    const duplicate = merged.some(
      (existing) =>
        existing.fingerprint === print ||
        (existing.file === candidate.file && Math.abs(existing.line - candidate.line) <= 3),
    );
    if (!duplicate) merged.push({ ...candidate, id: `c${merged.length + 1}`, fingerprint: print });
  }
  return merged;
}

/**
 * Keeps a candidate only when a majority of independent verifier runs
 * confirm it. A missing or uncertain verdict counts against it. The tag is
 * the one most verifiers chose, preferring the more severe on a tie.
 */
export function vote(
  candidates: readonly Candidate[],
  verdictRuns: readonly (readonly Verdict[])[],
): Finding[] {
  const runs = verdictRuns.length;
  if (runs === 0) return [];
  const needed = Math.floor(runs / 2) + 1;
  const findings: Finding[] = [];
  for (const candidate of candidates) {
    const confirmed = verdictRuns
      .map((run) => run.find((verdict) => verdict.id === candidate.id))
      .filter((verdict): verdict is Verdict => verdict?.verdict === "confirmed");
    if (confirmed.length < needed) continue;
    const counts = new Map<Tag, number>();
    for (const verdict of confirmed) {
      const tag = verdict.tag ?? candidate.tag ?? "important";
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tag = [...TAGS].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || TAGS.indexOf(a) - TAGS.indexOf(b),
    )[0] as Tag;
    findings.push({ ...candidate, tag, confirmations: confirmed.length, verifiers: runs });
  }
  return findings.sort(
    (a, b) =>
      TAGS.indexOf(a.tag) - TAGS.indexOf(b.tag) || a.file.localeCompare(b.file) || a.line - b.line,
  );
}
