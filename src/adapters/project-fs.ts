import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PathState, ProjectFsPort, TreeEntry } from "../application/ports.ts";

/** Local file system access for creating projects. */
export class LocalProjectFs implements ProjectFsPort {
  async state(target: string): Promise<PathState> {
    try {
      const info = await stat(target);
      if (!info.isDirectory()) return "file";
      return (await readdir(target)).length === 0 ? "empty-directory" : "directory";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }

  async readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }

  async createStaging(target: string): Promise<string> {
    const parent = path.dirname(path.resolve(target));
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(path.join(parent, `.${path.basename(target)}.liftoff-staging-`));
    // mkdtemp creates the directory private (0700); the project itself should
    // get the usual permissions for a new directory.
    if (process.platform !== "win32") await chmod(staging, 0o777 & ~process.umask());
    return staging;
  }

  async writeFile(file: string, content: string, executable: boolean): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { flag: "wx" });
    if (executable && process.platform !== "win32") await chmod(file, 0o755);
  }

  async replaceFile(file: string, content: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, file);
  }

  async publish(staging: string, target: string): Promise<void> {
    // rename() will not replace a non-empty directory, so nothing existing is
    // ever overwritten. An empty target is removed first; if something else
    // fills it in the meantime, rmdir fails and nothing is published.
    if ((await this.state(target)) === "empty-directory") await rmdir(target);
    await rename(staging, target);
  }

  async remove(target: string): Promise<void> {
    await rm(target, { recursive: true, force: true });
  }

  async listTree(directory: string): Promise<TreeEntry[]> {
    // A recursive listing reports links as links and does not follow them.
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .map(
        (entry): TreeEntry => ({
          path: path
            .relative(directory, path.join(entry.parentPath, entry.name))
            .split(path.sep)
            .join("/"),
          kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
        }),
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
