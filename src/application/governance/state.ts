import path from "node:path";
import {
  GOVERNANCE_STATE_FILE,
  type GovernanceState,
  parseGovernanceState,
  serializeGovernanceState,
} from "../../domain/governance/state.ts";
import type { ProjectFsPort } from "../ports.ts";

const file = (directory: string) => path.join(directory, ...GOVERNANCE_STATE_FILE.split("/"));

/** The recorded governance state of the project, if any. */
export async function readGovernanceState(
  fs: ProjectFsPort,
  directory: string,
): Promise<GovernanceState | undefined> {
  const text = await fs.readText(file(directory));
  return text === undefined ? undefined : parseGovernanceState(text);
}

export async function writeGovernanceState(
  fs: ProjectFsPort,
  directory: string,
  state: GovernanceState,
): Promise<void> {
  await fs.replaceFile(file(directory), serializeGovernanceState(state));
}
