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
  request's description. Neither version may already have a `vX.Y.Z` tag.

Anything else fails with what the branch should be called. Other events,
and pull requests into other branches, have nothing to check. A GitHub
error fails the job. Projects without a GitFlow profile get neither job.

Verification: test

## FLOW-002 What merges into main is exactly what CI qualified

A `release-lineage` job, which `ci-gate` also needs, checks that a pull
request into `main` contains every commit of the current `main`, and that
GitHub's merge result has exactly the tree of the candidate commit. A release
missing commits from `main` is told to bring `main` into `develop` with a
`sync/…` pull request first.

Verification: test
