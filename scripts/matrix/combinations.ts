// Every combination of project options this release could be asked for,
// built from the plugin registry so a new plugin joins the matrix by itself:
// each stack (with each GenAI pattern for GenAI stacks), with and without each
// frontend and infrastructure, each workflow, every subset of coding agents
// and every governance profile. The registry decides which are supported.
import path from "node:path";
import { PackageAssets } from "../../src/adapters/assets.ts";
import { generate } from "../../src/application/init/generation.ts";
import type { AssetPort } from "../../src/application/ports.ts";
import {
  CONFIG_SCHEMA,
  type ProjectConfig,
  validateConfig,
} from "../../src/domain/project/config.ts";
import type { ProjectFile } from "../../src/generators/project.ts";
import { AGENT_HOSTS } from "../../src/plugins/builtin/agents/hosts.ts";
import { ENVIRONMENTS } from "../../src/plugins/contracts/project-plugin.ts";
import {
  FRONTENDS,
  GOVERNANCE,
  INFRASTRUCTURE,
  NO_FRONTEND,
  NO_INFRASTRUCTURE,
  NO_PATTERN,
  PATTERNS,
  resolveSelection,
  SelectionError,
  STACKS,
  WORKFLOWS,
} from "../../src/plugins/registry.ts";

export interface Combination {
  /** Stable and readable, such as "node-fastify+vue openspec claude,codex team-gitflow". */
  readonly id: string;
  readonly config: ProjectConfig;
}

/** Every subset of the items, in their order, smallest first. */
function subsets<T>(items: readonly T[]): T[][] {
  const all: T[][] = [[]];
  for (const item of items) for (const subset of [...all]) all.push([...subset, item]);
  return all.sort((a, b) => a.length - b.length);
}

export function combinations(): Combination[] {
  const agentSets = subsets(Object.keys(AGENT_HOSTS));
  const result: Combination[] = [];
  for (const [stack, plugin] of Object.entries(STACKS)) {
    const patterns = plugin.workload === "genai" ? Object.keys(PATTERNS) : [NO_PATTERN];
    for (const pattern of patterns)
      for (const frontend of [NO_FRONTEND, ...Object.keys(FRONTENDS)])
        for (const infrastructure of [NO_INFRASTRUCTURE, ...Object.keys(INFRASTRUCTURE)])
          for (const workflow of Object.keys(WORKFLOWS))
            for (const agents of agentSets)
              for (const governance of Object.keys(GOVERNANCE)) {
                const components = [
                  stack,
                  ...(pattern === NO_PATTERN ? [] : [pattern]),
                  ...(frontend === NO_FRONTEND ? [] : [frontend]),
                  ...(infrastructure === NO_INFRASTRUCTURE ? [] : [infrastructure]),
                ];
                result.push({
                  id: [
                    components.join("+"),
                    workflow,
                    agents.length === 0 ? "no-agents" : agents.join(","),
                    governance,
                  ].join(" "),
                  config: validateConfig({
                    schema: CONFIG_SCHEMA,
                    name: "demo",
                    workload: plugin.workload,
                    stack,
                    pattern,
                    frontend,
                    infrastructure,
                    environments: infrastructure === NO_INFRASTRUCTURE ? [] : [...ENVIRONMENTS],
                    workflow,
                    agents,
                    governance,
                    review: { ai: agents.length > 0 },
                  }),
                });
              }
  }
  return result;
}

/** Why the registry refuses a combination, or undefined if it supports it. */
export function unsupportedReason(combination: Combination): string | undefined {
  try {
    resolveSelection(combination.config);
    return undefined;
  } catch (error) {
    if (error instanceof SelectionError) return error.message;
    throw error;
  }
}

/** The release's assets, each read from disk once however many projects use it. */
export function cachedAssets(root = path.resolve(import.meta.dirname, "../..")): AssetPort {
  const assets = new PackageAssets(path.join(root, "assets"), path.join(root, ".github/liftoff"));
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!memo.has(key)) memo.set(key, load());
    return memo.get(key) as Promise<T>;
  };
  return {
    list: (directory) => once(`list:${directory}`, () => assets.list(directory)),
    listTree: (directory) => once(`tree:${directory}`, () => assets.listTree(directory)),
    readText: (file) => once(`read:${file}`, () => assets.readText(file)),
    ciBundles: () => once("bundles", () => assets.ciBundles()),
  };
}

/** The files of one supported combination, generated in memory. */
export async function generateCombination(
  assets: AssetPort,
  combination: Combination,
): Promise<readonly ProjectFile[]> {
  return (await generate(assets, combination.config, "0.0.0")).files;
}
