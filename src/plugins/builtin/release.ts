import { renderTemplate } from "../../generators/template.ts";
import type { Artifact, ProjectPlugin } from "../contracts/project-plugin.ts";

const ROOT = "templates/release";

/**
 * Trivy, which scans each image, at a version at least a week old, checked
 * against the checksum its release publishes.
 */
export const TRIVY = {
  version: "0.76.0",
  sha256: "e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7",
} as const;

/**
 * The GitFlow release flow: each image built once from develop and hotfix
 * commits, scanned, published by digest and attested; releases cut from a
 * develop commit whose CI and build passed; and, after a release merges into
 * main, its manifest attested, the tag and GitHub release published, and main
 * brought back into develop.
 */
export const releasePlugin: ProjectPlugin = {
  id: "release/gitflow",
  kind: "release",
  version: "1",
  summary: "Build once, release from develop through main, and bring main back",
  templateRoots: [ROOT],
  artifacts(context): Artifact[] {
    const images = context.components.flatMap(({ image }) => (image ? [image] : []));
    if (images.length === 0) return [];
    const bundle = context.ciBundles["release.mjs"];
    if (bundle === undefined)
      throw new Error("this release does not ship the release.mjs CI bundle");
    const workflow = (name: string, values: Record<string, string> = {}): Artifact => ({
      path: `.github/workflows/${name}`,
      ownership: "managed",
      content: renderTemplate(context.templates.read(`${ROOT}/${name}`), values, `${ROOT}/${name}`),
    });
    return [
      { path: ".github/liftoff/release.mjs", ownership: "managed", content: bundle },
      workflow("10-build.yml", {
        images: images
          .map(
            ({ name, context: directory }) =>
              `          - name: ${name}\n            context: ${directory}`,
          )
          .join("\n"),
        trivyVersion: TRIVY.version,
        trivySha256: TRIVY.sha256,
      }),
      workflow("20-release.yml"),
      workflow("30-after-release.yml", { imageNames: images.map(({ name }) => name).join(" ") }),
    ];
  },
};
