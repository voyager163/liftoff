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
 * Once one fails no further file is started. When the files already being
 * hashed are done, so nothing is left reading the project, it throws the
 * error of the earliest file in the order given that failed, as hashing them
 * one after another would have.
 */
export async function hashEach(
  fs: ProjectFsPort,
  directory: string,
  relatives: readonly string[],
  maxBytes: number,
): Promise<FileHash[]> {
  const hashes: FileHash[] = new Array(relatives.length);
  let next = 0;
  // Every file before one that started has started too, so the earliest
  // failure among those started is the earliest of all.
  let failedAt = Number.POSITIVE_INFINITY;
  let failure: unknown;
  const work = async () => {
    while (failedAt === Number.POSITIVE_INFINITY && next < relatives.length) {
      const index = next++;
      try {
        hashes[index] = await fs.hashWithin(directory, relatives[index] as string, maxBytes);
      } catch (error) {
        if (index < failedAt) {
          failedAt = index;
          failure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, relatives.length) }, work));
  if (failedAt !== Number.POSITIVE_INFINITY) throw failure;
  return hashes;
}
