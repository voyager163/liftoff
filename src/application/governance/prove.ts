import type { GitHubApiPort } from "../ports.ts";

/** The ways a protected branch is changed without a pull request, each of which must be refused. */
export const PROOFS = ["direct-push", "force-push", "deletion"] as const;
export type ProofKind = (typeof PROOFS)[number];

export interface ProofResult {
  readonly branch: string;
  readonly proof: ProofKind;
  /** GitHub refused it, as the rules require. */
  readonly refused: boolean;
  readonly detail: string;
}

/** HTTP statuses GitHub answers a change a rule forbids with. */
const REFUSALS = new Set([403, 409, 422]);

/**
 * Tries each forbidden change on a protected branch: an empty commit pushed
 * on top, a commit forced in beside the head, and deleting the branch. Each
 * must be refused. If one is not, the branch is put back at once to the head
 * it had, which an unprotected branch allows, and the proof fails.
 */
export async function proveBranch(
  api: GitHubApiPort,
  repository: string,
  branch: string,
): Promise<ProofResult[]> {
  const route = `/repos/${repository}`;
  const ref = `${route}/git/refs/heads/${encodeURIComponent(branch)}`;
  const head = (await api.get<{ object: { sha: string } }>(`${route}/git/ref/heads/${branch}`))
    .object.sha;
  const commit = await api.get<{ tree: { sha: string }; parents: { sha: string }[] }>(
    `${route}/git/commits/${head}`,
  );
  const proofCommit = async (parents: string[]) =>
    (
      await api.send<{ sha: string }>("POST", `${route}/git/commits`, {
        message: "Liftoff governance proof: GitHub must refuse this change",
        tree: commit.tree.sha,
        parents,
      })
    ).sha;

  const results: ProofResult[] = [];
  const record = async (
    proof: ProofKind,
    outcome: Awaited<ReturnType<GitHubApiPort["attempt"]>>,
    repair: () => Promise<unknown>,
  ) => {
    if (outcome.ok) {
      await repair();
      results.push({
        branch,
        proof,
        refused: false,
        detail: `GitHub allowed it; ${branch} was put back at ${head.slice(0, 12)}`,
      });
    } else if (outcome.status !== undefined && REFUSALS.has(outcome.status)) {
      results.push({ branch, proof, refused: true, detail: `refused (HTTP ${outcome.status})` });
    } else {
      throw new Error(
        `could not tell whether ${proof} on ${branch} was refused: ${outcome.message}`,
      );
    }
  };
  const putBack = () => api.send("PATCH", ref, { sha: head, force: true });

  const ahead = await proofCommit([head]);
  await record(
    "direct-push",
    await api.attempt("PATCH", ref, { sha: ahead, force: false }),
    putBack,
  );
  const beside = await proofCommit(commit.parents.map((parent) => parent.sha));
  await record(
    "force-push",
    await api.attempt("PATCH", ref, { sha: beside, force: true }),
    putBack,
  );
  await record("deletion", await api.attempt("DELETE", ref), () =>
    api.send("POST", `${route}/git/refs`, { ref: `refs/heads/${branch}`, sha: head }),
  );
  return results;
}
