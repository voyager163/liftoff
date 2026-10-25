import path from "node:path";
import { GhCli } from "../../adapters/gh.ts";
import { LocalProjectFs } from "../../adapters/project-fs.ts";
import { applyNext, resume } from "../../application/governance/apply.ts";
import { type Assessment, assessGovernance } from "../../application/governance/assess.ts";
import { readGovernanceState } from "../../application/governance/state.ts";
import { verifyGovernance } from "../../application/governance/verify.ts";
import type { GitHubApiPort, ProjectFsPort } from "../../application/ports.ts";
import type { Action, Checkpoint } from "../../domain/governance/checkpoints.ts";
import type { CommandSpec, Io, ParsedArgs } from "../command.ts";
import { UsageError } from "../outcome.ts";

export interface GovernancePorts {
  fs: ProjectFsPort;
  github: GitHubApiPort;
}

export const defaultGovernancePorts = (cwd: string): GovernancePorts => ({
  fs: new LocalProjectFs(),
  github: new GhCli(cwd),
});

const DIR = {
  type: "string",
  valueName: "path",
  default: ".",
  description: "Project directory.",
} as const;

const GITHUB_OPTIONS = {
  dir: DIR,
  repo: {
    type: "string",
    valueName: "owner/name",
    description:
      "The GitHub repository. Defaults to the one the project's origin remote points at.",
  },
  "use-gh": {
    type: "boolean",
    description:
      "Let Liftoff use your GitHub CLI login to reach GitHub, without asking. Liftoff never sees or stores your credentials.",
  },
} as const;

/** What an action does, in words. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case "create-develop":
      return `create develop from main at ${action.from.slice(0, 12)}`;
    case "set-default-branch":
      return "make develop the default branch";
    case "apply-rulesets":
      return `apply the rulesets ${action.names.map((name) => `"${name}"`).join(" and ")}`;
    case "run-drift":
      return "run the Governance drift workflow";
  }
}

/** The repository to read, after the person has agreed to Liftoff using their GitHub CLI login. */
export async function repositoryWithConsent(
  args: ParsedArgs,
  io: Io,
  github: GitHubApiPort,
  directory: string,
): Promise<string> {
  const given = args.options.repo as string | undefined;
  const repository = given ?? (await github.repositoryOf(directory));
  if (repository === undefined) {
    throw new UsageError(
      "the project has no GitHub origin remote; name the repository with --repo",
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new UsageError(`--repo must be owner/name, not "${repository}"`);
  }
  if (args.options["use-gh"] !== true) {
    if (!io.interactive) {
      throw new UsageError(
        "Liftoff reaches GitHub with your GitHub CLI login only when you agree; pass --use-gh",
      );
    }
    if (!(await io.confirm(`Use your GitHub CLI login to read ${repository} on GitHub?`))) {
      throw new UsageError("GitHub was not read");
    }
  }
  return repository;
}

const MARK: Record<Checkpoint["status"], string> = { done: "done ", next: "next ", later: "later" };

/** The checklist, with what to do next. */
export function renderAssessment(assessment: Assessment): string {
  const { checkpoints, observed } = assessment;
  const lines = [
    `Governance of ${observed.repository.fullName} (repository ${observed.repository.id})`,
  ];
  checkpoints.forEach((checkpoint, index) => {
    lines.push(
      `  ${MARK[checkpoint.status]}  ${index + 1}. ${checkpoint.title}: ${checkpoint.detail}`,
    );
  });
  const next = checkpoints.find((checkpoint) => checkpoint.status === "next");
  lines.push("");
  if (next === undefined) {
    lines.push("Every checkpoint is done.");
  } else if (next.action) {
    lines.push(
      `Next: ${describeAction(next.action)}. liftoff governance apply-next does it after you agree.`,
    );
  } else {
    lines.push(`Next: ${next.todo ?? next.detail}, then assess again.`);
  }
  return `${lines.join("\n")}\n`;
}

export function makeGovernanceStatusCommand(
  portsFor: (cwd: string) => GovernancePorts = defaultGovernancePorts,
): CommandSpec {
  return {
    path: ["governance", "status"],
    summary: "Show what Liftoff has recorded about activating the project's governance.",
    description:
      "Reads .liftoff/governance.json: each action Liftoff took on GitHub, its outcome, and the proof. It does not contact GitHub; use `liftoff governance assess` for the live state.",
    readOnly: true,
    reportSchema: "liftoff.governance-status/v1",
    options: { dir: DIR },
    examples: ["liftoff governance status", "liftoff governance status --dir demo --json"],
    async run(args, { io }) {
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const state = await readGovernanceState(portsFor(io.cwd).fs, directory);
      if (state === undefined) {
        return {
          outcome: "success",
          report: { directory, recorded: false },
          text: "Nothing is recorded yet. Start with: liftoff governance assess\n",
        };
      }
      const interrupted = state.actions.filter((action) => action.finishedAt === undefined);
      const lines = [
        `Governance of ${state.repository.fullName} (repository ${state.repository.id})`,
        ...state.actions.map(
          (action) =>
            `  ${action.outcome ?? "unfinished"}  ${action.checkpoint}: ${action.kind}, started ${action.startedAt}${action.detail ? ` (${action.detail})` : ""}`,
        ),
        state.proof
          ? `  proof  ${state.proof.passed ? "passed" : "failed"} ${state.proof.at}`
          : "  proof  not run",
        "",
        interrupted.length > 0
          ? "An action was interrupted. Check it with: liftoff governance resume"
          : "See the live state with: liftoff governance assess",
      ];
      return {
        outcome: interrupted.length > 0 ? "attention" : "success",
        report: { directory, recorded: true, state },
        text: `${lines.join("\n")}\n`,
      };
    },
  };
}

export function makeGovernanceAssessCommand(
  portsFor: (cwd: string) => GovernancePorts = defaultGovernancePorts,
): CommandSpec {
  return {
    path: ["governance", "assess"],
    summary: "Check, read-only, how far the project's governance is enforced on GitHub.",
    description:
      "Reads the repository on GitHub with your GitHub CLI login, after you agree, and checks each step from the committed governance files to rules GitHub enforces: the branches, the workflows on develop, a real successful run of every required check, the rulesets, their readback, the drift job and the proof. It changes nothing.",
    readOnly: true,
    reportSchema: "liftoff.governance-assessment/v1",
    options: GITHUB_OPTIONS,
    examples: [
      "liftoff governance assess",
      "liftoff governance assess --repo octo/demo --use-gh --json",
    ],
    async run(args, { io }) {
      const ports = portsFor(io.cwd);
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const repository = await repositoryWithConsent(args, io, ports.github, directory);
      const assessment = await assessGovernance(ports, directory, repository);
      const ready = assessment.checkpoints.every((checkpoint) => checkpoint.status === "done");
      return {
        outcome: ready ? "success" : "attention",
        report: {
          repository,
          repositoryId: assessment.observed.repository.id,
          ready,
          checkpoints: assessment.checkpoints,
        },
        text: renderAssessment(assessment),
      };
    },
  };
}

export const GOVERNANCE_PLAN_SCHEMA = "liftoff.governance-plan/v1";

export function makeGovernancePlanCommand(
  portsFor: (cwd: string) => GovernancePorts = defaultGovernancePorts,
): CommandSpec {
  return {
    path: ["governance", "plan"],
    summary: "List the steps left to enforce the project's governance, and who takes each.",
    description:
      "Assesses the repository as `liftoff governance assess` does and lists every checkpoint not yet done: the ones Liftoff can take with `liftoff governance apply-next`, one at a time after you agree, and the ones you take yourself. With --out it saves the plan, bound to the repository and its next step, for apply-next --plan. It changes nothing on GitHub.",
    readOnly: true,
    reportSchema: "liftoff.governance-plan-report/v1",
    options: {
      ...GITHUB_OPTIONS,
      out: { type: "string", valueName: "file", description: "Save the plan to this file." },
    },
    examples: [
      "liftoff governance plan",
      "liftoff governance plan --use-gh --out governance.plan.json",
    ],
    async run(args, { io }) {
      const ports = portsFor(io.cwd);
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const repository = await repositoryWithConsent(args, io, ports.github, directory);
      const assessment = await assessGovernance(ports, directory, repository);
      const next = assessment.checkpoints.find((checkpoint) => checkpoint.status === "next");
      const plan = {
        schema: GOVERNANCE_PLAN_SCHEMA,
        repository: {
          id: assessment.observed.repository.id,
          fullName: assessment.observed.repository.fullName,
        },
        ...(next?.action ? { next: next.action } : {}),
        checkpoints: assessment.checkpoints,
      };
      const lines = [renderAssessment(assessment).trimEnd()];
      const pending = assessment.checkpoints.filter((checkpoint) => checkpoint.status !== "done");
      if (pending.length > 0) {
        lines.push("", "Steps left, in order:");
        for (const checkpoint of pending) {
          const who = checkpoint.action
            ? `Liftoff, with apply-next: ${describeAction(checkpoint.action)}`
            : checkpoint.todo
              ? `you: ${checkpoint.todo}`
              : "after the steps before it";
          lines.push(`  ${checkpoint.title}: ${who}`);
        }
      }
      const out = args.options.out as string | undefined;
      if (out !== undefined) {
        const file = path.resolve(io.cwd, out);
        await ports.fs.replaceFile(file, `${JSON.stringify(plan, null, 2)}\n`);
        lines.push("", `Saved the plan to ${file}.`);
      }
      return {
        outcome: pending.length === 0 ? "success" : "attention",
        report: { plan },
        text: `${lines.join("\n")}\n`,
      };
    },
  };
}

/** The next action a saved plan expects, after checking the plan is for this repository. */
async function plannedAction(
  fs: ProjectFsPort,
  file: string,
  repository: string,
): Promise<Action | undefined> {
  const text = await fs.readText(file);
  if (text === undefined) throw new UsageError(`cannot read the plan ${file}`);
  let plan: { schema?: string; repository?: { fullName?: string }; next?: Action };
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError(`${file} is not a governance plan`);
  }
  if (plan.schema !== GOVERNANCE_PLAN_SCHEMA)
    throw new UsageError(`${file} is not a governance plan`);
  if (plan.repository?.fullName !== repository) {
    throw new UsageError(`the plan is for ${plan.repository?.fullName}, not ${repository}`);
  }
  if (plan.next === undefined) throw new UsageError("the plan has no step for Liftoff to take");
  return plan.next;
}

export function makeGovernanceApplyNextCommand(
  portsFor: (cwd: string) => GovernancePorts = defaultGovernancePorts,
): CommandSpec {
  return {
    path: ["governance", "apply-next"],
    summary: "Take the next governance step Liftoff can take, after you agree.",
    description:
      "Assesses the repository again and, if the next checkpoint is one Liftoff can take, says exactly what it will do on GitHub and asks; the default answer is no. It takes that one step only: creating develop, making develop the default branch, applying the rulesets (only after every required check has run, and never changing a ruleset Liftoff did not create), or running the drift job. The step is recorded in .liftoff/governance.json before and after. With --plan, the step must be the one the plan expects. In scripts, pass --yes.",
    readOnly: false,
    reportSchema: "liftoff.governance-apply/v1",
    options: {
      ...GITHUB_OPTIONS,
      plan: {
        type: "string",
        valueName: "file",
        description: "Take the step this saved plan expects, and refuse if the next step differs.",
      },
      yes: { type: "boolean", short: "y", description: "Take the step without asking." },
    },
    examples: [
      "liftoff governance apply-next",
      "liftoff governance apply-next --plan governance.plan.json --use-gh --yes",
    ],
    async run(args, { io }) {
      const ports = portsFor(io.cwd);
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const repository = await repositoryWithConsent(args, io, ports.github, directory);
      const planFile = args.options.plan as string | undefined;
      const expected =
        planFile === undefined
          ? undefined
          : await plannedAction(ports.fs, path.resolve(io.cwd, planFile), repository);
      if (args.options.yes !== true && !io.interactive) {
        throw new UsageError(
          "apply-next changes GitHub; pass --yes when no one can answer a prompt",
        );
      }
      const result = await applyNext(ports, directory, repository, {
        confirm: (action) =>
          args.options.yes === true
            ? Promise.resolve(true)
            : io.confirm(`${describeAction(action)} on ${repository}?`),
        now: () => new Date().toISOString(),
        ...(expected ? { expected } : {}),
      });
      switch (result.kind) {
        case "done":
          return {
            outcome: "success",
            report: { applied: false, ready: true },
            text: "Every checkpoint is done; there is nothing to apply.\n",
          };
        case "person":
          return {
            outcome: "attention",
            report: { applied: false, checkpoint: result.checkpoint },
            text: `The next step is yours: ${result.checkpoint.todo ?? result.checkpoint.detail}.\n`,
          };
        case "declined":
          return {
            outcome: "cancelled",
            report: { applied: false, action: result.action },
            text: "Nothing was changed.\n",
          };
        case "applied":
          return {
            outcome: "success",
            report: {
              applied: true,
              action: result.action,
              checkpoints: result.assessment.checkpoints,
            },
            text: `Done: ${describeAction(result.action)}.\n\n${renderAssessment(result.assessment)}`,
          };
      }
    },
  };
}

export function makeGovernanceResumeCommand(
  portsFor: (cwd: string) => GovernancePorts = defaultGovernancePorts,
): CommandSpec {
  return {
    path: ["governance", "resume"],
    summary: "Check an interrupted governance step against GitHub instead of repeating it.",
    description:
      "If .liftoff/governance.json records a step that never finished, assesses the repository again and records whether GitHub shows it done. Nothing is repeated or sent: a step that did not happen is offered again by the next `liftoff governance apply-next`, which asks first. It changes only .liftoff/governance.json.",
    readOnly: false,
    reportSchema: "liftoff.governance-resume/v1",
    options: GITHUB_OPTIONS,
    examples: ["liftoff governance resume"],
    async run(args, { io }) {
      const ports = portsFor(io.cwd);
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const repository = await repositoryWithConsent(args, io, ports.github, directory);
      const result = await resume(ports, directory, repository, () => new Date().toISOString());
      const heading =
        result.kind === "nothing"
          ? "Nothing was interrupted."
          : result.outcome === "done"
            ? `The interrupted ${result.action} step is done on GitHub.`
            : `The interrupted ${result.action} step did not happen; liftoff governance apply-next offers it again.`;
      return {
        outcome: result.kind === "checked" && result.outcome === "failed" ? "attention" : "success",
        report: {
          interrupted: result.kind === "checked",
          ...(result.kind === "checked" ? { action: result.action, outcome: result.outcome } : {}),
          checkpoints: result.assessment.checkpoints,
        },
        text: `${heading}\n\n${renderAssessment(result.assessment)}`,
      };
    },
  };
}

export function makeGovernanceVerifyCommand(
  portsFor: (cwd: string) => GovernancePorts = defaultGovernancePorts,
): CommandSpec {
  return {
    path: ["governance", "verify"],
    summary: "Read back the rules GitHub enforces, and with --prove, test them.",
    description:
      "Compares the rules GitHub enforces on each protected branch with the committed rulesets. With --prove, after you agree, it also tries each change the rules forbid on every protected branch: an empty commit pushed on top, a commit forced in beside the head, and deleting the branch. Each must be refused; anything GitHub allows is put back at once. The outcome is recorded in .liftoff/governance.json. Without --prove it changes nothing.",
    readOnly: false,
    reportSchema: "liftoff.governance-verify/v1",
    options: {
      ...GITHUB_OPTIONS,
      prove: {
        type: "boolean",
        description: "Also try the changes the rules forbid, and record whether each was refused.",
      },
      yes: { type: "boolean", short: "y", description: "Run the proof without asking." },
    },
    examples: ["liftoff governance verify", "liftoff governance verify --prove"],
    async run(args, { io }) {
      const ports = portsFor(io.cwd);
      const directory = path.resolve(io.cwd, args.options.dir as string);
      const repository = await repositoryWithConsent(args, io, ports.github, directory);
      const prove = args.options.prove === true;
      if (prove && args.options.yes !== true && !io.interactive) {
        throw new UsageError("--prove tries changes on GitHub; pass --yes when no one can answer");
      }
      const result = await verifyGovernance(ports, directory, repository, {
        prove,
        confirm: () =>
          args.options.yes === true
            ? Promise.resolve(true)
            : io.confirm(
                `Try a direct push, a forced push and deleting each protected branch of ${repository}? Each must be refused, and anything GitHub allows is put back at once.`,
              ),
        now: () => new Date().toISOString(),
      });
      if (result.kind === "declined") {
        return { outcome: "cancelled", report: { proved: false }, text: "Nothing was tried.\n" };
      }
      if (result.kind === "readback") {
        const readback = result.assessment.checkpoints.find((c) => c.id === "readback");
        return {
          outcome: result.matches ? "success" : "attention",
          report: { matches: result.matches, checkpoints: result.assessment.checkpoints },
          text: result.matches
            ? "GitHub enforces exactly the committed rulesets.\n"
            : `GitHub does not enforce the committed rulesets yet: ${readback?.detail ?? "apply them first"}.\n`,
        };
      }
      const lines = result.results.map(
        (r) => `  ${r.refused ? "refused" : "ALLOWED"}  ${r.proof} on ${r.branch}: ${r.detail}`,
      );
      return {
        outcome: result.passed ? "success" : "failure",
        report: { proved: true, passed: result.passed, results: result.results },
        text: `${result.passed ? "Every forbidden change was refused." : "Some forbidden changes were allowed; the branch rules are not enforced."}\n${lines.join("\n")}\n`,
      };
    },
  };
}
