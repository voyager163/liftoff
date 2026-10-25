import path from "node:path";
import type { ProjectFsPort } from "../ports.ts";
import { GovernanceError } from "./assess.ts";

export const GOVERNANCE_LOCK_FILE = ".liftoff/governance.lock";

/**
 * Runs `body` holding the project's governance lock, from reading its record
 * to the last change, so two governance commands never interleave changes
 * on GitHub or overwrite each other's record. The lock is a file created
 * only if it does not exist, and removed when `body` ends.
 */
export async function withGovernanceLock<T>(
  fs: ProjectFsPort,
  directory: string,
  now: () => string,
  body: () => Promise<T>,
): Promise<T> {
  const lock = path.join(directory, ...GOVERNANCE_LOCK_FILE.split("/"));
  // Any other failure, such as a full disk, is thrown as it is.
  if (!(await fs.createExclusive(lock, `${now()}\n`))) {
    const since = (await fs.readText(lock))?.trim() || "an unknown time";
    throw new GovernanceError(
      `another liftoff governance command has been running since ${since}; if none is, delete ${GOVERNANCE_LOCK_FILE}`,
    );
  }
  try {
    return await body();
  } finally {
    await fs.remove(lock);
  }
}
