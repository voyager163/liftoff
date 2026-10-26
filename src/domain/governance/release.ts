/**
 * Releases under the GitFlow profiles: their versions, and the manifest that
 * records exactly what a release is. Pure; the release workflows gather the
 * facts and publish the manifest as an attestation.
 */
import { en } from "zod/locales";
import * as z from "zod/mini";

z.config(en());

export const RELEASE_MANIFEST_SCHEMA = "liftoff.release-manifest/v1";
/**
 * The attestation predicate type a release manifest is published under: the
 * page that describes it. It has no #fragment, which GitHub's attestations
 * API refuses when asked for attestations of one type.
 */
export const RELEASE_MANIFEST_PREDICATE =
  "https://github.com/voyager163/liftoff/blob/develop/docs/projects/release-manifest.md";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** An image's name in the project, such as "api". */
const IMAGE_NAME = /^[a-z][a-z0-9-]*$/;
/** Where an image is published, such as "ghcr.io/owner/repo/api". */
const IMAGE_REFERENCE = /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z][a-z0-9-]*$/;

/** Whether a version is X.Y.Z with no leading zeros. */
export const isVersion = (version: string): boolean => VERSION.test(version);

/** One container image of a release, by digest. */
export interface ReleaseImage {
  /** The image's name in the project, such as "api". */
  readonly name: string;
  /** Where it is published, without tag or digest, such as "ghcr.io/o/r/api". */
  readonly reference: string;
  readonly digest: string;
}

export interface ReleaseManifest {
  readonly schema: typeof RELEASE_MANIFEST_SCHEMA;
  readonly repository: string;
  readonly version: string;
  readonly kind: "release" | "hotfix";
  readonly pullRequest: number;
  readonly source: {
    /** The commit on main the release is. */
    readonly commit: string;
    /** Its tree, which is also the candidate's. */
    readonly tree: string;
    /** The commit CI qualified and the images were built from. */
    readonly candidate: string;
  };
  readonly images: readonly ReleaseImage[];
}

export class ReleaseError extends Error {
  override readonly name = "ReleaseError";
}

/** Reads "name reference digest" lines, one per image. */
export function parseImages(text: string): ReleaseImage[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, reference, digest, extra] = line.split(/\s+/);
      if (
        !name ||
        !reference ||
        !digest ||
        extra !== undefined ||
        !IMAGE_NAME.test(name) ||
        !IMAGE_REFERENCE.test(reference) ||
        !DIGEST.test(digest)
      ) {
        throw new ReleaseError(`expected "name reference sha256:digest", got "${line}"`);
      }
      return { name, reference, digest };
    });
}

export function releaseManifest(input: Omit<ReleaseManifest, "schema">): ReleaseManifest {
  if (!isVersion(input.version)) throw new ReleaseError(`${input.version} is not X.Y.Z`);
  for (const sha of [input.source.commit, input.source.tree, input.source.candidate]) {
    if (!COMMIT.test(sha)) throw new ReleaseError(`${sha} is not a full commit or tree SHA`);
  }
  return { schema: RELEASE_MANIFEST_SCHEMA, ...input };
}

/** The images as attestation subjects, in sha256sum's format. */
export const subjectChecksums = (manifest: ReleaseManifest): string =>
  manifest.images
    .map((image) => `${image.digest.slice("sha256:".length)}  ${image.reference}`)
    .join("\n");

const manifestSchema = z.strictObject({
  schema: z.literal(RELEASE_MANIFEST_SCHEMA),
  repository: z.string().check(z.regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)),
  version: z.string().check(z.regex(VERSION)),
  kind: z.enum(["release", "hotfix"]),
  pullRequest: z.number().check(z.int(), z.positive()),
  source: z.strictObject({
    commit: z.string().check(z.regex(COMMIT)),
    tree: z.string().check(z.regex(COMMIT)),
    candidate: z.string().check(z.regex(COMMIT)),
  }),
  images: z
    .array(
      z.strictObject({
        name: z.string().check(z.regex(IMAGE_NAME)),
        reference: z.string().check(z.regex(IMAGE_REFERENCE)),
        digest: z.string().check(z.regex(DIGEST)),
      }),
    )
    .check(z.minLength(1)),
});

/**
 * Reads a release manifest from its JSON, as anyone who can edit a release
 * could have changed it: every field must have exactly its form, each image
 * once, so nothing in it can pass for more than the value it is.
 */
export function parseReleaseManifest(json: string): ReleaseManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ReleaseError(`the release manifest is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = z.safeParse(manifestSchema, raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ReleaseError(`the release manifest is invalid: ${issues.join("; ")}`);
  }
  const names = parsed.data.images.map((image) => image.name);
  if (new Set(names).size !== names.length) {
    throw new ReleaseError("the release manifest lists an image twice");
  }
  return parsed.data;
}
