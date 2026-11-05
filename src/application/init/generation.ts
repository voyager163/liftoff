import {
  ConfigError,
  directoriesOf,
  isStandardLayout,
  type ProjectConfig,
} from "../../domain/project/config.ts";
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

export interface GenerateOptions {
  /**
   * Whether to generate the application's files too, as for a new project:
   * each part's starter code, Compose, .env.example and the README. Without
   * them, only Liftoff's own files are generated, for where the parts live,
   * as for a project adopted with an application of its own. Defaults to true.
   */
  readonly application?: boolean;
}

/** Checks the selection and generates every file of the project, in memory. */
export async function generate(
  assets: AssetPort,
  config: ProjectConfig,
  liftoffVersion: string,
  { application = true }: GenerateOptions = {},
): Promise<Generation> {
  // A starter is made only in the standard layout, never the standard
  // directories in place of the bound ones.
  if (application && !isStandardLayout(config)) {
    throw new ConfigError(
      "this release generates an application's files only in the standard layout; for a project whose parts live elsewhere, it generates only its own files",
    );
  }
  const selection = resolveSelection(config);
  const sources = await loadAgentSources(assets, { projectSkills: true });
  const context: GenerationContext = {
    config,
    liftoffVersion,
    layout: directoriesOf(config),
    application,
    hosts: selection.hosts,
    profile: selection.profile,
    workflow: selection.workflow,
    stack: selection.stack,
    pattern: selection.pattern,
    frontend: selection.frontend,
    infrastructure: selection.infrastructure,
    environments: selection.environments,
    components: selection.components,
    templates: await loadTemplates(assets, selection),
    skills: sources.skills,
    agents: sources.agents,
    ciBundles: await assets.ciBundles(),
  };
  return { selection, files: generateProject(selection, context) };
}
