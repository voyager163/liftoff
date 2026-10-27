import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a plan file as a new file and moves it into place, so whatever is
 * at that path already, a link or another name for a file elsewhere (a
 * hard link), is replaced and never written through: the file it led to,
 * perhaps one of a project's, stays as it was.
 */
export async function writePlanFile(file: string, text: string): Promise<void> {
  // A short name of its own, so any name the file may have is one it can.
  const temporary = path.join(
    path.dirname(file),
    `.liftoff-plan-${randomBytes(6).toString("hex")}.tmp`,
  );
  // Created only where nothing is, so not through a link left there either.
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    await handle.writeFile(text);
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
