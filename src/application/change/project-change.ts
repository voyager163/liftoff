import { JournalError } from "../../domain/change/journal.ts";
import {
  type ChangeOperation,
  type ChangePlan,
  type FileChange,
  sealChangePlan,
} from "../../domain/plan/change-plan.ts";
import { PLAN_SCHEMA, sha256Hex } from "../../domain/plan/plan.ts";
import {
  CONFIG_FILE,
  ConfigError,
  isStandardLayout,
  type ProjectConfig,
  parseConfig,
} from "../../domain/project/config.ts";
import {
  MANIFEST_FILE,
  type Manifest,
  ManifestError,
  parseManifest,
  serializeManifest,
} from "../../domain/project/manifest.ts";
import { pathKey } from "../../domain/project/paths.ts";
import type { ProjectFile } from "../../generators/project.ts";
import type { Selection } from "../../plugins/registry.ts";
import { generate } from "../init/generation.ts";
import type { AssetPort, ProjectFsPort } from "../ports.ts";
import { inventoryLegacy } from "../project/legacy-inventory.ts";
import {
  CHANGE_COMMANDS,
  type NewContent,
  readJournal,
  UNREADABLE_JOURNAL_ADVICE,
  type Unchanged,
} from "./apply-changes.ts";

/** The most of liftoff.yaml or the manifest read, or written; neither comes near it. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/** The most entries read from one directory when finding a file's name on disk. */
const MAX_LISTED = 10_000;

/** A change to an existing project was refused; nothing was changed. */
export class ProjectChangeError extends Error {
  override readonly name: string = "ProjectChangeError";
}

/** A project this release cannot change, such as one from before the rebuild. */
export class ProjectChangeUnsupportedError extends ProjectChangeError {
  override readonly name = "ProjectChangeUnsupportedError";
}

/** liftoff.yaml and the manifest as a change found them. */
export interface ProjectRecords {
  readonly directory: string;
  readonly config: ProjectConfig;
  readonly configText: string;
  readonly manifest: Manifest;
  readonly manifestText: string;
}

/** liftoff.yaml and the manifest, which a change records itself in rather than changes as other files. */
export const RECORDS: ReadonlySet<string> = new Set([pathKey(CONFIG_FILE), pathKey(MANIFEST_FILE)]);

/**
 * Reads a Liftoff project's configuration and manifest for a change, and
 * refuses, changing nothing, a directory that is not one, a project with a
 * change that has not finished, or records that are missing or invalid.
 */
export async function readProject(
  fs: ProjectFsPort,
  directory: string,
  operation: ChangeOperation,
): Promise<ProjectRecords> {
  if ((await fs.directoryIdentity(directory)) === undefined) {
    throw new ProjectChangeError(`${directory} is not a directory Liftoff can change`);
  }
  await refuseUnfinishedChange(fs, directory);
  const configText = await readRecord(fs, directory, CONFIG_FILE);
  if (configText === undefined) {
    if ((await inventoryLegacy(fs, directory)).project) {
      throw new ProjectChangeUnsupportedError(
        `this project was made by a Liftoff release before the rebuild; this release changes it only once it is adopted with liftoff adopt`,
      );
    }
    throw new ProjectChangeError(
      `there is no ${CONFIG_FILE} in ${directory}; ${operation} changes only projects Liftoff made`,
    );
  }
  const manifestText = await readRecord(fs, directory, MANIFEST_FILE);
  if (manifestText === undefined) {
    throw new ProjectChangeError(
      `${MANIFEST_FILE} is missing, so Liftoff cannot tell which files it manages`,
    );
  }
  try {
    return {
      directory,
      config: parseConfig(configText),
      configText,
      manifest: parseManifest(manifestText),
      manifestText,
    };
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof ManifestError)) throw error;
    throw new ProjectChangeError(`${error.message}; liftoff validate says more`);
  }
}

export interface Generated {
  readonly selection: Selection;
  /** This release's files other than liftoff.yaml and the manifest, by pathKey. */
  readonly files: ReadonlyMap<string, ProjectFile>;
  /** liftoff.yaml as the files were generated from it, which must not change before they apply. */
  readonly config: Unchanged;
}

/** Whether Liftoff adopted the project with an application of its own, rather than made it. */
export const isAdopted = (manifest: Manifest): boolean =>
  manifest.history[0]?.operation === "adopt";

/**
 * Generates what this release makes for the configuration the project was
 * made with: for an adopted project, only Liftoff's own files, where its
 * parts live. It refuses a liftoff.yaml changed since Liftoff wrote it, a
 * project it made in another layout, and a configuration this release
 * would make from other plugins, so a change never switches what the
 * project is made of.
 */
export async function generateFor(
  assets: AssetPort,
  project: ProjectRecords,
  liftoffVersion: string,
  operation: ChangeOperation,
): Promise<Generated> {
  const { config, configText, manifest } = project;
  const written = manifest.files.find((file) => file.path === CONFIG_FILE);
  if (written?.sha256 !== sha256Hex(configText)) {
    throw new ProjectChangeError(
      `${CONFIG_FILE} changed since Liftoff last wrote it, and ${operation} never applies a changed configuration; put it back as it was to ${operation}`,
    );
  }
  // A project Liftoff made has an application in the standard layout.
  const application = !isAdopted(manifest);
  if (application && !isStandardLayout(config)) {
    throw new ProjectChangeUnsupportedError(
      `this release can ${operation} a project it made only in the standard layout, but liftoff.yaml binds parts to other directories`,
    );
  }
  const { selection, files } = await generate(assets, config, liftoffVersion, { application });
  const made = new Set(manifest.plugins.map((plugin) => plugin.id));
  const making = new Set(selection.plugins.map((plugin) => plugin.id));
  const switched = [
    ...[...making].filter((id) => !made.has(id)).map((id) => `adds ${id}`),
    ...[...made].filter((id) => !making.has(id)).map((id) => `drops ${id}`),
  ];
  if (switched.length > 0) {
    throw new ProjectChangeError(
      `this release would make the project from other plugins (it ${switched.sort().join(", ")}), and ${operation} never switches the workflow, governance profile, stack, pattern, agents or any other plugin`,
    );
  }
  return {
    selection,
    // By name as macOS and Windows compare names, ignoring case.
    files: new Map(
      files
        .filter((file) => !RECORDS.has(pathKey(file.path)))
        .map((file) => [pathKey(file.path), file]),
    ),
    config: { path: CONFIG_FILE, sha256: sha256Hex(configText) },
  };
}

/**
 * Seals a change to a project, with the manifest changed last, the
 * operation added to its history, and the files it rests on without
 * changing them. The manifest must stay within what Liftoff reads.
 */
export function sealProjectChange(
  project: ProjectRecords,
  operation: ChangeOperation,
  liftoffVersion: string,
  changes: readonly FileChange[],
  contents: ReadonlyMap<string, NewContent>,
  manifest: Omit<Manifest, "history">,
  unchanged: readonly Unchanged[] = [],
): { readonly plan: ChangePlan; readonly contents: ReadonlyMap<string, NewContent> } {
  const updated = serializeManifest({
    ...manifest,
    history: [...project.manifest.history, { operation, liftoff: liftoffVersion }],
  });
  // Never a manifest Liftoff would then refuse to read.
  if (Buffer.byteLength(updated) > MAX_RECORD_BYTES) {
    throw new ProjectChangeError(
      `${MANIFEST_FILE} would be over ${MAX_RECORD_BYTES / 1024 / 1024} MiB after this ${operation}, more than Liftoff reads, so nothing was changed`,
    );
  }
  const plan = sealChangePlan({
    schema: PLAN_SCHEMA,
    operation,
    liftoff: liftoffVersion,
    target: project.directory,
    config: { ...project.config },
    effects: ["modify-files"],
    changes: [
      ...changes,
      {
        path: MANIFEST_FILE,
        before: sha256Hex(project.manifestText),
        after: sha256Hex(updated),
        ownership: "managed",
        executable: false,
      },
    ],
    unchanged,
  });
  return {
    plan,
    contents: new Map([...contents, [MANIFEST_FILE, { content: updated, executable: false }]]),
  };
}

/**
 * A file's path as its directories name it, in the letter case they use, or
 * undefined when it is not there, cannot be listed, or more than one name
 * matches it.
 */
export async function nameOnDisk(
  fs: ProjectFsPort,
  directory: string,
  relative: string,
): Promise<string | undefined> {
  const named: string[] = [];
  for (const part of relative.split("/")) {
    const listing = await fs.listWithin(directory, named.join("/") || ".", MAX_LISTED);
    if (listing.kind !== "directory") return undefined;
    const matching = listing.entries.filter((entry) => pathKey(entry.name) === pathKey(part));
    if (matching.length !== 1) return undefined;
    named.push(matching[0]?.name ?? part);
  }
  return named.join("/");
}

/** A change cannot begin while another has not finished. */
export async function refuseUnfinishedChange(fs: ProjectFsPort, directory: string): Promise<void> {
  let journal: Awaited<ReturnType<typeof readJournal>>;
  try {
    journal = await readJournal(fs, directory);
  } catch (error) {
    if (!(error instanceof JournalError)) throw error;
    throw new ProjectChangeError(
      `a change stopped part way, but its journal cannot be read: ${error.message}; ${UNREADABLE_JOURNAL_ADVICE}`,
    );
  }
  if (journal !== undefined) {
    const command = CHANGE_COMMANDS[journal.operation];
    throw new ProjectChangeError(
      `a change by ${command} that began ${journal.started} has not finished; unless it is still running, finish or undo it with ${command} --recover first`,
    );
  }
}

/** liftoff.yaml or the manifest, or undefined when it is missing. */
async function readRecord(
  fs: ProjectFsPort,
  directory: string,
  relative: string,
): Promise<string | undefined> {
  const found = await fs.readWithin(directory, relative, MAX_RECORD_BYTES);
  if (found.kind === "missing") return undefined;
  if (found.kind === "file" && found.text !== undefined) return found.text;
  throw new ProjectChangeError(
    found.kind === "inaccessible"
      ? `${relative} cannot be read by this user`
      : `${relative} is not a regular file of at most 1 MiB that Liftoff can read: it is a directory, a link or another kind of file, or it changed as it was read`,
  );
}
