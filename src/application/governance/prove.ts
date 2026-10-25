import { type PendingProbe, PROOFS, type ProofKind } from "../../domain/governance/state.ts";
import type { GitHubApiPort } from "../ports.ts";

export { PROOFS, type ProofKind };

/** The message of each commit a proof makes, so a leftover one can be recognised. */
export const PROOF_MESSAGE = "Liftoff governance proof: GitHub must refuse this change";

export interface ProofResult {
  readonly branch: string;
  readonly proof: ProofKind;
  /** GitHub refused it, as the rules require. */
  readonly refused: boolean;
  readonly detail: string;
}

/**
 * Where each forbidden change is recorded before it is tried and cleared once
 * the branch is as it was, so an interrupted proof can be put right.
 */
export interface ProbeJournal {
  start(probe: Omit<PendingProbe, "startedAt">): Promise<void>;
  finish(): Promise<void>;
}

/** HTTP statuses GitHub answers a change a rule forbids with. */
const REFUSALS = new Set([403, 409, 422]);
/**
 * What GitHub says when a rule refused a change. The same statuses also
 * answer rate limits and invalid requests, which prove nothing.
 */
const RULE_REFUSAL = /rule violation|protected branch|protected ref/i;

/** The commit a branch points at, or undefined when it does not exist. */
export const branchHead = async (api: GitHubApiPort, repository: string, branch: string) =>
  (
    await api.find<{ object: { sha: string } }>(
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    )
  )?.object.sha;

/**
 * What putting an interrupted proof's branch back would change, checked
 * against GitHub rather than trusted from the record, which is a file anyone
 * can edit. The branch must be one the rulesets protect. It is put back only
 * from a commit the proof made from the recorded head, with Liftoff's proof
 * message and the head's files, or created again if the proof deleted it.
 * Answers the change to ask the person about, or, when there is nothing to
 * change, what was found.
 */
export async function plannedRepair(
  api: GitHubApiPort,
  repository: string,
  probe: Omit<PendingProbe, "startedAt">,
  protectedBranches: readonly string[],
): Promise<{ readonly change: string } | { readonly found: string }> {
  const route = `/repos/${repository}`;
  const short = (sha: string) => sha.slice(0, 12);
  if (!protectedBranches.includes(probe.branch)) {
    return {
      found: `the record names ${probe.branch}, which the rulesets do not protect; nothing was changed`,
    };
  }
  const current = await branchHead(api, repository, probe.branch);
  if (current === probe.head)
    return { found: `${probe.branch} is at ${short(probe.head)}, as before` };
  type Commit = { tree: { sha: string }; parents: { sha: string }[]; message?: string };
  const head = await api.find<Commit>(`${route}/git/commits/${probe.head}`);
  if (head === undefined) {
    return {
      found: `the recorded head ${short(probe.head)} is not a commit here; nothing was changed`,
    };
  }
  if (current === undefined) {
    if (probe.proof !== "deletion") {
      return { found: `${probe.branch} does not exist; nothing was changed` };
    }
    // GitHub's own record of the branch: its latest change must be a
    // deletion from the recorded head, or the record is not believed.
    const [latest] =
      (await api.find<{ activity_type: string; before: string }[]>(
        `${route}/activity?ref=${encodeURIComponent(`refs/heads/${probe.branch}`)}&direction=desc&per_page=1`,
      )) ?? [];
    return latest?.activity_type === "branch_deletion" && latest.before === probe.head
      ? {
          change: `create ${probe.branch} again at ${short(probe.head)}, where the proof deleted it`,
        }
      : {
          found: `GitHub does not show ${probe.branch} deleted at ${short(probe.head)}, so it was not created again; restore it by hand if the proof deleted it`,
        };
  }
  const made =
    current === probe.sha ? await api.find<Commit>(`${route}/git/commits/${current}`) : undefined;
  const parents = made?.parents.map((parent) => parent.sha) ?? [];
  const fromHead =
    probe.proof === "direct-push"
      ? parents.length === 1 && parents[0] === probe.head
      : probe.proof === "force-push" &&
        parents.join() === head.parents.map((parent) => parent.sha).join();
  if (made?.message === PROOF_MESSAGE && made.tree.sha === head.tree.sha && fromHead) {
    return {
      change: `put ${probe.branch} back at ${short(probe.head)}, from the proof's commit ${short(current)}`,
    };
  }
  return {
    found: `${probe.branch} is at ${short(current)}, which the proof did not make, so it was left as it is; check it`,
  };
}

/**
 * Puts a branch back after a forbidden change GitHub allowed, but only while
 * it is exactly where that change left it: a branch someone has moved since
 * is left alone. Answers what happened, or throws when GitHub refuses.
 */
export async function putBack(
  api: GitHubApiPort,
  repository: string,
  probe: Omit<PendingProbe, "startedAt">,
): Promise<string> {
  const route = `/repos/${repository}`;
  const current = await branchHead(api, repository, probe.branch);
  const short = probe.head.slice(0, 12);
  if (current === probe.head) return `${probe.branch} is at ${short}, as before`;
  if (probe.proof === "deletion" && current === undefined) {
    await api.send("POST", `${route}/git/refs`, {
      ref: `refs/heads/${probe.branch}`,
      sha: probe.head,
    });
    return `${probe.branch} was created again at ${short}`;
  }
  if (current !== undefined && current === probe.sha) {
    await api.send("PATCH", `${route}/git/refs/heads/${encodeURIComponent(probe.branch)}`, {
      sha: probe.head,
      force: true,
    });
    return `${probe.branch} was put back at ${short}`;
  }
  return `${probe.branch} has moved to ${current?.slice(0, 12) ?? "nothing"} since, so it was left as it is; check it, and remove any "${PROOF_MESSAGE}" commit`;
}

/**
 * Tries each forbidden change on a protected branch: an empty commit pushed
 * on top, a commit forced in beside the head, and deleting the branch. Each
 * must be refused. If one is not, the branch is put back at the head it had
 * just before, unless it has moved since, and the proof fails. Each change is
 * recorded in the journal first; if the branch cannot be put back, the record
 * stays for resume, and no further change is tried.
 */
export async function proveBranch(
  api: GitHubApiPort,
  repository: string,
  branch: string,
  journal: ProbeJournal,
): Promise<ProofResult[]> {
  const route = `/repos/${repository}`;
  const ref = `${route}/git/refs/heads/${encodeURIComponent(branch)}`;
  const results: ProofResult[] = [];
  for (const proof of PROOFS) {
    // Read just before each change, so it is made against the latest head.
    const head = await branchHead(api, repository, branch);
    if (head === undefined) throw new Error(`${branch} does not exist`);
    let sha: string | undefined;
    if (proof !== "deletion") {
      const commit = await api.get<{ tree: { sha: string }; parents: { sha: string }[] }>(
        `${route}/git/commits/${head}`,
      );
      sha = (
        await api.send<{ sha: string }>("POST", `${route}/git/commits`, {
          message: PROOF_MESSAGE,
          tree: commit.tree.sha,
          // On top of the head, or beside it.
          parents: proof === "direct-push" ? [head] : commit.parents.map((parent) => parent.sha),
        })
      ).sha;
    }
    const probe = { branch, proof, head, ...(sha === undefined ? {} : { sha }) };
    await journal.start(probe);
    // GitHub's ref updates take no expected head, so check it once more
    // straight before the change: a merge since would otherwise be undone.
    if ((await branchHead(api, repository, branch)) !== head) {
      await journal.finish();
      throw new Error(
        `${branch} moved while the proof was running; prove it again when nothing is being merged into it`,
      );
    }
    const outcome =
      proof === "deletion"
        ? await api.attempt("DELETE", ref)
        : await api.attempt("PATCH", ref, { sha, force: proof === "force-push" });
    if (
      !outcome.ok &&
      outcome.status !== undefined &&
      REFUSALS.has(outcome.status) &&
      RULE_REFUSAL.test(outcome.message)
    ) {
      await journal.finish();
      results.push({ branch, proof, refused: true, detail: `refused (HTTP ${outcome.status})` });
      continue;
    }
    // Allowed, or no clear answer: what the branch is now says which.
    const current = await branchHead(api, repository, branch);
    if (!outcome.ok && current === head) {
      await journal.finish();
      throw new Error(
        `could not tell whether ${proof} on ${branch} was refused: ${outcome.message}`,
      );
    }
    const allowed = outcome.ok
      ? "GitHub allowed it"
      : `GitHub gave no clear answer (${outcome.message}), but ${branch} changed`;
    let repaired: string;
    try {
      repaired = await putBack(api, repository, probe);
    } catch (error) {
      results.push({
        branch,
        proof,
        refused: false,
        detail: `${allowed}, and it could not be put back at ${head.slice(0, 12)}: ${(error as Error).message}. Run liftoff governance resume, or reset it by hand`,
      });
      return results;
    }
    await journal.finish();
    results.push({ branch, proof, refused: false, detail: `${allowed}; ${repaired}` });
  }
  return results;
}
