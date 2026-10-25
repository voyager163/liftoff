# The release flow

Projects with a GitFlow governance profile get three workflows that build,
release and publish their container images. Each image is built once, and
a release is exactly what CI qualified on `develop`. The scripts they run are
bundled into `.github/liftoff/release.mjs`, so CI needs no Liftoff
installation.

## Build once

`.github/workflows/10-build.yml` runs on every push to `develop` and to
`hotfix/…` branches, once per image: `api`, and `web` with a frontend. It:

1. builds the image from its Dockerfile;
2. scans it with [Trivy](https://trivy.dev/) 0.76.0, which fails on fixable
   high and critical vulnerabilities, and with
   [Grype](https://github.com/anchore/grype), for information only;
3. writes a CycloneDX SBOM;
4. publishes it to GitHub Container Registry as
   `ghcr.io/OWNER/REPO/NAME:COMMIT`;
5. attests how it was built (SLSA provenance) and its SBOM, in GitHub and in
   the registry.

Trivy is installed from its release and checked against the checksum the
release publishes. It is not run through Trivy's GitHub Actions, whose tags
were hijacked to steal credentials in March 2026
([CVE-2026-33634](https://nvd.nist.gov/vuln/detail/CVE-2026-33634)).

## Cutting a release

Run the Release workflow (`20-release.yml`) from `develop` with the version,
and optionally the commit; the default is `develop`'s latest. It refuses a
version that is not X.Y.Z, one already tagged, a branch that already exists,
a commit not on `develop`, and a commit whose CI or build has not passed on
`develop`. Otherwise it creates `release/X.Y.Z` at that commit and opens its
pull request into `main`.

The pull request's `branch-policy` and `release-lineage` checks confirm the
same again: the release is an exact `develop` commit whose CI and build
passed, and it contains the current `main`. Merge it with a merge commit.

## After the merge

`30-after-release.yml` runs on every push to `main`. When the push merged a
release or hotfix pull request, it:

1. checks `main` now has exactly the tree of the candidate CI qualified;
2. finds each image built from the candidate by digest, and checks with
   `gh attestation verify` that the Build workflow built it from that commit;
3. writes the [release manifest](#release-manifest) and attests it for every
   image;
4. tags `vX.Y.Z` on `main` and publishes the GitHub release, listing each
   image by digest;
5. opens `sync/main-into-develop-X.Y.Z`, the pull request that brings `main`
   back into `develop`. Merge it with a merge commit too.

Other pushes to `main` have nothing to do.

## Hotfixes

Branch `hotfix/X.Y.Z` from `main`, push it so the Build workflow builds its
images, and open its pull request into `main` with an `Incident: <reference>`
line in the description. The checks require it to start from the current
`main` and its build to have passed. After the merge, the same workflow
publishes it and brings it back into `develop`.

## A GitHub App for releases

GitHub starts no workflows for pull requests opened with the workflow token.
Create a GitHub App with read and write access to contents and pull
requests and read access to actions, install it on the repository, and set the `RELEASE_APP_CLIENT_ID`
variable and the `RELEASE_APP_PRIVATE_KEY` secret: release and sync pull
requests are then opened with the app and start their checks like any other.

Without an app, the workflows open them with the workflow token and start CI
(`01-pr-ci.yml`) on the pull request's branch and the review policy on its
base themselves, naming the pull request. Those runs report on the pull
request's exact head commit; no check is ever reported as passed without
running.

## Release manifest

The manifest records exactly what a release is. It is attested for each of
the release's images under the predicate type
`https://github.com/voyager163/liftoff/blob/develop/docs/projects/release-flow.md#release-manifest`,
and included in the GitHub release:

```json
{
  "schema": "liftoff.release-manifest/v1",
  "repository": "OWNER/REPO",
  "version": "1.2.0",
  "kind": "release",
  "pullRequest": 21,
  "source": {
    "commit": "the merge commit on main",
    "tree": "its tree, which is also the candidate's",
    "candidate": "the develop commit CI qualified"
  },
  "images": [
    { "name": "api", "reference": "ghcr.io/owner/repo/api", "digest": "sha256:…" }
  ]
}
```

Verify an image's manifest with:

```bash
gh attestation verify oci://ghcr.io/owner/repo/api@sha256:DIGEST --repo OWNER/REPO --predicate-type https://github.com/voyager163/liftoff/blob/develop/docs/projects/release-flow.md#release-manifest
```

## Limits

- Deploying to the Azure environments, and promoting a release to production
  by digest, come with infrastructure activation in a later release.
- Liftoff has checked these workflows with actionlint and its tests, but has
  not yet run them in a GitHub repository. Until it has, they are
  unqualified.
