import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetPort } from "../application/ports.ts";

/**
 * The assets directory of this installation. Source and built layouts both
 * keep it two levels above this file (src/adapters or dist/adapters).
 */
export const defaultAssetRoot = (): string =>
  fileURLToPath(new URL("../../assets/", import.meta.url));

/** Reads assets shipped with Liftoff. Paths must stay inside the asset root. */
export class PackageAssets implements AssetPort {
  private readonly root: string;

  constructor(root: string = defaultAssetRoot()) {
    this.root = path.resolve(root);
  }

  async list(relativeDirectory: string): Promise<string[]> {
    const entries = await readdir(this.resolve(relativeDirectory));
    return entries.sort();
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(this.resolve(relativePath), "utf8");
  }

  private resolve(relative: string): string {
    const target = path.resolve(this.root, relative);
    const inside = path.relative(this.root, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new Error(`asset path escapes the asset root: ${relative}`);
    }
    return target;
  }
}
