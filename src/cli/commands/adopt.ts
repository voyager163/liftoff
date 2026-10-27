import os from "node:os";
import {
  type AdoptChoices,
  AdoptOptionError,
  type AdoptPlan,
  isBlocked,
  planAdopt,
  planAdoptFromSaved,
} from "../../application/adopt/adopt-project.ts";
import { AssessError } from "../../application/project/assess-project.ts";
import { COMPONENTS, type Component } from "../../domain/project/config.ts";
import { ENVIRONMENTS } from "../../plugins/contracts/project-plugin.ts";
import {
  FRONTENDS,
  GOVERNANCE,
  INFRASTRUCTURE,
  NO_FRONTEND,
  NO_INFRASTRUCTURE,
  PATTERNS,
  STACKS,
} from "../../plugins/registry.ts";
import type { CommandResult, CommandSpec, ParsedArgs } from "../command.ts";
import { UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import {
  applyApproved,
  changeSummary,
  checkPreview,
  leftBehind,
  listed,
  planLine,
  readSavedPlan,
  recoverChange,
  savePlan,
  toCli,
} from "./changing.ts";
import { defaultProjectPorts, type ProjectPorts, projectDirectory } from "./project-ports.ts";

const OWNED = {
  managed: "Liftoff keeps it current",
  seeded: "the project owns it",
  framework: "its framework owns it",
} as const;

/** The adoption, in the words the text shows it. */
export function renderAdopt(adopt: AdoptPlan, version: string): string[] {
  const lines: string[] = [];
  const blocked = isBlocked(adopt);
  if (adopt.proposal.length > 0) {
    lines.push(`Liftoff ${version} ${blocked ? "would adopt" : "adopts"} ${adopt.directory} as:`);
    const width = Math.max(...adopt.proposal.map((proposed) => proposed.choice.length));
    for (const { choice, value, from, evidence } of adopt.proposal) {
      const why = from === "found" && evidence?.length ? `found: ${evidence.join(", ")}` : from;
      lines.push(`  ${choice.padEnd(width)}  ${value} (${why})`);
    }
  }
  if (blocked) {
    lines.push(
      `Liftoff cannot adopt ${adopt.directory} as it is; nothing was changed:`,
      ...adopt.blocked.map((reason) => `  - ${reason}`),
    );
  }
  const section = (heading: string, items: readonly string[]) => {
    if (items.length > 0) lines.push(heading, ...items.map((item) => `  ${item}`));
  };
  section(
    "Left as they are, the project's own:",
    adopt.others.map((part) => `${part.stack} in ${part.path}: ${part.reason}`),
  );
  const of = (step: "add" | "kept") => adopt.files.filter((file) => file.step === step);
  section(
    "Liftoff's own files it adds:",
    of("add").map((file) => `add  ${file.path} (${OWNED[file.ownership]})`),
  );
  section(
    "Already there, so kept as the project's and not added:",
    of("kept").map((file) => `${file.path}: ${file.reason ?? ""}`),
  );
  section(
    "Application changes the standard expects, which adopting does not make:",
    adopt.application.map(
      (change) =>
        `${change.subject === undefined ? "" : `${change.subject}: `}${change.message}${change.next === undefined ? "" : `. ${change.next}`}`,
    ),
  );
  section(
    "Records from a Liftoff release before the rebuild, kept byte for byte as the project's:",
    adopt.legacy.map(
      (record) => `${record.path} (${record.format ?? record.record}, ${record.state})`,
    ),
  );
  if (adopt.plan !== undefined) lines.push(planLine(adopt.plan));
  // Paths, stacks and reasons come from the project, so every line is escaped.
  return lines.map(shown);
}

/** What the JSON report says about the adoption. */
const reported = (adopt: AdoptPlan) => ({
  directory: adopt.directory,
  adoptable: !isBlocked(adopt),
  blocked: adopt.blocked,
  proposal: adopt.proposal,
  ...(adopt.config === undefined ? {} : { config: adopt.config }),
  others: adopt.others,
  files: adopt.files,
  application: adopt.application,
  legacy: adopt.legacy,
  ...(adopt.plan === undefined ? {} : { plan: adopt.plan.hash }),
});

const list = (value: string | undefined) => (value === undefined ? undefined : [...listed(value)]);

/**
 * The parts --layout binds, as `part=directory` pairs. A trailing slash and
 * a leading "./" are dropped, so "./api/" is "api".
 */
function layoutFrom(value: string | undefined): Partial<Record<Component, string>> | undefined {
  if (value === undefined) return undefined;
  const layout: Partial<Record<Component, string>> = {};
  for (const binding of listed(value)) {
    const [part, ...rest] = binding.split("=");
    const directory = rest
      .join("=")
      .trim()
      .replace(/^\.\/(?=.)/, "")
      .replace(/(?<=.)\/+$/, "");
    const component = COMPONENTS.find((known) => known === part?.trim());
    if (component === undefined || directory === "") {
      throw new UsageError(
        `--layout takes part=directory pairs, where part is ${COMPONENTS.join(", ")}: ${binding} is not one`,
      );
    }
    if (layout[component] !== undefined) {
      throw new UsageError(`--layout binds the ${component} twice`);
    }
    layout[component] = directory;
  }
  return layout;
}

/** The choices typed on the command line; anything else is proposed. */
function choicesFrom(args: ParsedArgs): AdoptChoices {
  const option = (name: string) =>
    args.given.has(name) ? (args.options[name] as string | undefined) : undefined;
  const aiReview = option("ai-review") as AdoptChoices["aiReview"];
  const values: { [Key in keyof AdoptChoices]-?: AdoptChoices[Key] | undefined } = {
    name: option("name"),
    stack: option("stack"),
    pattern: option("pattern"),
    frontend: option("frontend"),
    infrastructure: option("infrastructure"),
    environments: list(option("environments")),
    agents: list(option("agents")),
    governance: option("governance"),
    aiReview,
    reviewEngine: option("review-engine"),
    owners: list(option("owners")),
    layout: layoutFrom(option("layout")),
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as AdoptChoices;
}

const CHOICE_OPTIONS = [
  "name",
  "stack",
  "pattern",
  "frontend",
  "infrastructure",
  "environments",
  "agents",
  "governance",
  "ai-review",
  "review-engine",
  "owners",
  "layout",
];

export function makeAdoptCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
  home: string = os.homedir(),
): CommandSpec {
  return {
    path: ["adopt"],
    summary: "Bring an existing project under Liftoff, adding only Liftoff's own files.",
    description:
      "Reads the project as liftoff assess does, running nothing, and proposes what it is: its backend's stack, a frontend and infrastructure, each where it lives, the coding-agent hosts it is set up for and, for a project from a Liftoff release before the rebuild, what its old configuration says. Options replace any part of the proposal. Adopting adds liftoff.yaml, .liftoff/manifest.json and Liftoff's own workflows, review policy, governance handoff, skills and instructions, made for where the parts live, and changes no file the project has: where one of Liftoff's files would go, the project's own is kept. It never replaces the application with a starter; a part it cannot place blocks adopting, with why. It lists the application changes the standard expects, which it does not make. It shows the plan and asks before changing anything; the default answer is no. In scripts, pass --yes. An adoption that stops part way can be finished or undone with --recover.",
    readOnly: false,
    reportSchema: "liftoff.adopt/v1",
    options: {
      dir: {
        type: "string",
        valueName: "path",
        default: ".",
        description:
          "Project directory. Without it, the current directory must be the root of a Git repository.",
      },
      name: {
        type: "string",
        valueName: "name",
        description:
          "Project name: 2 to 50 lowercase letters, digits and single hyphens. Defaults to the old configuration's, or the directory's name.",
      },
      stack: {
        type: "string",
        valueName: "stack",
        choices: Object.keys(STACKS),
        description: "The backend's stack, when the project holds more than one kind.",
      },
      pattern: {
        type: "string",
        valueName: "pattern",
        choices: Object.keys(PATTERNS),
        description: "GenAI pattern, for a PydanticAI backend. Defaults to generic.",
      },
      frontend: {
        type: "string",
        valueName: "frontend",
        choices: [NO_FRONTEND, ...Object.keys(FRONTENDS)],
        description: "Web frontend, or none to leave one found as the project's own.",
      },
      infrastructure: {
        type: "string",
        valueName: "provider",
        choices: [NO_INFRASTRUCTURE, ...Object.keys(INFRASTRUCTURE)],
        description: "Infrastructure as code, or none to leave any found as the project's own.",
      },
      environments: {
        type: "string",
        valueName: "list",
        description: `Environments the infrastructure deploys to, comma-separated: ${ENVIRONMENTS.join(", ")}. Defaults to all three.`,
      },
      agents: {
        type: "string",
        valueName: "list",
        description:
          "Coding-agent hosts, comma-separated: copilot, codex, claude. Defaults to those the project is set up for.",
      },
      governance: {
        type: "string",
        valueName: "profile",
        choices: Object.keys(GOVERNANCE),
        description: "Governance profile. Defaults to single-maintainer-gitflow.",
      },
      "ai-review": {
        type: "string",
        valueName: "mode",
        choices: ["auto", "on", "off"],
        description: "Verified AI review in CI; auto turns it on when agents are selected.",
      },
      "review-engine": {
        type: "string",
        valueName: "host",
        description: "Which selected agent host runs the verified AI review.",
      },
      owners: {
        type: "string",
        valueName: "logins",
        description: "GitHub logins that own the project, comma-separated, for CODEOWNERS.",
      },
      layout: {
        type: "string",
        valueName: "bindings",
        description:
          "Where each part lives, as part=directory pairs, comma-separated, such as backend=services/api,frontend=web; . is the repository root.",
      },
      check: {
        type: "boolean",
        description:
          "Change nothing; show what adopting would do, and exit 3 when the project cannot be adopted as it is.",
      },
      out: {
        type: "string",
        valueName: "file",
        description:
          "Save the plan to this file and change nothing in the project; apply it with --plan.",
      },
      plan: {
        type: "string",
        valueName: "file",
        description:
          "Apply exactly this saved plan, and refuse it if the project or Liftoff changed since.",
      },
      recover: {
        type: "string",
        valueName: "mode",
        choices: ["finish", "undo"],
        description: "Finish or undo an adoption that stopped part way.",
      },
      yes: { type: "boolean", short: "y", description: "Change the files without asking." },
    },
    examples: [
      "liftoff adopt --check",
      "liftoff adopt --dir ../service --layout backend=api,frontend=web --agents claude",
      "liftoff adopt --out adopt.plan.json",
      "liftoff adopt --plan adopt.plan.json --yes",
      "liftoff adopt --recover undo",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const given = (...options: string[]) => options.filter((option) => args.given.has(option));
      const yes = args.options.yes === true;
      const recover = args.options.recover as "finish" | "undo" | undefined;
      if (recover !== undefined) {
        const others = given("check", "out", "plan", ...CHOICE_OPTIONS);
        if (others.length > 0) {
          throw new UsageError(`--recover goes only with --dir and --yes, not --${others[0]}`);
        }
        return recoverChange(io, ports, args, recover, "adopt");
      }
      const planFile = args.options.plan as string | undefined;
      const out = args.options.out as string | undefined;
      const { preview } = checkPreview(args);
      const refused = [await projectDirectory(io.cwd, home)];

      let adopt: AdoptPlan;
      try {
        if (planFile !== undefined) {
          const others = given("dir", "check", "out", ...CHOICE_OPTIONS);
          if (others.length > 0) {
            throw new UsageError(
              `a saved plan names its project and configuration, so --plan goes without --${others[0]}`,
            );
          }
          adopt = await planAdoptFromSaved(ports, await readSavedPlan(io, planFile), version, {
            refused,
          });
        } else {
          const directory = await projectDirectory(io.cwd, args.options.dir as string);
          adopt = await planAdopt(ports, directory, version, choicesFrom(args), {
            named: args.given.has("dir"),
            refused,
          });
        }
      } catch (error) {
        if (error instanceof AssessError || error instanceof AdoptOptionError) {
          throw new UsageError(error.message);
        }
        return toCli(error);
      }

      const lines = renderAdopt(adopt, version);
      if (isBlocked(adopt)) {
        return {
          outcome: adopt.unsupported ? "unsupported" : "attention",
          report: { ...reported(adopt), changed: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      if (preview) {
        if (out !== undefined) lines.push(...(await savePlan(io, out, adopt.plan, "adopt")));
        return {
          outcome: "success",
          report: { ...reported(adopt), changed: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      const plan = adopt.plan;
      if (plan === undefined) {
        throw new Error("an adoption that is not blocked always has a plan");
      }
      io.stderr(`${lines.join("\n")}\n`);
      const result = await applyApproved(
        io,
        ports,
        { directory: adopt.directory, plan, contents: adopt.contents, unchanged: adopt.unchanged },
        "adopt",
        { yes, report: reported(adopt) },
      );
      if ("outcome" in result) return result;
      const adopted = [
        `Adopted ${adopt.config?.name ?? adopt.directory}: added ${changeSummary(plan)}.`,
        "Next: liftoff assess lists what the application still needs, and liftoff governance status shows how to turn on governance.",
        ...leftBehind(result.leftovers),
      ];
      return {
        outcome: result.leftovers.length > 0 ? "attention" : "success",
        report: { ...reported(adopt), changed: true, leftovers: result.leftovers },
        text: `${adopted.map(shown).join("\n")}\n`,
      };
    },
  };
}
