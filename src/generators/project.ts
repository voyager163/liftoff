import { sha256Hex } from "../domain/plan/plan.ts";
import { CONFIG_FILE, serializeConfig } from "../domain/project/config.ts";
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  type Ownership,
  serializeManifest,
} from "../domain/project/manifest.ts";
import type { GenerationContext, PluginKind } from "../plugins/contracts/project-plugin.ts";
import type { Selection } from "../plugins/registry.ts";

export interface ProjectFile {
  readonly path: string;
  readonly ownership: Ownership;
  readonly content: string;
  readonly sha256: string;
  /** Plugin that produced it, recorded as provenance. */
  readonly plugin: string;
}

/** Whether a generated file needs the executable bit. */
export const isExecutable = (path: string): boolean => path.endsWith(".sh");

/** Every file of a generated project, sorted by path. */
export type GeneratedProject = readonly ProjectFile[];

export class GenerationError extends Error {
  override readonly name = "GenerationError";
}

const RESERVED = new Set([CONFIG_FILE, MANIFEST_FILE]);

/** Plugins whose every file belongs to the application. */
const PARTS: ReadonlySet<PluginKind> = new Set(["stack", "pattern", "frontend", "infrastructure"]);

function checkPath(path: string, plugin: string): void {
  const parts = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-zA-Z]:/.test(path) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GenerationError(`${plugin} produced an unsafe path "${path}"`);
  }
  if (RESERVED.has(path)) throw new GenerationError(`${plugin} may not write ${path}`);
}

/**
 * Every file a new project gets, sorted by path: each plugin's files, the
 * project configuration and the manifest that inventories them. Two plugins
 * writing the same path is an error, never a silent overwrite. Without the
 * application (`context.application`), only Liftoff's own files are made.
 */
export function generateProject(selection: Selection, context: GenerationContext): ProjectFile[] {
  const byPath = new Map<string, ProjectFile>();
  const add = (file: Omit<ProjectFile, "sha256">) => {
    checkPath(file.path, file.plugin);
    const existing = byPath.get(file.path);
    if (existing) {
      throw new GenerationError(`${file.plugin} and ${existing.plugin} both write ${file.path}`);
    }
    byPath.set(file.path, { ...file, sha256: sha256Hex(file.content) });
  };

  for (const plugin of selection.plugins) {
    if (!context.application && PARTS.has(plugin.kind)) continue;
    for (const { application, ...artifact } of plugin.artifacts(context)) {
      if (context.application || application !== true) add({ ...artifact, plugin: plugin.id });
    }
  }

  const configText = serializeConfig(context.config);
  const config: ProjectFile = {
    path: CONFIG_FILE,
    ownership: "seeded",
    content: configText,
    sha256: sha256Hex(configText),
    plugin: "liftoff/config",
  };
  const inventoried = [...byPath.values(), config].sort((a, b) => a.path.localeCompare(b.path));
  const manifestText = serializeManifest({
    schema: MANIFEST_SCHEMA,
    generatedBy: { liftoff: context.liftoffVersion },
    history: [{ operation: "init", liftoff: context.liftoffVersion }],
    plugins: selection.plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
    files: inventoried.map(({ path, ownership, sha256, plugin }) => ({
      path,
      ownership,
      sha256,
      plugin,
    })),
  });
  const manifest: ProjectFile = {
    path: MANIFEST_FILE,
    ownership: "managed",
    content: manifestText,
    sha256: sha256Hex(manifestText),
    plugin: "liftoff/manifest",
  };
  return [...inventoried, manifest].sort((a, b) => a.path.localeCompare(b.path));
}
