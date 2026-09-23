## Context

See `proposal.md` for the motivation and scope. This design concerns
`voyager163/liftoff` itself, not the governance profile shipped to generated
projects.

Read-only discovery on 2026-09-23 established the following baseline. Re-read
hosted settings before implementation; these observations are not permanent
proof.

| Surface | Observed baseline |
| --- | --- |
| Ownership | Public personal repository; `voyager163` is the only listed collaborator, with administrator access. |
| Branches | `develop` is the default and unprotected; `main` has legacy protection with three required OS test contexts, strict freshness, linear history, resolved conversations, and blocked deletion/force pushes. PR reviews are not configured, and administrators are exempt. |
| Community | GPL-3.0-only, README, CONTRIBUTING, SECURITY, and a custom code of conduct exist. Issue forms, a PR template, CODEOWNERS, GOVERNANCE, and SUPPORT are absent. Conduct reports currently share the vulnerability channel. |
| Actions | Read-only default token, bot PR approvals disabled, all actions allowed, SHA enforcement disabled, approval for first-time fork contributors only. Workflow action references are already SHA-pinned. |
| Reporting | Private vulnerability reporting, secret scanning, push protection, and Dependabot security updates are enabled. |
| Qualification | PR CI includes three OS test jobs, telemetry infrastructure, and two standard Node template lanes. Push CI currently names only `main`. Existing dependency/freshness schedules are separate. |
| Publication | `release.yml` supports version-tag pushes and manual dispatch, including manual publishing. It declares workflow-level OIDC permission and no environment. No environments or rulesets exist; release immutability is off. npm-side settings have not been inspected. |
| Documentation | The root README is operationally dense. Contributor guidance calls for a README under 135 lines, portable links, and packaged assets. `package.json` explicitly packages `docs`, README, DEVELOPER, and LICENSE, but not all community documents. |

The MissionSpec reference uses required PRs with zero approving reviews and no
bypass actors. It is useful precedent, not a configuration template to copy:
its application checks, license, and generated instructions do not apply here.

On 2026-09-23 the owner authorized `ask.msncontrol@gmail.com` for private conduct
reports and excluded npm account/trusted-publisher settings from this change.
Migration away from npm is separate work. Existing npm publishing behavior is
preserved behind the GitHub-side controls; npm-side enforcement is not asserted.

## Goals / Non-Goals

**Goals:**

- Make the public entry path welcoming while retaining deliberate maintainer
  control over merges and releases.
- Make controls effective on both long-lived branches without requiring an
  unavailable second maintainer.
- Keep local document/workflow preparation and GitHub configuration independently
  reviewable and verifiable, with npm/account settings explicitly outside scope.
- Keep the setup portable across the planned rewrite: a small policy surface,
  named hosted identities, and clear replacement procedures rather than new
  application-quality thresholds.
- Deliver an original, accessible, lightweight README presentation within
  GitHub/npm Markdown constraints.

**Non-Goals:**

- No application-source or history audit, vulnerability triage, dependency/license
  investigation, new CodeQL/Scorecard/application scanning gates, or remediation.
- No changes to generated governance policies, manifests, activation engines,
  runtime compatibility, cloud infrastructure, or the npm package identity.
- No claim of two-person review, administrator-proof ownership, security
  certification, or qualification of the future rewrite.
- No release, tag creation, package publication, account-wide settings change,
  or installation of a GitHub App merely to complete this setup.
- No npm trusted-publisher inspection/migration, publishing-access changes,
  account 2FA or token changes, or implementation of the separate distribution
  migration.
- No new website, frontend framework, product runtime dependency, or generic
  repository-governance engine.

## Decisions

### 1. Use the existing capability boundaries and separate setup authority

Extend `liftoff-source-repository`, `liftoff-npm-distribution`, and
`liftoff-user-documentation`. Do not alter
`liftoff-repository-governance-profile`: it describes a distinct generated
product contract, including controls that are deliberately not being adopted
for the source repository in this change.

Implementation prepares exact named files locally. Hosted changes require an
explicitly approved settings diff against fresh observations. Record
nonsecret before/after settings, target repository, relevant rule/environment
identities, and remaining owner actions in the session's evidence area; retain
the durable operating procedure in GOVERNANCE and CONTRIBUTING. Do not add
credential material or transient machine-specific evidence to the public tree.

Use explicit file and setting inventories in setup checks. Do not infer
ownership of every file below `.github/`, `docs/`, or `openspec/`; existing
OpenSpec skills and unrelated workflows remain intact. No bulk regeneration
or deletion by wildcard is part of setup.

**Alternative rejected:** applying Liftoff's generated governance activation
or MissionSpec's full hardening plan. Either expands the task into application
assessment and unrelated infrastructure.

### 2. Establish a pragmatic single-maintainer participation model

Keep `GPL-3.0-only` and its existing inbound contribution terms. Document that
contributors must have permission to submit their work, preserve applicable
third-party notices, and review AI-assisted contributions. Do not require a
CLA, DCO sign-off, signed commits, private prompts, or model transcripts.

Use these version-controlled surfaces:

| File | Responsibility |
| --- | --- |
| `GOVERNANCE.md` | Current maintainer, decision authority, branch/release process, deliberate review of policy changes, recovery, and adding/removing future maintainers. |
| `SUPPORT.md` | Public support through Issues, realistic response expectations, and separate security/conduct links. No invented SLA or nonexistent chat service. |
| `CONTRIBUTING.md` | Fork/branch to `develop`, narrow changes, current qualification commands, rights/provenance, honest reporting of checks, and human review responsibility. Preserve existing technical guidance. |
| `CODE_OF_CONDUCT.md` | Retain useful existing expectations and enforcement; add scope and a verified separate private reporting contact. Do not imply an independent enforcement panel exists. |
| `SECURITY.md` | Preserve the supported-release policy and real private advisory route; make the separation from support and conduct explicit. |
| `.github/CODEOWNERS` | Default owner `@voyager163`, with explicit workflow/release/policy ownership entries for review visibility. No required code-owner approval while the owner is the only maintainer. |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Sanitized reproduction, version/platform, expected and actual behavior. |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Problem, desired outcome, alternatives, and willingness to contribute. |
| `.github/ISSUE_TEMPLATE/config.yml` | Keep blank issues enabled; point security/conduct reports to their correct policies. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Target branch, change rationale, actual validation, documentation/behavior impact, contribution rights, and limitations. Explain the release/sync PR exceptions to the normal `develop` target. |

Reuse appropriate existing labels or create only missing labels referenced by
the new forms, with separate live authorization. Keep Issues open; retain the
current disabled Wiki/Projects/Discussions unless the owner later requests
them.

The owner supplied and authorized `ask.msncontrol@gmail.com` as the private
conduct contact. No test email was sent, so owner confirmation establishes its
purpose and publication authority, not independently tested deliverability.
Never substitute a dummy address or vulnerability form. For a complaint about the sole maintainer, describe the
limited escalation option, including GitHub platform abuse reporting where
applicable, without promising independent mediation.

**Alternative rejected:** importing a corporate CLA and corporate security or
conduct contacts. Those organizations' legal and staffing arrangements are
not transferable to Liftoff.

### 3. Require PRs on both long-lived branches without artificial approvals

Use active branch rulesets targeting `refs/heads/develop` and `refs/heads/main`:

- PR required; approving review count zero.
- Code-owner approval and approval of the most recent push not required.
- Conversations resolved and observed required checks successful against the
  current merge candidate, with strict up-to-date enforcement.
- Force pushes and deletion blocked; no standing bypass actors, including
  administrators and automation.
- No signed-commit requirement or merge queue dependency.

Keep `develop` as the default. Feature/community PRs normally target `develop`.
Release promotion into `main` comes from the canonical repository's `develop`
branch, not a fork branch with the same name. A repository-policy check rejects
other promotion sources. Hotfixes follow the same reviewed integration path
for this baseline; exceptions need an explicit policy change.

Allow squash and merge commits at repository level; disable rebase merging.
Squash feature PRs into `develop`. Use merge commits for `develop` -> `main`
promotion and `main` -> `develop` back-synchronization, including synchronization
needed before a strict up-to-date promotion. If the branches have diverged,
prepare a temporary sync branch from current `develop`, merge canonical `main`
into it, and PR that branch into `develop` with a merge commit. Do not require
a direct `main`-headed PR to be up to date with a diverged `develop`; that would
create a circular freshness blocker. Git branch creation and pushes still need
explicit authorization. Do not require linear history on these branches.
Document that the repository-level merge-method switches alone
do not enforce the per-route convention; configure per-target restrictions
where supported and retain the maintainer's deliberate method selection.
Do not enable automatic merging or introduce an auto-back-merge bot.

Migrate legacy `main` protection only after the replacement rules are active
and read back. Explicitly reconcile its linear-history setting with the new
promotion model; retain its required checks until replacement identities are
proven. Rulesets and legacy protection compose, so ignoring the old rule would
leave the intended merge route unavailable.

**Alternatives rejected:** one mandatory approval would strand maintainer PRs;
an administrator bypass would hide a routine exception; squash-only promotion
would break the ancestry of repeated two-branch releases. Collapsing to `main`
alone would change the established branch model unnecessarily.

### 4. Establish required checks before requiring their identities

Add a small repository-policy check for the named community artifacts, issue
forms, CODEOWNERS, workflow permission/trigger/ref policy, and promotion route.
Use a stable job context, provisionally `Repository policy`. Prefer existing
test tooling and YAML parsing dependencies; add no application scanner.

Keep the current application CI jobs and assertions unchanged. Include
`develop` as well as `main` in post-merge push qualification, while keeping
pull-request checks runnable for forks. Do not add path filters that strand
required contexts.

Candidate contexts to verify from actual hosted runs are:

- `Repository policy`
- `Test (ubuntu-latest)`
- `Test (macos-latest)`
- `Test (windows-latest)`
- `Telemetry OpenTofu`
- `Standard Node templates (npm 10.9.4)`
- `Standard Node templates (npm 12.0.2)`

These names reflect current configuration and the intended setup check, not
proof that a run has succeeded. Read the actual successful check names,
producer GitHub App IDs, source revision, and event before binding them.
Preserve the existing three required `main` contexts during migration.
Do not turn the scheduled template audit or freshness reports into new
blocking PR gates.

A pre-existing application failure blocks promotion of that candidate gate
and is reported as outside this change; it does not authorize application
investigation, disabling tests, lowering thresholds, or silently omitting a
planned gate. The repository remains partially configured until the owner
resolves the blocker or explicitly revises the plan.

The owner has now authorized a narrow exception for diagnosing and repairing
the Windows CI blocker. Keep the repair tied to the failing Windows paths,
retain all existing assertions and deadlines, and distinguish portable protocol
fixtures from real Windows controller qualification. Other application failures
and general auditing remain outside scope.

Check source binding prevents unrelated status producers from satisfying a
gate but does not make a contributor-edited GitHub Actions workflow independent
review. The maintainer still reviews changes to workflows and checks before
merging. Replace checks during the future rewrite by first observing successor
checks, then explicitly replacing the required identities without a protection
gap.

**Alternative rejected:** copying MissionSpec's twenty contexts or enforcing
names solely because they appear in YAML would create unrelated or permanently
pending gates.

### 5. Separate contribution automation from release authority

Retain `default_workflow_permissions=read` and disabled workflow PR approvals.
Set outside-contributor approval to all outside collaborators, not only
first-time contributors. Allow only the currently used external actions:
`actions/checkout`, `actions/setup-node`, `actions/setup-python`,
`actions/setup-go`, and `opentofu/setup-opentofu`. Add reviewed full-SHA
references for `actions/upload-artifact` and `actions/download-artifact` for
the qualified release tarball handoff. Retain full commit SHAs and enforce
pinning at repository level. Dependabot continues maintaining existing
application and GitHub Actions dependencies; no refresh is performed here.

Ordinary PR checks use `pull_request`, read-only permissions, standard
GitHub-hosted runners, and no referenced secrets, OIDC grants, package write
access, or cloud credentials. Do not introduce `pull_request_target` or a
privileged `workflow_run` consumer of untrusted code/artifacts. Approval to
run a fork workflow is not permission to release, deploy, or share secrets.
Disable checkout credential persistence where it is not needed.

Keep release permissions job-scoped. Add PR concurrency cancellation to avoid
wasting runners on superseded commits; release serialization must not cancel
a publishing job in progress. Keep existing timeouts and no automatic merging.
This allowlist constrains `uses:` dependencies, not arbitrary commands in a
workflow; it is not a sandbox or a substitute for review.

**Alternative rejected:** disabling Actions or forks would undermine open
contribution; allowing every marketplace action ignores an avoidable setup
boundary.

### 6. Make release approval and artifact identity explicit

Retain the single `.github/workflows/release.yml` trusted workflow identity,
but separate non-publishing verification/build from publication. Qualify and
pack the exact release commit in an unprivileged job. Hand off the resulting
tarball through pinned `actions/upload-artifact` and
`actions/download-artifact`, binding its name, version, source commit,
workflow run, and SHA-256 digest.
Publish that verified tarball rather than rebuilding after approval.

The publish job:

- Exists only for a canonical-repository `v*` tag trigger, never a pull request
  or arbitrary branch dispatch.
- Depends on successful qualification, valid canonical package/version/tag
  identity, and proof that the tagged commit is reachable from `main`.
- References `npm-release`, requires approval from `voyager163`, permits that
  maintainer to approve their own initiated deployment, and disables
  administrative bypass. Environment deployment rules allow selected `v*`
  tags only, not identically named branches.
- Receives only the needed repository-read and OIDC permissions. Keep the
  canonical owner, repository, and `release.yml` identity used by current
  publishing. The GitHub environment approval is enforced by GitHub; do not
  claim or require a new npm-side environment binding in this change.
- Rechecks release-ref and artifact identity before publishing and retains
  canonical-registry post-publication verification, `latest`/`next`
  distinctions, and explicit failure reporting.

Manual workflow dispatch becomes verification-only, including removal of its
old publish-capable `dry_run=false` branch. It can be run without environment
approval, OIDC, or npm credentials and cannot mint a publication job. Do not
weaken existing package checks or recovery behavior when splitting jobs.

Use separate tag rulesets: an authority rule limits `v*` creation to the
approved release actor, while update/deletion prohibitions have no standing
bypass. A creation exception must not bypass immutability rules. Because this
is a personal repository, verify the supported actor types before applying;
the current API supports a direct `User` actor, so creation is bound narrowly
to `voyager163` (user ID 4599055), not to every administrator or an invented team.
Review release authority whenever maintainer access changes. Tag-name matching does not prove commit
ancestry; the workflow must check ancestry separately.

Enable GitHub release immutability for future releases. The maintainer assembles
all intended assets in a draft before final publication. Preserve existing
historical tags, assets, and releases; do not recreate them to claim retroactive
protection. GitHub immutability protects its release assets/tag, not npm
dist-tags or the npm account.

Leave npm publisher connections, publishing access, account 2FA, and tokens
untouched and uninspected. They are not owner prerequisites or completion gates
for this change. Do not add a token fallback or weaken the current trusted
publishing path. npm environment binding and account-level lockdown are not
established by the GitHub environment alone and must not be claimed.

GitHub configuration readback and a non-publishing run prove setup wiring, not
npm account settings or a real publication. Report live OIDC publication as unexercised until the next
separately authorized release; publishing a throwaway version is not a setup
test.

**Alternative rejected:** an approval label or a tag name alone is not a
publication boundary. Manual arbitrary-ref publishing and workflow-wide OIDC
would grant release authority before the intended gate. Mandatory independent
environment approval would deadlock the only maintainer.

### 7. Use Graft's hierarchy with an original Liftoff identity

The user selected original rocket-ascent artwork, not Graft's black-hole image.
The README is a GitHub/npm landing page for developers evaluating and installing
Liftoff, with contribution as the secondary action. It is not a standalone web
application and does not need a design-system framework.

Opening sequence:

1. Original cinematic rocket ascent against deep space, an illuminated upward
   trail, and a large Liftoff wordmark. Prefer a static self-contained SVG,
   with a raster alternative only if rendering quality requires it.
2. Real-text tagline: "Launch governed GenAI applications and APIs." Follow with
   one short factual explanation of reviewable scaffolding, spec workflows,
   and supported coding-agent integrations.
3. One compact row of linked npm version, CI, Node support, and GPL-3.0-only
   badges; quick links for Quick start, Documentation, Contributing, and
   Security.
4. Short installation and `liftoff init` quick start, including the actual
   selected-agent setup invocation and a link to prerequisites. Keep Codex's
   native invocation distinction and existing-repository behavior discoverable.
5. Accessible CLI preview, a short capability comparison, and a compact guide
   index. End with project status, contribution/community, reporting, and
   license guidance.

Keep the README below 135 physical lines without concealing a manual in dense
HTML or giant paragraphs. Move operational detail into the existing appropriate
guides, preserving every relevant route for updates, upgrades, repair, consent,
registry policy, telemetry, and release/contributor procedures. Do not replace
current capabilities with promises about the rewrite or declare the currently
published package abandoned merely because a rewrite is planned.

Use ordinary GitHub-supported Markdown and minimal alignment HTML. Keep meaning,
commands, and navigation outside images, with useful alt text and readable
mobile wrapping. A roughly 1600 by 640 hero allows a large wordmark without
burying installation. Target one hero asset of at most 300 KiB and total local
README image assets of at most 500 KiB. Use a deliberate self-contained dark
composition with a defined edge so it works on GitHub light and dark pages;
do not assume transparent pale text will always sit on a dark background.
No scripts, external fonts, animation dependency, or externally loaded textures
inside the asset.

Store the approved artwork at an explicit path such as
`docs/assets/liftoff-hero.svg`, retaining `liftoff-terminal.svg` unless its factual
content needs a bounded update. Create artwork and copy originally; do not
download or trace Graft's hero, substitute its product name, reproduce its
benchmark claims, or add fabricated rankings/adoption badges. Record attribution
only for legitimately used third-party material; a reference link does not grant
asset rights.

**Alternative rejected:** a text-only header misses the selected direction;
copying Graft's full badge wall adds noise and unsupported proof. A web framework
or generated docs site adds no value to this README.

### 8. Preserve package links and cross-platform contributor behavior

Explicitly package the community documents directly linked by README:
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, and
`SUPPORT.md`, alongside the existing README/DEVELOPER/LICENSE/docs assets.
Do not include the whole repository, `.github/`, tests, source, or local evidence.
Community documents link to checkout-only files through canonical GitHub URLs,
not broken relative paths into excluded directories.

Reuse existing documentation and package-surface checks and add only the
bounded setup cases they need. Asset existence, link correctness, issue-form
schema, command references, byte budgets, and package entries are deterministic
checks, not application audits. Use explicit relative asset/file inventories;
Node filesystem resolution uses `path.join`/`path.resolve`, while Markdown and
GitHub URLs retain URL separators. Test Windows paths with spaces, case-sensitive
Linux paths, and macOS without changing platform contracts.

No generated artifacts are removed by broad filename matching. When replacing
an asset or community file, identify it by exact inventory entry and verify
references first.

**Alternative rejected:** repository-only relative links would break the
published README; broad packaging would expose unnecessary contributor files.

## Risks / Trade-offs

- [Single maintainer is the final authority] -> Zero reviews and self-approved
  releases are disclosed limitations. Add independent review only when another
  trusted maintainer is actually available; an administrator can still edit
  repository policy, so "no standing bypass" is not administrator-proof security.
- [Legacy rules conflict with promotion] -> Inspect effective rule layering,
  stage the replacement first, and explicitly remove only the superseded
  legacy rule after protection equivalence is confirmed. Use an up-to-date
  temporary sync branch when strict freshness would block a direct back-merge.
- [Required-check deadlock] -> Bind observed successful identities, preserve
  existing checks, avoid path-filtered required jobs, and report outside-scope
  failures instead of bypassing them.
- [Fork workflow approval adds maintainer work] -> Accept this cost for the
  requested lockdown; keep participation itself open and explain pending runs.
- [GitHub controls do not establish npm account lockdown] -> Preserve existing
  publisher identity, exclude npm-side configuration from completion claims,
  distinguish a non-publishing run from real publication, and do not fall back
  to a long-lived token.
- [Future immutability changes recovery] -> Assemble drafts fully and recover
  published mistakes with a new version, not retagging or replacing assets.
- [A sole-maintainer conduct route cannot be fully independent] -> Use an actual
  owner-approved private contact and explain escalation limits.
- [A large banner hides useful content or fails on npm/mobile] -> Enforce
  dimensions/byte budgets, retain real text, and preview supported renderings.
- [Upcoming rewrite invalidates check names or product copy] -> Keep setup
  requirements separate, replace gates in observed order, and distinguish
  released behavior from planned work.

## Migration Plan

1. Re-read exact repository/settings ownership and working-tree state; preserve
   unrelated changes. Use the owner-approved conduct contact and record the
   explicit exclusion of npm-account configuration.
   Do not automatically create/switch a branch, commit, or push from the current
   in-place checkout.
2. Prepare community documents, original README/artwork, package allowlist,
   bounded setup checks, and revised workflows locally. Verify only the changed
   setup/documentation/package surfaces; retain existing product checks.
3. Present the live settings diff and disclose workflow-breaking effects,
   excluded npm-side scope, and known check blockers. Obtain explicit authority for the
   specific push/PR and hosted mutations before executing them.
4. Enable foundational PR/conversation/deletion/force-push protection for both
   branches without inventing required check identities; preserve existing
   `main` checks and protections. Stage compatible Actions restrictions.
5. Publish the setup through an authorized working branch and PR. Observe
   actual check identities and successful conclusions. Add each planned
   required gate only when its producer is verified. If an existing product
   gate fails, stop that activation step without investigating the application.
6. Complete the legacy protection migration and deliberate branch
   promotion/synchronization. Verify effective rules on both branches rather
   than merely reading the intended ruleset document.
7. Coordinate tag controls, release-environment approval, workflow separation,
   and future GitHub immutability. No npm settings are inspected or mutated,
   and no tag, GitHub release, npm package, cloud deployment, or billing change
   is created as part of setup.
8. Read back the effective settings, inspect a safe non-publishing workflow
   result, and record complete/blocked/unexercised states. Do not mark owner
   actions or real-publication behavior verified from local configuration alone.

Rollback is explicit and narrowly scoped: retain the pre-change nonsecret
snapshot, restore only an approved known-good setting/file, and preserve
equivalent protection while reconciling a defective rule. No default bypass,
blanket disabling of checks, history rewrite, token fallback, tag movement, or
unpublishing is permitted. Once a release is immutable, recovery uses a new
version rather than undoing the immutable asset.

## References

- [GitHub: starting an open-source project](https://opensource.guide/starting-a-project/)
- [GitHub: rulesets and rule layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [GitHub: secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub: deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub: immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [npm: trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [Microsoft: VS Code contribution guidance](https://github.com/microsoft/vscode/blob/main/CONTRIBUTING.md)
- [Microsoft: code of conduct](https://microsoft.github.io/codeofconduct/)
- [Google: releasing projects](https://opensource.google/documentation/reference/releasing)
- [Google: accepting contributions](https://opensource.google/documentation/reference/releasing/contributions)
- [Meta: Docusaurus contribution guidance](https://github.com/facebook/docusaurus/blob/main/CONTRIBUTING.md)
- [Graft: visual hierarchy reference](https://github.com/trailhq/Graft)
- [MissionSpec: public setup precedent](https://github.com/voyager163/missionspec/pull/1)
