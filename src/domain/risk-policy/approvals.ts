export interface Review {
  readonly reviewer: string;
  readonly isBot: boolean;
  /** The reviewer can push to the repository (write, maintain or admin). */
  readonly hasWriteAccess: boolean;
  readonly state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  readonly commitId: string;
  /** Monotonic order of submission (for example the submitted time in ms). */
  readonly submittedAt: number;
}

export interface ApprovalInput {
  readonly required: number;
  readonly author: string;
  readonly headSha: string;
  readonly reviews: readonly Review[];
}

export interface ApprovalResult {
  readonly required: number;
  readonly approvers: readonly string[];
  readonly ignored: readonly { reviewer: string; why: string }[];
  readonly satisfied: boolean;
}

/**
 * Counts approvals that a human could be held accountable for: the latest
 * review from each person, on the current head commit, from someone other
 * than the author, with write access. Bot approvals never count, and a later
 * comment-only review does not cancel an earlier approval.
 */
export function evaluateApprovals(input: ApprovalInput): ApprovalResult {
  const latest = new Map<string, Review>();
  for (const review of [...input.reviews].sort((a, b) => a.submittedAt - b.submittedAt)) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.reviewer.toLowerCase(), review);
  }

  const approvers: string[] = [];
  const ignored: { reviewer: string; why: string }[] = [];
  for (const review of latest.values()) {
    if (review.state !== "APPROVED") continue;
    const why = disqualify(review, input);
    if (why === undefined) approvers.push(review.reviewer);
    else ignored.push({ reviewer: review.reviewer, why });
  }
  approvers.sort();
  return {
    required: input.required,
    approvers,
    ignored,
    satisfied: approvers.length >= input.required,
  };
}

function disqualify(review: Review, input: ApprovalInput): string | undefined {
  if (review.isBot) return "bot approvals never count as human approvals";
  if (review.reviewer.toLowerCase() === input.author.toLowerCase())
    return "the author cannot approve";
  if (!review.hasWriteAccess) return "reviewer has no write access";
  if (review.commitId !== input.headSha) return "approval is for an older commit";
  return undefined;
}
