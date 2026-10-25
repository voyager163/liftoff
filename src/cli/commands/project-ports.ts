import { PackageAssets } from "../../adapters/assets.ts";
import { LocalProjectFs } from "../../adapters/project-fs.ts";
import { LocalTools } from "../../adapters/tools.ts";
import type { AssetPort, ProjectFsPort, ToolPort } from "../../application/ports.ts";

export interface ProjectPorts {
  assets: AssetPort;
  fs: ProjectFsPort;
  tools: ToolPort;
}

export const defaultProjectPorts = (cwd: string): ProjectPorts => ({
  assets: new PackageAssets(),
  fs: new LocalProjectFs(),
  tools: new LocalTools(cwd),
});
