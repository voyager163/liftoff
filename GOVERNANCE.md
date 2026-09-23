# Liftoff governance

Liftoff is an independent, GPL-3.0-only open-source project maintained by
[@voyager163](https://github.com/voyager163). Contributions, questions, and
constructive disagreement are welcome.

This document governs **Liftoff's own source repository**. It is separate from
the governance policies Liftoff generates for other projects.

## Decisions and responsibility

The maintainer sets project direction, reviews contributions, merges changes,
coordinates security reports, handles conduct concerns, and authorizes releases.
Discuss substantial behavior changes in an issue before investing in an
implementation. Record the agreed behavior in OpenSpec and explain trade-offs
in the pull request. Small fixes and documentation improvements can start with
a focused PR.

There is no guaranteed response time or entitlement to a merge. If a proposal
is declined, the maintainer should explain the scope or technical reason.
Contributors can ask for reconsideration with new information in the same
discussion. Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Liftoff currently has **one maintainer**. The process requires zero approving
reviews, and the maintainer can review and merge their own PR after its checks
pass and conversations are resolved. This is deliberate review, **not
independent or two-person approval**. CODEOWNERS routes review requests; it
does not by itself enforce approval.

## Branches and pull requests

| Change | Target | Merge method |
| --- | --- | --- |
| Feature, documentation, dependency update, or hotfix | `develop` | Squash |
| Release promotion from this repository's `develop` | `main` | Merge commit |
| Synchronization containing `main` history | `develop` | Merge commit |

`develop` is the default integration branch. `main` is the release branch.
Contributors normally work in a fork or a feature branch and open a PR into
`develop`. A fork branch named `develop` is not a release-promotion source.

Both long-lived branches must require PRs, resolved conversations, successful
required checks, and up-to-date merge candidates. Force pushes and deletion
are prohibited, with no standing administrator or bot bypass. Independent
approvals, signed commits, linear history, rebase merging, and automatic
merging are not required or enabled by this policy.

Repository settings must be activated and read back separately: committing
this document does not enforce them. Inspect the
[effective GitHub rules](https://github.com/voyager163/liftoff/rules) and PR
merge status rather than treating local policy as proof of live protection.
An administrator can change repository settings; this is not protection
against an administrator intentionally rewriting the policy.

### Preserve ancestry between releases

Promote `develop` into `main` with a merge commit, not a squash. Before the next
promotion, bring `main`'s merge history back into `develop`.

If both branches have advanced, start a temporary sync branch from the latest
`develop`, merge the latest canonical `main` into it, and submit that branch
as a PR into `develop`. Merge the sync PR with a **merge commit**. This keeps
the PR up to date without requiring a circular update of both protected heads.
Do not force-push, update a protected branch directly, or squash away the
history being synchronized.

## Checks and automation

The repository-policy check validates contribution metadata and workflow
configuration; it is not an application security audit. Existing cross-platform
and package qualification remains applicable to product changes.

Required check names and their GitHub App producers must come from actual
successful hosted runs. Establish replacement checks before retiring their
predecessors. Do not require a job that never runs for the relevant PR, hide a
failure, or remove an existing gate merely to unblock a merge. Scheduled
dependency audits and freshness reports are not automatically blocking PR gates.

Contribution workflows use read-only permissions and GitHub-hosted runners,
without publication credentials or cloud access. All outside contributors'
fork workflow runs require maintainer approval. Approval to run checks does
not grant permission to publish or deploy.

Actions are limited to the reviewed dependencies used by the workflows and
pinned to full commit SHAs. An action allowlist does not restrict every shell
command and is not a sandbox. Changes to workflows, checks, policies, and
release configuration require deliberate maintainer review even when CI is
green. A contributor-edited workflow reporting success is not independent
review of that workflow.

## Releases

The release workflow qualifies and packs a canonical version tag whose commit
is reachable from `main`. A separate publishing job receives the verified
artifact, checks its identity and digest, and waits for explicit approval in
the GitHub `npm-release` environment. It publishes that artifact, not a rebuild.

The sole maintainer may approve a release they initiated. Environment
administrator bypass is disabled. Manual workflow dispatch is
**verification-only**; it cannot publish, request publishing OIDC permission,
or bypass approval.

Version-tag creation is restricted to approved release authority. Moving or
deleting those tags is prohibited by a separate rule without a standing
bypass. If creation authority uses the repository administrator role, review
that grant before adding another administrator.

For future immutable GitHub releases, assemble every intended asset in a draft
before publishing. Correct a published artifact with a new version, not a
moved tag or replacement asset. Immutability does not retroactively protect
historical releases, freeze release notes, or control registry dist-tags.

The current npm integration remains in place. npm account, trusted-publisher,
token, and 2FA settings are outside this repository-setup change; migration
away from npm is separate work. GitHub environment approval is not proof of
npm-side account enforcement. See [release procedures](CONTRIBUTING.md#release-verification)
and the [developer guide](DEVELOPER.md#trusted-npm-publishing-overview).

## Access and succession

New maintainers are nominated through a public governance proposal, with their
consent, relevant contribution history, responsibilities, and intended access
recorded. The current maintainer makes the decision and grants only the access
needed. Update this document and CODEOWNERS together.

Before granting administrator or release access, review tag-creation authority,
release reviewers, and recovery responsibilities. Add independent approvals
only once another trusted maintainer is actually available. Removal or
resignation requires revoking the affected access and updating ownership and
release routes; never remove the last recovery path without an agreed successor.

There is currently no independent steering committee or enforcement panel.
Conduct-reporting limitations are explained in the
[Code of Conduct](CODE_OF_CONDUCT.md#reporting-and-enforcement).

## Settings changes and recovery

Changing hosted settings, creating or pushing branches, merging, and publishing
are distinct actions requiring explicit maintainer authority. Before changing
settings, capture a nonsecret baseline and review the exact settings diff.
Afterward, read back effective branch, tag, Actions, and environment rules.
Do not infer remote enforcement from files or a successful API write alone.

Keep protection active while replacing legacy rules; all overlapping rules
apply, including a legacy linear-history restriction. A defective setting
requires a reviewed, narrowly scoped correction or restoration of a known-good
setting, not a standing bypass or blanket removal of checks. Record any
unavailable capability or verification honestly.

Never place credentials, recovery codes, or private reports in the repository,
PRs, workflow logs, or public setup evidence. Use [SECURITY.md](SECURITY.md) for
vulnerabilities and [SUPPORT.md](SUPPORT.md) for public help.
