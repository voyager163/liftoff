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
