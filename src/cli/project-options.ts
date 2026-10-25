import path from "node:path";
import {
  CONFIG_SCHEMA,
  ConfigError,
  type ProjectConfig,
  validateConfig,
} from "../domain/project/config.ts";
import { DEFAULT_GOVERNANCE, DEFAULT_WORKFLOW, STACKS } from "../plugins/registry.ts";
import type { OptionSpec, ParsedArgs } from "./command.ts";
import { UsageError } from "./outcome.ts";

/** Options that describe a new project, shared by `plan` and `init`. */
export const PROJECT_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  name: {
    type: "string",
    valueName: "name",
    description: "Project name: lowercase letters, digits and hyphens.",
  },
  dir: {
    type: "string",
    valueName: "path",
    description: "Directory to create. Defaults to ./<name>.",
  },
  workload: {
    type: "string",
    valueName: "workload",
    default: "api",
    description: "Kind of project.",
    choices: ["api"],
  },
  stack: {
    type: "string",
    valueName: "stack",
    default: "python-fastapi",
    description: `Technology stack: ${Object.keys(STACKS).join(", ")}.`,
  },
  workflow: {
    type: "string",
    valueName: "workflow",
    default: DEFAULT_WORKFLOW,
    description: "Development workflow: openspec, spec-kit or manual.",
  },
  agents: {
    type: "string",
    valueName: "list",
    description: "Coding-agent hosts, comma-separated: copilot, codex, claude. Defaults to none.",
  },
  governance: {
    type: "string",
    valueName: "profile",
    default: DEFAULT_GOVERNANCE,
    description: "Governance profile.",
  },
  "ai-review": {
    type: "string",
    valueName: "mode",
    default: "auto",
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
};

const splitList = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

/** True when any project option was typed, including ones that have a default. */
export const hasProjectOptions = (args: ParsedArgs): boolean =>
  Object.keys(PROJECT_OPTIONS).some((name) => args.given.has(name));

/** Builds and validates the project configuration from command-line options. */
export function projectFromOptions(
  args: ParsedArgs,
  cwd: string,
): { config: ProjectConfig; target: string } {
  const option = (name: string) => args.options[name] as string | undefined;
  const name = option("name");
  if (name === undefined) throw new UsageError("--name is required");
  const agents = splitList(option("agents"));
  const aiMode = option("ai-review") ?? "auto";
  const engine = option("review-engine");
  try {
    const config = validateConfig(
      {
        schema: CONFIG_SCHEMA,
        name,
        workload: option("workload"),
        stack: option("stack"),
        workflow: option("workflow"),
        agents,
        governance: option("governance"),
        review: {
          ai: aiMode === "on" || (aiMode === "auto" && agents.length > 0),
          ...(engine === undefined ? {} : { engine }),
        },
        owners: splitList(option("owners")),
      },
      "the options",
    );
    return { config, target: path.resolve(cwd, option("dir") ?? name) };
  } catch (error) {
    if (error instanceof ConfigError)
      throw new UsageError(error.message.replace("the options is invalid: ", "invalid option: "));
    throw error;
  }
}
