import path from "node:path";
import { CONFIG_FILE, type ProjectConfig, parseConfig } from "../../domain/project/config.ts";
import type { ComponentPlugin, ProjectTool } from "../../plugins/contracts/project-plugin.ts";
import { resolveSelection } from "../../plugins/registry.ts";
import type { ProjectFsPort, ToolPort } from "../ports.ts";

export type ToolStatus = "ok" | "missing" | "too-old" | "unknown-version";

export interface ToolCheck {
  readonly name: string;
  readonly required: boolean;
  readonly status: ToolStatus;
  readonly version?: string;
  readonly minimum?: string;
  readonly purpose: string;
  readonly install: string;
}

export interface DoctorResult {
  /** Project the checks are for, when run inside one. */
  readonly project?: { readonly name: string; readonly stack: string };
  readonly tools: readonly ToolCheck[];
  /** Every required tool is present and new enough. */
  readonly ready: boolean;
}

/** Tools every project needs, whatever its stack. */
const BASE_TOOLS: readonly ProjectTool[] = [
  {
    name: "Git",
    command: "git",
    versionArgs: ["--version"],
    required: true,
    minimum: "2.40.0",
    purpose: "version control",
    install: "https://git-scm.com/downloads",
  },
];

/** Parses the first dotted version number in a tool's output. */
export function parseVersion(text: string): number[] | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

function meetsMinimum(version: number[], minimum: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const a = version[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The tools a project's components need, each command once and required if
 * any component requires it. Components that share a tool ask for the same
 * minimum version, which a test checks.
 */
function projectTools(components: readonly ComponentPlugin[]): ProjectTool[] {
  const byCommand = new Map<string, ProjectTool>();
  for (const tool of components.flatMap((component) => component.tools)) {
    const seen = byCommand.get(tool.command);
    byCommand.set(
      tool.command,
      seen ? { ...seen, required: seen.required || tool.required } : tool,
    );
  }
  return [...byCommand.values()];
}

/**
 * Checks the tools the project in `directory` needs. It only runs version
 * commands: nothing is installed or changed.
 */
export async function runDoctor(
  ports: { fs: ProjectFsPort; tools: ToolPort },
  directory: string,
): Promise<DoctorResult> {
  let config: ProjectConfig | undefined;
  const text = await ports.fs.readText(path.join(directory, CONFIG_FILE));
  if (text !== undefined) config = parseConfig(text);
  const tools = config ? projectTools(resolveSelection(config).components) : BASE_TOOLS;

  const checks: ToolCheck[] = [];
  for (const tool of tools) {
    const output = await ports.tools.version(tool.command, tool.versionArgs);
    const base = {
      name: tool.name,
      required: tool.required,
      purpose: tool.purpose,
      install: tool.install,
    };
    const withMinimum = tool.minimum === undefined ? base : { ...base, minimum: tool.minimum };
    if (output === undefined) {
      checks.push({ ...withMinimum, status: "missing" });
      continue;
    }
    const version = parseVersion(output);
    const minimum = tool.minimum === undefined ? undefined : parseVersion(tool.minimum);
    const found = version ? version.join(".") : output;
    let status: ToolStatus = "ok";
    if (minimum)
      status =
        version === undefined
          ? "unknown-version"
          : meetsMinimum(version, minimum)
            ? "ok"
            : "too-old";
    checks.push({ ...withMinimum, status, version: found });
  }
  return {
    ...(config ? { project: { name: config.name, stack: config.stack } } : {}),
    tools: checks,
    ready: checks.every((check) => !check.required || check.status === "ok"),
  };
}
