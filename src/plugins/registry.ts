import type { ProjectConfig } from "../domain/project/config.ts";
import { PROFILE_IDS, type ProfileId } from "../domain/risk-policy/policy.ts";
import { AGENT_HOSTS } from "./builtin/agents/hosts.ts";
import { agentsPlugin } from "./builtin/agents.ts";
import { commonPlugin } from "./builtin/common.ts";
import { gitflowGovernance, noGovernance } from "./builtin/governance/gitflow.ts";
import { reviewPlugin } from "./builtin/review/review.ts";
import { goHumaStack } from "./builtin/stacks/go-huma.ts";
import { nodeFastifyStack } from "./builtin/stacks/node-fastify.ts";
import { pythonFastapiStack } from "./builtin/stacks/python-fastapi.ts";
import { manualWorkflow } from "./builtin/workflows.ts";
import type { AgentHostId } from "./contracts/agent-host.ts";
import type { ProjectPlugin, StackPlugin } from "./contracts/project-plugin.ts";

/**
 * Every plugin this release ships. Plugins are bundled and listed here;
 * nothing is ever loaded from a project or the network.
 */
export const WORKLOADS = ["api"] as const;
export const STACKS: Readonly<Record<string, StackPlugin>> = {
  "python-fastapi": pythonFastapiStack,
  "node-fastify": nodeFastifyStack,
  "go-huma": goHumaStack,
};
export const WORKFLOWS: Readonly<Record<string, ProjectPlugin>> = { manual: manualWorkflow };
/** Workflows the product supports but this release cannot generate yet. */
export const PLANNED_WORKFLOWS: Readonly<Record<string, string>> = {
  openspec: "OpenSpec",
  "spec-kit": "Spec Kit",
};
export const GOVERNANCE: Readonly<Record<ProfileId, ProjectPlugin>> = {
  "single-maintainer-gitflow": gitflowGovernance("single-maintainer-gitflow"),
  "team-gitflow": gitflowGovernance("team-gitflow"),
  "risk-tiered-gitflow": gitflowGovernance("risk-tiered-gitflow"),
  none: noGovernance,
};
export const DEFAULT_WORKFLOW = "openspec";
export const DEFAULT_GOVERNANCE: ProfileId = "single-maintainer-gitflow";

export class SelectionError extends Error {
  override readonly name = "SelectionError";
  /** True when the selection is valid but this release cannot generate it. */
  readonly unsupported: boolean;

  constructor(message: string, unsupported = false) {
    super(message);
    this.unsupported = unsupported;
  }
}

export interface Selection {
  readonly stack: StackPlugin;
  readonly hosts: readonly AgentHostId[];
  readonly profile: ProfileId;
  /** In generation order. */
  readonly plugins: readonly ProjectPlugin[];
}

const list = (values: Iterable<string>) => [...values].join(", ");

/** Checks a configuration against what this release ships, before anything is generated. */
export function resolveSelection(config: ProjectConfig): Selection {
  if (!(WORKLOADS as readonly string[]).includes(config.workload)) {
    throw new SelectionError(
      `unknown workload "${config.workload}"; available: ${list(WORKLOADS)}`,
    );
  }
  const stack = STACKS[config.stack];
  if (!stack)
    throw new SelectionError(
      `unknown stack "${config.stack}"; available: ${list(Object.keys(STACKS))}`,
    );
  if (stack.workload !== config.workload) {
    throw new SelectionError(
      `stack "${config.stack}" is for ${stack.workload} projects, not ${config.workload}`,
    );
  }

  const workflow = WORKFLOWS[config.workflow];
  if (!workflow) {
    const planned = PLANNED_WORKFLOWS[config.workflow];
    if (planned) {
      throw new SelectionError(
        `the ${planned} workflow is not available in this release yet; use --workflow manual`,
        true,
      );
    }
    throw new SelectionError(
      `unknown workflow "${config.workflow}"; available: ${list(Object.keys(WORKFLOWS))}`,
    );
  }

  const hosts: AgentHostId[] = [];
  for (const agent of config.agents) {
    if (!(agent in AGENT_HOSTS)) {
      throw new SelectionError(
        `unknown agent "${agent}"; available: ${list(Object.keys(AGENT_HOSTS))}`,
      );
    }
    hosts.push(agent as AgentHostId);
  }

  if (!(PROFILE_IDS as readonly string[]).includes(config.governance)) {
    throw new SelectionError(
      `unknown governance profile "${config.governance}"; available: ${list(PROFILE_IDS)}`,
    );
  }
  const profile = config.governance as ProfileId;
  const governance = GOVERNANCE[profile];

  if (config.review.engine !== undefined && !config.agents.includes(config.review.engine)) {
    throw new SelectionError(
      `review engine "${config.review.engine}" must be one of the selected agents`,
    );
  }
  if (config.review.ai && hosts.length === 0) {
    throw new SelectionError(
      "verified AI review needs at least one coding agent; add --agents or turn it off",
    );
  }

  return {
    stack,
    hosts,
    profile,
    plugins: [commonPlugin, stack, workflow, agentsPlugin, reviewPlugin, governance],
  };
}

/** Every plugin, for capability listings and asset checks. */
export function allPlugins(): ProjectPlugin[] {
  const plugins = [
    commonPlugin,
    ...Object.values(STACKS),
    ...Object.values(WORKFLOWS),
    agentsPlugin,
    reviewPlugin,
    ...Object.values(GOVERNANCE),
  ];
  const ids = plugins.map((plugin) => plugin.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`two plugins share the id ${duplicate}`);
  return plugins;
}
