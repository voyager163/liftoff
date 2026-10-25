import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspacePort } from "../application/ports.ts";

/** Reads files under a root directory, refusing paths that escape it. */
export class LocalWorkspace implements WorkspacePort {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async readText(relativePath: string): Promise<string | undefined> {
    const target = path.resolve(this.root, relativePath);
    const inside = path.relative(this.root, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      throw new Error(`refusing to read outside the workspace: ${relativePath}`);
    }
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
