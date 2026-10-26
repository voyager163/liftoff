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
the published checksum (fixable high and critical vulnerabilities fail it,
as does a secret anywhere but the files of installed packages, whose
documentation can carry example keys)
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
need to. Without one, the repository must let GitHub Actions create pull
requests; when it does not, the workflow stops and says which setting to
turn on. A run started that way checks the pull request as GitHub's own
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

## GOV-001 Governance is assessed read-only, with consent

`liftoff governance assess` reads the repository on GitHub through the
person's own GitHub CLI login, only after they agree (or pass `--use-gh`),
and changes nothing. It evaluates, in order: the local handoff, develop and
main with develop as the default branch, the project's workflows on the
default branch, a real successful run of every check the rulesets require
from the app that produces it, on any page of a recent commit's checks, the rulesets being active, their readback,
the drift job having passed, and the proof. The first checkpoint not done is
the next one; it says what Liftoff can do for it or what the person must do.
A repository that is not a Liftoff project, such as Liftoff's own, is
assessed against the rulesets it commits.

Verification: test

## GOV-002 One agreed step at a time

`liftoff governance apply-next` assesses again and takes only the next step,
and only one Liftoff can take: creating develop, making it the default
branch, applying the rulesets (only after every required check has run,
only as an admin, and changing only Liftoff's own rulesets by name, never
another one), or running the drift job. It asks first, with no as the
default, or needs `--yes`. With `--plan` the step must be the one the saved
plan expects, for the same repository by GitHub's id; a rulesets step
carries a digest of exactly the rulesets it sends, so a plan saved before
they changed is refused. A ruleset is read
again just before it is changed, and left as it is if it changed on GitHub
since it was assessed. Each step is recorded in `.liftoff/governance.json`
before and after, with its outcome. Only one governance command that
changes GitHub or the record runs at a time in a project.
`liftoff governance plan` lists who takes each step left.

Verification: test

## GOV-003 An interrupted step is checked, never repeated

A step recorded as started but not finished, or a proof interrupted part
way, blocks apply-next, even when every checkpoint looks done, until
`liftoff governance resume` checks it against GitHub: a step is done if
GitHub shows its checkpoint done, otherwise failed, for apply-next to offer
again after asking. For an interrupted proof, the record is not trusted:
resume puts a branch back only if the rulesets protect it and it is at a
commit that proof made, or GitHub's activity record shows it was deleted
from the recorded head, and only after the person agrees. `liftoff governance status` shows what is recorded, including an
interrupted proof, without contacting GitHub. A record for another
repository is refused.

Verification: test

## GOV-004 The rules are proved by trying what they forbid

`liftoff governance verify` compares the rules GitHub enforces with the
committed rulesets, including the branches each applies to and who may
bypass it; a ruleset that selects branches by pattern cannot match, and
without committed rulesets nothing matches. With `--prove`, once the
rulesets match, the record is this repository's and the person agrees, it
tries a direct push, a forced push and deleting each protected branch. An
earlier pass stops counting as soon as it starts. Each must be refused by a
rule; any other refusal, such as a rate limit, leaves
the proof unfinished. Each change is recorded before it is tried; anything GitHub
allows, or answers unclearly but makes, is put back while the branch is
still where the change left it, and a branch that moved since is left
alone. A change that cannot be put back stops the proof and stays recorded
for `resume`. The outcome, and the rulesets it proved, are recorded, and a
proof counts only while those rulesets are unchanged on GitHub, including
an edit in place. The drift checkpoint counts only `develop`'s own runs.

Verification: test

## GOV-005 Governance is activated on a real repository

In a disposable GitHub repository made from a generated project, the
checkpoints are taken in order from a new repository to enforced and proved
rules, and the readback matches. Read-only, `liftoff governance assess`
reports on Liftoff's own repository.

Verification: live

## FLOW-007 Projects with infrastructure deploy by digest, failing closed

A GitFlow project with Azure infrastructure gets a reusable deploy workflow
that, for one environment and candidate commit, checks every variable the
environment needs and fails naming those missing, verifies each image's
build provenance (and, when given, that the images are exactly the expected
digests), copies them into the environment's registry, runs the migrations
with the new API image, updates the container apps and waits until each new
revision is healthy with all traffic and the application is ready. A
migration still running from an earlier deployment is waited for, and one a
deployment gives up on is stopped, so two never run at once. Develop builds
deploy to dev, but only while their commit is still develop's head, so an
older build never replaces a newer one. The Release workflow deploys the
candidate to staging and qualifies it with the browser tests (with a
frontend) and the ZAP baseline before cutting the release, holding
staging's deployment lock and first checking staging runs exactly that
candidate's images; all only once the AZURE_DEPLOYMENTS variable is on, and
until then the release says it was not qualified on staging. The Production
workflow, from main only, reads the release's manifest strictly, checks the
release's tag is on main with the candidate's tree, requires each image's
attestation, made on main from the release's commit, to carry exactly that
manifest, and deploys exactly those images. Each workflow exists only for
the environments the infrastructure has.

Verification: test

## FLOW-008 Deployments work on Azure

Once Azure is set up, a develop build deploys to dev, a release is qualified
on staging, and a release deploys to production by digest, each ending with
the application ready.

Verification: live
