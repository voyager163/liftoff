## 1. Confirm the setup boundary and owner inputs

The owner excluded npm account settings and trusted-publisher configuration on
2026-09-23 because distribution is moving away from npm in a separate change.
Those activities are not completion requirements here. GitHub-side release
safeguards and preservation of current publishing behavior remain in scope.

- [x] 1.1 Re-read working-tree state and the canonical repository's current branches, protections/rulesets, collaborators, Actions settings, private-reporting status, environments, and immutable-release setting; verify that a dated nonsecret baseline and exact intended settings diff are recorded without reading application source or alert findings.
- [x] 1.2 Obtain and verify the owner's approved private conduct-reporting contact; record the permitted public contact and sole-maintainer escalation limits, leaving this task incomplete if the input is unavailable rather than inserting a placeholder.

## 2. Complete community and contributor guidance

- [x] 2.1 Add `GOVERNANCE.md` and `SUPPORT.md` with the single-maintainer authority model, branch/release process, support route, realistic expectations, future-maintainer process, and recovery boundaries; verify links and that self-review is not described as independent approval.
- [x] 2.2 Update `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `SECURITY.md` with the approved separate channels, public-data precautions, GPL-3.0-only inbound terms, AI-assistance responsibilities, and normal PR target `develop`; verify preservation of existing technical/supported-release guidance and absence of mandatory CLA/DCO/signing requirements.
- [x] 2.3 Add `.github/CODEOWNERS` for the real maintainer, including explicit automation, release, and policy ownership; verify syntax, owner eligibility, sensitive-path coverage, and that required code-owner approval is not introduced.
- [x] 2.4 Add bug/feature issue forms, issue configuration with blank issues enabled, and the PR template; verify YAML/form structure, sanitized-report instructions, actual referenced labels, private-channel links, and normal versus release/synchronization PR guidance.

## 3. Create the original open-source README presentation

- [x] 3.1 Create original static rocket-ascent artwork at the explicitly selected `docs/assets/liftoff-hero.svg` path, or record an approved raster replacement if needed; verify the Liftoff wordmark, dark-space/illuminated-trail direction, useful alt text, self-contained rendering, and hero size at or below 300 KiB without copying Graft assets.
- [x] 3.2 Rewrite `README.md` with the agreed factual tagline, four compact linked badges, quick navigation, concise install/init/native-setup flow, CLI preview, capabilities, status, and community/license links; verify it stays below 135 physical lines and distinguishes current releases from the planned rewrite.
- [x] 3.3 Relocate lengthy README operational material into the existing appropriate guides and update affected navigation; verify discoverability of upgrade/update, repair, consent, managed-registry, telemetry, workload, prerequisite, and release guidance without inventing commands or changing behavior.
- [x] 3.4 Update the explicit package file inventory and directly related package/documentation expectations for CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, GOVERNANCE, SUPPORT, and the original assets; verify dry-run package contents and recursive local documentation links without including `.github/`, source, tests, or local evidence.

## 4. Prepare bounded repository and release automation

- [x] 4.1 Add a stable `Repository policy` check using existing tooling for named community artifacts, issue forms, ownership, workflow/ref policy, and canonical `develop` promotion into `main`; verify positive and negative fixtures, including a fork named `develop`, without adding application scanners.
- [x] 4.2 Update CI trigger/permission/concurrency configuration for PRs and post-merge `develop`/`main` runs, preserving existing product jobs and assertions; verify fork-safe read-only execution, no referenced secrets or OIDC, no path filters that strand required jobs, appropriate checkout credential handling, and cancellation limited to superseded PR work.
- [x] 4.3 Refactor `release.yml` into unprivileged qualification/pack and a separately gated publish job using reviewed full-SHA artifact upload/download actions; verify the same tarball is bound to the commit/run/version/digest and that publishing never rebuilds a substitute after approval.
- [x] 4.4 Restrict publication to canonical-repository version-tag events reachable from `main`, with environment `npm-release`, job-scoped OIDC, and non-cancelling release serialization; verify event/ref/ancestry, identity mismatch, missing artifact, and digest mismatch cases with fixtures and local temporary Git repositories, not live release tags.
- [x] 4.5 Make manual release dispatch verification-only and preserve existing package qualification, provenance, stable/prerelease selection, and canonical post-publication verification; verify no dispatch input can enable publication and no release credentials or environment approval are needed for the manual path.
- [x] 4.6 Update CONTRIBUTING, GOVERNANCE, and the release section of DEVELOPER for feature squashes, merge-commit promotion, ancestry-preserving sync branches, tag approval, draft-first immutable releases, and the explicit exclusion of npm-account changes; verify the diverged-branch synchronization procedure in a temporary Git fixture without changing this checkout's refs.

## 5. Verify the prepared local setup

- [x] 5.1 Extend and run the existing focused documentation/package checks plus the bounded repository-policy and release-configuration cases; verify exact file inventory, first-use commands, both image byte budgets, required channel links, prohibited permission/trigger combinations, and preservation of unchanged product checks without running vulnerability or license audits.
- [x] 5.2 Prepare the changed path/link/package checks for the existing Windows, macOS, and Linux CI lanes, including temporary paths containing spaces and exact filename case; verify locally available platform cases and confirm the Windows coverage is discoverable, with actual hosted platform results collected in task 6.4 rather than inferred.
- [x] 5.3 Preview the README/artwork in GitHub light/dark desktop and 375-pixel mobile layouts and check npm-compatible rendering; verify wrapping, meaningful image-free text, readable quick start, no horizontal page overflow, and combined local README image size at or below 500 KiB. Use one inspection batch and one bounded correction/confirmation pass.
- [x] 5.4 Review the complete setup diff against the explicit artifact/settings inventory and validate the OpenSpec change; verify that no application remediation, dependency refresh, generated governance-policy change, secret material, or unrelated file edit has entered scope.

## 6. Activate branch and Actions controls with explicit authority

The owner chose to leave remaining check activation pending after the initial
Ubuntu native Go preparation failure and Windows boundary-coverage failure.
The owner subsequently authorized diagnosis and repair of the Windows CI blocker
only, including necessary application/test changes, without a general audit,
disabled tests, weaker assertions, or npm-account changes. All other application
investigation/remediation remains out of scope. Existing `main`
checks and its legacy rule are retained; no merge is authorized. The manual
verification run also exposed an outdated workflow-only test reference to the
old `publish` job; that assertion now targets `qualify`, without changing repair
behavior. The corrected verification-only run `35853212074` passed on revision
`06d69606c1cc52207a4d4a8b755f0aee5ca93941`; its publishing job was skipped.

On resumption, the current revision passed the Ubuntu, macOS, repository-policy,
telemetry-infrastructure, and both template checks. Windows still fails in the
application repair/job-runner cases. Live-control readback is complete, with
the missing new required-check bindings and legacy `main` cutover explicitly
recorded as gaps rather than represented as active enforcement.

- [x] 6.1 Present the fresh live GitHub settings diff, workflow-breaking effects, excluded npm-account scope, and exact intended Git publication operations; obtain explicit authority before any branch creation/switch, commit, push, PR publication, merge, or hosted mutation, and verify the recorded approval covers the actual targets.
- [x] 6.2 Activate foundational PR/conversation/force-push/deletion rules for both `develop` and `main`, with zero approvals and no standing branch bypass; retain existing `main` required checks during migration and verify effective protection readback on both branches.
- [x] 6.3 Apply the approved action allowlist and SHA enforcement, read-only defaults, disabled bot approvals, all-outside-contributor run approval, and only necessary issue labels; verify every referenced action is allowed and private reporting, secret scanning/push protection, and existing Dependabot configuration remain enabled without reviewing their findings.
- [ ] 6.4 Publish the prepared setup through the explicitly authorized working branch/PR and observe hosted results; verify the changed path/link/package cases in Windows CI and macOS/Linux lanes and each planned context from design section 4 against its actual successful run, revision, event, and producer App ID, leaving application failures as out-of-scope blockers without investigation or bypass.
- [ ] 6.5 Bind the observed contexts as strict required checks and reconcile legacy `main` protection with the ancestry-preserving promotion model; verify no protection gap or linear-history conflict, rebase/automatic merging disabled, intended merge methods available, and the documented sync route workable.
- [ ] 6.6 After exact merge authority and all gates are satisfied, integrate the setup PR into `develop`, perform any required checked sync-branch PR, and promote it through the canonical `develop` to `main` PR; verify the intended setup/release workflow revision is present on both long-lived branches without a direct push, bypass, release tag, or package publication.

## 7. Activate the separate release boundary

- [x] 7.1 Create the approved `npm-release` environment with `voyager163` confirmation, self-approval allowed for the sole maintainer, administrative bypass disabled, and selected `v*` tags only; verify reviewer, bypass, and ref-type restrictions through readback before treating the release gate as active.
- [x] 7.2 Apply separate version-tag creation-authority and update/deletion-prohibition rulesets using supported personal-repository actor types; verify the creation exception cannot bypass tag immutability and record the access-review obligation before another administrator is added.
- [x] 7.3 Enable future GitHub release immutability and document draft-first assets plus new-version recovery; verify the setting is enabled while historical releases/tags remain unchanged, without creating or publishing a release.
- [x] 7.4 With explicit dispatch authority, run the verification-only release path from the reviewed setup revision; verify it has no publishing/OIDC/environment-approval path and retains qualification behavior, recording real OIDC publication as unexercised and npm-account settings as outside this change.

## 8. Confirm effective setup and hand off

- [x] 8.1 Read back all effective branch/tag rules, Actions permissions, merge settings, environment restrictions, reporting controls, and immutable-release state; compare them with the approved settings inventory and verify any capability/permission gaps are reported explicitly.
- [ ] 8.2 Confirm the public README/community links and configured issue/PR entry points correspond to the approved published revision and that package documentation remains self-contained; verify original artwork attribution/provenance and no claims of application security certification or completed rewrite.
- [x] 8.3 Produce a concise setup handoff identifying locally prepared artifacts, published revision, effective GitHub controls, excluded npm-account scope, and blocked or unexercised items; verify every completed task has its stated evidence and no npm-account mutation, package publication, history rewrite, cloud deployment, or automatic main-spec archival was performed as part of setup.

## Execution handoff

- Setup implementation is published in draft PR #96. The qualified implementation
  revision is `06d69606c1cc52207a4d4a8b755f0aee5ca93941`.
- [Verification-only release run](https://github.com/voyager163/liftoff/actions/runs/35853212074)
  passed qualification, package checks, exact-tarball smoke, and artifact upload.
  Publication was skipped; no publishing environment was entered.
- [Repository policy](https://github.com/voyager163/liftoff/actions/runs/35847485911)
  passed. [Application CI](https://github.com/voyager163/liftoff/actions/runs/35847485917)
  passed Linux, macOS, infrastructure, and both template lanes; Windows failed
  in application repair/job-runner cases. No application-source diagnosis or
  remediation was performed.
- Readback confirms foundational branch ruleset `23872385`, tag creation rule
  `23872476`, tag immutability rule `23872477`, the pinned Actions allowlist,
  outside-contributor approval, the protected `npm-release` environment, and
  future-release immutability.
- Full enforcement is not complete: the new branch ruleset has no required-check
  bindings yet; legacy `main` check requirements, administrator exemption, and
  linear-history restriction remain pending replacement. No failing gate was
  removed or bypassed.
- Tasks 6.4, 6.5, 6.6, and 8.2 remain blocked. Merges are not authorized, and
  the new README/community files are not on the default branch yet.
- npm account/publisher settings, the distribution migration, application
  hardening, releases, and cloud deployment remain outside this change.
  Real OIDC publication is unexercised; this change has not been archived.
