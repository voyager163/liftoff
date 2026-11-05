import * as z from "zod/mini";
import type { Finding } from "./findings.ts";

/**
 * A review evaluation case. A "missed-bug" or "seeded" case is a change that
 * introduces a known defect; the reviewer should report it. A "clean" case is
 * a harmless change; any Important finding on it is a false positive.
 */
const caseSchema = z.strictObject({
  kind: z.enum(["missed-bug", "seeded", "clean", "false-positive"]),
  /** Patch file, relative to the case directory, applied on top of the base branch. */
  patch: z.string().check(z.minLength(1)),
  /** What the reviewer is told the change is for. Must not give the defect away. */
  description: z.string().check(z.minLength(1)),
  /** Where the defect is, for cases that have one. */
  file: z.optional(z.string().check(z.minLength(1))),
  line: z.optional(z.number().check(z.int(), z.positive())),
  /** How far from `line` a finding may point and still count. Default 8. */
  tolerance: z.optional(z.number().check(z.int(), z.nonnegative())),
  summary: z.string().check(z.minLength(1)),
});

export type EvalCase = z.output<typeof caseSchema>;

export function parseEvalCase(text: string, source: string): EvalCase {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not valid JSON: ${(error as Error).message}`);
  }
  const parsed = z.safeParse(caseSchema, raw);
  if (!parsed.success) {
    throw new Error(
      `${source}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const value = parsed.data;
  const hasDefect = value.kind === "missed-bug" || value.kind === "seeded";
  if (hasDefect && (value.file === undefined || value.line === undefined)) {
    throw new Error(`${source}: a ${value.kind} case needs file and line`);
  }
  return value;
}

export interface EvalScore {
  readonly kind: EvalCase["kind"];
  /** For defect cases: whether a confirmed finding pointed at the defect. */
  readonly caught: boolean | undefined;
  /** Important findings that do not point at the known defect. */
  readonly falsePositives: number;
  readonly findings: number;
}

/** Scores one review run against a case. */
export function scoreEval(evalCase: EvalCase, findings: readonly Finding[]): EvalScore {
  const tolerance = evalCase.tolerance ?? 8;
  const atDefect = (finding: Finding) =>
    evalCase.file !== undefined &&
    evalCase.line !== undefined &&
    finding.file === evalCase.file &&
    Math.abs(finding.line - evalCase.line) <= tolerance;
  const hasDefect = evalCase.kind === "missed-bug" || evalCase.kind === "seeded";
  return {
    kind: evalCase.kind,
    caught: hasDefect ? findings.some(atDefect) : undefined,
    falsePositives: findings.filter((finding) => finding.tag === "important" && !atDefect(finding))
      .length,
    findings: findings.length,
  };
}
