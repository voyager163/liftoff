import type { FileChange } from "../../domain/plan/change-plan.ts";
import { sha256Hex } from "../../domain/plan/plan.ts";
import {
  CONFIG_FILE,
  ConfigError,
  isStandardLayout,
  type ProjectConfig,
  validateConfig,
} from "../../domain/project/config.ts";
import type { Manifest, ManifestFile } from "../../domain/project/manifest.ts";
import { pathKey } from "../../domain/project/paths.ts";
import { isExecutable, type ProjectFile } from "../../generators/project.ts";
import { resolveSelection, SelectionError } from "../../plugins/registry.ts";
import { type Generation, generate } from "../init/generation.ts";
import type { AssetPort, ProjectFsPort } from "../ports.ts";
import { MAX_CHANGED_BYTES, type NewContent } from "./apply-changes.ts";
import {
  isAdopted,
  ProjectChangeError,
  ProjectChangeUnsupportedError,
  type ProjectRecords,
  RECORDS,
  readProject,
} from "./project-change.ts";

/**
 * What a transition does with one of Liftoff's files:
 * - change: as Liftoff last wrote it, so it is rewritten for the new choice;
 * - add: one the new choice has that the project does not, added;
 * - remove: one only the old choice had, as Liftoff last wrote it, removed;
 * - left: one the new choice writes differently, left as it is, with why.
 */
export interface TransitionFile {
  readonly path: string;
  readonly step: "change" | "add" | "remove" | "left";
  readonly reason?: string;
}

/** A choice this project cannot take, such as a workflow its agents rule out. */
export class TransitionOptionError extends ProjectChangeError {
  override readonly name = "TransitionOptionError";
}

/** Switching one choice of a project, planned: what changes, and the manifest it leaves. */
export interface Transition {
  readonly project: ProjectRecords;
  /** The configuration once switched. */
  readonly config: ProjectConfig;
  /** What this release makes for the new configuration. */
  readonly generated: Generation;
  readonly files: readonly TransitionFile[];
  readonly changes: readonly FileChange[];
  readonly contents: ReadonlyMap<string, NewContent>;
  /** The manifest once switched, without its history, which sealing adds to. */
  readonly manifest: Omit<Manifest, "history">;
  /** Files of a framework the switch leaves, which stay as the project's own. */
  readonly released: readonly string[];
}

/**
 * Plans switching one choice of a Liftoff project, such as its workflow or
 * governance profile: `choice` names it, and `edit` makes the new
 * configuration from the old. It only reads. It refuses a liftoff.yaml
 * changed since Liftoff wrote it, whatever is asked, so a choice typed in by
 * hand is never taken for one switched to; it returns undefined when the
 * project already has what is asked.
 *
 * liftoff.yaml and the manifest are rewritten. Each other file this release
 * writes differently for the new configuration is changed or removed only
 * while as Liftoff last wrote it, and added only where nothing is; one
 * removed since is recorded as the new configuration writes it, so liftoff
 * repair can put it back; anything else is left and named. A file the
 * manifest lists as kept is never written. Files of a framework the new
 * configuration no longer has stay byte for byte, and the manifest no
 * longer lists them.
 */
export async function planTransition(
  ports: { readonly assets: AssetPort; readonly fs: ProjectFsPort },
  directory: string,
  liftoffVersion: string,
  operation: "workflow-set" | "profile-set",
  choice: {
    /** How the choice is named in text, such as "governance profile". */
    readonly name: string;
    /** The field of liftoff.yaml that holds it. */
    readonly field: "workflow" | "governance";
    readonly to: string;
  },
): Promise<Transition | undefined> {
  const { fs } = ports;
  const project = await readProject(fs, directory, operation);
  const { config, configText, manifest } = project;
  const written = manifest.files.find((file) => file.path === CONFIG_FILE);
  if (written?.sha256 !== sha256Hex(configText)) {
    throw new ProjectChangeError(
      `${CONFIG_FILE} changed since Liftoff last wrote it, and the ${choice.name} is switched only from a configuration Liftoff wrote; put it back as it was first`,
    );
  }
  const from = config[choice.field];
  if (from === choice.to) return undefined;
  let next: ProjectConfig;
  try {
    next = validateConfig({ ...config, [choice.field]: choice.to }, `the new ${choice.name}`);
    resolveSelection(next);
  } catch (error) {
    if (!(error instanceof ConfigError || error instanceof SelectionError)) throw error;
    throw new TransitionOptionError(error.message);
  }
  const application = !isAdopted(manifest);
  if (application && !isStandardLayout(config)) {
    throw new ProjectChangeUnsupportedError(
      `this release switches the ${choice.name} of a project it made only in the standard layout, but liftoff.yaml binds parts to other directories`,
    );
  }
  const before = await generate(ports.assets, config, liftoffVersion, { application });
  const after = await generate(ports.assets, next, liftoffVersion, { application });
  const was = new Map(before.files.map((file) => [pathKey(file.path), file]));
  const now = new Map(after.files.map((file) => [pathKey(file.path), file]));
  const entries = new Map(manifest.files.map((entry) => [pathKey(entry.path), entry]));
  const kept = new Set(manifest.kept.map(pathKey));

  const files: TransitionFile[] = [];
  const keeping: string[] = [];
  const changes: FileChange[] = [];
  const contents = new Map<string, NewContent>();
  const recorded = new Map<string, ManifestFile>(
    manifest.files.map((entry) => [pathKey(entry.path), entry]),
  );
  const write = (file: ProjectFile, previous: string | null) => {
    const executable = isExecutable(file.path);
    changes.push({
      path: file.path,
      before: previous,
      after: file.sha256,
      ownership: file.ownership,
      executable,
    });
    contents.set(file.path, { content: file.content, executable });
    recorded.set(pathKey(file.path), {
      path: file.path,
      ownership: file.ownership,
      sha256: file.sha256,
      plugin: file.plugin,
    });
  };
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const old = was.get(key);
    const made = now.get(key);
    if (old?.sha256 === made?.sha256) continue;
    const relative = made?.path ?? old?.path ?? key;
    if (key === pathKey(CONFIG_FILE) && made !== undefined) {
      write(made, sha256Hex(configText));
      files.push({ path: relative, step: "change" });
      continue;
    }
    if (RECORDS.has(key)) continue;
    if (kept.has(key)) {
      files.push({
        path: relative,
        step: "left",
        reason: "the project's own, kept in place of Liftoff's",
      });
      continue;
    }
    const entry = entries.get(key);
    const disk = await fs.hashWithin(directory, relative, MAX_CHANGED_BYTES);
    const asWritten = entry !== undefined && disk.kind === "file" && disk.sha256 === entry.sha256;
    if (made !== undefined && entry === undefined && disk.kind === "missing") {
      write(made, null);
      files.push({ path: relative, step: "add" });
    } else if (made !== undefined && asWritten && entry.sha256 === made.sha256) {
      // Already as the new configuration has it, such as one put back by hand.
    } else if (made !== undefined && asWritten) {
      write(made, entry.sha256);
      files.push({ path: relative, step: "change" });
    } else if (made !== undefined && entry !== undefined && disk.kind === "missing") {
      // Recorded as the new configuration writes it, so liftoff repair can
      // put back that version, as for any file Liftoff wrote.
      recorded.set(key, { ...entry, sha256: made.sha256, plugin: made.plugin });
      files.push({
        path: relative,
        step: "left",
        reason: `removed since Liftoff wrote it; liftoff repair --restore ${relative} puts it back`,
      });
    } else if (made === undefined && asWritten) {
      changes.push({ path: relative, before: entry.sha256, after: null });
      recorded.delete(key);
      files.push({ path: relative, step: "remove" });
    } else if (made === undefined && entry !== undefined && disk.kind === "missing") {
      // Already gone, as the new configuration has it.
      recorded.delete(key);
    } else if (made === undefined && entry === undefined) {
      // Neither Liftoff's nor the new configuration's: nothing to do with it.
    } else {
      files.push({
        path: relative,
        step: "left",
        reason:
          entry === undefined
            ? "something is already there"
            : made === undefined
              ? `changed since Liftoff wrote it, and the new ${choice.name} has none; it stays the project's own`
              : `changed since Liftoff wrote it, so it still describes ${from}; bring it up to date by hand`,
      });
      // A file the new configuration no longer has, left in place, is the
      // project's now, kept, so a later switch back or update leaves it be.
      if (made === undefined) {
        recorded.delete(key);
        keeping.push(relative);
      }
    }
  }

  // A file the switch would remove that a file staying in the project
  // still names, such as a script a workflow runs, stays too, as the
  // project's own, so what stays keeps working: any file under .github that
  // is not removed, and any file left in place, and then, in turn, each file
  // kept that way.
  const removing = new Set(
    changes.filter((change) => change.after === null).map((change) => change.path),
  );
  if (removing.size > 0) {
    const users: { path: string; text: string }[] = [];
    // A file the switch rewrites is read as it will be, not as it is, by
    // the name macOS and Windows compare.
    const rewritten = new Map([...contents].map(([file, content]) => [pathKey(file), content]));
    const read = async (file: string) => {
      const written = rewritten.get(pathKey(file));
      if (written !== undefined) {
        users.push({ path: file, text: written.content });
        return;
      }
      const found = await fs.readWithin(directory, file, MAX_CHANGED_BYTES);
      if (found.kind !== "file" || found.text === undefined) {
        throw new ProjectChangeError(
          `${file} could not be read whole, so Liftoff cannot tell whether it uses a file the switch removes; nothing was changed`,
        );
      }
      users.push({ path: file, text: found.text });
    };
    const removed = (file: string) => [...removing].some((path) => pathKey(path) === pathKey(file));
    const staying = new Set([
      ...(await filesUnder(fs, directory, ".github")),
      ...files.filter((item) => item.step === "left").map((item) => item.path),
    ]);
    for (const file of [...staying].filter((item) => !removed(item)).sort()) await read(file);
    for (let found = true; found; ) {
      found = false;
      for (const path of [...removing].sort()) {
        const user = users.find((item) => item.text.includes(path));
        if (user === undefined) continue;
        removing.delete(path);
        found = true;
        changes.splice(
          changes.findIndex((change) => change.path === path),
          1,
        );
        keeping.push(path);
        files.splice(
          files.findIndex((item) => item.path === path),
          1,
          {
            path,
            step: "left",
            reason: `${user.path}, which stays, still uses it, so it stays the project's own`,
          },
        );
        await read(path);
      }
    }
  }

  // A plugin the new configuration no longer has gives up its files: a
  // framework's stay, as the project's own.
  const making = new Set(after.selection.plugins.map((plugin) => plugin.id));
  const released = manifest.files
    .filter((entry) => entry.ownership === "framework" && !making.has(entry.plugin))
    .map((entry) => entry.path)
    .sort();
  for (const file of released) recorded.delete(pathKey(file));
  const had = new Set(manifest.plugins.map((plugin) => plugin.id));
  const plugins = [
    ...manifest.plugins.filter((plugin) => making.has(plugin.id)),
    ...after.selection.plugins
      .filter((plugin) => !had.has(plugin.id))
      .map(({ id, version }) => ({ id, version })),
  ];
  const { history: _, ...rest } = manifest;
  return {
    project,
    config: next,
    generated: after,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    changes,
    contents,
    manifest: {
      ...rest,
      plugins,
      files: [...recorded.values()],
      kept: [...new Set([...manifest.kept, ...keeping])],
    },
    released,
  };
}

/** The most entries read from one directory, and the deepest, when looking for what stays. */
const MAX_LISTED = 10_000;
const MAX_DEPTH = 12;

/**
 * Every regular file under a directory of the project, reached through no
 * link. What it cannot see whole, a directory listed only in part, closed
 * to this user, changed meanwhile or deeper than the bound, refuses the
 * switch rather than being taken to use nothing.
 */
async function filesUnder(
  fs: ProjectFsPort,
  directory: string,
  relative: string,
): Promise<string[]> {
  const found: string[] = [];
  const unseen = (at: string, why: string) =>
    new ProjectChangeError(
      `${at} ${why}, so Liftoff cannot tell whether a file there uses one the switch removes; nothing was changed`,
    );
  const walk = async (at: string, depth: number) => {
    const listing = await fs.listWithin(directory, at, MAX_LISTED);
    if (listing.kind === "missing" && at === relative) return;
    if (listing.kind !== "directory") throw unseen(at, "could not be listed");
    if (!listing.complete) throw unseen(at, `has more than ${MAX_LISTED} entries`);
    for (const entry of listing.entries) {
      const child = `${at}/${entry.name}`;
      if (entry.kind === "file") found.push(child);
      else if (entry.kind === "directory") {
        if (depth >= MAX_DEPTH) throw unseen(child, `is deeper than ${MAX_DEPTH} directories`);
        await walk(child, depth + 1);
      }
    }
  };
  await walk(relative, 1);
  return found;
}
