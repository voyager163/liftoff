import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  copyFile,
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
  FileHash,
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

  hashWithin(directory: string, relative: string, maxBytes: number): Promise<FileHash> {
    return hashWithin(directory, relative, maxBytes);
  }

  async moveFile(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async makeDirectory(target: string): Promise<void> {
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  copyWithin(directory: string, relative: string, maxBytes: number, to: string): Promise<FileHash> {
    return copyWithin(directory, relative, maxBytes, to);
  }

  async copyFile(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }

  async directoryIdentity(target: string): Promise<string | undefined> {
    const seen = await inspect(NODE_CALLS, target);
    if (typeof seen === "string" || !seen.isDirectory()) return undefined;
    return `${seen.dev}:${seen.ino}`;
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

  async createStaging(target: string, access?: "private"): Promise<string> {
    const parent = path.dirname(path.resolve(target));
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(path.join(parent, `.${path.basename(target)}.liftoff-staging-`));
    // mkdtemp creates the directory private (0700). A project published from
    // it should get the usual permissions for a new directory; kept copies of
    // a project's files stay private.
    if (access !== "private" && process.platform !== "win32") {
      await chmod(staging, 0o777 & ~process.umask());
    }
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
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
}

const NODE_CALLS: ReadCalls = {
  lstat: (target) => lstat(target, { bigint: true }),
  open: (target, flags, mode) => open(target, flags, mode),
};

/**
 * Reads a regular file under `directory` without following a link, however
 * the files change meanwhile (see openWithin), no more than `maxBytes` of
 * it. Its text is dropped if it changed while being read.
 */
export async function readWithin(
  directory: string,
  relative: string,
  maxBytes: number,
  calls: ReadCalls = NODE_CALLS,
): Promise<RegularFileRead> {
  const opened = await openWithin(directory, relative, calls, maxBytes);
  if (opened.kind !== "opened") return opened;
  const { handle } = opened;
  try {
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
    const elsewhere = await opened.moved();
    if (elsewhere !== undefined) return elsewhere;
    return { kind: "file", size: length, text: buffer.toString("utf8", 0, length) };
  } finally {
    await handle.close();
  }
}

/**
 * Hashes a whole regular file under `directory` without following a link,
 * however the files change meanwhile (see openWithin), unless it is over
 * `maxBytes`. It is "other" if the file changed while it was being hashed.
 */
export async function hashWithin(
  directory: string,
  relative: string,
  maxBytes: number,
  calls: ReadCalls = NODE_CALLS,
): Promise<FileHash> {
  const opened = await openWithin(directory, relative, calls, maxBytes);
  if (opened.kind !== "opened") return opened;
  const { handle, stats } = opened;
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    let position = 0;
    // A file that grows while it is hashed is read no further than the limit.
    while (position <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (position > maxBytes || after.size !== BigInt(position) || after.mtimeNs !== stats.mtimeNs) {
      return { kind: "other" };
    }
    const elsewhere = await opened.moved();
    if (elsewhere !== undefined) return elsewhere;
    return {
      kind: "file",
      sha256: hash.digest("hex"),
      size: position,
      executable: process.platform !== "win32" && (Number(stats.mode) & 0o111) !== 0,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Copies a regular file under `directory` to `to`, which must not exist,
 * reading it as hashWithin does and keeping its mode. It returns the hash of
 * exactly what was written. Nothing is left at `to` unless the whole file
 * was copied and it did not change or move meanwhile.
 */
export async function copyWithin(
  directory: string,
  relative: string,
  maxBytes: number,
  to: string,
  calls: ReadCalls = NODE_CALLS,
): Promise<FileHash> {
  const opened = await openWithin(directory, relative, calls, maxBytes);
  if (opened.kind !== "opened") return opened;
  const { handle, stats } = opened;
  let out: FileHandle | undefined;
  let copied = false;
  try {
    await mkdir(path.dirname(to), { recursive: true });
    out = await calls.open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    let position = 0;
    while (position <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      // A write may take fewer bytes than given, as on a nearly full disk.
      for (let done = 0; done < bytesRead; ) {
        const { bytesWritten } = await out.write(buffer, done, bytesRead - done, position + done);
        if (bytesWritten === 0) throw new Error(`could not write ${to}: no progress`);
        done += bytesWritten;
      }
      position += bytesRead;
    }
    if (position > maxBytes) return { kind: "file", size: position };
    const after = await handle.stat({ bigint: true });
    if (after.size !== BigInt(position) || after.mtimeNs !== stats.mtimeNs)
      return { kind: "other" };
    const elsewhere = await opened.moved();
    if (elsewhere !== undefined) return elsewhere;
    if (process.platform !== "win32") await out.chmod(Number(stats.mode) & 0o777);
    copied = true;
    return {
      kind: "file",
      sha256: hash.digest("hex"),
      size: position,
      executable: process.platform !== "win32" && (Number(stats.mode) & 0o111) !== 0,
    };
  } finally {
    await handle.close();
    await out?.close();
    if (out !== undefined && !copied) await rm(to, { force: true });
  }
}

/**
 * Opens a regular file under `directory` without following a link, however
 * the files change meanwhile, or says what is there instead. Each directory
 * on the way and the file itself are inspected first. The file is opened
 * without following a link and without blocking where the system allows (a
 * FIFO swapped in would otherwise wait for a writer), and must be the file
 * inspected. Every directory on the way must still be the one inspected, or
 * the open may have gone through a link swapped in. A file over `maxBytes`
 * is not opened. Node has no openat, so a directory swapped for
 * a link and back between the two inspections is the one case this cannot
 * see.
 */
async function openWithin(
  directory: string,
  relative: string,
  calls: ReadCalls,
  maxBytes: number,
): Promise<
  | { readonly kind: "missing" | "directory" }
  | { readonly kind: "other" | "inaccessible"; readonly via?: string }
  | { readonly kind: "file"; readonly size: number }
  | {
      readonly kind: "opened";
      readonly handle: FileHandle;
      readonly stats: BigIntStats;
      /**
       * Inspects the path again once the file has been read: every directory
       * on the way and the file must still be the ones opened, or the file
       * was replaced meanwhile, as an editor's save does. What it says
       * instead, or undefined when nothing moved.
       */
      readonly moved: () => Promise<
        { readonly kind: "other" | "inaccessible"; readonly via?: string } | undefined
      >;
    }
> {
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
  const tooLarge = (size: bigint) => size > BigInt(maxBytes);
  if (tooLarge(inspected.size)) return { kind: "file", size: Number(inspected.size) };
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
    if (code === "EACCES" || code === "EPERM") return { kind: "inaccessible" };
    // The machine failing, rather than the path, is an error.
    if (code === "EMFILE" || code === "ENFILE" || code === "EIO") throw error;
    // Anything else, such as a link (ELOOP) or a socket swapped in, is not
    // a regular file to read.
    return { kind: "other" };
  }
  const refuse = async <T>(result: T): Promise<T> => {
    await handle.close();
    return result;
  };
  const moved = async () => {
    for (const parent of parents) {
      const now = await inspect(calls, parent.path);
      if (now === "inaccessible")
        return { kind: "inaccessible" as const, via: container(parent.depth) };
      if (now === "missing" || !now.isDirectory() || !sameFile(now, parent.stats)) {
        return { kind: "other" as const, via: parts.slice(0, parent.depth).join("/") };
      }
    }
    const now = await inspect(calls, file);
    return typeof now === "string" || !sameFile(now, inspected)
      ? { kind: "other" as const }
      : undefined;
  };
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(opened, inspected)) return refuse({ kind: "other" });
    const elsewhere = await moved();
    if (elsewhere !== undefined) return refuse(elsewhere);
    if (tooLarge(opened.size)) return refuse({ kind: "file", size: Number(opened.size) });
    return { kind: "opened", handle, stats: opened, moved };
  } catch (error) {
    await handle.close();
    throw error;
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
