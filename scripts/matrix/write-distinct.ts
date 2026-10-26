// Writes every distinct GitHub Actions workflow and shell script that any
// supported combination of options generates, so the nightly matrix can lint
// each one once: node scripts/matrix/write-distinct.ts <directory>
// Each file goes to <directory>/<first 12 hex of its sha256>/<its path>,
// with any of the project's own reusable workflows it calls beside it. Each
// such directory has an empty .git, so actionlint takes it as the project
// and resolves "./.github/workflows/..." there, not in Liftoff's checkout.
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
  const files = await generateCombination(assets, combination);
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files) {
    const linted =
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path) || file.path.endsWith(".sh");
    if (!linted || written.has(file.sha256)) continue;
    written.add(file.sha256);
    const project = path.join(out, file.sha256.slice(0, 12));
    const write = (relative: string, content: string) => {
      const target = path.join(project, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    write(file.path, file.content);
    for (const [, callee = ""] of file.content.matchAll(/uses: \.\/(\.github\/workflows\/\S+)/g)) {
      const called = byPath.get(callee);
      if (called === undefined)
        throw new Error(`${file.path} calls ${callee}, which is not generated`);
      write(callee, called.content);
    }
    mkdirSync(path.join(project, ".git"), { recursive: true });
  }
}
console.log(`wrote ${written.size} distinct workflows and scripts from ${supported} combinations`);
