# GitFlow governance requirements

What generated projects enforce about branches, releases and their lineage
under the GitFlow profiles.

## FLOW-001 Branches merge only where the branch model allows

A generated project with a GitFlow profile runs a `branch-policy` job in CI,
which `ci-gate` needs. On a pull request it allows:

- into `develop`: `feature/…`, `fix/…`, `chore/…`, `docs/…` and `ci/…`
  branches, `sync/…` branches that bring `main` back, and branches that
  Dependabot and the project's coding agents open;
- into `main`: `release/X.Y.Z`, only at a commit already on `develop` whose
  CI workflow passed on a push to `develop`, and `hotfix/X.Y.Z`, only from
  the current `main` and with an `Incident: <reference>` line in the pull
  request's description. X, Y and Z are numbers without leading zeros, as a
  release is published, and neither version may already have a `vX.Y.Z`
  tag.

Anything else fails with what the branch should be called. Other events,
and pull requests into other branches, have nothing to check. A GitHub
error fails the job. Projects without a GitFlow profile get neither job.

Both jobs run the base branch's copy of the check, never the pull request's
own, and read the pull request as it is when they run, so editing its
description or base, which also starts CI again, or re-running the job,
always checks the current one. The incident reference must be on the
Incident line itself. When the base branch has no checks yet, the pull
request that adds them passes with a notice; a base branch whose CI runs
them but lacks their script fails.

Verification: test

## FLOW-002 What merges into main is exactly what CI qualified

A `release-lineage` job, which `ci-gate` also needs, checks that a pull
request into `main` contains every commit of the current `main`, and that
GitHub's merge result has exactly the tree of the candidate commit. A release
missing commits from `main` is told to bring `main` into `develop` with a
`sync/…` pull request first.

Verification: test

## FLOW-003 Each image is built once, scanned and attested

A GitFlow project with container images gets a Build workflow that runs on
every push to `develop` and to `hotfix/…` branches, once per image. It builds
the image, scans it with Trivy installed from its release and checked against
the published checksum (fixable high and critical vulnerabilities fail it)
and with Grype for information, publishes it tagged with its commit, and
attests its build provenance and CycloneDX SBOM. A re-run keeps an image
whose provenance shows this workflow built it for the commit, attesting its
SBOM if an earlier run did not; it never replaces an existing image, failing
instead when it cannot look one up or verify it. Once Build passes, an After
build workflow starts CI again for every open pull request into `main` at
that commit, whose branch check needs the build.

Verification: test

## FLOW-004 Releases are cut from a qualified develop commit

The Release workflow, run from `develop` with a version, creates
`release/X.Y.Z` at a `develop` commit whose CI and build passed and opens
its pull request into `main`. It refuses anything else: another branch, a
version that is not X.Y.Z or is already tagged, a release branch already at
another commit, a commit not on `develop`, or one whose CI or build has not
passed. Without a release app it starts CI and the review policy for the
pull request, and CodeQL, at its exact head commit; with one it does not
need to. A run started that way checks the pull request as GitHub's own
would: the branch checks run its base's copy, dependency review compares its
base and head, and CodeQL reports on the pull request. Re-running the workflow after a failure resumes the release it cut,
reusing the branch and pull request rather than refusing or duplicating them.

Verification: test

## FLOW-005 A merged release is checked, attested, published and synced

After a push to `main` that merged a release or hotfix pull request, the
After release workflow checks `main` has exactly the candidate's tree, finds
each image built from the candidate by digest and verifies its provenance,
attests the release manifest for every image, tags `vX.Y.Z` (never twice),
publishes the GitHub release, and opens the `sync/…` pull request into
`develop`, unless `develop` already has everything on `main`. When `develop`
has moved on, the sync branch merges it in, so it is up to date and its
checks cover what merging it gives; a conflict is left for a person to
resolve in that pull request. Other pushes to
`main` have nothing to do. Re-running it after a failure finishes the
release: a tag already on the same commit, a GitHub release that records the
same manifest and the sync pull request are reused, and a tag on any other
commit, or a release without that manifest, is refused.

Verification: test

## FLOW-006 The release flow works on GitHub

In a GitHub repository made from a generated project, the build, release,
after-release and sync workflows run end to end, with and without a release
app, and a release whose tree was changed fails the lineage check.

Verification: live
