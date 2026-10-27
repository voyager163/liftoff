import { RELEASE_MANIFEST_PREDICATE } from "../../domain/governance/release.ts";
import { placedIn } from "../../domain/project/config.ts";
import { renderTemplate } from "../../generators/template.ts";
import type { Artifact, ProjectPlugin } from "../contracts/project-plugin.ts";
import { layoutValues } from "./files.ts";

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
 * brought back into develop. With infrastructure it also deploys by digest:
 * each develop build to dev, each release candidate to staging to qualify it
 * first, and a published release to production on request. Deployments fail
 * closed until Azure is set up.
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
    if (bundle === undefined) {
      throw new Error("this release does not ship the release.mjs CI bundle");
    }
    const read = (name: string, values: Record<string, string> = {}) =>
      renderTemplate(context.templates.read(`${ROOT}/${name}`), values, `${ROOT}/${name}`);
    const workflow = (path: string, text: string): Artifact => ({
      path: `.github/workflows/${path}`,
      ownership: "managed",
      content: text,
    });
    const imageNames = images.map(({ name }) => name).join(" ");
    const deploys = context.infrastructure !== undefined;
    const has = (environment: string) =>
      deploys && (context.environments as readonly string[]).includes(environment);
    const frontend = context.frontend !== undefined;

    return [
      { path: ".github/liftoff/release.mjs", ownership: "managed", content: bundle },
      {
        path: ".github/liftoff/resolve-images.sh",
        ownership: "managed",
        content: read("resolve-images.sh"),
      },
      workflow(
        "10-build.yml",
        read("10-build.yml", {
          images: images
            .map(
              ({ name, context: directory }) =>
                `          - name: ${name}\n            context: ${placedIn(context.layout, directory)}`,
            )
            .join("\n"),
          trivyVersion: TRIVY.version,
          trivySha256: TRIVY.sha256,
          deployDev: has("dev") ? read("deploy-dev-job.yml") : "",
        }),
      ),
      workflow("11-after-build.yml", read("11-after-build.yml")),
      workflow(
        "20-release.yml",
        has("staging")
          ? read("20-release-qualified.yml", {
              qualification: frontend
                ? "its browser tests and the ZAP baseline scan"
                : "the ZAP baseline scan",
              browserTests: frontend
                ? read("browser-tests.yml", layoutValues(context.layout)).trimEnd()
                : "",
            })
          : read("20-release.yml"),
      ),
      workflow("30-after-release.yml", read("30-after-release.yml", { imageNames })),
      ...(has("prod")
        ? [
            workflow(
              "50-production.yml",
              read("50-production.yml", {
                manifestPredicate: RELEASE_MANIFEST_PREDICATE,
                imageNames,
              }),
            ),
          ]
        : []),
      ...(deploys
        ? [
            workflow(
              "reusable-deploy.yml",
              read("reusable-deploy.yml", {
                imageNames,
                webVariable: frontend ? " AZURE_WEB_APP" : "",
                readyPath: frontend ? "/api/health/ready" : "/health/ready",
                // Only a new project gets the README that explains it.
                setupGuide: context.application
                  ? " See the infrastructure section of README.md."
                  : "",
              }),
            ),
          ]
        : []),
    ];
  },
};
