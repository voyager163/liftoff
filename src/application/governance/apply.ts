import path from "node:path";
import type { Action, Checkpoint } from "../../domain/governance/checkpoints.ts";
import { GOVERNANCE_STATE_SCHEMA, type GovernanceState } from "../../domain/governance/state.ts";
import { canonicalJson } from "../../domain/plan/plan.ts";
import type { GitHubApiPort, ProjectFsPort } from "../ports.ts";
import { type Assessment, assessGovernance, GovernanceError } from "./assess.ts";
import { putBack } from "./prove.ts";
import { readGovernanceState, writeGovernanceState } from "./state.ts";

export interface ApplyPorts {
  fs: ProjectFsPort;
  github: GitHubApiPort;
}

export interface ApplyOptions {
  /** Asks the person to agree to the action, described in words; the default is no. */
  readonly confirm: (action: Action) => Promise<boolean>;
  /** The time now, as an ISO timestamp. */
  readonly now: () => string;
  /** When given, the action must be this one, as planned. */
  readonly expected?: Action;
  /** When given, the repository GitHub answers for must be this one, as planned. */
  readonly repositoryId?: number;
}

export type ApplyResult =
  | { readonly kind: "done"; readonly assessment: Assessment }
  | { readonly kind: "person"; readonly checkpoint: Checkpoint; readonly assessment: Assessment }
  | { readonly kind: "declined"; readonly action: Action }
  | { readonly kind: "applied"; readonly action: Action; readonly assessment: Assessment };

/** A new state for the repository, or the recorded one if it is for the same repository. */
export async function stateFor(
  fs: ProjectFsPort,
  directory: string,
  assessment: Assessment,
): Promise<GovernanceState> {
  const { id, fullName } = assessment.observed.repository;
  const state = await readGovernanceState(fs, directory);
  if (state === undefined) {
    return { schema: GOVERNANCE_STATE_SCHEMA, repository: { id, fullName }, actions: [] };
  }
  if (state.repository.id !== id) {
    throw new GovernanceError(
      `.liftoff/governance.json is for ${state.repository.fullName} (repository ${state.repository.id}), not ${fullName}; move it aside to start again`,
    );
  }
  return state;
}

/**
 * Takes the next step, if Liftoff can: observes the repository again, and
 * performs the next checkpoint's action once the person agrees. The action
 * is recorded before it starts and after it ends, so an interrupted one can
 * be checked with resume.
 */
export async function applyNext(
  ports: ApplyPorts,
  directory: string,
  repository: string,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const assessment = await assessGovernance(ports, directory, repository);
  const observed = assessment.observed.repository;
  if (options.repositoryId !== undefined && options.repositoryId !== observed.id) {
    throw new GovernanceError(
      `the plan is for repository ${options.repositoryId}, but ${repository} is repository ${observed.id}; make a new plan`,
    );
  }
  const next = assessment.checkpoints.find((checkpoint) => checkpoint.status === "next");
  if (next === undefined) return { kind: "done", assessment };
  const state = await stateFor(ports.fs, directory, assessment);
  const unfinished = state.actions.find((action) => action.finishedAt === undefined);
  if (unfinished) {
    throw new GovernanceError(
      `the ${unfinished.kind} action started ${unfinished.startedAt} never finished; check it with liftoff governance resume first`,
    );
  }
  if (state.probe !== undefined) {
    throw new GovernanceError(
      `a proof was interrupted while trying ${state.probe.proof} on ${state.probe.branch}; run liftoff governance resume first`,
    );
  }
  if (next.action === undefined) return { kind: "person", checkpoint: next, assessment };
  if (
    options.expected !== undefined &&
    canonicalJson(options.expected) !== canonicalJson(next.action)
  ) {
    throw new GovernanceError(
      "the repository changed since the plan was made, so its next step is different; make a new plan",
    );
  }
  const { action } = next;
  if (!(await options.confirm(action))) return { kind: "declined", action };

  const record = { checkpoint: next.id, kind: action.kind, startedAt: options.now() };
  await writeGovernanceState(ports.fs, directory, {
    ...state,
    actions: [...state.actions, record],
  });
  let outcome: "done" | "failed" = "done";
  let detail: string | undefined;
  try {
    await perform(ports, repository, action, assessment);
  } catch (error) {
    outcome = "failed";
    detail = (error as Error).message;
    throw error;
  } finally {
    await writeGovernanceState(ports.fs, directory, {
      ...state,
      actions: [
        ...state.actions,
        { ...record, finishedAt: options.now(), outcome, ...(detail ? { detail } : {}) },
      ],
    });
  }
  return {
    kind: "applied",
    action,
    assessment: await assessGovernance(ports, directory, repository),
  };
}

async function perform(
  ports: ApplyPorts,
  repository: string,
  action: Action,
  assessment: Assessment,
): Promise<void> {
  const route = `/repos/${repository}`;
  switch (action.kind) {
    case "create-develop":
      await ports.github.send("POST", `${route}/git/refs`, {
        ref: "refs/heads/develop",
        sha: action.from,
      });
      return;
    case "set-default-branch":
      await ports.github.send("PATCH", route, { default_branch: action.branch });
      return;
    case "apply-rulesets":
      for (const name of action.names) {
        const desired = assessment.desired.rulesets.find((ruleset) => ruleset.name === name);
        if (desired === undefined)
          throw new GovernanceError(`the project has no ruleset "${name}"`);
        // Only Liftoff's own rulesets, found by name, are ever changed; any
        // other ruleset stays as it is, so nothing stricter is weakened.
        const existing = assessment.observed.rulesets.find((ruleset) => ruleset.name === name);
        // Read again just before the change: one changed since it was
        // assessed, or made active by someone else, is left as it is.
        const changed = () =>
          new GovernanceError(
            `the "${name}" ruleset changed on GitHub since it was assessed, so it was left as it is; run apply-next again`,
          );
        if (existing) {
          const current = await ports.github.get<{ enforcement: string; updated_at?: string }>(
            `${route}/rulesets/${existing.id}`,
          );
          if (current.enforcement === "active" || current.updated_at !== existing.updatedAt) {
            throw changed();
          }
          await ports.github.send("PUT", `${route}/rulesets/${existing.id}`, desired);
        } else {
          const now = await ports.github.get<{ name: string }[]>(`${route}/rulesets?per_page=100`);
          if (now.some((ruleset) => ruleset.name === name)) throw changed();
          await ports.github.send("POST", `${route}/rulesets`, desired);
        }
      }
      return;
    case "run-drift":
      await ports.github.send(
        "POST",
        `${route}/actions/workflows/${path.posix.basename(action.workflow)}/dispatches`,
        { ref: "develop" },
      );
      return;
  }
}

export type ResumeResult =
  | { readonly kind: "nothing"; readonly assessment: Assessment }
  | {
      readonly kind: "checked";
      readonly action: string;
      readonly outcome: "done" | "failed";
      readonly assessment: Assessment;
    }
  | {
      readonly kind: "probe";
      /** What was done about the interrupted proof's branch. */
      readonly detail: string;
      readonly assessment: Assessment;
    };

/**
 * Checks an interrupted action against GitHub instead of repeating it: done
 * if its checkpoint is now done, otherwise failed, for apply-next to retry
 * once the person agrees again.
 */
export async function resume(
  ports: ApplyPorts,
  directory: string,
  repository: string,
  now: () => string,
): Promise<ResumeResult> {
  const assessment = await assessGovernance(ports, directory, repository);
  const state = await stateFor(ports.fs, directory, assessment);
  if (state.probe !== undefined) {
    // An interrupted proof: put its branch back if it is still where the
    // forbidden change left it. A refusal keeps the record for another try.
    const { probe, ...rest } = state;
    const detail = await putBack(ports.github, repository, probe);
    await writeGovernanceState(ports.fs, directory, rest);
    return {
      kind: "probe",
      detail,
      assessment: await assessGovernance(ports, directory, repository),
    };
  }
  const index = state.actions.findIndex((action) => action.finishedAt === undefined);
  const interrupted = state.actions[index];
  if (interrupted === undefined) return { kind: "nothing", assessment };
  const status = assessment.checkpoints.find(
    (checkpoint) => checkpoint.id === interrupted.checkpoint,
  )?.status;
  // A dispatched drift run counts once GitHub shows it passed.
  const outcome = status === "done" ? "done" : "failed";
  const actions = [...state.actions];
  actions[index] = {
    ...interrupted,
    finishedAt: now(),
    outcome,
    detail:
      outcome === "done"
        ? "confirmed on GitHub after an interruption"
        : "not done on GitHub after an interruption; apply-next offers it again",
  };
  await writeGovernanceState(ports.fs, directory, { ...state, actions });
  return { kind: "checked", action: interrupted.kind, outcome, assessment };
}
