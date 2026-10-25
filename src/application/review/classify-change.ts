import { type Classification, classify } from "../../domain/risk-policy/classify.ts";
import { POLICY_PATH, parsePolicy } from "../../domain/risk-policy/policy.ts";
import type { GitPort, WorkspacePort } from "../ports.ts";

export interface ClassifyChangeRequest {
  /** Branch the change will merge into. */
  readonly base: string;
  /** GitHub login of the author; when absent a trusted author is assumed. */
  readonly author?: string;
  /** Only committed changes, ignoring the working tree. */
  readonly committedOnly: boolean;
}

export interface ClassifyChangeResult {
  readonly base: { readonly ref: string; readonly commit: string; readonly mergeBase: string };
  /** Where the policy came from: the base ref (trusted) or the working tree (unverified). */
  readonly policySource: "base" | "working-tree";
  readonly author: { readonly login: string; readonly assumedTrusted: boolean };
  readonly fileCount: number;
  readonly classification: Classification;
}

export class ClassifyChangeError extends Error {
  override readonly name = "ClassifyChangeError";
}

/** Classifies the current change against its base branch, without writing anything. */
export async function classifyChange(
  ports: { git: GitPort; workspace: WorkspacePort },
  request: ClassifyChangeRequest,
): Promise<ClassifyChangeResult> {
  const { git, workspace } = ports;
  const baseRef = await resolveBase(git, request.base);
  const head = await git.resolveCommit("HEAD");
  if (head === undefined) throw new ClassifyChangeError("this repository has no commits yet");
  const mergeBase = await git.mergeBase(baseRef.commit, head);

  let policySource: ClassifyChangeResult["policySource"] = "base";
  let policyText = await git.showFile(baseRef.commit, POLICY_PATH);
  if (policyText === undefined) {
    policySource = "working-tree";
    policyText = await workspace.readText(POLICY_PATH);
  }
  if (policyText === undefined) {
    throw new ClassifyChangeError(`no review policy: ${POLICY_PATH} is missing`);
  }
  const policy = parsePolicy(policyText);

  const files = await git.changedFiles(mergeBase, !request.committedOnly);
  // Without a known author, assume the first trusted author so local runs show
  // the tier the change itself earns. CI always passes the real author.
  const assumedTrusted = request.author === undefined;
  const login = request.author ?? policy.trusted_authors[0] ?? "local-author";
  const classification = classify({
    policy:
      assumedTrusted && policy.trusted_authors.length === 0
        ? { ...policy, trusted_authors: [login] }
        : policy,
    files,
    author: login,
  });

  return {
    base: { ref: baseRef.ref, commit: baseRef.commit, mergeBase },
    policySource,
    author: { login, assumedTrusted },
    fileCount: files.length,
    classification,
  };
}

// The remote branch is what a pull request merges into, so it wins over a
// local branch of the same name that may be stale.
async function resolveBase(git: GitPort, base: string): Promise<{ ref: string; commit: string }> {
  for (const ref of [`origin/${base}`, base]) {
    const commit = await git.resolveCommit(ref);
    if (commit !== undefined) return { ref, commit };
  }
  throw new ClassifyChangeError(`base branch "${base}" was not found locally or on origin`);
}
