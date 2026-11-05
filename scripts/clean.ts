// Removes build output directories named on the command line, inside the
// repository only.
import { rmSync } from "node:fs";
import path from "node:path";
import { isInside } from "./inside.ts";

const root = path.resolve(import.meta.dirname, "..");
for (const name of process.argv.slice(2)) {
  const target = path.resolve(root, name);
  if (!isInside(root, target)) {
    throw new Error(`refusing to remove ${name}: not inside the repository`);
  }
  rmSync(target, { recursive: true, force: true });
}
