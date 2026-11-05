import { COMPONENTS, type Directories } from "../../domain/project/config.ts";
import type { Ownership } from "../../domain/project/manifest.ts";
import { renderTemplate } from "../../generators/template.ts";
import type { Artifact, TemplateSet } from "../contracts/project-plugin.ts";

/**
 * Every file under an asset directory, rendered with the given values, at
 * the same relative path in the project.
 */
export function filesFrom(
  templates: TemplateSet,
  root: string,
  values: Readonly<Record<string, string>>,
  ownership: Ownership,
  rename: (path: string) => string = (path) => path,
): Artifact[] {
  return templates.list(root).map((asset) => ({
    path: rename(asset.slice(root.length + 1)),
    ownership,
    content: renderTemplate(templates.read(asset), values, asset),
  }));
}

/**
 * Template values for where each part lives, for files that refer to it:
 * `{{liftoff.backendDirectory}}` is the backend's directory ("." for the
 * repository root), `{{liftoff.backendPrefix}}` goes before a path in it
 * ("" for the root), and `{{liftoff.backendFromRoot}}` is the directory as
 * Dependabot names it ("/" for the root). The frontend and the
 * infrastructure have the same three.
 */
export function layoutValues(layout: Directories): Record<string, string> {
  return Object.fromEntries(
    COMPONENTS.flatMap((component) => {
      const directory = layout[component];
      const root = directory === ".";
      return [
        [`${component}Directory`, directory],
        [`${component}Prefix`, root ? "" : `${directory}/`],
        [`${component}FromRoot`, root ? "/" : `/${directory}`],
      ];
    }),
  );
}
