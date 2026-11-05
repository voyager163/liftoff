import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isVersion,
  parseImages,
  RELEASE_MANIFEST_PREDICATE,
  ReleaseError,
  releaseManifest,
  subjectChecksums,
} from "../../src/domain/governance/release.ts";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("FLOW-005 the release manifest", () => {
  it("accepts X.Y.Z versions without leading zeros", () => {
    for (const version of ["0.1.0", "1.2.3", "10.20.30"]) expect(isVersion(version)).toBe(true);
    for (const version of ["1.2", "v1.2.3", "01.2.3", "1.2.3-rc.1", ""]) {
      expect(isVersion(version)).toBe(false);
    }
  });

  it("reads one image per line, by digest", () => {
    expect(
      parseImages(`api ghcr.io/o/r/api ${DIGEST}\n\n web ghcr.io/o/r/web ${DIGEST} \n`),
    ).toEqual([
      { name: "api", reference: "ghcr.io/o/r/api", digest: DIGEST },
      { name: "web", reference: "ghcr.io/o/r/web", digest: DIGEST },
    ]);
    for (const line of [
      "api ghcr.io/o/r/api",
      "api ghcr.io/o/r/api latest",
      `a b ${DIGEST} c`,
      `API ghcr.io/o/r/api ${DIGEST}`,
      `api docker.io/o/r/api ${DIGEST}`,
    ]) {
      expect(() => parseImages(line)).toThrow(ReleaseError);
    }
  });

  it("records the source and images, and lists the images as attestation subjects", () => {
    const manifest = releaseManifest({
      repository: "o/r",
      version: "1.2.0",
      kind: "release",
      pullRequest: 3,
      source: { commit: SHA, tree: SHA, candidate: SHA },
      images: [{ name: "api", reference: "ghcr.io/o/r/api", digest: DIGEST }],
    });
    expect(manifest.schema).toBe("liftoff.release-manifest/v1");
    expect(subjectChecksums(manifest)).toBe(`${"b".repeat(64)}  ghcr.io/o/r/api`);
    expect(() => releaseManifest({ ...manifest, version: "1.2" })).toThrow(/is not X.Y.Z/);
    expect(() =>
      releaseManifest({ ...manifest, source: { ...manifest.source, tree: "abc" } }),
    ).toThrow(/not a full commit or tree SHA/);
  });
});

describe("FLOW-005 the manifest's predicate type is one GitHub can look up", () => {
  it("has no #fragment, and names the page that describes the manifest", () => {
    // GitHub's attestations API refuses a predicate type with a fragment.
    expect(RELEASE_MANIFEST_PREDICATE).not.toContain("#");
    const page = RELEASE_MANIFEST_PREDICATE.replace(
      "https://github.com/voyager163/liftoff/blob/develop/",
      "",
    );
    expect(existsSync(path.resolve(import.meta.dirname, "../..", page)), page).toBe(true);
  });
});
