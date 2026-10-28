import os from "node:os";
import {
  AdoptOptionError,
  type AdoptPlan,
  isBlocked,
  planAdopt,
  planAdoptFromSaved,
} from "../../application/adopt/adopt-project.ts";
import { AssessError } from "../../application/project/assess-project.ts";
import { COMPONENTS, type Component } from "../../domain/project/config.ts";
import type { CommandResult, CommandSpec } from "../command.ts";
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
import { CHOICE_OPTIONS, choicesFrom, proposalLines } from "./choosing.ts";
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
    lines.push(...proposalLines(adopt.proposal));
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

/** The options that choose what the project is, which a saved plan or recovery already names. */
const CHOSEN = [...Object.keys(CHOICE_OPTIONS), "layout"];

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
      ...CHOICE_OPTIONS,
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
        const others = given("check", "out", "plan", ...CHOSEN);
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
          const others = given("dir", "check", "out", ...CHOSEN);
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
          const layout = layoutFrom(
            args.given.has("layout") ? (args.options.layout as string) : undefined,
          );
          const choices = { ...choicesFrom(args), ...(layout === undefined ? {} : { layout }) };
          adopt = await planAdopt(ports, directory, version, choices, {
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

      // Ctrl+C while planning, even for --check, cancels rather than reporting.
      io.signal.throwIfAborted();
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
        { directory: adopt.directory, plan, contents: adopt.contents },
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
