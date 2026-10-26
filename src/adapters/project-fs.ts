import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
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
      if (code === "EACCES" || code === "EPERM") return { kind: "inaccessible", size: 0 };
      throw error;
    }
  }

  readWithin(directory: string, relative: string, maxBytes: number): Promise<RegularFileRead> {
    return readWithin(directory, relative, maxBytes);
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

/** The calls readWithin makes, which a test can replace to change files between them. */
export interface ReadCalls {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const NODE_CALLS: ReadCalls = {
  lstat: (target) => lstat(target, { bigint: true }),
  open: (target, flags) => open(target, flags),
};

/**
 * Reads a regular file under `directory` without following a link, however
 * the files change meanwhile. Each directory on the way and the file itself
 * are inspected first. The file is opened without following a link and
 * without blocking where the system allows (a FIFO swapped in would
 * otherwise wait for a writer), and must be the file inspected. Every
 * directory on the way must still be the one inspected, or the open may
 * have gone through a link swapped in. Only then is it read, no more than
 * `maxBytes` of it, and its text is dropped if it changed while being read.
 * Node has no openat, so a directory swapped for a link and back between
 * the two inspections is the one case this cannot see.
 */
export async function readWithin(
  directory: string,
  relative: string,
  maxBytes: number,
  calls: ReadCalls = NODE_CALLS,
): Promise<RegularFileRead> {
  const parts = relative.split("/");
  // A path that cannot be inspected is in a directory this user may not
  // search: that directory is the one reported.
  const container = (depth: number) => parts.slice(0, depth - 1).join("/") || ".";
  const parents: { readonly path: string; readonly depth: number; readonly stats: BigIntStats }[] =
    [];
  for (let depth = 1; depth < parts.length; depth++) {
    const target = path.join(directory, ...parts.slice(0, depth));
    const seen = await inspect(calls, target);
    if (seen === "missing") return { kind: "missing" };
    if (seen === "inaccessible") return { kind: "inaccessible", via: container(depth) };
    if (!seen.isDirectory()) return { kind: "other", via: parts.slice(0, depth).join("/") };
    parents.push({ path: target, depth, stats: seen });
  }
  const file = path.join(directory, ...parts);
  const inspected = await inspect(calls, file);
  if (inspected === "missing") return { kind: "missing" };
  if (inspected === "inaccessible") return { kind: "inaccessible", via: container(parts.length) };
  if (!inspected.isFile()) return { kind: inspected.isDirectory() ? "directory" : "other" };
  if (inspected.size > BigInt(maxBytes)) return { kind: "file", size: Number(inspected.size) };
  let handle: FileHandle;
  try {
    // Windows has neither flag; there the checks below catch a link.
    handle = await calls.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "other" };
    if (code === "EACCES" || code === "EPERM") return { kind: "inaccessible" };
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(opened, inspected)) return { kind: "other" };
    for (const parent of parents) {
      const now = await inspect(calls, parent.path);
      if (now === "inaccessible") return { kind: "inaccessible", via: container(parent.depth) };
      if (now === "missing" || !now.isDirectory() || !sameFile(now, parent.stats)) {
        return { kind: "other", via: parts.slice(0, parent.depth).join("/") };
      }
    }
    if (opened.size > BigInt(maxBytes)) return { kind: "file", size: Number(opened.size) };
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== BigInt(length)) {
      return after.size > BigInt(maxBytes)
        ? { kind: "file", size: Number(after.size) }
        : { kind: "other" };
    }
    return { kind: "file", size: length, text: buffer.toString("utf8", 0, length) };
  } finally {
    await handle.close();
  }
}

async function inspect(
  calls: ReadCalls,
  target: string,
): Promise<BigIntStats | "missing" | "inaccessible"> {
  try {
    return await calls.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EACCES" || code === "EPERM") return "inaccessible";
    throw error;
  }
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
