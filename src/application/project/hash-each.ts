import type { FileHash, ProjectFsPort } from "../ports.ts";

/**
 * How many files are hashed at once. Opening a file Liftoff has just written
 * is slow, above all on Windows, where antivirus scans it first; hashing a
 * few at a time keeps that from adding up file by file, without holding
 * open more files than the system allows.
 */
const AT_ONCE = 16;

/**
 * Hashes each file as hashWithin does, a few at a time, in the order given.
 * Once one fails no further file is started, and the first error is thrown
 * only when the files already being hashed are done, so nothing is left
 * reading the project after it returns.
 */
export async function hashEach(
  fs: ProjectFsPort,
  directory: string,
  relatives: readonly string[],
  maxBytes: number,
): Promise<FileHash[]> {
  const hashes: FileHash[] = new Array(relatives.length);
  let next = 0;
  let failed = false;
  const work = async () => {
    while (!failed && next < relatives.length) {
      const index = next++;
      try {
        hashes[index] = await fs.hashWithin(directory, relatives[index] as string, maxBytes);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(AT_ONCE, relatives.length) }, work),
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return hashes;
}
