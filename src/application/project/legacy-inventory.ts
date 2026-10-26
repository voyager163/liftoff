import path from "node:path";
import {
  classifyLegacy,
  LEGACY_CANDIDATES,
  type LegacyInventory,
  type LegacyObservation,
  MAX_LEGACY_BYTES,
} from "../../domain/legacy/inventory.ts";
import type { ProjectFsPort } from "../ports.ts";

/**
 * Looks for what Liftoff releases before the rebuild left in a directory. It
 * only reads: it checks the old releases' own paths, never follows a link,
 * reads only small records that cannot hold copies of files, credentials or
 * state, and runs nothing.
 */
export async function inventoryLegacy(
  fs: ProjectFsPort,
  directory: string,
): Promise<LegacyInventory> {
  const observations = new Map<string, LegacyObservation>();
  for (const candidate of LEGACY_CANDIDATES) {
    observations.set(candidate.path, await observe(fs, directory, candidate.path, candidate.open));
  }
  return classifyLegacy(observations);
}

async function observe(
  fs: ProjectFsPort,
  directory: string,
  relative: string,
  open: boolean,
): Promise<LegacyObservation> {
  const parts = relative.split("/");
  const before = await onTheWay(fs, directory, parts);
  if (before !== undefined) return before;
  const target = path.join(directory, ...parts);
  if (!open) {
    const entry = await fs.entry(target);
    return entry.kind === "file" ? { kind: "file", size: entry.size } : { kind: entry.kind };
  }
  const read = await fs.readRegular(target, MAX_LEGACY_BYTES);
  // A directory on the way that became a link during the read was followed:
  // what was read is dropped.
  return (await onTheWay(fs, directory, parts)) ?? read;
}

/** A link or a file on the way to a record, such as a linked .liftoff, which is not followed. */
async function onTheWay(
  fs: ProjectFsPort,
  directory: string,
  parts: readonly string[],
): Promise<LegacyObservation | undefined> {
  for (let depth = 1; depth < parts.length; depth++) {
    const parent = await fs.entry(path.join(directory, ...parts.slice(0, depth)));
    if (parent.kind === "missing") return { kind: "missing" };
    if (parent.kind !== "directory") return { kind: "other", via: parts.slice(0, depth).join("/") };
  }
  return undefined;
}
