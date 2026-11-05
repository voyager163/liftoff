import { type Finding, TAG_LABEL } from "./findings.ts";

/** Marker on the summary comment, so later rounds can find earlier ones. */
export const SUMMARY_MARKER = "liftoff-ai-review";
/** Marker on each inline comment, so a finding is never posted twice. */
export const FINDING_MARKER = "liftoff-finding";

export interface PreviousReview {
  /** Rounds already completed on this pull request. */
  readonly rounds: number;
  readonly fingerprints: ReadonlySet<string>;
  /** Head commit the last round reviewed, for diff-only re-review. */
  readonly lastHead?: string;
}

export interface ReviewPlanInput {
  readonly findings: readonly Finding[];
  /** Lines on the new side of the diff that GitHub accepts comments on, per file. */
  readonly commentable: Readonly<Record<string, ReadonlySet<number>>>;
  readonly previous: PreviousReview;
  readonly headSha: string;
  readonly maxRounds?: number;
  readonly nitCap?: number;
}

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ReviewPlan {
  readonly round: number;
  readonly stopped: boolean;
  readonly inline: readonly InlineComment[];
  readonly summary: string;
  readonly reported: readonly Finding[];
}

/** Parses the commentable new-side lines from a unified diff patch. */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let next = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    lines.add(next);
    next++;
  }
  return lines;
}

function findingBody(finding: Finding): string {
  const parts = [`**[${TAG_LABEL[finding.tag]}]** ${finding.title}`, "", finding.scenario];
  if (finding.fix) parts.push("", `**Fix:** ${finding.fix}`);
  if (finding.bug_class)
    parts.push("", `**Bug class:** ${finding.bug_class}. Check for other instances.`);
  if (finding.tag === "pre-existing") {
    parts.push(
      "",
      "This was already in the code before this pull request; consider a separate issue.",
    );
  }
  parts.push(
    "",
    `<sub>Confirmed by ${finding.confirmations} of ${finding.verifiers} independent verifiers. Fix it, or reply with a reason and resolve the thread.</sub>`,
    `<!-- ${FINDING_MARKER}:${finding.fingerprint} -->`,
  );
  return parts.join("\n");
}

/**
 * Decides what to post: never repeat a finding already posted, cap nits,
 * comment inline only where GitHub allows, and stop after `maxRounds` so an
 * author is asked to reconsider rather than loop on fixes.
 */
export function planReview(input: ReviewPlanInput): ReviewPlan {
  const maxRounds = input.maxRounds ?? 3;
  const nitCap = input.nitCap ?? 3;
  const round = input.previous.rounds + 1;
  const marker = `<!-- ${SUMMARY_MARKER} round=${round} head=${input.headSha} -->`;

  if (round > maxRounds) {
    return {
      round,
      stopped: true,
      inline: [],
      reported: [],
      summary: [
        marker,
        `### AI review: stopped after ${maxRounds} rounds`,
        "",
        "This pull request has been through the maximum number of automated review rounds. Rather than another round of fixes, reconsider the approach or split the change, and ask a person to review it.",
      ].join("\n"),
    };
  }

  const fresh = input.findings.filter(
    (finding) => !input.previous.fingerprints.has(finding.fingerprint),
  );
  let nits = 0;
  const reported = fresh.filter((finding) => finding.tag !== "nit" || ++nits <= nitCap);
  const inline: InlineComment[] = [];
  const outside: Finding[] = [];
  for (const finding of reported) {
    if (input.commentable[finding.file]?.has(finding.line)) {
      inline.push({ path: finding.file, line: finding.line, body: findingBody(finding) });
    } else {
      outside.push(finding);
    }
  }

  const count = (tag: Finding["tag"]) => reported.filter((finding) => finding.tag === tag).length;
  const headline =
    reported.length === 0
      ? "No findings. Nothing to fix."
      : `${reported.length} finding${reported.length === 1 ? "" : "s"}: ${count("important")} Important, ${count("nit")} Nit, ${count("pre-existing")} Pre-existing.`;
  const summary = [marker, `### AI review, round ${round}`, "", headline];
  if (outside.length > 0) {
    summary.push("", "Outside the changed lines:");
    for (const finding of outside) {
      summary.push(
        `- **[${TAG_LABEL[finding.tag]}]** \`${finding.file}:${finding.line}\`: ${finding.title}. ${finding.scenario} <!-- ${FINDING_MARKER}:${finding.fingerprint} -->`,
      );
    }
  }
  const skipped = input.findings.length - fresh.length;
  if (skipped > 0)
    summary.push(
      "",
      `${skipped} finding${skipped === 1 ? " was" : "s were"} already reported in an earlier round and not repeated.`,
    );
  if (fresh.length > reported.length) {
    summary.push(
      "",
      `${fresh.length - reported.length} more nits were left out (at most ${nitCap} per review).`,
    );
  }
  summary.push(
    "",
    `<sub>Each finding was found independently and confirmed by a majority of separate verifier runs. Round ${round} of at most ${maxRounds}.</sub>`,
  );
  return { round, stopped: false, inline, summary: summary.join("\n"), reported };
}
