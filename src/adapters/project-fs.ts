import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  PathEntry,
  PathState,
  ProjectFsPort,
  RegularFileRead,
  TreeEntry,
} from "../application/ports.ts";

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

  async entry(target: string): Promise<PathEntry> {
    try {
      const info = await lstat(target);
      if (info.isFile()) return { kind: "file", size: info.size };
      return { kind: info.isDirectory() ? "directory" : "other", size: 0 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing", size: 0 };
      throw error;
    }
  }

  async readRegular(file: string, maxBytes: number): Promise<RegularFileRead> {
    let inspected: BigIntStats;
    try {
      inspected = await lstat(file, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
      throw error;
    }
    if (!inspected.isFile()) return { kind: inspected.isDirectory() ? "directory" : "other" };
    return readUnchanged(file, inspected, maxBytes);
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

  async createExclusive(file: string, content: string): Promise<boolean> {
    await mkdir(path.dirname(file), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await handle.writeFile(content);
    } catch (error) {
      await handle.close();
      await rm(file, { force: true });
      throw error;
    }
    await handle.close();
    return true;
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

/**
 * Reads `file` only if it is still the regular file `inspected` describes:
 * it is opened without following a link where the system allows, and the
 * file opened must be the same one, so a link or another file swapped in
 * after the inspection is not read. No more than `maxBytes` and one more
 * byte are read, however much the file has grown.
 */
export async function readUnchanged(
  file: string,
  inspected: BigIntStats,
  maxBytes: number,
): Promise<RegularFileRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Windows has no O_NOFOLLOW; there the identity check below catches a link.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "other" };
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.ino !== inspected.ino || opened.dev !== inspected.dev) {
      return { kind: "other" };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const size = Math.max(Number(opened.size), length);
    return length > maxBytes
      ? { kind: "file", size }
      : { kind: "file", size, text: buffer.toString("utf8", 0, length) };
  } finally {
    await handle.close();
  }
}
