import { PackageAssets } from "../../adapters/assets.ts";
import { LocalInitializer } from "../../adapters/initializer.ts";
import { LocalProjectFs } from "../../adapters/project-fs.ts";
import { LocalTools } from "../../adapters/tools.ts";
import type {
  AssetPort,
  InitializerPort,
  ProjectFsPort,
  ToolPort,
} from "../../application/ports.ts";

export interface ProjectPorts {
  assets: AssetPort;
  fs: ProjectFsPort;
  tools: ToolPort;
  initializer: InitializerPort;
}

export const defaultProjectPorts = (cwd: string): ProjectPorts => ({
  assets: new PackageAssets(),
  fs: new LocalProjectFs(),
  tools: new LocalTools(cwd),
  initializer: new LocalInitializer(),
});
