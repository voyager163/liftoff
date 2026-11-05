import path from "node:path";
import {
  classifyLegacy,
  LEGACY_CANDIDATES,
  type LegacyInventory,
  type LegacyObservation,
  MAX_LEGACY_BYTES,
} from "../../domain/legacy/inventory.ts";
import { sha256Hex } from "../../domain/plan/plan.ts";
import type { ProjectFsPort } from "../ports.ts";

/**
 * Looks for what Liftoff releases before the rebuild left in a directory. It
 * only reads: it checks the old releases' own paths, never follows a link,
 * reads only small records that cannot hold copies of files, credentials or
 * state, and runs nothing. `read`, when given, is filled with the sha256 of
 * each record's text as it was read, by path.
 */
export async function inventoryLegacy(
  fs: ProjectFsPort,
  directory: string,
  read?: Map<string, string>,
): Promise<LegacyInventory> {
  const observations = new Map<string, LegacyObservation>();
  const look = async (marker: boolean) => {
    for (const candidate of LEGACY_CANDIDATES.filter((found) => found.marker === marker)) {
      const observed = await observe(fs, directory, candidate.path, candidate.open);
      if (observed.kind === "file" && observed.text !== undefined) {
        read?.set(candidate.path, sha256Hex(observed.text));
      }
      observations.set(candidate.path, observed);
    }
  };
  // Generic paths such as governance/ are looked at only in a project the
  // old releases' own records mark, never in an unrelated repository.
  await look(true);
  if (!classifyLegacy(observations).project) return { project: false, records: [] };
  await look(false);
  return classifyLegacy(observations);
}

async function observe(
  fs: ProjectFsPort,
  directory: string,
  relative: string,
  open: boolean,
): Promise<LegacyObservation> {
  if (open) return fs.readWithin(directory, relative, MAX_LEGACY_BYTES);
  // Records noted by presence alone are never read, so only lstat them.
  const parts = relative.split("/");
  const before = await onTheWay(fs, directory, parts);
  if (before !== undefined) return before;
  const entry = await fs.entry(path.join(directory, ...parts));
  if (entry.kind === "inaccessible")
    return { kind: "inaccessible", via: container(parts, parts.length) };
  return entry.kind === "file" ? { kind: "file", size: entry.size } : { kind: entry.kind };
}

/**
 * A path that cannot be inspected is in a directory this user may not
 * search, so that directory is the one reported, never the path.
 */
const container = (parts: readonly string[], depth: number) =>
  parts.slice(0, depth - 1).join("/") || ".";

/**
 * A link, a file or a directory this user may not look into, on the way to
 * a record, such as a linked .liftoff. It is not followed.
 */
async function onTheWay(
  fs: ProjectFsPort,
  directory: string,
  parts: readonly string[],
): Promise<LegacyObservation | undefined> {
  for (let depth = 1; depth < parts.length; depth++) {
    const parent = await fs.entry(path.join(directory, ...parts.slice(0, depth)));
    if (parent.kind === "missing") return { kind: "missing" };
    if (parent.kind === "directory") continue;
    if (parent.kind === "inaccessible")
      return { kind: "inaccessible", via: container(parts, depth) };
    return { kind: "other", via: parts.slice(0, depth).join("/") };
  }
  return undefined;
}
