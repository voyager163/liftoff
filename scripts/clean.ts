// Removes build output directories named on the command line, inside the
// repository only.
import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const name of process.argv.slice(2)) {
  const target = path.resolve(root, name);
  if (path.relative(root, target).startsWith("..") || target === root) {
    throw new Error(`refusing to remove ${name}: not inside the repository`);
  }
  rmSync(target, { recursive: true, force: true });
}
