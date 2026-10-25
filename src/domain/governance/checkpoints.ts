import {
  compareDefinition,
  compareRuleset,
  type DesiredRuleset,
  type EffectiveRule,
  type LiveRuleset,
  patternTargets,
} from "./ruleset-drift.ts";

/**
 * The ordered checkpoints that take a generated project's governance from
 * files in the repository to rules GitHub enforces. Each is satisfied only by
 * what is observed on GitHub, never by what Liftoff did earlier. Rulesets come
 * after every check they require has really run, so a new rule never waits
 * on a check that does not exist; the proof comes after the rulesets, since
 * only enforced rules can refuse a push.
 */
export const CHECKPOINTS = [
  "handoff",
  "branches",
  "workflows",
  "checks",
  "rulesets",
  "readback",
  "drift",
  "proof",
] as const;
export type CheckpointId = (typeof CHECKPOINTS)[number];

/** The GitHub Actions app, which produces the checks the rulesets require. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** Something Liftoff can do for a checkpoint, one at a time and only after a person agrees. */
export type Action =
  | { readonly kind: "create-develop"; readonly from: string }
  | { readonly kind: "set-default-branch"; readonly branch: "develop" }
  | { readonly kind: "apply-rulesets"; readonly names: readonly string[] }
  | { readonly kind: "run-drift"; readonly workflow: string };

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly title: string;
  readonly status: "done" | "next" | "later";
  /** What was observed. */
  readonly detail: string;
  /** What Liftoff can do next for it, when it is the next one. */
  readonly action?: Action;
  /** What a person does for it, when Liftoff cannot. */
  readonly todo?: string;
}

/** What the repository should have, from the generated governance handoff. */
export interface Desired {
  readonly rulesets: readonly DesiredRuleset[];
  /** Workflow files the default branch must have, such as ".github/workflows/01-pr-ci.yml". */
  readonly workflows: readonly string[];
  /** Status checks the rulesets require, by name, each from its producing app. */
  readonly requiredChecks: readonly { readonly context: string; readonly integrationId: number }[];
  readonly driftWorkflow: string;
}

/** What GitHub says about the repository now. */
export interface Observed {
  readonly repository: {
    readonly id: number;
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly admin: boolean;
  };
  /** Head commits of develop and main, when they exist. */
  readonly branches: { readonly develop?: string; readonly main?: string };
  /** Workflow files on the default branch. */
  readonly workflows: readonly string[];
  /** Successful checks and statuses seen on recent pull requests, with their producer. */
  readonly checks: readonly {
    readonly context: string;
    readonly appId: number;
    readonly url: string;
  }[];
  /** Rulesets the repository defines, by name. */
  readonly rulesets: readonly {
    readonly id: number;
    readonly name: string;
    readonly enforcement: string;
    /** When it last changed, to tell whether it changed since it was observed. */
    readonly updatedAt?: string;
  }[];
  /** The full definitions of the rulesets the project commits, by name, where they exist. */
  readonly definitions: Readonly<Record<string, LiveRuleset>>;
  /** The rules GitHub enforces on each branch, from every source. */
  readonly rules: Readonly<Record<string, readonly EffectiveRule[]>>;
  /** The drift workflow's latest run, if it has run. */
  readonly driftRun?: { readonly conclusion: string | null; readonly url: string };
}

/** What was recorded locally about the proof, the one checkpoint GitHub cannot show. */
export interface ProofRecord {
  readonly passed: boolean;
  /** The ruleset ids it proved, so new or replaced rulesets need a new proof. */
  readonly rulesetIds: readonly number[];
  readonly at: string;
}

interface Evaluation {
  readonly done: boolean;
  readonly detail: string;
  readonly action?: Action;
  readonly todo?: string;
}

/** Evaluates every checkpoint in order. The first one not done is next. */
export function assessCheckpoints(
  desired: Desired,
  observed: Observed,
  local: { readonly problems: readonly string[]; readonly proof?: ProofRecord },
): Checkpoint[] {
  const evaluations: Record<CheckpointId, Evaluation> = {
    handoff: handoff(desired, local.problems),
    branches: branches(observed),
    workflows: workflows(desired, observed),
    checks: checks(desired, observed),
    rulesets: rulesets(desired, observed),
    readback: readback(desired, observed),
    drift: drift(desired, observed),
    proof: proof(desired, observed, local.proof),
  };
  let reachedNext = false;
  return CHECKPOINTS.map((id) => {
    const evaluation = evaluations[id];
    const status = evaluation.done ? "done" : reachedNext ? "later" : "next";
    if (status === "next") reachedNext = true;
    return {
      id,
      title: TITLES[id],
      status,
      detail: evaluation.detail,
      ...(status === "next" && evaluation.action ? { action: evaluation.action } : {}),
      ...(!evaluation.done && evaluation.todo ? { todo: evaluation.todo } : {}),
    };
  });
}

const TITLES: Record<CheckpointId, string> = {
  handoff: "The governance files in the project are valid",
  branches: "develop and main exist, and develop is the default branch",
  workflows: "The default branch has the project's workflows",
  checks: "Every required check has run successfully on a pull request",
  rulesets: "The rulesets are applied and active",
  readback: "GitHub enforces exactly the committed rules",
  drift: "The governance drift job has passed",
  proof: "Protected branches refuse direct, forced and deleting pushes",
};

function handoff(desired: Desired, problems: readonly string[]): Evaluation {
  if (problems.length > 0) {
    return {
      done: false,
      detail: problems.join("; "),
      todo: "fix what liftoff validate reports",
    };
  }
  if (desired.rulesets.length === 0) {
    return {
      done: false,
      detail: "the project has no rulesets in .github/rulesets/",
      todo: "use a GitFlow governance profile",
    };
  }
  return { done: true, detail: `${desired.rulesets.length} rulesets to apply` };
}

function branches(observed: Observed): Evaluation {
  const { develop, main } = observed.branches;
  if (main === undefined) {
    return {
      done: false,
      detail: "main does not exist",
      todo: "push the project's first commit to main",
    };
  }
  if (develop === undefined) {
    return {
      done: false,
      detail: "develop does not exist",
      action: { kind: "create-develop", from: main },
    };
  }
  if (observed.repository.defaultBranch !== "develop") {
    return {
      done: false,
      detail: `the default branch is ${observed.repository.defaultBranch}`,
      action: { kind: "set-default-branch", branch: "develop" },
    };
  }
  return { done: true, detail: "develop is the default branch, and main exists" };
}

function workflows(desired: Desired, observed: Observed): Evaluation {
  const missing = desired.workflows.filter((file) => !observed.workflows.includes(file));
  return missing.length === 0
    ? { done: true, detail: `${desired.workflows.length} workflows on develop` }
    : {
        done: false,
        detail: `develop is missing ${missing.join(", ")}`,
        todo: "push the generated files to develop",
      };
}

function checks(desired: Desired, observed: Observed): Evaluation {
  const missing = desired.requiredChecks.filter(
    ({ context, integrationId }) =>
      !observed.checks.some((check) => check.context === context && check.appId === integrationId),
  );
  return missing.length === 0
    ? {
        done: true,
        detail: desired.requiredChecks.map(({ context }) => context).join(", "),
      }
    : {
        done: false,
        detail: `no successful run yet of ${missing.map(({ context }) => context).join(", ")}`,
        todo: "open a pull request into develop and let its checks pass",
      };
}

function rulesets(desired: Desired, observed: Observed): Evaluation {
  const missing = desired.rulesets.filter(
    ({ name }) =>
      !observed.rulesets.some(
        (ruleset) => ruleset.name === name && ruleset.enforcement === "active",
      ),
  );
  if (missing.length === 0) return { done: true, detail: "every ruleset is active" };
  const names = missing.map(({ name }) => name);
  return {
    done: false,
    detail: `not active: ${names.join(", ")}`,
    ...(observed.repository.admin
      ? { action: { kind: "apply-rulesets", names } as const }
      : { todo: "ask a repository admin to apply them" }),
  };
}

function readback(desired: Desired, observed: Observed): Evaluation {
  const differences = desired.rulesets.flatMap((ruleset) => {
    const patterns = patternTargets(ruleset);
    const live = observed.definitions[ruleset.name];
    return [
      ...(patterns.length === 0
        ? []
        : [
            {
              branch: `ruleset "${ruleset.name}"`,
              rule: "(conditions)",
              detail: `targets ${patterns.join(", ")}; Liftoff can only verify rulesets that name each branch`,
            },
          ]),
      ...compareRuleset(ruleset, observed.rules),
      ...(live === undefined ? [] : compareDefinition(ruleset, live)),
    ];
  });
  return differences.length === 0
    ? { done: true, detail: "the enforced rules match the committed rulesets" }
    : {
        done: false,
        detail: differences.map((d) => `${d.branch} ${d.rule}: ${d.detail}`).join("; "),
        todo: "make the live rulesets match .github/rulesets/, or change the files to match",
      };
}

function drift(desired: Desired, observed: Observed): Evaluation {
  if (observed.driftRun?.conclusion === "success") {
    return { done: true, detail: observed.driftRun.url };
  }
  return {
    done: false,
    detail:
      observed.driftRun === undefined
        ? "the drift job has not run"
        : `its latest run ended ${observed.driftRun.conclusion ?? "unfinished"}: ${observed.driftRun.url}`,
    action: { kind: "run-drift", workflow: desired.driftWorkflow },
  };
}

function proof(desired: Desired, observed: Observed, record?: ProofRecord): Evaluation {
  const ids = desired.rulesets
    .map(({ name }) => observed.rulesets.find((ruleset) => ruleset.name === name)?.id)
    .filter((id): id is number => id !== undefined)
    .sort((a, b) => a - b);
  const proved =
    record?.passed === true && [...record.rulesetIds].sort((a, b) => a - b).join() === ids.join();
  return proved
    ? { done: true, detail: `proved ${record?.at}` }
    : {
        done: false,
        detail: record === undefined ? "not proved yet" : "the rulesets changed since the proof",
        todo: "run liftoff governance verify --prove",
      };
}
