import path from "node:path";
import type { LegacyInventory } from "../../domain/legacy/inventory.ts";
import { sha256Hex } from "../../domain/plan/plan.ts";
import {
  CONFIG_FILE,
  ConfigError,
  type ProjectConfig,
  parseConfig,
} from "../../domain/project/config.ts";
import {
  MANIFEST_FILE,
  type Manifest,
  ManifestError,
  parseManifest,
} from "../../domain/project/manifest.ts";
import { allPlugins, resolveSelection, SelectionError } from "../../plugins/registry.ts";
import type { ProjectFsPort } from "../ports.ts";
import { inventoryLegacy } from "./legacy-inventory.ts";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ValidationResult {
  readonly directory: string;
  readonly valid: boolean;
  readonly config?: ProjectConfig;
  readonly manifest?: Manifest;
  /** What a Liftoff release before the rebuild left, when there is no liftoff.yaml. */
  readonly legacy?: LegacyInventory;
  readonly findings: readonly Finding[];
}

/**
 * Checks a project against its own configuration and manifest. It reads only:
 * nothing is repaired, installed or reported anywhere.
 */
export async function validateProject(
  fs: ProjectFsPort,
  directory: string,
): Promise<ValidationResult> {
  const findings: Finding[] = [];
  const read = (relative: string) => fs.readText(path.join(directory, ...relative.split("/")));
  const result = (extra: Partial<ValidationResult> = {}): ValidationResult => ({
    directory,
    valid: !findings.some((finding) => finding.severity === "error"),
    findings,
    ...extra,
  });

  const configText = await read(CONFIG_FILE);
  if (configText === undefined) {
    const legacy = await inventoryLegacy(fs, directory);
    if (legacy.project) {
      const marker = legacy.records[0];
      findings.push({
        severity: "error",
        code: "pre-rebuild-project",
        ...(marker ? { path: marker.path } : {}),
        message:
          "this was made by a Liftoff release before the rebuild; this release changes and runs nothing in it. Adopting existing projects comes in a later release.",
      });
      for (const record of legacy.records) {
        findings.push({
          severity: record.blocks ? "error" : record.state === "unsupported" ? "warning" : "info",
          code: `legacy-${record.state}`,
          path: record.path,
          message: `${record.state}: ${record.blocks ?? record.reason}${record.format ? ` [${record.format}${record.release ? ` from ${record.release}` : ""}]` : ""}`,
        });
      }
      return result({ legacy });
    }
    findings.push({
      severity: "error",
      code: "not-a-liftoff-project",
      message: `no ${CONFIG_FILE} here`,
    });
    return result();
  }

  let config: ProjectConfig;
  try {
    config = parseConfig(configText);
    resolveSelection(config);
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof SelectionError)) throw error;
    findings.push({
      severity: "error",
      code: "invalid-config",
      path: CONFIG_FILE,
      message: error.message,
    });
    return result();
  }

  const manifestText = await read(MANIFEST_FILE);
  if (manifestText === undefined) {
    findings.push({
      severity: "error",
      code: "missing-manifest",
      path: MANIFEST_FILE,
      message: `${MANIFEST_FILE} is missing`,
    });
    return result({ config });
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(manifestText);
  } catch (error) {
    if (!(error instanceof ManifestError)) throw error;
    findings.push({
      severity: "error",
      code: "invalid-manifest",
      path: MANIFEST_FILE,
      message: error.message,
    });
    return result({ config });
  }

  const known = new Map(allPlugins().map((plugin) => [plugin.id, plugin.version]));
  for (const plugin of manifest.plugins) {
    const current = known.get(plugin.id);
    if (current === undefined) {
      findings.push({
        severity: "error",
        code: "unknown-plugin",
        message: `${plugin.id} is not part of this Liftoff release`,
      });
    } else if (current !== plugin.version) {
      findings.push({
        severity: "info",
        code: "plugin-version",
        message: `${plugin.id} was generated at version ${plugin.version}; this release has version ${current}`,
      });
    }
  }

  for (const file of manifest.files) {
    // Framework files belong to the framework, which may change or remove them.
    if (file.ownership === "framework") continue;
    const state = await fs.state(path.join(directory, ...file.path.split("/")));
    if (state === "directory" || state === "empty-directory") {
      findings.push({
        severity: "error",
        code: "not-a-file",
        path: file.path,
        message: "this should be a file Liftoff created, but it is a directory",
      });
      continue;
    }
    const text = await read(file.path);
    if (text === undefined) {
      findings.push({
        severity: file.ownership === "managed" ? "error" : "warning",
        code: file.ownership === "managed" ? "managed-file-missing" : "seeded-file-missing",
        path: file.path,
        message:
          file.ownership === "managed"
            ? "a file Liftoff manages is missing"
            : "a file Liftoff created is gone; that is fine if you removed it on purpose",
      });
    } else if (file.ownership === "managed" && sha256Hex(text) !== file.sha256) {
      findings.push({
        severity: "warning",
        code: "managed-file-changed",
        path: file.path,
        message: "a file Liftoff manages was changed by hand; Liftoff would replace this change",
      });
    }
  }
  return result({ config, manifest });
}
