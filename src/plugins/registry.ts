import type { ProjectConfig } from "../domain/project/config.ts";
import { PROFILE_IDS, type ProfileId } from "../domain/risk-policy/policy.ts";
import { AGENT_HOSTS } from "./builtin/agents/hosts.ts";
import { agentsPlugin } from "./builtin/agents.ts";
import { commonPlugin } from "./builtin/common.ts";
import { deliveryPlugin } from "./builtin/delivery.ts";
import { vueFrontend } from "./builtin/frontends/vue.ts";
import { gitflowGovernance, noGovernance } from "./builtin/governance/gitflow.ts";
import { azureInfrastructure } from "./builtin/infrastructure/azure.ts";
import { reviewPlugin } from "./builtin/review/review.ts";
import { goHumaStack } from "./builtin/stacks/go-huma.ts";
import { nodeFastifyStack } from "./builtin/stacks/node-fastify.ts";
import { pythonFastapiStack } from "./builtin/stacks/python-fastapi.ts";
import { manualWorkflow } from "./builtin/workflows.ts";
import type { AgentHostId } from "./contracts/agent-host.ts";
import {
  type ComponentPlugin,
  ENVIRONMENTS,
  type EnvironmentId,
  type FrontendPlugin,
  type InfrastructurePlugin,
  type ProjectPlugin,
  type StackPlugin,
} from "./contracts/project-plugin.ts";

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
/** Web frontends; "none" selects no frontend. */
export const FRONTENDS: Readonly<Record<string, FrontendPlugin>> = { vue: vueFrontend };
export const NO_FRONTEND = "none";
/** Infrastructure as code; "none" selects none. */
export const INFRASTRUCTURE: Readonly<Record<string, InfrastructurePlugin>> = {
  azure: azureInfrastructure,
};
export const NO_INFRASTRUCTURE = "none";
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
  readonly frontend: FrontendPlugin | undefined;
  readonly infrastructure: InfrastructurePlugin | undefined;
  /** In dev, staging, prod order. */
  readonly environments: readonly EnvironmentId[];
  /** The stack, then the frontend and the infrastructure if selected. */
  readonly components: readonly ComponentPlugin[];
  readonly hosts: readonly AgentHostId[];
  readonly profile: ProfileId;
  /** In generation order. */
  readonly plugins: readonly ProjectPlugin[];
}

const list = (values: Iterable<string>) => [...values].join(", ");

/**
 * The registry entry for an id read from a project or plan file. Only the
 * registry's own entries count, never inherited object properties such as
 * "constructor".
 */
export const entry = <T>(registry: Readonly<Record<string, T>>, id: string): T | undefined =>
  Object.hasOwn(registry, id) ? registry[id] : undefined;

/** Checks a configuration against what this release ships, before anything is generated. */
export function resolveSelection(config: ProjectConfig): Selection {
  if (!(WORKLOADS as readonly string[]).includes(config.workload)) {
    throw new SelectionError(
      `unknown workload "${config.workload}"; available: ${list(WORKLOADS)}`,
    );
  }
  const stack = entry(STACKS, config.stack);
  if (!stack)
    throw new SelectionError(
      `unknown stack "${config.stack}"; available: ${list(Object.keys(STACKS))}`,
    );
  if (stack.workload !== config.workload) {
    throw new SelectionError(
      `stack "${config.stack}" is for ${stack.workload} projects, not ${config.workload}`,
    );
  }

  let frontend: FrontendPlugin | undefined;
  if (config.frontend !== NO_FRONTEND) {
    frontend = entry(FRONTENDS, config.frontend);
    if (!frontend) {
      throw new SelectionError(
        `unknown frontend "${config.frontend}"; available: ${list([NO_FRONTEND, ...Object.keys(FRONTENDS)])}`,
      );
    }
  }

  let infrastructure: InfrastructurePlugin | undefined;
  if (config.infrastructure !== NO_INFRASTRUCTURE) {
    infrastructure = entry(INFRASTRUCTURE, config.infrastructure);
    if (!infrastructure) {
      throw new SelectionError(
        `unknown infrastructure "${config.infrastructure}"; available: ${list([NO_INFRASTRUCTURE, ...Object.keys(INFRASTRUCTURE)])}`,
      );
    }
  }
  for (const environment of config.environments) {
    if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
      throw new SelectionError(
        `unknown environment "${environment}"; available: ${list(ENVIRONMENTS)}`,
      );
    }
  }
  if (infrastructure && config.environments.length === 0) {
    throw new SelectionError(
      `${config.infrastructure} infrastructure needs at least one environment`,
    );
  }
  if (!infrastructure && config.environments.length > 0) {
    throw new SelectionError("environments need infrastructure; add --infrastructure azure");
  }
  const environments = ENVIRONMENTS.filter((environment) =>
    config.environments.includes(environment),
  );

  const workflow = entry(WORKFLOWS, config.workflow);
  if (!workflow) {
    const planned = entry(PLANNED_WORKFLOWS, config.workflow);
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
    if (!entry(AGENT_HOSTS, agent)) {
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

  const components: ComponentPlugin[] = [stack];
  if (frontend) components.push(frontend);
  if (infrastructure) components.push(infrastructure);
  return {
    stack,
    frontend,
    infrastructure,
    environments,
    components,
    hosts,
    profile,
    plugins: [
      commonPlugin,
      ...components,
      deliveryPlugin,
      workflow,
      agentsPlugin,
      reviewPlugin,
      governance,
    ],
  };
}

/** Every plugin, for capability listings and asset checks. */
export function allPlugins(): ProjectPlugin[] {
  const plugins = [
    commonPlugin,
    ...Object.values(STACKS),
    ...Object.values(FRONTENDS),
    ...Object.values(INFRASTRUCTURE),
    deliveryPlugin,
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
