import type { FileHash, ProjectFsPort } from "../ports.ts";

/**
 * How many files are hashed at once. Opening a file Liftoff has just written
 * is slow, above all on Windows, where antivirus scans it first; hashing a
 * few at a time keeps that from adding up file by file, without holding
 * open more files than the system allows.
 */
const AT_ONCE = 16;

/** Hashes each file as hashWithin does, a few at a time, in the order given. */
export async function hashEach(
  fs: ProjectFsPort,
  directory: string,
  relatives: readonly string[],
  maxBytes: number,
): Promise<FileHash[]> {
  const hashes: FileHash[] = new Array(relatives.length);
  let next = 0;
  const work = async () => {
    while (next < relatives.length) {
      const index = next++;
      hashes[index] = await fs.hashWithin(directory, relatives[index] as string, maxBytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, relatives.length) }, work));
  return hashes;
}
