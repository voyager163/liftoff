import type { ProjectConfig } from "../../domain/project/config.ts";
import { type GeneratedProject, generateProject } from "../../generators/project.ts";
import type { GenerationContext, TemplateSet } from "../../plugins/contracts/project-plugin.ts";
import { resolveSelection, type Selection } from "../../plugins/registry.ts";
import { loadAgentSources } from "../agents/agent-files.ts";
import type { AssetPort } from "../ports.ts";

/** Loads every asset the selected plugins need, so generation itself does no I/O. */
async function loadTemplates(assets: AssetPort, selection: Selection): Promise<TemplateSet> {
  const texts = new Map<string, string>();
  for (const plugin of selection.plugins) {
    for (const root of plugin.templateRoots) {
      for (const file of await assets.listTree(root)) texts.set(file, await assets.readText(file));
    }
  }
  return {
    read(path) {
      const text = texts.get(path);
      if (text === undefined) throw new Error(`this release does not ship ${path}`);
      return text;
    },
    list(directory) {
      const prefix = `${directory.replace(/\/+$/, "")}/`;
      return [...texts.keys()].filter((path) => path.startsWith(prefix)).sort();
    },
  };
}

export interface Generation {
  readonly selection: Selection;
  readonly files: GeneratedProject;
}

/** Checks the selection and generates every file of the project, in memory. */
export async function generate(
  assets: AssetPort,
  config: ProjectConfig,
  liftoffVersion: string,
): Promise<Generation> {
  const selection = resolveSelection(config);
  const sources = await loadAgentSources(assets, { projectSkills: true });
  const context: GenerationContext = {
    config,
    liftoffVersion,
    hosts: selection.hosts,
    profile: selection.profile,
    stack: selection.stack,
    templates: await loadTemplates(assets, selection),
    skills: sources.skills,
    agents: sources.agents,
    ciBundles: await assets.ciBundles(),
  };
  return { selection, files: generateProject(selection, context) };
}
