import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MANIFEST_FILE,
  type Manifest,
  type ManifestFile,
  parseManifest,
  serializeManifest,
} from "../../src/domain/project/manifest.ts";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Files of a generated project with Claude, used by the update tests. */
export const SKILL = (name: string): string => `.claude/skills/${name}/SKILL.md`;

/** Reads and writes a project's files by repository-relative path. */
export function projectFiles(root: () => string) {
  const at = (relative: string) => path.join(root(), ...relative.split("/"));
  const write = (relative: string, content: string) => {
    mkdirSync(path.dirname(at(relative)), { recursive: true });
    writeFileSync(at(relative), content);
  };
  const read = (relative: string) => readFileSync(at(relative), "utf8");
  /** Every file under the project, with its bytes, to show what changed. */
  const snapshot = () => {
    const files: Record<string, string> = {};
    const walk = (relative: string) => {
      for (const entry of readdirSync(at(relative || "."), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) files[child] = "(link)";
        else if (entry.isDirectory()) walk(child);
        else files[child] = readFileSync(at(child)).toString("base64");
      }
    };
    walk("");
    return files;
  };
  /** Rewrites the manifest as an earlier release might have left it. */
  const age = (edit: (manifest: Manifest) => void) => {
    const manifest = parseManifest(read(MANIFEST_FILE));
    edit(manifest);
    write(MANIFEST_FILE, serializeManifest(manifest));
  };
  return { at, write, read, snapshot, age };
}

/** The manifest's entry for a file, which the test expects to be there. */
export function entry(manifest: Manifest, relative: string): ManifestFile {
  const found = manifest.files.find((file) => file.path === relative);
  if (found === undefined) throw new Error(`the manifest does not list ${relative}`);
  return found;
}
