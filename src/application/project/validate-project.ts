import path from "node:path";
import { JournalError } from "../../domain/change/journal.ts";
import type { LegacyInventory } from "../../domain/legacy/inventory.ts";
import { CHANGE_JOURNAL_FILE } from "../../domain/plan/change-plan.ts";
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
import {
  CHANGE_COMMANDS,
  readJournal,
  UNREADABLE_JOURNAL_ADVICE,
} from "../change/apply-changes.ts";
import type { ProjectFsPort } from "../ports.ts";
import { inventoryLegacy } from "./legacy-inventory.ts";

export type Severity = "error" | "warning" | "info";

/** The most of liftoff.yaml or the manifest read; neither comes near it. */
const MAX_RECORD_BYTES = 1024 * 1024;
/** The largest file Liftoff creates that is hashed; none comes near it. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

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
 * Checks a project against its own configuration and manifest. It reads only,
 * and follows no link to a file or on the way to one: nothing is repaired,
 * installed or reported anywhere.
 */
export async function validateProject(
  fs: ProjectFsPort,
  directory: string,
): Promise<ValidationResult> {
  const findings: Finding[] = [];
  /**
   * liftoff.yaml or the manifest: its text, undefined when it is missing,
   * or null once a finding says why it cannot be read.
   */
  const record = async (relative: string, name: string): Promise<string | undefined | null> => {
    const found = await fs.readWithin(directory, relative, MAX_RECORD_BYTES);
    if (found.kind === "missing") return undefined;
    if (found.kind === "file" && found.text !== undefined) return found.text;
    findings.push(
      found.kind === "inaccessible"
        ? {
            severity: "error",
            code: `${name}-unreadable`,
            path: relative,
            message: `${relative} cannot be read by this user`,
          }
        : {
            severity: "error",
            code: `${name}-not-a-file`,
            path: relative,
            message:
              found.kind === "file"
                ? `${relative} is over ${MAX_RECORD_BYTES / 1024 / 1024} MiB, so it was not read`
                : `${relative} is not a regular file Liftoff can read: it is a directory, a link or another kind of file, or it changed as it was read`,
          },
    );
    return null;
  };
  const result = (extra: Partial<ValidationResult> = {}): ValidationResult => ({
    directory,
    valid: !findings.some((finding) => finding.severity === "error"),
    findings,
    ...extra,
  });

  // A change that stopped part way, such as an adoption before liftoff.yaml
  // was written, may explain other findings, so it is reported first and the
  // checks go on.
  try {
    const journal = await readJournal(fs, directory);
    if (journal !== undefined) {
      findings.push({
        severity: "error",
        code: "interrupted-change",
        path: CHANGE_JOURNAL_FILE,
        message: `a change by ${CHANGE_COMMANDS[journal.operation]} that began ${journal.started} has not finished; unless it is still running, finish or undo it with ${CHANGE_COMMANDS[journal.operation]} --recover before anything else changes the project`,
      });
    }
  } catch (error) {
    if (!(error instanceof JournalError)) throw error;
    findings.push({
      severity: "error",
      code: "interrupted-change",
      path: CHANGE_JOURNAL_FILE,
      message: `a change stopped part way, but its journal cannot be read: ${error.message}; ${UNREADABLE_JOURNAL_ADVICE}`,
    });
  }

  const configText = await record(CONFIG_FILE, "config");
  if (configText === null) return result();
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

  // A part bound to a directory that is not there, or reached through a link.
  for (const [component, bound] of Object.entries(config.layout)) {
    if (bound === undefined || bound === ".") continue;
    const parts = bound.split("/");
    let real = true;
    for (let depth = 1; depth <= parts.length && real; depth++) {
      const entry = await fs.entry(path.join(directory, ...parts.slice(0, depth)));
      real = entry.kind === "directory";
    }
    if (!real) {
      findings.push({
        severity: "warning",
        code: "layout-directory-missing",
        path: CONFIG_FILE,
        message: `layout: ${component} is bound to ${bound}, which is not a directory here, or is reached through a link`,
      });
    }
  }

  const manifestText = await record(MANIFEST_FILE, "manifest");
  if (manifestText === null) return result({ config });
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
    const found = await fs.hashWithin(directory, file.path, MAX_FILE_BYTES);
    if (found.kind === "directory" || found.kind === "other") {
      findings.push({
        severity: "error",
        code: "not-a-file",
        path: file.path,
        message: `this should be a file Liftoff created, but it is ${found.kind === "directory" ? "a directory" : "a link or another kind of file, or it is reached through one"}`,
      });
    } else if (found.kind === "inaccessible") {
      findings.push({
        severity: "warning",
        code: "file-unreadable",
        path: file.path,
        message: "a file Liftoff created cannot be read by this user, so it was not checked",
      });
    } else if (found.kind === "missing") {
      findings.push({
        severity: file.ownership === "managed" ? "error" : "warning",
        code: file.ownership === "managed" ? "managed-file-missing" : "seeded-file-missing",
        path: file.path,
        message:
          file.ownership === "managed"
            ? "a file Liftoff manages is missing; liftoff repair can put it back"
            : "a file Liftoff created is gone; that is fine if you removed it on purpose, and liftoff repair can put it back if not",
      });
    } else if (
      found.kind === "file" &&
      file.ownership === "managed" &&
      found.sha256 !== file.sha256
    ) {
      // A file over the limit is not hashed, and no file Liftoff writes is that large.
      findings.push({
        severity: "warning",
        code: "managed-file-changed",
        path: file.path,
        message:
          "a file Liftoff manages was changed by hand; liftoff update leaves it as it is, so it takes no update until it is restored, which liftoff repair can do",
      });
    }
  }
  return result({ config, manifest });
}
