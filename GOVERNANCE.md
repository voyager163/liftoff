# Liftoff governance

Liftoff is an independent, GPL-3.0-only open source project maintained by
[@voyager163](https://github.com/voyager163). This document describes how the
project itself is run.

## Decisions and responsibility

The maintainer sets project direction, triages issues, writes and reviews
code, merges changes, coordinates security reports, handles conduct concerns
and authorizes releases.

The community shapes Liftoff through issues: bug reports, root-cause analysis,
design discussion and feature requests. Outside code contributions are
accepted only when the maintainer invites them in an issue, and invited
contributors must sign the [Contributor License Agreement](docs/CLA.md). See
[CONTRIBUTING.md](CONTRIBUTING.md).

There is no guaranteed response time and no entitlement to a feature or a
merge. When a proposal is declined, the maintainer should explain the scope or
technical reason. Anyone can ask for reconsideration with new information in
the same issue. Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Liftoff currently has **one maintainer**, who can review and merge their own
pull requests after required checks pass. This is deliberate review, not
independent two-person approval. CODEOWNERS routes review requests; it does
not enforce approval by itself.

## Branches and pull requests

| Change | Target | Merge method |
| --- | --- | --- |
| Feature, fix, documentation or dependency update | `develop` | Squash |
| Release promotion from `develop` | `main` | Merge commit |
| Synchronization of `main` history back into `develop` | `develop` | Merge commit |

`develop` is the default integration branch and `main` is the release branch.

Promote `develop` into `main` with a merge commit, never a squash, and bring
`main`'s history back into `develop` before the next promotion. If both
branches have moved, start a temporary sync branch from the latest `develop`,
merge `main` into it, and merge that pull request into `develop` with a merge
commit. Don't force-push, update a protected branch directly, or squash away
history being synchronized.

Repository settings such as branch rulesets are configured on GitHub and are
not enforced by this file. Check the
[effective rules](https://github.com/voyager163/liftoff/rules) rather than
assuming protection from documentation.

## Checks and automation

- Workflows default to read-only permissions. A job gets write access only
  when it needs it, and only for that job.
- Third-party actions are pinned to full commit SHAs. Dependabot proposes
  updates after a seven-day cooldown.
- Workflow runs from outside contributors' forks require maintainer approval.
  Approving a run does not grant permission to publish or deploy.
- `pull_request_target` workflows, such as the CLA check, must never check out
  or run pull request code.
- Changes to workflows, checks and policies get deliberate maintainer review,
  even when CI is green.

Don't remove or weaken a required check just to unblock a merge. Add a
replacement check and confirm it runs before retiring the old one.

## Releases

Liftoff is being rebuilt and nothing has been released from this source yet.
The release process, including versioning, signing and distribution channels,
will be documented here before the first release. Notable changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## Access and succession

New maintainers are nominated in a public issue that records their consent,
contribution history, responsibilities and intended access. The current
maintainer decides and grants only the access needed. Update this document and
[CODEOWNERS](.github/CODEOWNERS) together.

Add independent approval requirements only once another trusted maintainer is
actually available. Removal or resignation requires revoking the affected
access and updating ownership. Never remove the last recovery path without an
agreed successor.

Never put credentials, recovery codes or private reports in the repository,
pull requests or workflow logs. Use [SECURITY.md](SECURITY.md) for
vulnerabilities and [SUPPORT.md](SUPPORT.md) for public help.
