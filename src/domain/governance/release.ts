/**
 * Releases under the GitFlow profiles: their versions, and the manifest that
 * records exactly what a release is. Pure; the release workflows gather the
 * facts and publish the manifest as an attestation.
 */

export const RELEASE_MANIFEST_SCHEMA = "liftoff.release-manifest/v1";
/** The attestation predicate type a release manifest is published under. */
export const RELEASE_MANIFEST_PREDICATE =
  "https://github.com/voyager163/liftoff/blob/develop/docs/projects/release-flow.md#release-manifest";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

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
      if (!name || !reference || !digest || extra !== undefined || !DIGEST.test(digest)) {
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
