import path from "node:path";
import {
  GOVERNANCE_STATE_FILE,
  type GovernanceState,
  GovernanceStateError,
  parseGovernanceState,
  serializeGovernanceState,
} from "../../domain/governance/state.ts";
import type { ProjectFsPort } from "../ports.ts";

/** The most of the state file read; it never comes near this. */
const MAX_STATE_BYTES = 1024 * 1024;

const file = (directory: string) => path.join(directory, ...GOVERNANCE_STATE_FILE.split("/"));

/** The recorded governance state of the project, if any, read without following a link. */
export async function readGovernanceState(
  fs: ProjectFsPort,
  directory: string,
): Promise<GovernanceState | undefined> {
  const found = await fs.readWithin(directory, GOVERNANCE_STATE_FILE, MAX_STATE_BYTES);
  if (found.kind === "missing") return undefined;
  if (found.kind === "file" && found.text !== undefined) return parseGovernanceState(found.text);
  throw new GovernanceStateError(
    found.kind === "inaccessible"
      ? `${GOVERNANCE_STATE_FILE} cannot be read by this user`
      : `${GOVERNANCE_STATE_FILE} is not a regular file Liftoff can read`,
  );
}

export async function writeGovernanceState(
  fs: ProjectFsPort,
  directory: string,
  state: GovernanceState,
): Promise<void> {
  await fs.replaceFile(file(directory), serializeGovernanceState(state));
}
