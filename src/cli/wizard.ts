import { isGithubLogin, projectNameProblem } from "../domain/project/config.ts";
import { PROFILES } from "../domain/risk-policy/profiles.ts";
import { AGENT_HOSTS } from "../plugins/builtin/agents/hosts.ts";
import type { AgentHostId } from "../plugins/contracts/agent-host.ts";
import { ENVIRONMENTS } from "../plugins/contracts/project-plugin.ts";
import {
  DEFAULT_GOVERNANCE,
  DEFAULT_PATTERN,
  DEFAULT_STACKS,
  DEFAULT_WORKFLOW,
  entry,
  FRONTENDS,
  GOVERNANCE,
  INFRASTRUCTURE,
  NO_FRONTEND,
  NO_INFRASTRUCTURE,
  NO_PATTERN,
  PATTERNS,
  STACKS,
  WORKFLOWS,
  WORKLOADS,
} from "../plugins/registry.ts";
import type { Choice, Prompts } from "./command.ts";
import { PROJECT_OPTIONS } from "./project-options.ts";

/** A choice with its summary, when it has one. */
const described = (value: string, summary: string | undefined): Choice =>
  summary === undefined ? { value } : { value, description: summary };

const WORKLOAD_NAMES: Readonly<Record<string, string>> = {
  api: "API: an HTTP API with PostgreSQL",
  genai: "GenAI: an API built around one GenAI pattern",
};

/**
 * Asks for every project option in turn, offering only what this release can
 * generate with the earlier answers: a frontend and infrastructure only for
 * stacks with a database, Spec Kit only with a coding agent. Each question is
 * named after its option, and the answers come back as they would be typed
 * on the command line, so `init` checks them exactly as it checks flags.
 */
export async function askProjectOptions(prompts: Prompts): Promise<Record<string, string>> {
  const name = await prompts.text({
    flag: "name",
    message: "Project name",
    validate: projectNameProblem,
  });
  const dir = await prompts.text({ flag: "dir", message: "Directory to create", default: name });

  const workload = await prompts.select({
    flag: "workload",
    message: "Kind of project",
    choices: WORKLOADS.map((id) => ({ value: id, name: WORKLOAD_NAMES[id] ?? id })),
    default: "api",
  });
  const stacks = Object.entries(STACKS).filter(([, stack]) => stack.workload === workload);
  const defaultStack = entry(DEFAULT_STACKS, workload);
  const stack =
    stacks.length === 1
      ? (stacks[0]?.[0] ?? "")
      : await prompts.select({
          flag: "stack",
          message: "Stack",
          choices: stacks.map(([id, plugin]) => ({ value: id, description: plugin.summary })),
          ...(defaultStack ? { default: defaultStack } : {}),
        });
  const pattern =
    workload === "genai"
      ? await prompts.select({
          flag: "pattern",
          message: "GenAI pattern",
          choices: Object.entries(PATTERNS).map(([id, plugin]) => ({
            value: id,
            description: `${plugin.maturity.level}: ${plugin.summary}`,
          })),
          default: DEFAULT_PATTERN,
        })
      : NO_PATTERN;

  // The frontend and the infrastructure need a stack with a database.
  const withDatabase = entry(STACKS, stack)?.database !== undefined;
  const frontend = withDatabase
    ? await prompts.select({
        flag: "frontend",
        message: "Web frontend",
        choices: [NO_FRONTEND, ...Object.keys(FRONTENDS)].map((id) =>
          described(id, entry(FRONTENDS, id)?.summary),
        ),
        default: NO_FRONTEND,
      })
    : NO_FRONTEND;
  const infrastructure = withDatabase
    ? await prompts.select({
        flag: "infrastructure",
        message: "Infrastructure as code",
        choices: [NO_INFRASTRUCTURE, ...Object.keys(INFRASTRUCTURE)].map((id) =>
          described(id, entry(INFRASTRUCTURE, id)?.summary),
        ),
        default: NO_INFRASTRUCTURE,
      })
    : NO_INFRASTRUCTURE;
  const environments =
    infrastructure === NO_INFRASTRUCTURE
      ? []
      : await prompts.checkbox({
          flag: "environments",
          message: "Environments",
          choices: ENVIRONMENTS.map((id) => ({ value: id, checked: true })),
          required: true,
        });

  const agents = await prompts.checkbox({
    flag: "agents",
    message: "Coding agents",
    choices: Object.values(AGENT_HOSTS).map((host) => ({
      value: host.id,
      name: host.displayName,
    })),
  });
  const hosts = agents as AgentHostId[];
  const workflow = await prompts.select({
    flag: "workflow",
    message: "Specification workflow",
    choices: Object.entries(WORKFLOWS).map(([id, plugin]) => {
      const unsupported = plugin.unsupportedHosts?.(hosts);
      return {
        value: id,
        description: plugin.summary,
        ...(unsupported ? { disabled: "needs a coding agent" } : {}),
      };
    }),
    default: DEFAULT_WORKFLOW,
  });
  const aiReview =
    agents.length === 0
      ? "off"
      : await prompts.select({
          flag: "ai-review",
          message: "Verified AI review in CI",
          choices: [
            { value: "on", description: "finder and verifier passes on medium and high tiers" },
            { value: "off" },
          ],
          default: "on",
        });
  const engine =
    aiReview === "on" && agents.length > 1
      ? await prompts.select({
          flag: "review-engine",
          message: "Agent that runs the AI review",
          choices: [
            { value: "", name: "Let Liftoff choose" },
            ...agents.map((id) => ({ value: id, name: entry(AGENT_HOSTS, id)?.displayName ?? id })),
          ],
          default: "",
        })
      : "";

  const governance = await prompts.select({
    flag: "governance",
    message: "Governance profile",
    choices: Object.keys(GOVERNANCE).map((id) => ({
      value: id,
      description: entry(PROFILES, id)?.summary ?? "",
    })),
    default: DEFAULT_GOVERNANCE,
  });
  const owners = await prompts.text({
    flag: "owners",
    message: "GitHub logins that own the project, comma-separated (optional)",
    default: "",
    validate: (value) => {
      const wrong = splitList(value).find((login) => !isGithubLogin(login));
      return wrong === undefined ? undefined : `${wrong} is not a GitHub login.`;
    },
  });

  return {
    name,
    dir,
    workload,
    stack,
    pattern,
    frontend,
    infrastructure,
    environments: environments.join(","),
    workflow,
    agents: agents.join(","),
    governance,
    // "auto" turns AI review on exactly when there is an agent.
    "ai-review": aiReview === (agents.length > 0 ? "on" : "off") ? "auto" : aiReview,
    "review-engine": engine,
    owners: splitList(owners).join(","),
  };
}

const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** The shell a printed command is for: macOS's, or PowerShell on Windows. */
export type Shell = "posix" | "powershell";

/**
 * Quotes a value for the shell, when it needs it. A value is left bare only
 * when it starts with a letter, digit, dot, slash or hyphen, since zsh
 * expands a leading = or ~. PowerShell also reads commas, @ and % specially,
 * and escapes an apostrophe by doubling it.
 */
function quote(value: string, shell: Shell): string {
  if (shell === "powershell") {
    return /^[\w./-][\w./:=+-]*$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
  }
  return /^[\w./-][\w@%+=:,./-]*$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command line that gives the same answers without questions, for the
 * shell. Answers that are empty or the option's default are left out, and a
 * value that starts with a hyphen is joined to its option with "=".
 */
export function equivalentCommand(
  answers: Readonly<Record<string, string>>,
  shell: Shell = "posix",
): string {
  const flags = Object.entries(answers).flatMap(([flag, value]) => {
    const spec = PROJECT_OPTIONS[flag];
    if (value === "" || (spec?.type === "string" && spec.default === value)) return [];
    if ((flag === "dir" && value === answers.name) || (flag === "pattern" && value === NO_PATTERN))
      return [];
    return [
      value.startsWith("-")
        ? quote(`--${flag}=${value}`, shell)
        : `--${flag} ${quote(value, shell)}`,
    ];
  });
  return ["liftoff init", ...flags].join(" ");
}
