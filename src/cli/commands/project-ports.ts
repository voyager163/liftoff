import { realpath } from "node:fs/promises";
import path from "node:path";
import { PackageAssets } from "../../adapters/assets.ts";
import { LocalInitializer } from "../../adapters/initializer.ts";
import { LocalProcesses } from "../../adapters/process.ts";
import { LocalProjectFs } from "../../adapters/project-fs.ts";
import { LocalTools } from "../../adapters/tools.ts";
import type {
  AssetPort,
  InitializerPort,
  ProcessesPort,
  ProjectFsPort,
  ToolPort,
} from "../../application/ports.ts";

export interface ProjectPorts {
  assets: AssetPort;
  fs: ProjectFsPort;
  tools: ToolPort;
  initializer: InitializerPort;
  processes: ProcessesPort;
}

export const defaultProjectPorts = (cwd: string): ProjectPorts => ({
  assets: new PackageAssets(),
  fs: new LocalProjectFs(),
  tools: new LocalTools(cwd),
  initializer: new LocalInitializer(),
  processes: new LocalProcesses(),
});

/**
 * The project directory a command line names, relative to `cwd`, with any
 * link in its path followed once, here: every later read under it follows
 * no link, so it must start from the real directory. A path that cannot be
 * resolved, such as one that does not exist, is left for the command to
 * report.
 */
export async function projectDirectory(cwd: string, named: string): Promise<string> {
  const absolute = path.resolve(cwd, named);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}
