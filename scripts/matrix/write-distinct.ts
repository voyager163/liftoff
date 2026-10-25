// Writes every distinct GitHub Actions workflow and shell script that any
// supported combination of options generates, so the nightly matrix can lint
// each one once: node scripts/matrix/write-distinct.ts <directory>
// Each file goes to <directory>/<first 12 hex of its sha256>/<its path>.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cachedAssets,
  combinations,
  generateCombination,
  unsupportedReason,
} from "./combinations.ts";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: node scripts/matrix/write-distinct.ts <directory>");
  process.exit(2);
}

const assets = cachedAssets();
const written = new Set<string>();
let supported = 0;
for (const combination of combinations()) {
  if (unsupportedReason(combination) !== undefined) continue;
  supported++;
  for (const file of await generateCombination(assets, combination)) {
    const linted =
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path) || file.path.endsWith(".sh");
    if (!linted || written.has(file.sha256)) continue;
    written.add(file.sha256);
    const target = path.join(out, file.sha256.slice(0, 12), ...file.path.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}
console.log(`wrote ${written.size} distinct workflows and scripts from ${supported} combinations`);
