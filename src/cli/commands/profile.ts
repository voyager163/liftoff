import { TransitionOptionError } from "../../application/change/config-transition.ts";
import { type ProfilePlan, planProfileSet } from "../../application/governance/profile-set.ts";
import { GOVERNANCE } from "../../plugins/registry.ts";
import type { CommandResult, CommandSpec } from "../command.ts";
import { UsageError } from "../outcome.ts";
import { shown } from "../terminal.ts";
import { applyApproved, changeSummary, leftBehind, recoverChange, toCli } from "./changing.ts";
import { defaultProjectPorts, type ProjectPorts, projectDirectory } from "./project-ports.ts";

const STEPS = { change: "rewrite", add: "add", remove: "remove" } as const;

/** What the switch leaves on GitHub, said every time. */
const github = (profile: ProfilePlan): string[] => [
  "Nothing on GitHub changes: the rulesets already applied there stay as they are. liftoff governance assess shows how they differ from the project's; change rulesets that are already active on GitHub by hand, as Liftoff never changes an active ruleset.",
  ...(profile.weaker
    ? [
        profile.to === "none"
          ? `none has no rulesets; until the ones on GitHub are removed there, they still protect the project as ${profile.from} does.`
          : `${profile.to} requires fewer approvals than ${profile.from}; until the rulesets on GitHub are changed, they still require what ${profile.from} does.`,
      ]
    : []),
];

/** The switch, in the words the text shows it. */
export function renderProfileSet(profile: ProfilePlan): string[] {
  const lines = [`Switch ${profile.directory} from ${profile.from} to ${profile.to}:`];
  for (const file of profile.files) {
    lines.push(
      file.step === "left"
        ? `  left ${file.path}: ${file.reason ?? ""}`
        : `  ${STEPS[file.step]} ${file.path}`,
    );
  }
  lines.push(...github(profile));
  // Paths and reasons come from the project, so every line is escaped.
  return lines.map(shown);
}

const reported = (profile: ProfilePlan) => ({
  directory: profile.directory,
  from: profile.from,
  to: profile.to,
  files: profile.files,
  weaker: profile.weaker,
});

export function makeGovernanceProfileSetCommand(
  portsFor: (cwd: string) => ProjectPorts = defaultProjectPorts,
): CommandSpec {
  return {
    path: ["governance", "profile", "set"],
    summary: "Switch a Liftoff project's governance profile.",
    description:
      "Switches the project's governance profile as a reviewed change of its own: liftoff.yaml and the manifest are rewritten, and the files Liftoff writes differently for the new profile, such as the rulesets, the review policy, GOVERNANCE.md and the release workflows, change only while they are as Liftoff wrote them; any other is left and named. Nothing on GitHub changes: liftoff governance assess shows how its rulesets differ, and active rulesets are changed there by hand. It shows the change and asks first; the default answer is no. In scripts, pass --yes. A switch that stops part way can be finished or undone with --recover.",
    readOnly: false,
    reportSchema: "liftoff.profile-set/v1",
    positionals: [
      {
        name: "profile",
        description: `The profile to switch to: ${Object.keys(GOVERNANCE).join(", ")}.`,
      },
    ],
    options: {
      dir: { type: "string", valueName: "path", default: ".", description: "Project directory." },
      check: { type: "boolean", description: "Change nothing; show what switching would do." },
      recover: {
        type: "string",
        valueName: "mode",
        choices: ["finish", "undo"],
        description: "Finish or undo a switch that stopped part way.",
      },
      yes: { type: "boolean", short: "y", description: "Switch without asking." },
    },
    examples: [
      "liftoff governance profile set team-gitflow --check",
      "liftoff governance profile set risk-tiered-gitflow",
      "liftoff governance profile set --recover undo",
    ],
    async run(args, { io, version }): Promise<CommandResult> {
      const ports = portsFor(io.cwd);
      const recover = args.options.recover as "finish" | "undo" | undefined;
      const [target] = args.positionals;
      if (recover !== undefined) {
        if (target !== undefined || args.options.check === true) {
          throw new UsageError(
            "--recover goes only with --dir and --yes, not a profile or --check",
          );
        }
        return recoverChange(io, ports, args, recover, "profile-set");
      }
      if (target === undefined) {
        throw new UsageError(
          `name the profile to switch to: ${Object.keys(GOVERNANCE).join(", ")}`,
        );
      }
      if (args.options.check === true && args.options.yes === true) {
        throw new UsageError("--check changes nothing, so --yes has nothing to confirm");
      }
      const directory = await projectDirectory(io.cwd, args.options.dir as string);
      let profile: ProfilePlan;
      try {
        profile = await planProfileSet(ports, directory, version, target);
      } catch (error) {
        if (error instanceof TransitionOptionError) throw new UsageError(error.message);
        return toCli(error);
      }
      io.signal.throwIfAborted();
      if (profile.plan === undefined) {
        return {
          outcome: "success",
          report: { ...reported(profile), changed: false },
          text: `${shown(`${directory} already uses ${profile.to}; nothing to change.`)}\n`,
        };
      }
      const lines = renderProfileSet(profile);
      if (args.options.check === true) {
        return {
          outcome: "success",
          report: { ...reported(profile), changed: false },
          text: `${lines.join("\n")}\n`,
        };
      }
      io.stderr(`${lines.join("\n")}\n`);
      if (args.options.yes !== true) {
        if (!io.interactive) {
          throw new UsageError(
            "governance profile set changes files; pass --yes to confirm when no one can answer a prompt",
          );
        }
        if (!(await io.confirm(`Switch ${shown(directory)} to ${profile.to}?`))) {
          return {
            outcome: "cancelled",
            report: { ...reported(profile), changed: false },
            text: "Nothing was changed.\n",
          };
        }
      }
      const result = await applyApproved(
        io,
        ports,
        { directory, plan: profile.plan, contents: profile.contents },
        "profile-set",
        { yes: true, report: reported(profile) },
      );
      if ("outcome" in result) return result;
      const done = [
        `Switched ${directory} to ${profile.to}: changed ${changeSummary(profile.plan)}.`,
        ...github(profile),
        ...leftBehind(result.leftovers),
      ];
      return {
        outcome: result.leftovers.length > 0 ? "attention" : "success",
        report: { ...reported(profile), changed: true, leftovers: result.leftovers },
        text: `${done.map(shown).join("\n")}\n`,
      };
    },
  };
}
