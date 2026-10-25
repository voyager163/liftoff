import { describe, expect, it } from "vitest";
import {
  isVersion,
  parseImages,
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
    for (const line of ["api ghcr.io/o/r/api", "api ghcr.io/o/r/api latest", `a b ${DIGEST} c`]) {
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
