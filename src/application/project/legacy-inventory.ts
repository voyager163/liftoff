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
  // A link or a file on the way, such as a linked .liftoff, is not followed.
  for (let depth = 1; depth < parts.length; depth++) {
    const parent = await fs.entry(path.join(directory, ...parts.slice(0, depth)));
    if (parent.kind === "missing") return { kind: "missing" };
    if (parent.kind !== "directory") return { kind: "other", via: parts.slice(0, depth).join("/") };
  }
  const target = path.join(directory, ...parts);
  const entry = await fs.entry(target);
  if (entry.kind !== "file") return { kind: entry.kind };
  if (!open || entry.size > MAX_LEGACY_BYTES) return { kind: "file", size: entry.size };
  const text = await fs.readText(target);
  return text === undefined ? { kind: "missing" } : { kind: "file", size: entry.size, text };
}
