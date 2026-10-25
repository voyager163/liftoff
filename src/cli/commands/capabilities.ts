import { PROFILES } from "../../domain/risk-policy/profiles.ts";
import { AGENT_HOSTS } from "../../plugins/builtin/agents/hosts.ts";
import { ENVIRONMENTS } from "../../plugins/contracts/project-plugin.ts";
import {
  DEFAULT_GOVERNANCE,
  DEFAULT_WORKFLOW,
  FRONTENDS,
  GOVERNANCE,
  INFRASTRUCTURE,
  PATTERNS,
  STACKS,
  WORKFLOWS,
  WORKLOADS,
} from "../../plugins/registry.ts";
import { type CommandSpec, commandName } from "../command.ts";
import { OUTCOMES } from "../outcome.ts";
import { COMMON_OPTIONS } from "../parse.ts";

/**
 * Describes exactly what this installed Liftoff can do, so skills and scripts
 * can check for a command before calling it instead of assuming.
 */
export const capabilitiesCommand: CommandSpec = {
  path: ["capabilities"],
  summary: "List the commands and options this Liftoff supports.",
  description:
    "Prints every command this installation supports, with its options, whether it is read-only and the schema of its JSON report. Coding-agent skills call this before running other commands.",
  readOnly: true,
  reportSchema: "liftoff.capabilities/v1",
  options: {},
  examples: ["liftoff capabilities --json"],
  async run(_args, { registry, version }) {
    const commands = registry.map((spec) => ({
      name: commandName(spec),
      summary: spec.summary,
      readOnly: spec.readOnly,
      reportSchema: spec.reportSchema,
      options: Object.entries({ ...spec.options, ...COMMON_OPTIONS }).map(([name, option]) => ({
        name: `--${name}`,
        type: option.type,
        ...(option.type === "string" && option.choices ? { choices: option.choices } : {}),
      })),
    }));
    const report = {
      cliVersion: version,
      exitCodes: OUTCOMES,
      commands,
      workloads: WORKLOADS,
      stacks: Object.values(STACKS).map((stack) => ({
        id: stack.id.replace(/^stack\//, ""),
        workload: stack.workload,
        summary: stack.summary,
      })),
      // Each id is the value the matching option accepts.
      patterns: Object.entries(PATTERNS).map(([id, pattern]) => ({
        id,
        summary: pattern.summary,
        maturity: pattern.maturity.level,
      })),
      frontends: Object.entries(FRONTENDS).map(([id, frontend]) => ({
        id,
        summary: frontend.summary,
      })),
      infrastructure: Object.entries(INFRASTRUCTURE).map(([id, infrastructure]) => ({
        id,
        summary: infrastructure.summary,
      })),
      environments: ENVIRONMENTS,
      workflows: Object.entries(WORKFLOWS).map(([id, workflow]) => ({
        id,
        available: true,
        summary: workflow.summary,
        ...(workflow.initializer
          ? {
              initializer: {
                name: workflow.initializer.name,
                version: workflow.initializer.version,
              },
            }
          : {}),
      })),
      defaultWorkflow: DEFAULT_WORKFLOW,
      agents: Object.values(AGENT_HOSTS).map((host) => ({ id: host.id, name: host.displayName })),
      governanceProfiles: Object.values(PROFILES).map((profile) => ({
        id: profile.id,
        available: GOVERNANCE[profile.id] !== undefined,
        approvals: profile.approvals,
        alwaysHumanMinimum: profile.alwaysHumanMinimum,
      })),
      defaultGovernance: DEFAULT_GOVERNANCE,
    };
    const text = [
      `Liftoff ${version}`,
      "",
      ...commands.map((c) => `${c.name}${c.readOnly ? " (read-only)" : ""}: ${c.summary}`),
    ].join("\n");
    return { outcome: "success", report, text: `${text}\n` };
  },
};
