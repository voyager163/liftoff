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

## Review

Liftoff follows the layered model in
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/):
machines do most of the reading, and human attention goes where a change's
risk calls for it. Each layer catches different problems.

1. **Before the pull request**, the author's coding agent runs the project
   checks and shows their output (`liftoff-verify`), reviews the diff in a
   fresh context (`liftoff-code-review`) and drafts the description with
   Testing, Risk and How to revert (`liftoff-pr`). These skills live in
   `assets/skills/` and are rendered into `.claude/skills/`.
2. **Required CI**: `ci-gate` passes only when lint, types, architecture
   boundaries, requirement traceability, generated-file drift and the tests
   with coverage on macOS and Windows all pass. The repository checks
   (Markdown, spelling, links, workflows) and dependency review are also
   required.
3. **AI review on every pull request**: GitHub Copilot code review, guided by
   [REVIEW.md](REVIEW.md) and [AGENTS.md](AGENTS.md).
4. **Security review**: CodeQL for TypeScript and workflows, with merging
   blocked while high or critical alerts are open; dependency review; and
   secret scanning with push protection.
5. **Risk-scaled human attention**: the `review-policy` check classifies each
   pull request from what it touches, using
   [.github/review-policy.yml](.github/review-policy.yml) as it is on the base
   branch, and reports the tier. With one maintainer no approval is required,
   so the tier sets how deep the automated review goes; workflows, rulesets,
   review instructions, installers, release and telemetry code are always
   high. `liftoff review classify` shows the same result locally.
6. **Every review thread is resolved** before merging: fixed, or answered with
   a reason.

### Branch rules

The intended rules for `develop` and `main` are committed in
[.github/rulesets/](.github/rulesets/). They are applied with
`node scripts/governance/apply-rulesets.ts --apply` by the maintainer, and only
after every check they require has run successfully on a real pull request,
so a new rule never waits on a check that does not exist. The Governance
drift workflow reads back the rules GitHub enforces each week and fails if
they differ from the committed ones.

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
