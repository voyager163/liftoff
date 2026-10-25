import { en } from "zod/locales";
import * as z from "zod/mini";

z.config(en());

export const MANIFEST_FILE = ".liftoff/manifest.json";
export const MANIFEST_SCHEMA = "liftoff.manifest/v1";

/**
 * Who owns a generated file after it is written:
 * - managed: Liftoff keeps it current; local edits are reported as drift.
 * - seeded: written once by Liftoff, then owned by the project. Liftoff never
 *   overwrites it.
 * - framework: written by a development framework's own initializer, such as
 *   OpenSpec's, and owned by that framework. Liftoff never changes it and
 *   does not report edits to it.
 * Ownership is what the manifest declares, never inferred from a path or a
 * matching hash.
 */
export const OWNERSHIP = ["managed", "seeded", "framework"] as const;
export type Ownership = (typeof OWNERSHIP)[number];

const sha256 = z.string().check(z.regex(/^[0-9a-f]{64}$/, "must be a sha256 hex digest"));
const relativePath = z.string().check(
  z.refine(
    (p) => p.length > 0 && !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."),
    {
      message: "must be a repository-relative POSIX path",
    },
  ),
);

const manifestSchema = z.strictObject({
  schema: z.literal(MANIFEST_SCHEMA),
  generatedBy: z.strictObject({ liftoff: z.string().check(z.minLength(1)) }),
  plugins: z.array(z.strictObject({ id: z.string(), version: z.string() })),
  files: z.array(
    z.strictObject({
      path: relativePath,
      ownership: z.enum(OWNERSHIP),
      sha256,
      plugin: z.string(),
    }),
  ),
});

export type Manifest = z.output<typeof manifestSchema>;
export type ManifestFile = Manifest["files"][number];

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`${MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = z.safeParse(manifestSchema, raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ManifestError(`${MANIFEST_FILE} is invalid: ${issues.join("; ")}`);
  }
  return parsed.data;
}

export function serializeManifest(manifest: Manifest): string {
  const sorted: Manifest = {
    ...manifest,
    plugins: [...manifest.plugins].sort((a, b) => a.id.localeCompare(b.id)),
    files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
