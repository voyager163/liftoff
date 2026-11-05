import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetPort } from "../application/ports.ts";
import { leaves } from "../domain/project/paths.ts";

/**
 * The assets directory of this installation. Source and built layouts both
 * keep it two levels above this file (src/adapters or dist/adapters).
 */
export const defaultAssetRoot = (): string =>
  fileURLToPath(new URL("../../assets/", import.meta.url));

/** The committed CI bundles, shipped beside the assets in the package. */
export const defaultBundleRoot = (): string =>
  fileURLToPath(new URL("../../.github/liftoff/", import.meta.url));

// npm leaves every .gitignore out of a package, so the assets keep each one
// as _gitignore, and Liftoff reads it under its real name.
const STORED: Record<string, string> = { ".gitignore": "_gitignore" };
const SHIPPED: Record<string, string> = { _gitignore: ".gitignore" };
const renamed = (relative: string, names: Record<string, string>): string => {
  const slash = relative.lastIndexOf("/");
  const name = names[relative.slice(slash + 1)];
  return name === undefined ? relative : `${relative.slice(0, slash + 1)}${name}`;
};

/** Reads assets shipped with Liftoff. Paths must stay inside the asset root. */
export class PackageAssets implements AssetPort {
  private readonly root: string;
  private readonly bundleRoot: string;

  constructor(root: string = defaultAssetRoot(), bundleRoot: string = defaultBundleRoot()) {
    this.root = path.resolve(root);
    this.bundleRoot = path.resolve(bundleRoot);
  }

  async list(relativeDirectory: string): Promise<string[]> {
    const entries = await readdir(this.resolve(relativeDirectory));
    return entries.map((name) => renamed(name, SHIPPED)).sort();
  }

  async listTree(relativeDirectory: string): Promise<string[]> {
    const directory = this.resolve(relativeDirectory);
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        renamed(
          path
            .relative(this.root, path.join(entry.parentPath, entry.name))
            .split(path.sep)
            .join("/"),
          SHIPPED,
        ),
      )
      .sort();
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(this.resolve(renamed(relativePath, STORED)), "utf8");
  }

  async ciBundles(): Promise<Record<string, string>> {
    const bundles: Record<string, string> = {};
    for (const name of (await readdir(this.bundleRoot)).sort()) {
      if (name.endsWith(".mjs")) {
        bundles[name] = await readFile(path.join(this.bundleRoot, name), "utf8");
      }
    }
    return bundles;
  }

  private resolve(relative: string): string {
    const target = path.resolve(this.root, relative);
    const inside = path.relative(this.root, target);
    if (leaves(inside)) {
      throw new Error(`asset path escapes the asset root: ${relative}`);
    }
    return target;
  }
}
