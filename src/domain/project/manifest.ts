import { en } from "zod/locales";
import * as z from "zod/mini";
import { LEGACY_RECORD_KINDS } from "../legacy/inventory.ts";
import { OPERATIONS } from "./operations.ts";
import { repositoryPathProblem } from "./paths.ts";

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
  z.refine((p) => repositoryPathProblem(p) === undefined, {
    message: "must be a repository-relative POSIX path every system can hold",
  }),
);

const manifestSchema = z.strictObject({
  schema: z.literal(MANIFEST_SCHEMA),
  generatedBy: z.strictObject({ liftoff: z.string().check(z.minLength(1)) }),
  /**
   * Each Liftoff operation that wrote the project, with its release, oldest
   * first. A manifest from before this was recorded has none.
   */
  history: z._default(
    z.array(
      z.strictObject({
        operation: z.enum(OPERATIONS),
        liftoff: z.string().check(z.minLength(1)),
      }),
    ),
    [],
  ),
  /**
   * What a Liftoff release before the rebuild left, for a project adopted
   * from one: kept as the project's own, byte for byte, and never counted
   * as current configuration or proof.
   */
  legacy: z.optional(
    z.strictObject({
      /** The old release that last wrote the project, when it said. */
      release: z.optional(z.string().check(z.minLength(1))),
      records: z.array(
        z.strictObject({
          path: relativePath,
          record: z.enum(LEGACY_RECORD_KINDS),
          state: z.enum(["readable", "migratable", "unsupported"]),
          format: z.optional(z.string()),
          /** A kept file's sha256 when it was adopted; a directory has none. */
          sha256: z.optional(sha256),
        }),
      ),
    }),
  ),
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

/**
 * Writes the manifest with every object's keys in the schema's order and
 * every list sorted, so the same manifest is always the same bytes, however
 * the caller built it.
 */
export function serializeManifest(manifest: Manifest): string {
  const { legacy } = manifest;
  const ordered: Manifest = {
    schema: manifest.schema,
    generatedBy: { liftoff: manifest.generatedBy.liftoff },
    history: manifest.history.map(({ operation, liftoff }) => ({ operation, liftoff })),
    plugins: [...manifest.plugins]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, version }) => ({ id, version })),
    files: [...manifest.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ path, ownership, sha256, plugin }) => ({ path, ownership, sha256, plugin })),
    ...(legacy === undefined
      ? {}
      : {
          legacy: {
            ...(legacy.release === undefined ? {} : { release: legacy.release }),
            records: [...legacy.records]
              .sort((a, b) => a.path.localeCompare(b.path))
              .map(({ path, record, state, format, sha256 }) => ({
                path,
                record,
                state,
                ...(format === undefined ? {} : { format }),
                ...(sha256 === undefined ? {} : { sha256 }),
              })),
          },
        }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
