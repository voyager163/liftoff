# The release flow

Projects with a GitFlow governance profile get workflows that build,
release, publish and deploy their container images. Each image is built once, and
a release is exactly what CI qualified on `develop`. The scripts they run are
bundled into `.github/liftoff/release.mjs`, so CI needs no Liftoff
installation.

## Build once

`.github/workflows/10-build.yml` runs on every push to `develop` and to
`hotfix/…` branches, once per image: `api`, and `web` with a frontend. It:

1. builds the image from its Dockerfile;
2. scans it with [Trivy](https://trivy.dev/) 0.76.0, which fails on fixable
   high and critical vulnerabilities and on secrets, except in the files of
   installed Python and npm packages, whose documentation can carry example
   keys; and with
   [Grype](https://github.com/anchore/grype), for information only;
3. writes a CycloneDX SBOM;
4. publishes it to GitHub Container Registry as
   `ghcr.io/OWNER/REPO/NAME:COMMIT`;
5. attests how it was built (SLSA provenance) and its SBOM, in GitHub and in
   the registry.

A commit's image is built once. A re-run keeps an image whose provenance
shows this workflow built it for that commit, and attests its SBOM if an
earlier run did not get that far. It never replaces an existing image: if it
cannot look the image up or verify it, it fails and says why.

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
requests and read access to actions, install it on the repository, and set
the `RELEASE_APP_CLIENT_ID` variable and the `RELEASE_APP_PRIVATE_KEY`
secret: release and sync pull requests are then opened with the app and
start their checks like any other.

Without an app, turn on "Allow GitHub Actions to create and approve pull
requests" in the repository's Settings > Actions > General: new repositories
have it off, and the workflows then cannot open the pull requests, which
they say. A run that stopped there resumes from the branch it created.

Without an app, the workflows open them with the workflow token and start CI
(`01-pr-ci.yml`) and CodeQL (`02-codeql.yml`) on the pull request's branch
and the review policy on its base themselves, naming the pull request. Those
runs check it as GitHub's own would: the branch checks run its base's copy,
dependency review compares its base and head, and CodeQL reports on the pull
request. They report on its exact head commit; no check is ever reported as
passed without running.

If a release or hotfix pull request's CI runs before its build has finished,
the branch check fails; when the build passes, the After build workflow
(`11-after-build.yml`) starts CI again for every open pull request into
`main` at that commit.

A sync pull request whose `develop` has moved on since the release also
merges `develop` in, so it is up to date and its checks cover what merging it
gives. If the two conflict, its description says to merge `develop` into it
and resolve them.

## Release manifest

The manifest records exactly what a release is: the commit on `main`, its
tree, the candidate CI qualified and each image by digest. It is attested for
each of the release's images and included in the GitHub release. See
[the release manifest](release-manifest.md) for its format and how to verify
it.

## Deploying

With `--infrastructure azure`, the workflows also deploy, always by digest
and never by rebuilding, through `.github/workflows/reusable-deploy.yml`:

| Environment | When | How |
| --- | --- | --- |
| `dev` | every build of `develop` | a job of the Build workflow, only while its commit is still `develop`'s head, so a slower build of an older commit never replaces a newer one |
| `staging` | when you run the Release workflow | the candidate is deployed and qualified before `release/X.Y.Z` is cut: holding staging's deployment lock, and once staging is checked to run exactly its images, the frontend's browser tests (with a frontend) and the ZAP baseline scan run against it |
| `prod` | when you run the Production workflow (`50-production.yml`) from `main` with a released version | the release's manifest is read strictly; its tag must be on `main` with exactly the candidate's tree; each image's attestation, made on `main` from the release's commit, must carry exactly that manifest; and exactly those images are deployed |

Each deployment verifies each image's build provenance, copies it into the
environment's container registry, runs the database migrations with the new
API image, updates the container apps, waits until each new revision is
healthy and takes all traffic (the previous one keeps answering until then),
and waits until the application is ready. A migration still running from an
earlier deployment is waited for first, and one a deployment gives up on is
stopped, so two never run at once.

Deployments start once Azure is set up: set the `AZURE_DEPLOYMENTS`
repository variable to `on`, and these variables on each GitHub environment
(`dev`, `staging`, `prod`):

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | the identity GitHub signs in as with OpenID Connect, which needs no secret |
| `AZURE_RESOURCE_GROUP`, `AZURE_API_APP`, `AZURE_WEB_APP`, `AZURE_MIGRATE_JOB`, `APP_URL` | the environment root's outputs |
| `AZURE_CONTAINER_REGISTRY` | bootstrap's `container_registry` output |

Until then the dev deployment and staging qualification are skipped, and a
release's pull request says it was not qualified on staging. A deployment
that does run without them fails, naming what is missing: it never reports a
deployment that did not happen. Protect the `prod` environment with
required reviewers so that a person approves each production deployment.

## Limits

- Setting up Azure for deployments, its identity and the role assignments it
  needs, comes with infrastructure activation in a later release.
- Liftoff has checked these workflows with actionlint and its tests, but has
  not yet run them in a GitHub repository or against Azure. Until it has,
  they are unqualified.
