# Liftoff modernization handoff

This file is the continuation guide for another GitHub Copilot session on
another machine. It records the repository state, decisions, validation,
remaining work, and cautions needed to continue the OpenSpec change
`modernize-liftoff-platform` without reconstructing the prior conversation.

## Start here

- Repository: `voyager163/liftoff`
- OpenSpec change: `modernize-liftoff-platform`
- Latest continuation branch: `voyager163-liftoff-modernization`
- Original implementation branch: `feature/state-custody-readiness`, preserved
  at `2914f0f1395e46abfe0ad045535e424c7a1d3ad9`.
- Ultimate base: `develop`
- Base commit used by this branch:
  `48609df1954221c296ab4bd8bfe0c382a27f01ef`
- Protected-custody implementation commit:
  `c23d1842` (`feat(governance): implement protected state custody`)
- Original handoff commit:
  `2914f0f1395e46abfe0ad045535e424c7a1d3ad9`.
- Windows qualification checkpoint:
  `d6222b30d66751857634b5fbb8a8cbf6a95d8dbc`, now pushed to the continuation
  branch. The tip containing this MacBook-return update is a later handoff commit.
- The branch tip containing this file is the handoff commit. After fetching,
  run `git rev-parse HEAD` to record its full SHA.
- OpenSpec progress is 82/136 tasks complete; 54 remain.
- Task 13.5 is complete after exact hosted-native qualification and independent
  artifact re-judgment on clean revision `94f0d63e`. Task 13.6 remains
  unchecked; task 13.7 is complete.
- Read "MacBook return checkpoint, 2026-10-12" below first for the latest
  transfer status and next actions; earlier sections retain the original
  architecture and qualification history.

Recommended checkout on the MacBook, in a new unowned checkout/worktree:

```bash
git fetch origin
git switch --track origin/voyager163-liftoff-modernization
git status --short
git log --oneline -5
git merge-base --is-ancestor c23d1842 HEAD
git merge-base --is-ancestor 2914f0f1395e46abfe0ad045535e424c7a1d3ad9 HEAD
git merge-base --is-ancestor d6222b30d66751857634b5fbb8a8cbf6a95d8dbc HEAD
openspec status --change modernize-liftoff-platform --json
openspec instructions apply --change modernize-liftoff-platform --json
```

If that local branch already exists or another app session owns it, do not force
checkout/reset it. Use the app's isolated continuation session based on the
explicit continuation branch, or fast-forward only an unowned clean checkout.
Fetching only `feature/state-custody-readiness` omits both Windows handoff
updates. The continuation branch is a documentation successor, not a new
implementation layer or a registered native-stack member.

Do not squash, rebase, reset, regenerate baselines, or reinterpret task 13.5's
passing hosted-native evidence before reading this file and the OpenSpec
artifacts.

## Original modernization objective

The user authorized autonomous completion of the
`modernize-liftoff-platform` change, including implementation, validation,
commits, stacked PRs, and merges. The broad scope is:

- Native-first distribution: Homebrew cask on Apple Silicon macOS, WinGet on
  Windows, and verified native archives/user-local installation on Linux.
- Safe Apple Silicon migration from legacy global npm installations to the
  Homebrew cask.
- Maintainable CLI/application/domain/adapter/plugin structure.
- Project scaffold, update, adoption, migration, repair, doctor, assessment,
  governance, Azure setup, activation, telemetry, and Grafana capabilities.
- LLM skills as guidance over CLI-owned plans, approvals, verification, and
  recovery rather than independent mutation authority.
- Source-complete statements, branches, functions, and lines coverage strictly
  greater than 80%.
- Updated maintained README and contributor/developer guidance.

The complete approved scope, non-goals, and remaining tasks are in:

- `openspec/changes/modernize-liftoff-platform/proposal.md`
- `openspec/changes/modernize-liftoff-platform/design.md`
- `openspec/changes/modernize-liftoff-platform/specs/`
- `openspec/changes/modernize-liftoff-platform/tasks.md`

Use those artifacts as the product source of truth. Do not infer completion
from this handoff.

## Current branch ancestry

The current branch is a dependency-ordered stack above `develop`. At the time
of the implementation commit, `origin/develop..c23d1842` contained:

```text
49162d33 feat: add reviewed governance profile transitions
46ae082b feat: bind production discovery identities
de18c693 feat: enforce Azure provider readiness
767d0648 fix: align installed package smoke contracts
9d3579c5 test: record installed package assessment
4576600a test: align provider capability count
94dffc67 test: allow bounded adoption collision setup
522485aa feat: enroll verified GitHub credentials
344e6a4c docs: complete credential readiness task
8da488a8 feat: classify Azure deployment ownership
ca281a04 feat: preserve asynchronous operation readiness
a8b00f3d docs: clarify Azure governance readiness
cc7ae059 feat: verify private backend readiness
e3e55526 feat: qualify backend network bootstrap
f3102ae1 feat(governance): qualify hosted runner readiness
9af74685 feat(governance): qualify protected state handover
c23d1842 feat(governance): implement protected state custody
```

Do not rewrite this ancestry from another checkout while an owning session or
PR may still exist.

Live GitHub state last verified on 2026-10-11:

- PR #154 is open:
  `develop <- feature/governance-profile-transitions`.
- PR #155 is open:
  `feature/governance-profile-transitions <- feature/production-discovery-identity`.
- No PR existed for `feature/state-custody-readiness`.
- `feature/backend-bootstrap-readiness` and
  `feature/hosted-runner-readiness` existed on `origin`.
- Earlier app-native PR creation was blocked because the project's linked
  GitHub account was unavailable. `gh` reads and authenticated Git pushes still
  worked. Recheck app-native account linkage before creating more stack PRs.
- Preserve the native stack workflow. Each layer should create its own
  app-native PR, bottom to top; do not replace that with ordinary `gh pr create`
  merely because linkage is unavailable.

## Completed milestone: OpenSpec task 13.5

Task 13.5:

> Preserve due-time/custody/disposal obligations and unsupported-host
> admission; verify absent protected storage/keys/locking blocks rather than
> falling back to plaintext or an unapproved execution host.

The implementation and exact hosted-native qualification are complete. Run
`38359670554`, attempt 1, passed on clean revision `94f0d63e`; the independent
audit described in the latest checkpoint below re-judged the raw reports
against a fresh archive of those committed bytes. Task 13.5 is checked. Task
13.6 remains a distinct authorization/capability gate and is not implied by
this result.

### Implemented custody model

Protected state execution now has two independent injected contracts:

- `ProtectedStateHandoverPort`: private provider workflow/backend/import
  behavior.
- `ProtectedStateCustodyPort`: host/storage/key/lock admission and due-time
  disposal.

Both are required for `private-backend-proof` and
`remote-import-verified`. The custody port is also required for
`bootstrap-state-disposed`.

A `ProtectedStateCustodyProof` binds:

- The exact handover binding digest.
- Runner ID, label, group ID, and network configuration ID.
- Stable protected host identity.
- Opaque workspace, protected storage, and key-provider references.
- `encrypted-private` storage.
- `external-nonexporting` key custody.
- Azure blob-lease locking.
- Writer quiescence.
- Explicitly disabled plaintext fallback.
- Due-time disposal support.
- Observation/expiry timestamps.
- Qualification digest.

Qualification and stable identity are deliberately separate:

- `qualificationDigest` covers the complete observation, including timestamps.
- `protectedStateCustodyIdentityDigest` covers stable authority and custody
  identity.
- A fresh observation may update timestamps but may not change runner, host,
  workspace, storage, key provider, locking, writer-quiescence, plaintext, or
  disposal identity.

`remote-import-verified` must preserve the same custody identity established by
`private-backend-proof`.

### Protected backup decision

Protected backups contain:

- `artifactDigest`
- `encryptedStateRef`
- `encryptionKeyRef`

The references are bounded opaque values such as
`state-workspace:.../bootstrap.tfstate.enc` and `key-provider:...`; they are not
project-relative files.

Multiple distinct encrypted artifacts may share the one qualified
non-exporting key reference. This is intentional:

- Artifact references must be unique.
- Every artifact must be below the qualified workspace reference.
- Every artifact must use the exact qualified key-provider reference.
- Key inventory and disposal evidence deduplicate the shared key reference.

Do not reintroduce the earlier behavior that rejected the second artifact merely
because it shared the qualified key. Disposal already models unique key
deletion.

### Retention and disposal decision

The activation-state schema was not advanced. Existing fields
`encryptedStatePathParts` and `encryptionKeyPathParts` retain deterministic
synthetic inventories:

```text
["protected-custody", sha256(opaque-reference)]
```

These values are identity records, not local filesystem paths.

`bootstrap-state-disposed` is now injected-only:

- It cannot delete project files.
- It cannot execute before the exact 30-day due time.
- It cannot treat already-missing material as success.
- It revalidates the immutable remote-import evidence and retained
  artifact/key inventory.
- It requires a fresh qualification of the same stable custody identity.
- It delegates deletion to the custody port.
- Success requires payload-free proof that every artifact and unique key
  reference was deleted at or after the due time.

Unsupported hosts, expired or changed custody, missing protected storage,
missing keys, unavailable locking, active writers, missing disposal support,
incomplete cleanup, or contradictory deletion evidence remain blocked.

### Compatibility decisions

- Current activation records strictly validate custody proof and opaque backup
  inventories.
- Historical released-v3 records continue through the existing
  `allowLegacyProtectedStateProof: true` isolation.
- Do not weaken current validation to make historical records pass.
- The public CLI still exposes no arbitrary brownfield state import,
  partition, relocation, or address migration.
- The frozen released-v3 graph asset remains unchanged:
  `2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703`.
- The current graph hash is:
  `243c2df5b113d59183287f2dac0091389a64c3798670f11ee064547ceea7a97b`.
- The current modern source-contract asset digest is:
  `sha256:74023432198c9eed026a3600a9f37cc1bb39dcda373a16929dd72b1f1b49731f`.
- Capability counts are 15 built-in, 5 injected-only, and 9 unavailable.
- `bootstrap-state-disposed` retains its historical action ID and mutation
  class to avoid unnecessary schema widening, but its destination is external
  protected custody and execution emits no file mutations.

## Files changed in the custody implementation

Core implementation:

- `src/governance-activation/protected-state-custody.ts`
  - New custody proof validation, stable identity hashing, opaque-reference
    validation, and synthetic inventory construction.
- `src/governance-activation/transition-ports.ts`
  - Custody qualification/disposal request, result, proof, and port types.
- `src/governance-activation/protected-state-handover.ts`
  - Requires handover plus custody, validates returned custody, and enforces
    custody continuity between backend proof and handover.
- `src/governance-activation/phase-bootstrap-state.ts`
  - Retains opaque inventories and delegates exact due-time deletion to the
    custody port.
- `src/domain/governance/activation/source-values.ts`
  - Strict current-record validation while preserving the historical-v3
    bypass.
- `src/domain/governance/activation/capabilities.ts`
  - Makes disposal injected-only and updates capability counts.
- `src/governance-activation/transitions.ts`
  - Requires the appropriate private capabilities for protected phases.
- `src/governance-activation/transition-planning.ts`
  - Describes disposal destinations as external custody identities.
- `src/domain/governance/activation/phase-graph-values.ts`
  - Updates disposal contract language and current graph identity.
- `assets/governance/modern/source-contracts.json`
  - Updated current authoritative source identities.
- `src/plugins/builtin/modern-release.ts`
  - Updated the release-owned current source-contract digest.

Tests and reviewed contracts:

- `tests/governance-state-handover.test.ts`
- `tests/governance-transitions.test.ts`
- `tests/governance-activation-v2.test.ts`
- `tests/modern-activation-contract-parity.test.ts`
- `tests/update-compatibility.test.ts`
- `tests/documentation.test.ts`
- `tests/fixtures/contract-baseline-changes.json`

Documentation:

- `DEVELOPER.md`
- `docs/repository-governance.md`
- `docs/troubleshooting.md`
- `src/application/state-migration/README.md`

The large change to
`tests/fixtures/contract-baseline-changes.json` is intentional. Task 13.5
successor records wrap and retain each prior reviewed change chain. Do not
flatten or regenerate the registry, and do not modify frozen baseline files.

## Validation already completed

The following passed on the exact source committed in `c23d1842`, using Node
24.21.0, npm 12.0.2, OpenTofu 1.12.6, and OpenSpec 1.11.0:

```bash
npm run build -- --pretty false

npx vitest run \
  tests/governance-state-handover.test.ts \
  tests/governance-transitions.test.ts \
  tests/governance-activation-v2.test.ts \
  tests/modern-activation-contract-parity.test.ts \
  tests/update-compatibility.test.ts \
  tests/contract-baseline.test.ts \
  tests/governance-extraction.test.ts \
  tests/plugin-generation-parity.test.ts \
  tests/generator-parity.test.ts \
  tests/documentation.test.ts \
  tests/developer-activation-documentation.test.ts \
  --maxWorkers=1 --no-file-parallelism --reporter=dot
```

Result: 11 files passed; 286 tests passed; 1 skipped; 0 failed.

Also passed:

```bash
npm run smoke:package
npm run check:repository
openspec validate modernize-liftoff-platform --strict
git diff --check
```

The package smoke reported success for `@msn-control/liftoff@0.12.3`.
Repository policy reported that named-file policy passed; hosted settings still
require separate live readback.

## Validation still required

Do not mark task 13.5 complete until these are rerun from a clean checkout of the
committed branch:

1. Full repository suite:

   ```bash
   npm run check:supported-stack
   npm run build -- --pretty false
   npm test -- --maxWorkers=1 --no-file-parallelism --reporter=dot
   ```

2. Source-complete CLI coverage, with every raw metric strictly above 80%:

   ```bash
   npm run coverage:cli -- --max-workers 1
   ```

3. Inspect `coverage/cli/coverage-evidence.json` and confirm it names the exact
   committed revision/source inventory rather than a dirty or earlier tree.

4. Rerun package smoke, repository policy, strict OpenSpec validation, and
   `git diff --check` after any correction.

5. Only after all qualification passes:
   - Change task 13.5 from `[ ]` to `[x]` in
     `openspec/changes/modernize-liftoff-platform/tasks.md`.
   - Commit that qualification/task-state update.

Earlier full-suite attempts are not qualification evidence:

- One long run suffered a Vitest/Vite transport disconnect while evaluating
  `tests/governance-task-writes.test.ts`.
- That test then passed independently: 7/7.
- Later full runs were stopped when source changed or when the user paused.
- No successful full-suite or source-complete coverage result exists for this
  custody layer. The later completed Windows runs failed on clean `2914f0f`;
  their exact results are recorded in the Windows checkpoint below.

The network-dependent command below failed twice during an internet outage and
Docker Hub anonymous rate limiting:

```bash
npm run check:supported-stack-freshness
```

It reported registry timeouts, Docker 429 responses, a MinIO authorization
error, and genuine upstream digest changes. Do not blindly refresh
`assets/supported-stack.json` as part of task 13.5. The offline deterministic
`npm run check:supported-stack` passed before the interrupted full runs.
Treat freshness as separate supported-stack maintenance requiring review of
real version/digest changes.

## Required toolchain on the next laptop

Use the repository-supported exact versions:

- Node: 24.21.0
- npm: 12.0.2
- OpenTofu: 1.12.6
- OpenSpec: 1.11.0

The prior machine's global npm 11.19.0 and OpenTofu 1.13.1 were not accepted as
qualification evidence. Session-local paths used on that machine are not
portable; install or isolate the supported versions on the new machine.

No live Azure credentials or cloud writes are required to rerun task 13.5 unit,
contract, package, or coverage qualification. Task 13.6 is where explicitly
approved disposable native/cloud qualification begins.

## Immediate continuation order

1. Fetch the latest `origin/voyager163-liftoff-modernization` handoff into an
   isolated or unowned clean checkout. Preserve the original implementation
   branch and all existing PR owner branches.
2. Confirm `c23d1842`, `2914f0f1395e46abfe0ad045535e424c7a1d3ad9`, and
   `d6222b30d66751857634b5fbb8a8cbf6a95d8dbc` are ancestors of `HEAD`, then
   read this file in full and the complete OpenSpec context.
3. Run `npm ci` if dependencies are not already installed.
4. Verify the exact toolchain versions above.
5. Run the full suite and source-complete CLI coverage.
6. Fix only failures caused by this layer; preserve unrelated historical
   contracts and existing behavior.
7. Rerun focused, package, repository, OpenSpec, diff, full-suite, and coverage
   checks after any code correction.
8. Mark task 13.5 complete and commit only when qualification is clean.
9. Proceed to task 13.6, preserving honest real-versus-mock reporting and
   partial provider checkpoints.
10. Proceed to task 13.7 for generated infrastructure/bootstrap guidance and
    the final narrow state-migration documentation pass.
11. Resume sequential app-native PR creation only after GitHub account linkage
    works. Preserve the branch/PR dependency chain and native stack metadata.

## Guardrails for future work

- Never expose generic public brownfield state migration merely because private
  custody primitives exist.
- Never fall back from protected custody to project files, plaintext, a local
  key, or a different host.
- Never reinterpret frozen released-v3 graph bytes or history as current proof.
- Never regenerate contract baselines when a reviewed successor record is
  required; preserve the complete `priorChange` chain.
- Never infer successful deletion from absent artifacts or keys.
- Never allow a refreshed custody observation to change stable custody
  identity.
- Never treat source configuration, mocks, synthetic checks, skipped checks, or
  a green package smoke as live cloud qualification.
- Never claim task 13.6, full new-environment activation, native publication,
  signing, Grafana deployment, or telemetry production deployment from the
  work in this branch.
- Keep the public existing-deployment path planning-only.
- Keep task checkboxes honest. The OpenSpec tasks file, not session-local todo
  storage, is the portable completion record.

## Repository cleanliness

Two `.reviewed-update-fixture-*` directories were left by an interrupted full
test run. They were inspected and removed before the implementation commit.
They were not source and are not included in the handoff.

At handoff creation there were no active background test processes. Run
`git status --short` after checkout; expected state is clean.

## Latest continuation checkpoint: Windows qualification, 2026-10-11

The continuation session fetched `origin/feature/state-custody-readiness` and
fast-forwarded its app-managed branch, `voyager163-liftoff-modernization`, to
`2914f0f1395e46abfe0ad045535e424c7a1d3ad9`. Both required commits were verified
as ancestors, including full implementation SHA
`c23d18427b0bd1cebd81905b6c9b11619e26e1eb`. All qualification below ran before
this documentation update, with a clean working tree and unchanged source,
tests, assets, baselines, and configuration.

OpenSpec reported the `spec-driven` schema, ready to apply, with 78/136 tasks
complete. The complete proposal, design, tasks, and all 24 delta specifications
were read. **Task 13.5 remains unchecked. Qualification failed; tasks 13.6 and
13.7 were not advanced.**

### Exact toolchain and completed runs

Node 24.21.0 and OpenTofu 1.12.6 were downloaded into session-local storage and
checked against their release SHA-256 inventories. npm 12.0.2 and OpenSpec
1.11.0 were installed there without changing the system installation. Locked
repository dependencies were restored using that toolchain. On this Windows
host, `npm.cmd` and `openspec.cmd` avoid the system's disabled PowerShell script
execution policy; the policy itself was not changed.

| Command | Actual result on committed revision `2914f0f` |
| --- | --- |
| `npm run check:supported-stack` | Passed; deterministic baseline was not refreshed |
| `npm run build -- --pretty false` | Passed |
| `npm test -- --maxWorkers=1 --no-file-parallelism --reporter=dot` | Failed: 108 failed files, 194 passed files, 7 skipped files; 1,783 failed tests, 7,994 passed tests, 508 skipped tests |
| `npm run coverage:cli -- --max-workers 1` | Failed: 1,782 failed tests, 7,990 passed tests, 513 skipped tests across 309 files |
| `node scripts/coverage-gate.mjs verify cli` | Failed; independently rejected the failed evidence and missing coverage reports |
| `npx vitest run tests/governance-state-handover.test.ts --maxWorkers=1 --no-file-parallelism --reporter=dot` | Passed: 14/14 tests |
| The eleven-file focused invocation recorded under "Validation already completed" | Failed: 2 files failed, 9 passed; 6 failed tests, 277 passed tests, 4 skipped tests |
| `npm run smoke:package` | Failed during isolated package installation: npm `EALLOWREMOTE` for an existing Microsoft-feed dependency URL |
| `npm run check:repository` | Passed named-file policy; no hosted-settings qualification implied |
| `openspec validate modernize-liftoff-platform --strict` | Passed |
| `git diff --check` | Passed |

The coverage evidence recorded:

- `revision.commit`: `2914f0f1395e46abfe0ad045535e424c7a1d3ad9`;
- `revision.dirty`: `false`, with zero changed paths;
- source inventory: 506 executable files,
  `sha256:279011126b38568d0361768167d2a0f1b30821d9afaf56539098b199c9cc4cab`;
- Node `v24.21.0`, npm `12.0.2`, Vitest and V8 coverage provider `5.0.0`,
  Vite `8.2.2`, Windows x64, and the unfiltered one-worker invocation;
- failed process exit with no termination signal.

Because tests failed and the existing configuration has `reportOnFailure: false`,
neither `coverage-summary.json` nor `coverage-final.json` was emitted. The
evidence's metrics object is empty. **No statements, branches, functions, or
lines percentage is available, and none may be claimed to exceed 80%.**

### Reproduced host blockers, not custody-layer fixes

A standalone disposable-file probe reproduced the main failure independently
of Liftoff: opening an unchanged file for reading changes its `ctimeMs` on this
host. This occurred both in the system temporary directory and session artifact
storage, while inode/device, size, and `mtimeMs` remained unchanged. Existing
strict readers consequently report `file changed before inspection` or
`Preview file changed while reading`. The preview check at
`src/adapters/filesystem/update-previews.ts:453-455` was traced to pre-custody
commit `c865dbf6`; the custody implementation did not change it. The six focused
suite failures also stop at this existing preview integrity guard, including
the disposal transition test.

The same independent probe established that native file-symlink creation is
denied with `EPERM`. Installed-tool and historical/path tests therefore cannot
qualify their native link cases here. Full runs also reported Windows controller
admission failures and obsolete snapshots after unsuccessful fixture setup.
These are not permission to weaken freshness checks, fabricate native
capabilities, skip failing files, increase acceptance thresholds, or regenerate
historical fixtures.

WSL has no installed distribution, and the committed hosted CI uses Node
24.20.0 for its full-suite and CLI-coverage lanes. Those lanes cannot substitute
for the explicitly requested Node 24.21.0 qualification without a separately
reviewed toolchain change. No cloud credentials or customer resources were used,
no host security policy was changed, and no Azure/native/cloud success was
inferred from the injected custody tests. The required next input is a
qualification host with stable read metadata and the native capabilities
required by the unchanged tests, using the exact toolchain above.

The package-smoke failure is separate: npm 12 refused a dependency tarball URL
on the already configured Microsoft feed. No registry was replaced and no
remote-source policy bypass was applied. Review that existing package-install
prerequisite in its own scope rather than changing locks or mirrors to pass
task 13.5.

### Retained evidence and stack state

Full logs and the copied coverage evidence remain in this session's artifact
storage as `custody-full-suite.log`, `custody-cli-coverage.log`,
`custody-coverage-evidence.json`, `custody-focused-suite.log`,
`custody-package-smoke.log`, and `custody-coverage-verification.log`. They are
not package assets, source changes, or portable qualification for another
revision.

Live GitHub readback still found PR #154 and PR #155 open. Filtered native-stack
membership was empty for both; the dependent PR chain exists but is not yet
registered as a native stack. PR #154's head is now
`1fef0d2ff7187a02b1d03bbeef4bcdaf6a028d85`, with passing reported checks.
PR #155 remains at `46ae082bb9f2ff30b7a151965900424cf9f11f48` with failed
reported platform and CLI-coverage checks. The newer #154 head contains
separate versions of installed-package and bounded-collision corrections
already represented in the handoff ancestry. Do not rewrite either owner branch,
drop those commits, merge failing work, or claim stack registration occurred.

No implementation or task checkbox was changed in this continuation. The next
session must rerun full-suite, source-complete coverage, focused and package
qualification on a capable host before completing task 13.5. Private handover
and custody production ports remain unregistered by the public CLI; task 13.6
still needs actual approved disposable host/cloud evidence, not this failed
Windows run or success-shaped test injections.

## MacBook return checkpoint, 2026-10-12

The user requested a complete committed handoff before returning to the
MacBook. This update changes only `resume.md`; it does not implement another
OpenSpec task or reinterpret failed qualification as success.

### Work done and work not done

| Area | Done | Not done / next gate |
| --- | --- | --- |
| Source and planning context | Fetched the custody branch, verified both required commits, read the complete handoff and all OpenSpec artifacts, and invoked `openspec-apply-change` for the named change | No implementation code, frozen baseline, contract chain, or OpenSpec task checkbox changed during the Windows continuation |
| Toolchain | Isolated and verified Node 24.21.0, npm 12.0.2, OpenTofu 1.12.6, and OpenSpec 1.11.0; restored locked dependencies | Windows binaries and session-local installations do not transfer to macOS; verify the exact native MacBook tools rather than accepting earlier global versions |
| Qualification | Completed the full suite, source-complete CLI coverage, focused tests, package smoke, policy, build, and strict OpenSpec checks; retained their actual results in the Windows checkpoint | Full suite, focused suite, package smoke, and coverage did not qualify; every coverage metric still needs a fresh measured result strictly above 80% |
| Root-cause investigation | Reproduced read-induced `ctimeMs` drift and denied file symlinks outside Liftoff, and traced representative failures to pre-custody integrity readers | No host security setting, integrity guard, registry policy, lockfile, fixture, timeout, or coverage scope was weakened to make this host pass |
| Protected custody and cloud | Preserved strict current records, frozen released-v3 history, opaque retained inventories, and injected-only handover/disposal boundaries | No production custody/handover ports supplied, no cloud resources or credentials used, and no disposable native/cloud qualification or live disposal performed |
| Remaining modernization | Kept the existing dependency order and truthful 78/136 progress | Tasks 13.5-13.7, remaining native distribution/upgrade/migration, application activation, client reporting, Grafana/deployment, and integrated release tasks remain as recorded in `tasks.md` |
| Git and PRs | Committed the first Windows checkpoint as `d6222b3`; successfully pushed and verified it on `origin/voyager163-liftoff-modernization` on 2026-10-12 | No PR created, retargeted, registered in a native stack, or merged; app-native GitHub account linkage was not requalified |

### Decisions carried forward

The Windows failure is not a reason to broaden this layer into unrelated
filesystem/platform repair. Rerun the committed bytes on the MacBook first.
The independent host probe explains representative freshness failures but does
not establish that every failed test has the same cause or that macOS will pass.
If failures persist, diagnose them against the custody-layer diff and fix only
its root causes within the approved scope. Preserve historical contracts and
the complete reviewed `priorChange` chains; do not update snapshots to bless
failed execution.

The following settled custody decisions remain unchanged:

- No public brownfield state migration and no sensitive-state authority from
  local metadata update, repair, a setup request, or generic approval.
- No plaintext, project-file, local-key, different-host, or missing-material
  success fallback for protected custody.
- Current proof is strict; released-v3 history retains its isolated frozen
  interpretation without becoming current execution authority.
- Multiple distinct encrypted artifacts may share the exact qualified
  non-exporting key; key inventory and deletion evidence deduplicate that key.
- Due-time disposal is injected-only, occurs no earlier than the exact retained
  due time, requalifies the same stable custody identity, and never deletes local
  project files.
- Native, cloud, signing, publication, deployment, telemetry, and Grafana
  qualification each require their real evidence and applicable exact
  authorization; synthetic tests or a checked task cannot substitute.

### Transfer and PR ancestry

The previous three failed HTTPS push attempts were a transport blocker, not an
uncommitted-work problem. On 2026-10-12, a normal `git push --set-upstream origin
HEAD` succeeded and remote readback matched the exact `d6222b3` commit. The
original `feature/state-custody-readiness` still points to `2914f0f`. Carry this
newer documentation checkpoint through the continuation branch, without
force-pushing the original layer or creating a duplicate custody PR.

Fresh GitHub readback on 2026-10-12 still shows PR #154 and PR #155 open,
unmerged, and non-draft, with empty filtered native-stack membership:

- PR #154: `develop <- feature/governance-profile-transitions`, head
  `1fef0d2ff7187a02b1d03bbeef4bcdaf6a028d85`, reported mergeable state `clean`.
- PR #155:
  `feature/governance-profile-transitions <- feature/production-discovery-identity`,
  head `46ae082bb9f2ff30b7a151965900424cf9f11f48`, reported mergeable state
  `unstable`.

These API states are not fresh reruns of their checks. Re-read exact heads,
checks, bases, and membership before any stack mutation or merge. The
`pr-stack` workflow was loaded during the Windows continuation, but no stack
operation was performed. Keep PR creation app-native and dependency-ordered;
do not substitute `gh pr create` or individually merge a registered stack.

The detailed Windows logs and tool binaries remain in session-local artifact
storage on the Windows machine, not Git and not the npm package. The portable
results, revision, source-inventory digest, and limitations are recorded here.
They cannot replace a new macOS evidence file naming the exact measured
committed revision and complete source inventory.

### MacBook continuation order

1. Fetch the continuation handoff, verify the required ancestry and clean
   status, and read this full file plus the complete OpenSpec change context.
2. Use `openspec-apply-change` for `modernize-liftoff-platform`; verify native
   Node 24.21.0, npm 12.0.2, OpenTofu 1.12.6, and OpenSpec 1.11.0. Do not reuse
   Windows executable paths or assume the older MacBook globals are current.
3. Run the full-suite and source-complete CLI-coverage commands under
   "Validation still required" before changing source. Inspect the new evidence
   for a clean exact revision, all 506 expected source files unless reviewed
   implementation changes alter that inventory, and all four raw metrics
   strictly above 80%. Failed tests or missing reports remain a failed gate.
4. Rerun focused custody/history/contracts, package smoke, policy, strict
   OpenSpec, and diff checks. Reobserve the Microsoft-feed package prerequisite
   rather than bypassing registry policy. If a custody-layer correction is
   needed, commit it and rerun qualification on its clean committed bytes.
5. Only after qualification passes, mark 13.5 complete, commit, and push. Then
   proceed to real explicitly approved disposable qualification for 13.6 and
   evidence-backed narrow generated guidance for 13.7.
6. Continue remaining dependency-ordered actionable tasks and app-native PR
   layers, stopping honestly at external capability or authorization blockers.
   Do not archive the change or claim all modernization delivered while
   mandatory tasks remain unchecked.

## MacBook custody qualification checkpoint, 2026-10-13

This continuation used the exact native Apple Silicon toolchain required above:
Node 24.21.0, npm 12.0.2, OpenTofu 1.12.6, and OpenSpec 1.11.0. The initial
checkout was clean at `2785087c6eccb487017c75d50b36863627de5382`, and
`c23d18427b0bd1cebd81905b6c9b11619e26e1eb`,
`2914f0f1395e46abfe0ad045535e424c7a1d3ad9`,
`d6222b30d66751857634b5fbb8a8cbf6a95d8dbc`, and `2785087c` were verified
ancestors.

### Current-versus-historical custody correction

The clean initial full suite exposed the custody successor changing the current
source-contract bytes to
`sha256:74023432198c9eed026a3600a9f37cc1bb39dcda373a16929dd72b1f1b49731f`
while historical v8 release records still correctly named frozen
`sha256:b336953323f1099a429e35cb22a39c9dda48e884bc5e610bfa44424db914bcf6`
bytes and pre-custody graph hashes. The correction was committed as
`65501156334a780d6455d3332f31c583906a37a1`
(`fix: preserve pre-custody source identity`) and changed exactly these 14
files:

- `src/application/project/manifest-writer.ts`
- `src/application/project/manifest.ts`
- `src/application/project/modern-plugins.ts`
- `src/domain/governance/activation/modern-graph.ts`
- `src/domain/governance/activation/modern-identity.ts`
- `src/domain/governance/activation/phase-graph-values.ts`
- `src/domain/governance/policy/identity.ts`
- `src/domain/governance/policy/modern-context.ts`
- `src/governance-activation/modern-compatibility.ts`
- `src/plugins/builtin/modern-pre-assessment.ts`
- `tests/modern-managed-core.test.ts`
- `tests/modern-source-registry.test.ts`
- `tests/pre-assessment-source-contract.test.ts`
- `tests/project-telemetry-source.test.ts`

The correction embeds the exact captured pre-custody source-contract bytes,
reconstructs all six frozen historical phase-graph hashes, resolves historical
v8 manifests against that read-only source family, and preserves a recorded
historical identity only during ordinary maintenance. New identity creation
remains current-only, so frozen history does not become current execution
authority. The released-v3 records, historical `b336...` release declarations,
contract baselines, and complete `priorChange` chains were not changed.

Focused results after the correction:

- The three previously failing historical compatibility files passed: 106/106.
- Custody/history parity, contract baseline, governance extraction,
  plugin-generation parity, generator parity, current registry, managed core,
  and telemetry source checks passed: 12 files, 466 passed, 1 skipped.
- `npm run check:supported-stack` and
  `npm run build -- --pretty false` passed on clean `65501156`.
- The required unfiltered suite passed on clean `65501156`: 304 files passed,
  5 skipped; 10,154 tests passed, 131 skipped; duration 2719.15 seconds.
- `npm run smoke:package` passed for `@msn-control/liftoff@0.12.3`.
- `npm run check:repository` passed named-file policy; hosted settings still
  require separate live readback.
- `openspec validate modernize-liftoff-platform --strict` passed.
- `git diff --check` passed and the tree remained clean for those gates.

### Source-complete coverage remains unresolved

The first clean `npm run coverage:cli -- --max-workers 1` attempt ended partway
through the suite without a verdict or evidence file. It is retained only as
incomplete diagnostic evidence.

The completed retry ran from a clean tree at exact revision
`65501156334a780d6455d3332f31c583906a37a1` and produced a failed qualifying
evidence record:

- Source inventory: 506 executable files,
  `sha256:d224256c5587b23788bbe9a646b54d15134eeb10c134983465d1f6b8ddc89a98`.
- Test result: 10,129 passed, 25 failed, 131 skipped, 0 todo across 309 files.
- Vitest summary: 6 failed files, 298 passed files, 5 skipped files.
- The evidence parser recorded `failedFiles: 15`; do not reinterpret that
  field as a passing result or replace the actual Vitest summary.
- No statements, branches, functions, or lines percentages were produced
  because tests failed and `reportOnFailure` remains false.
- Failed files and measured file durations were:
  - `tests/isolated-hcl-parser.test.ts`: 14 failed tests, 173170 ms.
  - `tests/local-verification-transaction.test.ts`: 1 failed test, 86194 ms.
  - `tests/migrate.test.ts`: 2 failed tests, 328105 ms.
  - `tests/modern-installed-preflight.test.ts`: 3 failed tests, 325149 ms.
  - `tests/modern-successor-revalidation.test.ts`: 3 failed tests, 397354 ms.
  - `tests/repair-workspaces.test.ts`: 2 failed tests, 1207296 ms.
- Most failures were unchanged 30-second test deadlines reached under the
  long instrumented run. One `v1/spec-kit` successor revalidation case reported
  that its inputs changed; the neighboring `v3/spec-kit` case timed out.

Those same six files were immediately rerun under V8 coverage, one worker, and
the same telemetry-free CI environment. All 6 files and all 353 tests passed in
147.78 seconds. That focused command was diagnostic only and exited nonzero
because a partial test selection cannot satisfy source-complete 80.01% global
thresholds. It does not qualify coverage or replace the required unfiltered
gate.

The completed failed evidence was recovered into session artifact storage as
`macos-custody-cli-coverage-evidence-65501156-failed.json`, with artifact
SHA-256
`062ae8d896b3d606c515154485ce21b33ed77bb8fadb410acc687868761b36a8`.
The full failed log is
`macos-custody-cli-coverage-65501156-retry.log`; the incomplete first attempt
is `macos-custody-cli-coverage-65501156.log`; and the focused diagnostic is
`macos-custody-coverage-failures-focused-65501156.log`.

Host readiness did not permit another honest retry. The Mac was on battery and
fell from 66% to 62% during a bounded five-minute read-only check, with only
51-73 minutes estimated remaining versus the completed coverage run's 5465.63
seconds. Load averages remained 6.65-13.20, and a pre-existing Docker
Virtualization process intermittently consumed up to 463.7% CPU. No unrelated
process was terminated, no operating-system setting was changed, and no test
deadline, source inventory, coverage threshold, or historical contract was
weakened.

Task 13.5 therefore remains unchecked. Do not commit this checkpoint as a
qualification/task-state layer until a fresh clean source-complete run succeeds
with zero failed tests, exact revision/inventory verification, and statements,
branches, functions, and lines each strictly above 80%. A future retry should
start only when AC power or adequate battery runtime is available and host load
has materially subsided. Task 13.6 also remains unchecked: no explicit
authorization, disposable cloud scope, production custody/handover ports, or
real native/cloud evidence became available in this continuation. Synthetic
tests remain distinct from real qualification.

## Task 13.7 generated/bootstrap guidance checkpoint, 2026-10-12

This continuation resumed from clean published revision
`85846e7b74d72227fad6b77a7fae803343e267ef` and completed only the independent
task 13.7 documentation and generated-guidance scope. Tasks 13.5 and 13.6 remain
unchecked.

The maintained and current-generated guidance now distinguishes all of the
following without claiming production readiness:

- Verified reuse of an existing approved private backend/execution path.
- The narrow exception for backend resources created and handed over by the
  same recorded activation operation after exact ownership and no-change
  readback.
- Implemented phase logic, proof validation, and injected
  `ProtectedStateHandoverPort` / `ProtectedStateCustodyPort` contracts.
- The installed public CLI's missing production handover/custody port
  registration. This is an implementation integration and qualification gap;
  operator approval cannot instantiate a missing adapter.
- The separate real-capability requirement for a disposable scope, scoped
  credentials, cost/network authority, qualified host, protected storage/key
  custody, locking, retention, disposal, and exact provider evidence even after
  a production adapter exists.
- Pre-existing/brownfield deployment or state adoption, import, partition,
  relocation, and address migration remaining planning-only.
- The actual native local lane being limited to the documented
  `darwin/arm64`, OpenTofu 1.12.6 and CPython 3.14 existing-inode refactor
  profile with `synthetic-disposable-only` result. It is not Azure, production,
  relocation, partition, Windows, or Linux qualification.

The repository-maintained telemetry bootstrap README now labels its live
plan/apply sequence as an operator runbook requiring independently admitted
Azure scope and custody. Its supported backend-free repository checks are:

```bash
tofu -chdir=infrastructure/opentofu/bootstrap fmt -check
tofu -chdir=infrastructure/opentofu/bootstrap init -backend=false -input=false -lockfile=readonly -no-color
tofu -chdir=infrastructure/opentofu/bootstrap validate -no-color
```

Current manifest-v8 infrastructure README generation adds the same exact
availability boundary and distinguishes application image bootstrap from
protected state bootstrap. Frozen historical generation remains byte-identical:
the 165-case plugin-generation matrix, governance extraction, pre-custody
managed bodies, released records, and historical source identities were not
regenerated or retagged. The reviewed
`tests/fixtures/contract-baseline-changes.json` entry for
`cli-json` / `update --check --json` was advanced as a task 13.7 successor with
the complete task 13.5 record retained under `priorChange`; no baseline or
prior-change chain was flattened.

Validation used Node 24.21.0, session-local npm 12.0.2, OpenTofu 1.12.6, and
OpenSpec 1.11.0:

- `npm run build -- --pretty false`: passed.
- Focused current-generation and documentation suite:
  `tests/current-project-generation.test.ts`,
  `tests/developer-activation-documentation.test.ts`,
  `tests/generated-infrastructure.test.ts`,
  `tests/modern-managed-core.test.ts`, and
  `tests/repository-governance.test.ts`: 5 files passed, 256 tests passed.
- Frozen-history/source-contract/generation parity suite:
  `tests/contract-baseline.test.ts`,
  `tests/current-project-generation.test.ts`,
  `tests/generator-parity.test.ts`,
  `tests/governance-extraction.test.ts`,
  `tests/governance-source-of-truth.test.ts`,
  `tests/manifest-v8-source.test.ts`,
  `tests/modern-governance-source.test.ts`,
  `tests/modern-source-registry.test.ts`,
  `tests/plugin-generation-parity.test.ts`,
  `tests/pre-assessment-source-contract.test.ts`, and
  `tests/project-telemetry-source.test.ts`: 11 files passed, 496 tests passed,
  1 skipped.
- `npm run smoke:package`: passed for `@msn-control/liftoff@0.12.3`.
- `npm run check:repository`: passed named-file policy; hosted settings still
  require separate readback.
- The three backend-free bootstrap OpenTofu commands above passed.
- `openspec validate modernize-liftoff-platform --strict`: passed.
- `git diff --check`: passed.

An independently dispatched existing hosted workflow also completed partial
evidence on the unchanged pre-task-13.7 revision
`85846e7b74d72227fad6b77a7fae803343e267ef`:

- Workflow run:
  `https://github.com/voyager163/liftoff/actions/runs/38338242547`.
- Gateway shard: 211 passed, 0 failed; statements 243/258 (94.1860%),
  branches 182/223 (81.6143%), functions 64/68 (94.1176%), and lines 233/245
  (95.1020%). Source/config hashes matched committed bytes.
- macOS ARM64 parser shard: 3 files, 276 passed, 0 failed, 0 skipped.
- Runtime-inclusive development bundle: 42 passed, 0 failed, 1
  case-sensitive-host skip; all 11 actual-installed cases passed on Node
  24.21.0 `darwin/arm64`; `releaseReady=false`.
- All seven builder input hashes were verified, and the full 506-source digest
  was independently reconstructed from Git objects as
  `sha256:d224256c5587b23788bbe9a646b54d15134eeb10c134983465d1f6b8ddc89a98`.

That hosted run is not native Mac source-complete CLI coverage, does not cover
this newer task 13.7 revision, and does not qualify production custody,
handover, Azure, or task 13.6. Its CLI-coverage and platform shards were still
active when this checkpoint was recorded and must be evaluated independently
when their final evidence is available.

Task 13.7 is complete because every maintained/current-generated guidance
surface now uses only actual validated local commands and labels unavailable
production combinations as unavailable. Tasks 13.5 and 13.6 remain pending
until their distinct exact evidence requirements are met.

## Tasks 15.4-15.5 semantic telemetry checkpoint, 2026-10-12

This continuation completed the independent task 15.4 and 15.5 telemetry
delivery layer without changing the blocked custody/cloud qualification state.
OpenSpec progress advanced from 79/136 to 81/136. Tasks 13.5 and 13.6 remain
unchecked.

The production default CLI now sends exactly one schema-2 command event after
an eligible ordinary command. The event uses the final invocation-local
semantic outcome (`success`, `attention-required`, `cancelled`, or `failure`)
rather than reconstructing meaning from the numeric exit code. It reuses the
existing invocation-local delivery object and its single absolute one-second
deadline; unreachable transport, timeout, rejection, opt-out, or duplicate
delivery cannot change ordinary stdout, stderr, or exit status.

The legacy `trackCommand()` API remains available and preserves exact schema-1
zero/nonzero behavior for historical integrations. The default CLI does not
send both schemas. The new internal `reportCommandEvent()` seam accepts either
validated command schema, returns the fixed command-slot result (`delivered`,
`disabled`, or `failed` with its fixed reason), and does not invoke the CLI
lifecycle. Reusing one delivery object for a second command report returns
`failed` / `duplicate-channel` without another network request, preventing
recursive or repeated aggregate emission.

The existing fixed command/project slots, concurrent ready-channel dispatch,
HTTPS and 1-KiB validation, no-retry/no-queue/no-response-body behavior,
global opt-outs, and ordinary `CI=true` disablement remain unchanged.
Assessment, assessment help/live modes, capability discovery, repair
capability/layout inventory, and self-upgrade replacement verification remain
telemetry/disclosure-free. There is still no public project enrollment,
project report, heartbeat, or telemetry report command; those remain section
16 work.

`docs/telemetry.md` now documents the schema-2 default, immutable schema-1
history, schema-grouped operator queries during the 180-day overlap, and the
internal explicit result contract. No frozen CLI baseline or released
historical record changed.

Validation used Node 24.21.0 and session-local npm 12.0.2:

- `npm run build -- --pretty false`: passed.
- Focused telemetry, semantic outcome, documentation, project-source,
  telemetry infrastructure/bootstrap, and self-upgrade verification suite:
  13 files passed, 340 tests passed.
- Frozen/history/contract suite selected by `tests/*contract*.test.ts`:
  12 files passed, 444 tests passed.
- `npm run smoke:package`: passed for `@msn-control/liftoff@0.12.3`.
- `npm run check:repository`: passed named-file policy; hosted settings still
  require separate readback.
- `openspec validate modernize-liftoff-platform --strict --no-interactive`:
  passed.
- `git diff --check`: passed.

This checkpoint does not reuse hosted run `38338242547`, claim native
source-complete coverage, qualify production custody/cloud behavior, mutate
lower PR-owner branches, or dispatch another workflow. Continue with the next
dependency-safe OpenSpec implementation independently of tasks 13.5/13.6;
sections 14 and real section-16 project enrollment remain dependency-blocked
until their prerequisites are met.

## Hosted coverage and native-lane continuation checkpoint, 2026-10-13

The independently dispatched existing CI workflow
`https://github.com/voyager163/liftoff/actions/runs/38338242547` completed on
clean revision `85846e7b74d72227fad6b77a7fae803343e267ef`. Its Ubuntu
source-complete CLI coverage gate passed with the complete 506-source inventory
digest
`sha256:d224256c5587b23788bbe9a646b54d15134eeb10c134983465d1f6b8ddc89a98`,
9,920 passed tests, 0 failed tests, and 365 host-gated skips. Independent
verification reconstructed all 914 source/test/configuration Git blobs and the
raw metrics:

- Statements: 37,907/44,515 (85.1555%).
- Branches: 33,179/41,022 (80.8809%).
- Functions: 7,192/7,899 (91.0494%).
- Lines: 33,877/38,449 (88.1089%).

All four metrics are strictly above 80%. Six negative V8 inferred-else
counters remain uncovered and were not excluded. The raw final report, summary,
saved evidence, and independent audit agree. The independent audit is retained
outside the repository in the coordinating session as
`files/custody-hosted-38338242547-cli/independent-audit.json`.

Both Linux shards, both macOS shards, and Windows shard 2 passed. Windows shard
1 recorded 4,877 passed, 1 failed, and 281 skipped tests. The sole failed
assertion was
`tests/governance-credential-readiness.test.ts:249`: Windows synthesized file
mode `0666` where the test unconditionally expected POSIX `0600`. Consequently
all three aggregate `Test` jobs correctly remained failed; this was not waived.

The implementation already requests `mode: 0o600` for the local credential
policy transaction. Windows mode bits do not establish ACL protection, and the
policy file is metadata rather than the protected PAT. The test correction
does not skip the Windows enrollment scenario or treat Windows `chmod` as
protection: it continues to verify protected input, exact secret write,
in-memory secret zeroization, payload-free policy/readback, and provider
isolation on every host; it now also proves the persisted policy contains
neither the exact PAT nor any `github_pat_` value. Only the POSIX `0600`
filesystem assertion is conditional on a non-Windows host, matching existing
repository mode-testing patterns. Focused credential/state/repository policy
validation passed: 3 files and 145 tests.

The first attempt to dispatch the new standalone native workflow failed with
GitHub HTTP 404 because a newly named `workflow_dispatch` file is not
dispatchable until that workflow exists on the default branch. No run was
created. The same exact read-only native job was moved into the already
registered `repository.yml` workflow behind
`${{ github.event_name == 'workflow_dispatch' }}`. PR and long-lived push
events retain only their prior repository-policy job; manual dispatch runs
that short check plus the native lane, not the broad CI workflow.

The registered lane was first dispatched as run
`https://github.com/voyager163/liftoff/actions/runs/38340698042` on exact clean
revision `322351775f343267ed94bb91dfde08e6fc1c41f5`. It pins Node 24.21.0,
npm 12.0.2, OpenTofu 1.12.6, OpenSpec 1.11.0, Go 1.27.0, Python 3.14.7, and
uv 0.12.7 on `macos-15` ARM64; runs supported-stack, build, unfiltered
one-worker tests, source-complete one-worker coverage, evidence verification,
focused custody/history checks, package smoke, repository policy, strict
OpenSpec validation, and clean-tree verification; and uploads its logs,
coverage directory, and a revision/toolchain/metric-bound evidence record.

Run `38340698042` ended cancelled at `2026-10-13T04:06:47Z` after the unfiltered
full-suite step failed and the evidence-preserving coverage step began. The
coverage step was cancelled before a final summary, evidence file, or artifact
could be produced, so this run has no qualifying test count, inventory, or
coverage metrics. Its retained console log showed failures in
`modern-revalidation-records` (13), `modern-spec-kit-completion` (16),
`modern-local-publication` (22), `modern-manual-execution` (13),
`modern-local-execution` (13), `modern-manual-controls` (6),
`coverage-gate` (1), a generated Compose binding case (1), and
`modern-openspec-tool-identity` collection before any test ran. These are
diagnostic occurrences in the interrupted coverage invocation, not a complete
final failure count.

Focused reproduction identified three lane-contract causes:

- Global `npm install --global npm@12.0.2` did not reliably expose the selected
  launcher's exact package identity to Liftoff's file-bound npm admission.
  Prepending an isolated `npm@12.0.2` package `.bin` directory removed that
  identity failure.
- The job omitted the documented native execution/initialization opt-ins and
  finite identity budgets:
  `LIFTOFF_OPENSPEC_B_TESTS=1`, `OB1_VERSION_REMAINING=2`,
  `OB1_SUPPORT_REMAINING=10`, and `LIFTOFF_OI_TESTS=1`.
- Hosted macOS supplied the separately bound Compose plugin at 5.6.0 while two
  tests froze the prior incidental 5.5.1 host version. The correction retains
  5.5.1 as the minimum on release line 5, enforces that policy in production
  tool admission, and verifies the actual plugin identity/version rather than
  replacing one exact runner snapshot with another.

With isolated npm and the required budgets, the npm and missing-budget failures
disappeared locally. The laptop's ambient OpenTofu 1.13.1 still cannot execute
the exact 1.12.6 native cases, so that focused local result is not hosted-native
qualification. The ordinary focused `coverage-gate.test.ts` invocation passed;
its single interrupted-coverage occurrence has not reproduced as an independent
contract failure.

Before committing the lane correction, the following local gates passed:

- `npm run build -- --pretty false`.
- A forced-portable workflow/policy/Compose/coverage/documentation selection:
  5 files, 263 passed, 1 skipped, 0 failed.
- The exact focused custody/history selection retained by the workflow:
  15 files, 472 passed, 1 skipped, 0 failed.
- `npm run smoke:package` for `@msn-control/liftoff@0.12.3`.
- `npm run check:repository`.
- `openspec validate modernize-liftoff-platform --strict --no-interactive`.
- `git diff --check`.

The workflow's exact isolated npm installation command was also reproduced in
a disposable local prefix. The selected launcher resolved to that prefix's
`node_modules/npm/bin/npm-cli.js`, its owning package was exactly
`npm@12.0.2`, and both direct Node launcher execution and the ordinary npm
probe returned `12.0.2`; the disposable prefix was then removed. These local
checks validate the correction but do not replace a clean hosted native full
suite or source-complete coverage run.

Run `38340698042` is retained failed diagnostic evidence only. Task 13.5 remains
unchecked, and task 13.6 remains unchecked without production
custody/handover adapters, authorized disposable scope, and real cloud
evidence. The Ubuntu coverage result is separate hosted evidence and does not
replace the dedicated hosted macOS ARM64 run.

The Windows metadata portability correction and this hosted-evidence checkpoint
were published as
`028134f2ad4ca705f0b02091c99ec3c4a8678868` on
`origin/voyager163-liftoff-modernization`; local and remote readback matched and
the tree was clean before the next dispatches. The exact corrected native
candidate is:

- Workflow file: `.github/workflows/repository.yml`.
- Registered workflow name: `Repository setup`.
- Event: `workflow_dispatch`.
- Run:
  `https://github.com/voyager163/liftoff/actions/runs/38342935457`.
- Head revision:
  `028134f2ad4ca705f0b02091c99ec3c4a8678868`.
- Created at `2026-10-13T03:41:57Z`. It was queued behind run `38340698042`
  under the workflow's same-ref non-cancelling concurrency group. After the
  older run exposed the lane defects above, cancellation was requested for
  this known-nonqualifying candidate before it consumed a second full run.
  GitHub records the native job as cancelled at `2026-10-13T04:15:01Z` with
  zero recorded steps; the repository-policy job passed. It produced no native
  evidence and must not qualify `028134f2`.

The isolated npm/native-budget/Compose correction was committed and pushed as
`be537bf1871b1ed4bba2e0a69bcd8e5072b3f94b`; local and
`origin/voyager163-liftoff-modernization` readback matched and the tree was
clean at dispatch. The single replacement native candidate is:

- Workflow file: `.github/workflows/repository.yml`.
- Registered workflow name: `Repository setup`.
- Event: `workflow_dispatch`.
- Run:
  `https://github.com/voyager163/liftoff/actions/runs/38346014663`.
- Head revision:
  `be537bf1871b1ed4bba2e0a69bcd8e5072b3f94b`.
- Created at `2026-10-13T04:21:03Z`; the native job acquired a runner at
  `2026-10-13T04:25:53Z`. Repository policy, exact toolchain verification,
  clean-candidate verification, supported-stack, and build passed. The
  unfiltered full suite ran from `2026-10-13T04:26:32Z` through
  `2026-10-13T05:12:37Z` (46 minutes 5 seconds) and failed. Source-complete
  coverage then began and remains diagnostic only regardless of its result.
  The Actions logs API does not expose the in-progress job log; retrieve and
  retain the exact failed case/assertion, raw full-suite report, selected
  npm/OpenSpec/Compose identities, and coverage evidence after the job
  completes. Do not infer an environmental cause or dispatch another run
  before that evidence is inspected.

Do not dispatch a parallel duplicate. Qualification requires this run's
uncancelled native job, exact-revision evidence artifact, zero full-suite and
coverage failures, complete executable-source inventory, and every raw metric
strictly above 80%.

The existing cross-platform workflow was also dispatched on the same exact
corrected candidate to prove the Windows assertion on a real Windows host:

- Workflow file: `.github/workflows/ci.yml`.
- Registered workflow name: `CI`.
- Event: `workflow_dispatch`.
- Run:
  `https://github.com/voyager163/liftoff/actions/runs/38342935367`.
- Head revision:
  `028134f2ad4ca705f0b02091c99ec3c4a8678868`.
- Created at `2026-10-13T03:41:57Z`; status was `in_progress` at the latest
  readback with no completed job failure observed.

An independent audit of this exact `028134f2` CI run verified the completed
coverage gates without reclassifying them as native or as evidence for the
later `be537bf1` candidate:

- CLI coverage: 506 executable sources with digest
  `sha256:29dc50e427a9f68330495d42dcbab87da672e363fe1467f90d4d970acad476e4`;
  all 915 committed source/test/configuration inventory blobs verified; 9,940
  passed, 0 failed, and 365 skipped tests.
- CLI raw metrics: statements 85.1537%, branches 80.8861%, functions 91.0413%,
  and lines 88.1084%. Six negative inferred-else hits remain uncovered.
- Gateway coverage: 4 sources; all 20 committed inventory blobs verified; 211
  passed and 0 failed tests; statements 94.1860%, branches 81.6143%, functions
  94.1176%, and lines 95.1020%.

These coverage jobs ran on Linux with Node 24.20/npm 12.0.2. Run
`38342935367` attempt 1 completed successfully at `2026-10-13T04:36:31Z`.
Both Linux shards, both macOS shards, both Windows shards, all standard-template
jobs, both coverage gates, the isolated native parser, runtime-inclusive bundle,
Telemetry OpenTofu, and all three aggregate `Test` jobs passed. In particular,
the real Windows shard-1 regression proves the metadata-mode correction without
weakening protected credential delivery or treating Windows mode bits as DACL
evidence. The independent receipts are retained outside the repository under
`files/custody-hosted-38342935367-coverage/`. This evidence freshens the
cross-platform/coverage record for `028134f2` only; it does not qualify task
13.5 for `be537bf1` and does not establish task 13.6 production custody.

An additional independent platform-report audit verified all six raw shard
reports against run `38342935367`, attempt 1, exact head `028134f2`, and each
successful job's `head_sha`. On each operating system, the two shards formed an
exact partition of all 310 tracked `.test.ts` files: 155 files per shard with
no overlap or omission. Raw results were:

- Linux shard 1: 4,982 passed, 0 failed, 188 skipped.
- Linux shard 2: 4,962 passed, 0 failed, 173 skipped.
- macOS shard 1: 4,978 passed, 0 failed, 192 skipped.
- macOS shard 2: 4,962 passed, 0 failed, 173 skipped.
- Windows shard 1: 4,889 passed, 0 failed, 281 skipped.
- Windows shard 2: 4,922 passed, 0 failed, 213 skipped.

The exact credential-enrollment regression passed in Windows shard-1 job
`115117764571`, and installed-package smoke steps succeeded on each operating
system's shard 1. All 20 jobs and all three aggregate jobs succeeded. The
receipt and retained API metadata/raw reports are stored outside the repository
under `files/custody-hosted-38342935367-platforms/`. This remains hosted
Node-24.20 evidence for `028134f2`; it is not the exact-toolchain macOS ARM64
qualification for `be537bf1` and is not production custody qualification.

The independently audited native development-bundle/parser artifacts for the
same CI run also passed against exact `028134f2`:

- Source/config digest:
  `sha256:29dc50e427a9f68330495d42dcbab87da672e363fe1467f90d4d970acad476e4`.
- All seven builder Git blobs, package/lock binding, package
  `@msn-control/liftoff@0.12.3`, and darwin/arm64 artifact identity verified.
- Development installed bundle: 2 files, 42 passed, 0 failed, 1
  case-sensitive-host skip; all 11 actual-installed cases passed.
- Required native HCL: 3 files, 276 passed, 0 failed, 0 skipped.

The artifact retains `releaseReady=false`. Its receipt is stored outside the
repository under
`files/custody-hosted-38342935367-native/independent-audit.json`. It is
development bundle/parser evidence only, not the full exact-toolchain
`be537bf1` native custody run, production execution, or signed-release
qualification.

Neither cancelled native attempt on `3223517` or `028134f2`, nor the separate
Linux coverage evidence above, can qualify task 13.5. Only the exact
`be537bf1` replacement run can provide the required hosted native artifact.
The existing telemetry 15.4/15.5 contribution remains preserved, but no
further telemetry transport or enrollment work belongs to this continuation.
The owning `voyager163-telemetry-delivery-budget` layer is reconciling only
those telemetry commits/contracts onto its independent `develop`-based branch;
it does not import this continuation's custody, resume, or workflow changes.

### Completed lower delivery chain

The existing lower implementation chain is now fully delivered. Native stack
156 was registered with the exact ordered membership `[154, 155]` and landed
only through top member 155 by merge-async operation
`c0374310-6a6b-427c-a1e0-11e786dfafb3`. The reviewed merge settings were
`direct_merge`, viewer-default `SQUASH`, and `bypass_rules=false`; no member was
merged independently.

The verified postcondition is:

- PR 154 merged as `072b1c20d40ae78292065dc130904ba4dffbead6`.
- PR 155 merged into `develop` as
  `692088e953801adef9d055856df523bbc83ebbf9`.
- Stack 156 is closed and retains both merged members. Do not unstack or
  recreate it.

GitHub automatic branch cleanup deleted both owning refs after the stack
landed. Their respective owning sessions restored only the exact prior
published refs under absence leases:

- `feature/governance-profile-transitions` at
  `1fef0d2ff7187a02b1d03bbeef4bcdaf6a028d85`.
- `feature/production-discovery-identity` at
  `a740b6f396e6999a85b8979b29172d19162d9ac0`.

Shared repository settings and the main checkout were unchanged. Preserve
those upstream implementation branches and their source history. Future
native successors start from the recorded ultimate base `develop` once every
older stack member is merged; they do not reuse, unstack, or recreate stack
156.

An isolated owning session
`c199f3bf-8e36-4d4d-807e-b915b0ccd9d6` is implementing independent telemetry
tasks 15.4 and 15.5 from qualified `develop`
`692088e953801adef9d055856df523bbc83ebbf9`, where task-15 dependencies 1 and 3
are met. Do not duplicate that telemetry transport work or mutate its branch.
The current continuation remains limited to custody/native qualification and
the Windows metadata-mode correction. The stack landing does not waive tasks
13.5 or 13.6 and does not convert hosted Ubuntu coverage into native evidence.

App-native PR 159 is open and non-draft for the separate group-16 owner:
parent PR 158 branch `voyager163-telemetry-delivery-budget` at
`2775077190df79ee5e8b81f8d04a6e12c0743249` to child branch
`voyager163-project-telemetry-enrollment` at
`abbdd7e27c007f505b77638d1126869d677a0120`. Session
`48ac3104-697c-468e-8a00-3bcf0c860bdc` owns only tasks 16.1, 16.2, 16.7, and
16.8; its branch-local state is 75/136 and does not change this continuation's
global 81/136 state until scoped integration. Task 16.3 still requires a
qualified installer migration. Tasks 16.4 through 16.6 lack a genuinely
qualified published Linux heartbeat archive/digest and exact activation
producer; public heartbeat/activation entry points correctly refuse. There is
no active cron or production effect.

Exact-head CI run `38348040097` and repository setup run `38348040104` had only
just started at the ownership report and were not qualification evidence.
Registration/landing remains pending until the owning session finishes or
repairs hosted qualification. Do not duplicate this work, import its source or
flags, mutate its refs, or infer production enrollment from a waitable run.

Parent review subsequently reproduced a real old-head defect at `abbdd7e`: the
project reporter nests observation plus transport inside the outer shared
`withinBudget`. After the fetch starts and the deadline expires, the transport
correctly returns `attempted: true`, but the outer race discards that result
and reports `attempted: false`. An exact committed-control-flow reproduction
observed one fake fetch, abort, `true` from the inner transport, and `false`
from the outer reporter; it made no live request. The owning session has the
repair and actual-report regression instructions. Treat `abbdd7e` and its CI
as diagnosis only.

Session `48ac3104-697c-468e-8a00-3bcf0c860bdc` completed and pushed the surgical
repair as fresh PR-159 head
`c09be2ecf18bca59878cc2f39427cc51a2e07a18`; parent PR-158 head
`2775077190df79ee5e8b81f8d04a6e12c0743249` remains unchanged. Only
observation/preparation remains inside the outer budget, while the existing
bounded channel returns its truthful `attempted` result under the same
1,000-millisecond deadline. Parent review covered the actual reporter and CLI
regressions. The owner reported 17 files, 559 tests, build, installed-package
smoke, repository policy, supported-stack, and strict OpenSpec validation
passing. Fresh CI run `38349182167` and repository-setup run `38349182149`
then exposed another real contract failure: Linux shard 2 failed
`tests/telemetry-contract.test.ts:41` because the exhaustive anonymous
exclusion set omitted six new management IDs. Treat `c09be2e` as diagnostic
only. The owner fixed all six exclusions plus seven regressions without a
schema or budget change and published replacement PR-159 head
`2d87c0825488e3840253cae114408a20e550612a`. Fresh CI run `38350921935`
and repository-setup run `38350921933` were pending at the latest report.
Grafana's ordinary forward merge of `2d87c08` is approved. Registration/landing
remains pending until the replacement head qualifies.
Tasks 16.3 through 16.6 remain unchecked/refusing; source/schema/interfaces are
unchanged, and no source or global task flag is copied into this continuation's
81/136 state.

PR 158 also already had direct-head workflow dispatch `38344594888`; no new
dispatch was created. The run completed successfully with all 20 jobs on exact
parent head `2775077190df79ee5e8b81f8d04a6e12c0743249`. All six raw platform
reports formed exact 302-file partitions per operating system: 151 files per
shard with no overlap or omission. Results were Linux 1 4,959/0/188, Linux 2
4,907/0/173, macOS 1 4,955/0/192, macOS 2 4,907/0/173, Windows 1
4,866/0/281, and Windows 2 4,867/0/213 passed/failed/skipped. Package smoke and
aggregate gates passed.

Independent direct-head coverage verification tied 497 CLI sources and all 898
inventory blobs to source digest
`sha256:870f502a6184f60d7f8566f1f127ad822946c2e3ac91c8b102dd66b0c5f74757`:
9,862 passed, 0 failed, 365 skipped; statements 36,755/43,186 (85.1086%),
branches 32,049/39,658 (80.8135%), functions 6,946/7,642 (90.8924%), and
lines 32,766/37,174 (88.1422%). Six negative inferred-else hits remained
uncovered. Gateway verification tied 4 sources and all 20 blobs to digest
`sha256:3e32017987886b56fa30ecae1c890674c61f073b5d8b17bf1cfa43c9db8a2c8f`:
211 passed, 0 failed; statements 243/258 (94.1860%), branches 182/223
(81.6143%), functions 64/68 (94.1176%), and lines 233/245 (95.1020%).

The direct native report audit verified all seven immutable builder blobs,
package/lock binding, 497-source digest above, configuration digest
`sha256:63b6e933a0e58b7a551e8e0794067fa29130736bb48b31d27bbcad935b13f2f8`,
42 passed/0 failed/1 skipped bundle cases with all 11 actual-installed cases
passing, and 276 passed/0 failed/0 skipped HCL cases. It retains
`releaseReady=false`: the metadata/report artifact did not include installed
bundle bytes for an independent binary rehash and does not prove physical
minimum-host, signed release, reproducible HCL correspondence, production
custody, publication, or Azure qualification.

PR run `38344533020` remains separate merge-tree-equivalent evidence. PR 158 is
hosted-qualified with all 21 required PR checks green, and direct manual run
`38344594888` is globally complete. The platform helper now treats the Windows
credential regression according to immutable-source applicability: exact
`2775077` does not track that test. A separate re-audit of exact `028134f2`
retains the mandatory Windows credential case and its passing 310-file-per-OS
receipt without overwriting the earlier receipt. None of this is production
telemetry or native custody qualification.

A read-only named Azure telemetry re-observation found the existing Korea
Central resource group/resources and a six-column `Command` table with
180/180-day retention. The DCR exposes only the command stream. There is no
`Project` table or Grafana resource; `Microsoft.Dashboard` is not registered
although it advertises Korea Central. The observation performed no
authentication, provider, resource, or production mutation and read no event
or state payloads. It does not establish production ingestion readiness.
This defect, repair, hosted evidence, and read-only observation do not change
any 13.x source/flags or establish release support.

The retained partial task-17.1 metadata receipt is
`files/telemetry-production-readonly-20261013.json` in the coordinating
session. Both named resource groups, `rg-liftoff-prod` and the separate
`rg-liftoff-tfstate`, are in Korea Central. The exact existing state account is
`stliftofftfstatef5be1618`, container `tfstate`: private, shared keys disabled,
TLS 1.2, `SecuredByPerimeter`, with enforced state-storage association and
profile `telemetry-storage`. The source
`production.tfvars.example` still says `eastus`; an example/default must never
be used as future region authority in place of the observed named resources.

No state payload, key, record, or state-object lineage/ownership evidence was
read, and no registration, ingestion, deployment, or resource change occurred.
This existing production telemetry state is not an approved disposable task
13.6 custody scope and must not be borrowed for writes or custody
qualification. Task-17 flags remain unchanged; this is partial metadata only.
The already-running PR-158 direct-head dispatch `38344594888` was not
duplicated. Its independently audited exact-`2775077` CLI/gateway totals,
digests, test counts, and metrics agree with the separate PR merge-tree proof.
All 21 required PR checks and all 20 direct-manual jobs are now green.

Separate session `9952c9a2-1fce-4bac-bb07-5b3c59ede0f4` owns native
distribution qualification tasks 9.2 through 9.8 from exact qualified
`develop` base `692088e953801adef9d055856df523bbc83ebbf9`. Its branch is
`voyager163-native-distribution-qualification`, published head at the recorded
milestone
`e454f7fe41de7b9e0eac4d0cceaf57dd1cf8c263`, with CI run `38350526965`.
Its schema-1 receipt owner is `liftoff-native` and records canonical prefix,
version-manifest, inventory hashes, source/target/launcher/runtime, and local
attribution only. No task-9 flag has advanced; namespaces and public install
remain unqualified. The scope is source, packaging, platform proof, and
directly related documentation only. It must not copy this continuation's
custody, source-contract, workflow, or resume changes; import global task
flags; invent signing, namespace, or support-floor claims; or publish. Do not
duplicate its 9.x work or mutate its branch/PR. Stage 10/11 follow the
committed interface that owner establishes. A later `ee0...` native-9 commit
was explicitly intermediate. The task-9 owner now owns the unchanged pure
admission extraction in
`distribution/native/native-release-admission.mjs` plus inert bundle policy;
group 10 must forward-merge the final task-9 parent without duplicating that
logic.

Session `68be53ea-3101-4b13-b2a8-e520cecb7a48` (`Application artifact
readiness`) is the sole owner for task 14.1. Session metadata verifies branch
`voyager163-application-artifact-readiness`, based explicitly on published
continuation head `be537bf1871b1ed4bba2e0a69bcd8e5072b3f94b`. The source gap
is concrete: Azure phase plans currently expose placeholder prerequisites
`acr` and `managedIdentity` plus artifact `verifyDigest`, while execution
implements only phase 0 and provider/backend/bootstrap/custody ports default to
null. This child owns only actual bounded new-environment registry/identity,
source-bound immutable application publication/readback, adapters, tests, and
documentation with current authority, ownership, and protected-path guards.

It does not own tasks 14.2 through 14.9; task-13 source, workflow, or resume;
cloud writes; disposable qualification; or source copying from another owner.
Its code/source contracts must ordinary-forward-merge this session's corrected
parent before qualification. No task-13 or task-14 flag is currently claimed.
Do not duplicate task-14.1 implementation; task-13 triage and authoritative
resume ownership remain here.

Session `82044f9c-ecbb-44ec-84a0-10f915b21c99` (`Owner-aware CLI upgrades`)
owns group 10 only. Session metadata verifies branch
`voyager163-owner-aware-cli-upgrades`; it starts explicitly from native
distribution owner branch `voyager163-native-distribution-qualification` at
`e454f7fe41de7b9e0eac4d0cceaf57dd1cf8c263`. Group 10 will reuse the
local-attribution receipt interface without claiming task-9 qualification,
fabricating published metadata, performing host installation effects, or
starting group 11. The native owner has been informed. Preserve the separate
future 9→10→11 coordinator chain; it is independent from the
PR-158→PR-159→Grafana chain. Do not import its source or task flags into this
continuation before scoped integration.

Session `dd2469fb-1715-433c-9155-925eee7eee4d` is the source-only owner for
Grafana telemetry tasks 17.2 through 17.6. Session metadata verifies branch
`voyager163-grafana-telemetry-dashboards`. It intentionally starts from
diagnostic PR-159 head `c09be2e` and owns static OpenTofu, KQL, dashboards,
alerts, documentation, and tests only. It must perform an ordinary forward
merge of the eventual repaired PR-159 head before qualification. It has no
Azure effects or qualification claim. Keep all actual-cloud task-17 gates,
task 13.5/13.6, and blocked task-16 subparts honest; do not import child flags
wholesale.

The Grafana owner has published app-native non-draft PR 161 at head
`5e77876644637fb08c394a8018a84d44bf907a2b`, based on exact repaired PR-159
head `2d87c0825488e3840253cae114408a20e550612a` through the required ordinary
forward merge. All task-17 flags remain unchecked and live blockers remain
explicit; PR publication is not Azure qualification.

Native distribution owner PR 160 is draft at current head
`33efcfdd4a07f2584734633bc96ad79060c90a77`. It contains source-admission
extraction plus the Windows CRLF archive-parser correction. Earlier `b366...`
and `e454...` evidence is diagnostic only; fresh hosted qualification was
pending at the latest report.

## Completed native failure triage and corrected profile, 2026-10-13

Replacement native run
`https://github.com/voyager163/liftoff/actions/runs/38346014663`, attempt 1,
completed failed on exact clean revision
`be537bf1871b1ed4bba2e0a69bcd8e5072b3f94b`. The macOS ARM64 full-suite and
source-complete coverage job was `115127497967`; repository-policy job
`115127498147` succeeded. The selected runtime/tool versions were darwin/arm64,
Node 24.21.0, npm 12.0.2, OpenTofu 1.12.6, OpenSpec 1.11.0, Go 1.27.0,
Python 3.14.7, and uv 0.12.7.

The original completed API job log and complete artifact were retained before
another source candidate was created:

- API job log SHA-256:
  `e6ac305af23f1c5d9055cf735f39a2826a67ec423542224bfd50c0ad1ba3cef2`.
- Artifact `11791759677` ZIP SHA-256:
  `98950fa0f7d8eee7794d585582b5fbba8e6eb59fc6bf3f96cd247345e34e4001`.
- Artifact full-suite log SHA-256:
  `3896e7ae88fd6896ab2bb7bc2385f848403896e5258a303caeb29de8e082401f`.
- Artifact coverage log SHA-256:
  `259cd2718c3d2ec42e9c1107fe7f512c19bb0c234fafde2a33e8835ea9aaa98e`.
- Failed evidence-record SHA-256:
  `63f47b77a62c3f2184f20f3906e343eebe390ce473944e3b929088aba5dc837f`.

The retained originals and normalized audit are outside the repository under
`files/native-custody-failure-38346014663/`; earlier copies also remain under
`files/native-custody-38346014663-artifact/`. Do not overwrite either set.

The unfiltered report records 10,097 passed, 99 failed, and 117 pending tests.
The JSON reporter's 25 runner-suite count is labeled as failed test files in
its aggregate fields; the `testResults` array contains exactly 11 failed file
entries. These are two views of the same attempt, not different runs. All 99
individual failed assertions reduce to three
environment/setup roots rather than custody-source regressions:

- 96 assertions require an independently installed Docker CLI and separately
  bound Compose plugin. The candidate had neither. These failures span
  Compose/manual/local/publication/revalidation/Spec Kit cases, including ten
  OpenSpec execution/initialization cases whose first unmet prerequisite is
  Docker.
- Two read-only actual OpenSpec execution/initialization probes reject the
  incomplete non-global npm layout because required dependency
  `@inquirer/core` resolves outside the captured package tree.
- The one coverage-gate assertion correctly expected
  `services/telemetry-ingest/node_modules/vitest/vitest.mjs`, but the workflow
  omitted the gateway's locked install and Node fell back to root
  `node_modules/vitest/vitest.mjs`.

Coverage repeated the same failures. The retained evidence is tied to the
clean `be537bf1` source inventory of 506 files with digest
`sha256:8d71186fbe98052b903b46db90751c103b5553390527adb73f41dca081b6f50e`
and 404-test inventory digest
`sha256:e8c447023b37d63d2d57ebf3d79573e06b3b93b8b0e562e3d8c815b993e39b7d`,
but its metrics object is empty and its ZIP has no final coverage report.
Full-suite, coverage, coverage verification, and final evidence gates failed.
Later focused/package/policy/OpenSpec successes cannot convert it into native
qualification.

The next native candidate corrects only these setup roots under the unchanged
240-minute job bound, test deadlines, source inventory, coverage floor,
baselines, and production admission:

- Download the official Docker 29.8.2 Apple Silicon archive and Compose 5.5.1
  binary over HTTPS. Require archive SHA-256
  `5ffa2bafbabe073470f0333f4a129599230b73d1170bb61146b3d9b08e1d1325`,
  installed Docker binary SHA-256
  `b95f15a2e7c6a13c17b8af361a2797981bc858a87a1537c38cfa117a0c5009e1`,
  and Compose binary SHA-256
  `998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5`.
  Install only `liftoff-docker/bin/docker` and
  `liftoff-docker/cli-plugins/docker-compose`, prepend only the bin directory,
  and recheck exact file identities and versions without starting a daemon.
- Install OpenSpec 1.11.0 into a global-style isolated npm-12 prefix using
  registry cutoff `2026-09-26T23:59:59Z`. Before adding its bin directory to
  `PATH`, scan the complete tree twice and require 2,590 files, 299
  directories, two internal links, 11,862,860 bytes, and content-profile digest
  `sha256:05d52efd0875c1ff0c1bd0aec13f7128a4baab787ea6b31f33fa7360cd53bde2`.
  This reproduces the frozen qualified graph; it does not refresh the
  expectation to current registry resolution.
- Run both root `npm ci` and
  `npm ci --prefix services/telemetry-ingest` so the coverage gate selects the
  package-local gateway launcher.
- Record Docker and Compose versions plus the verified OpenSpec content profile
  in the revision-bound native evidence.

The official Docker archive and Compose binary execute as native arm64 Mach-O
programs on the physical Mac profile and report
`Docker version 29.8.2, build 7fc2dff` and `5.5.1`. The OpenSpec cutoff
reproduces the exact frozen counts and content digest. Repository policy now
rejects a changed download, checksum, layout, cutoff, profile verifier, or
missing gateway install.

The exact 11 file entries that failed in run `38346014663` were then rerun on
the physical Apple Silicon Mac with one worker, the same native environment
flags and deadlines, npm 12.0.2, OpenTofu 1.12.6, OpenSpec 1.11.0, Docker
29.8.2, Compose 5.5.1, the complete qualified OpenSpec tree, and the
telemetry-ingest locked install. All 11 files passed: 279 tests passed, 19
intentional host/profile cases were skipped, and zero failed in 1,872.89
seconds. The complete 2,440,034-byte raw log is retained outside the repository
as `files/native-custody-corrected-profile/prior-failures-focused.log` with
SHA-256
`0909b44befdae3bfeee2b392fce9152f99935bb5808766e169a06fe3c2c5efc0`.
`npm run smoke:package` also passed for `@msn-control/liftoff@0.12.3` on these
source bytes. The final pre-commit source validation used npm 12.0.2 and
OpenSpec 1.11.0: supported-stack and build passed; the native-evidence,
repository-policy, and documentation selection passed 166/166 tests across
three files; repository policy passed; strict noninteractive OpenSpec
validation passed; and `git diff --check` passed.

These focused and package checks are prerequisites only; task 13.5 remains
unchecked until a new clean committed candidate completes the unfiltered native
suite and source-complete coverage with zero failures and all four raw metrics
strictly above 80%.

Downstream ownership remains separate:

- Draft PR 160 now supersedes earlier native-distribution heads at
  `6279d55752836f88c9c3c29200bf68cf5cc9406d`. Its only new source is the
  isolated-copy correction for the Windows installed-package running-image
  fixture. The owner reported 220 focused passes; fresh actual Windows proof
  remained pending. Task 9.7 alone is checked on that owning branch. Task 9.4
  and the remaining production/public qualification gates are incomplete.
  Do not import its task flags or source here.
- PR 159's current repaired head is
  `c477d24d50e906a98afd718682d6aa2466693515`, changing only three current
  parser/UI test files while retaining all frozen released history. Actual
  synthetic merge `71ee9796910fff333cfd929df73c0209bc326ebc` has fresh
  source-complete CLI evidence for 503 sources, 9,951 passed/0 failed/365
  explicitly unrun tests, and all four raw metrics above 80.01%; remaining
  platform gates were still pending. Grafana PR 161 accepted the required
  ordinary merge and is now at
  `4945a9741fb4ecf7ccdc73f9b9109e28b7789b4c`; its fresh CI run
  `38356008443` had both Windows shards and CLI coverage still in progress at
  the latest direct read. Native successor stack 162 remains ordered
  `[158, 159, 161]` with recorded source heads
  `[2775077190df79ee5e8b81f8d04a6e12c0743249,
  c477d24d50e906a98afd718682d6aa2466693515,
  4945a9741fb4ecf7ccdc73f9b9109e28b7789b4c]`. The reported synthetic top is
  abbreviated `96d7...`, recursively bridged through actual parent
  `71ee9796910fff333cfd929df73c0209bc326ebc` and earlier root `452...`;
  preserve exact measured commit/tree equivalence and never relabel an old
  direct-head metric as fresh merge qualification.
- Session `68be53ea-3101-4b13-b2a8-e520cecb7a48` remains the sole task-14.1
  application-artifact owner. It has its own concrete producer/adapter tests
  and must ordinary-forward-merge this continuation's final corrected parent
  before its own qualification. Do not duplicate or import that source here.

## Hosted native custody qualification passed, 2026-10-13

The setup correction was committed and pushed as
`94f0d63e4294a809bf7e3592d6434f0dc1f33e57`
(`fix: correct hosted native qualification profile`). The remote
`origin/voyager163-liftoff-modernization` read back that exact SHA and the
worktree was clean. Required ancestry through `c23d1842`, `2914f0f`,
`d6222b3`, and `2785087c` remained intact. No task checkbox changed in that
source-repair commit.

Exactly one replacement `Repository setup` workflow was dispatched:

- Run: `38359670554`, attempt 1, `workflow_dispatch`.
- Exact head:
  `94f0d63e4294a809bf7e3592d6434f0dc1f33e57`.
- Native job: `115170628167`, completed `SUCCESS`.
- Repository-policy job: `115170628289`, completed `SUCCESS`.
- Artifact: `11804615717`,
  `liftoff-native-custody-38359670554-1`, 4,982,748 bytes.

The native job ran from `2026-10-13T06:57:18Z` through
`2026-10-13T10:18:30Z`. Every named gate recorded `success`: exact toolchain,
clean start, supported stack, build, unfiltered full suite, source-complete
coverage, independent coverage verification, focused custody/history checks,
package smoke, repository policy, strict OpenSpec validation, and clean finish.
The evidence records darwin/arm64 with Node 24.21.0, npm 12.0.2, OpenTofu
1.12.6, OpenSpec 1.11.0, Go 1.27.0, Python 3.14.7, uv 0.12.7, Docker 29.8.2
build `7fc2dff`, Compose 5.5.1, and the exact complete OpenSpec content profile
`sha256:05d52efd0875c1ff0c1bd0aec13f7128a4baab787ea6b31f33fa7360cd53bde2`.

The raw unfiltered full suite passed 305 files and skipped five intentional
host/profile files, for 310 result files total: 10,206 tests passed, zero
failed, and 117 were explicitly skipped. The source-complete coverage run
recorded the same zero-failure test totals and a complete clean inventory:

- 506 runtime source files,
  `sha256:8d71186fbe98052b903b46db90751c103b5553390527adb73f41dca081b6f50e`.
- 404 test/input files,
  `sha256:5a4202929c20f2ab9c54a77778ef22d712af353eb24d196c6fbda25947266e38`,
  including all 310 executable `.test.ts` files.
- Five configuration/gate files,
  `sha256:63b6e933a0e58b7a551e8e0794067fa29130736bb48b31d27bbcad935b13f2f8`.
- Statements: 39,911/44,525, **89.6372%**.
- Branches: 35,103/41,036, **85.5419%**.
- Functions: 7,503/7,904, **94.9266%**.
- Lines: 35,322/38,459, **91.8432%**.

All four integer ratios are strictly greater than 80%; no source exclusion,
threshold change, deadline change, snapshot refresh, baseline regeneration, or
failed-evidence reuse was used. The focused custody/history selection also
passed 15/15 files, 472 tests passed, one intentional case skipped, and zero
failed. Package smoke, repository policy, strict OpenSpec validation, and both
clean-tree gates passed on the same committed revision.

The complete raw run metadata, jobs metadata, artifact, job log, extracted
reports, and independent receipt are retained outside the repository under
`files/native-custody-38359670554/`. Immutable hashes include:

- Artifact ZIP:
  `c5aa44ae885f2e21162f067cda731f07aadb9a42a106bc808b1afaafc2e9d444`.
- Native job log:
  `749601857a76162852671c0d934e85f23129b8dc5a6770d7b3c2646c6976e311`.
- Native evidence:
  `2c09ba7b6fb91837339aaeb8a5317823449a7967ec556b2ec98e47ab678b7889`.
- Coverage evidence:
  `db0422656b4d2257db3f36a1f8384685be3ee43830b0af85cee315b23c68fa8e`.
- Full-suite log:
  `1b42f050fb329e1fedbe6d268936db76cc99fd489d1e49321de60478a2c7ee1b`.
- Coverage log:
  `31ab26ca9a33aa87e56efd6c767993932e5181a875d5000d6564802e407b463d`.
- Independent audit receipt:
  `6bb8ab8c24348e5f50ce534bf6a1cc78391270013d5a7e471785d66022ec7c69`.

The independent audit did not trust the stored passing verdict. It reconstructed
the exact committed tree with `git archive`, recomputed source, test, and
configuration inventories, verified every raw report used the uniform hosted
runner root, relocated only that absolute path prefix into the fresh archive,
and ran the repository's verifier again. Re-judgment returned `passed` with an
empty failure list and the exact raw integer metrics above.

Task 13.5 is therefore complete and OpenSpec progress is 82/136. Task 13.6
remains unchecked: no approved disposable cloud scope, production
custody/handover ports, or authorized real-cloud operation was supplied. The
existing Korea Central telemetry and state resources remain explicitly outside
task-13.6 scope and must not be borrowed for writes or qualification.

Downstream source ownership remains separate. Task-14.1 owner session
`68be53ea-3101-4b13-b2a8-e520cecb7a48` explicitly admitted `94f0d63e` as its
source parent and now owns source head
`efa749cf9276db76bc27c4e42d1c78c0b6bad80b` in draft PR 164, with 546 selected
tests and no real/native qualification flag. Task-14.3 owner session
`e1389524-41f1-47aa-8c43-4bf14b14cf20` alone owns the current-only protected
execution contract proposal from schema family 4 to 5. Released-v3,
pre-custody, current-family-4, and v7 history remain readable and immutable;
there is no implicit migration or cloud effect. Do not duplicate either
owner's source in this continuation.

## Task 13.6 partial native qualification, 2026-10-13

The safe native-only portion of task 13.6 was exercised on exact clean
documentation successor
`67eb20f0ea3c7ecbe97d639130d653888524ad15`. The first wrapper invocation
exited before starting because the ambient shell had no `python` command; it
created no fixture and changed no repository bytes. The lane was immediately
rerun with the preserved qualified CPython 3.14.7 executable, OpenTofu 1.12.6,
Node 24.21.0, and npm 12.0.2.

The explicit `LIFTOFF_NATIVE_STATE_QUALIFICATION=1` lane passed both tests in
`tests/state-backend-native-qualification.test.ts` with zero failures. It used
only a fresh private scratch directory, the builtin `terraform_data` resource,
empty credentials, and a filesystem-only empty provider mirror. The result is
scope `synthetic-disposable-only`, records `azureLiveQualification:
not-performed`, and does not claim atomic crash-safe replacement.

The actual native result verified all 20 declared checks, including mutual
OpenTofu/fcntl exclusion, observer descriptor-close behavior, exact pre-acquire
metadata preservation, an actual module address move, stable lineage/resource
identity, an actual no-change plan, same-inode conditional publication,
stale-write rejection, replaced/unlinked inode lock-loss detection, preservation
of the newer native writer and its lock metadata, and rejection of absent
destination/unlink retirement. Tool/result identities were:

- Native host:
  `native-host:a9e3d703d3efc5f5840c137826212ed5a50ed4bb65a806390ec311cc94abefa0`.
- OpenTofu binary:
  `0445d7cc114d24440af150b1ddec600f4e4c3e6af16ba63a9a7d42054ae970e3`.
- CPython binary:
  `16a1bac7c40871327d591833239cafc6cd060b4d199d3aa4b3048b8d69644bce`.
- Native protocol:
  `bef6fcb34e93bd9029667de242273c653d95462da7da4ee75949ac127774a607`,
  tied to immutable OpenTofu source commit
  `b4305e5a5dd2fb79a27897ae30784a181d3a26cb`.
- Observed volume: APFS, FileVault enabled, encrypted, owner-only, and not
  currently locked.

The raw 2,526-byte log is retained as
`files/native-state-qualification-67eb20f0/native-state.log` with SHA-256
`5cb7ee2852be3313d8a870606b09acaa968df925ee3cc1e9e2ef9738102e3226`.
The structured partial receipt has SHA-256
`3b62a191cc5915f8d8191335b3ab3f026af05ce5d0b59532708c99341ead11f6`.

Task 13.6 remains unchecked. This native scratch result is real local-state
evidence, but it is not production custody/handover qualification and performs
no Azure operation. Completion still requires explicitly approved disposable
cloud scope plus the missing production adapters and authority; existing Korea
Central resources remain excluded.

Native successor stack 162 remains ordered `[158, 159, 161]`. PRs 158 and 159
are green and mergeable, but PR 161 current head
`5adcb6c18257139a1f70d398c0a929233d3262a1` is not landable. Run
`38366776115` failed two Windows cases: an `EBUSY` cleanup of the OpenTofu
AzureRM provider in `repair-command.test.ts`, and a process-supervisor startup
timeout before target dispatch in `repair-application.test.ts`. The unchanged
15-second startup supervisor fired at `loading-compiler`; the public
30-second target budget never began. No deadline was changed, no old evidence
was relabeled, and the PR-161 owner retains the repair/forward-integration
scope. Do not invoke native cascading merge until a fresh exact-head run is
fully green.

## Native distribution parent audit and active owner state, 2026-10-13

The current native-distribution parent in draft PR 160 is exact head
`b65515ccfb83a19972574340ad45a11c09c79710`. Repository run
`38367272627` and repository-setup run `38367272614` both completed
successfully at that exact head; all 23 repository jobs succeeded. An
independent coordinator audit downloaded the four native artifacts and both
coverage artifacts rather than relying on the PR-body verdict.

Every one of the 16 files declared by the four native release manifests had
the exact uploaded byte count and SHA-256 value. The actual installed/package
reports recorded:

- macOS arm64: 105 passed, zero failed, five explicitly unrun;
- Linux x64: 95 passed, zero failed, four explicitly unrun;
- Linux arm64: 95 passed, zero failed, four explicitly unrun; and
- Windows x64: 79 passed, zero failed, 20 explicitly unrun.

The unrun cases remain named foreign-host/platform cases and are not evidence
for their behavior. The retained archive extraction case passed on every
applicable target. The exact clean-head coverage evidence independently
records:

- CLI statements/branches/functions/lines:
  85.1061%/80.8105%/90.8900%/88.1403%, 9,905 passed, zero failed, 377
  explicitly unrun, 497 source files.
- Gateway statements/branches/functions/lines:
  94.1860%/81.6143%/94.1176%/95.1020%, 211 passed, zero failed or unrun,
  four source files.

The audit receipt is retained outside the repository as
`files/native-distribution-b65515cc/independent-audit.json`, SHA-256
`9b08a36260d21a16d2caf2f5c0270d356f92592cbb55a97eacddb52da7a70805`.
It qualifies exact-source development-bundle/archive proof only. Every native
manifest still states `releaseReady: false`; minimum-host, installer ownership,
signing, notarization, package namespace, and HCL source-correspondence flags
remain false. Tasks 9.2-9.6 and 9.8 remain incomplete, and no artifact was
published.

Dependent draft PR 163 remains on exact parent `b65515cc` with current head
`def217170a70caaf8938221ab7c925e71a6f08e5`; its fresh full CI run
`38392481282` was still in progress at the latest direct read. All Group 10
task flags remain unchecked because real managers, deployed stable metadata,
approved identities, public assets, and minimum-host qualification are still
absent. Task-14.1 draft PR 164 superseded its cancelled
`ad3f6041ff1c3cc0145a7964a6bcc9a6a073c0f4` run with source head
`6b8c0e90fcbdde0384955746825d2cfc1dab04e6`; fresh run `38393897604`
was in progress. No owner branch source or task flags were copied into this
continuation.

There was no published owner for PR 161's two Windows repairs. To prevent
overlap, the PR-161/Grafana owner is now the sole repair owner for that exact
branch: diagnose and correct the pre-dispatch `loading-compiler` startup
failure without changing the 15-second startup supervisor or 30-second target
budget, and make native validation settle the required process tree while
ensuring `finally` cleanup cannot mask an earlier validation failure. The
repair must preserve every grace, worker, skip, coverage-floor, frozen-history,
and cleanup/locking contract, publish an exact SHA, and pass fresh exact-head
full CI before stack 162 can land.

The user was unavailable when asked for task-13.6 disposable Azure write
authorization. The autonomous safe decision is therefore to keep all cloud
writes blocked and continue source/integration work only. Existing Korea
Central production resources remain prohibited qualification scope. Task 13.6
stays unchecked.

## Task 14.2 protected application deployment source, 2026-10-13

The continuation ordinary-merged the exact admitted task-14.1 source
`6b8c0e90fcbdde0384955746825d2cfc1dab04e6` and its direct terminal-handle
successor `5d51b79623548717e8c9c1eba147c67e6e713284`. The resulting local merge
commits are `d76334c9853d58fa4128cd7de5fc944c6c5b2aaa` and
`9161a36f509f409003f8689f050ecac7af80191d`; no rebase, squash, force update,
owner task flag, or mutable branch guess was used.

The bounded task-14.2 source milestone is commit
`65aa8d66b08f8f2d186857b7d2c8a052ce2d26e2`
(`feat: bind protected application deployment source`). It adds only
`src/governance-activation/application-deployment.ts` and
`tests/governance-application-deployment.test.ts`. Shared transition ports,
phase graph/identity/schema/header/authority contracts, current-family-5
assets, runtime registration, and production execution wiring were not
changed.

The private source contract now:

- binds the exact current immutable artifact, application-prerequisite
  registry/identity/RBAC records, protected backend/custody records, current
  committed environment/module HCL inventory, provider lock, protected backend
  overlay, variable overlay, subscription/tenant/environment/resource names,
  fixed cost ceilings, and original approval/operation invocation;
- preserves all tracked bounded application customizations, excludes only the
  exact generated local backend from isolated protected execution staging,
  rejects dirty/untracked/sensitive/state/plan/backend-overlay collisions, and
  never writes a protected value to project source;
- permits only the fixed same-operation mapping set: move the bootstrap
  resource-group address, import the exact task-14.1 ACR, workload identity,
  and AcrPull assignment, and retain the publisher AcrPush role externally;
- requires provider-derived configuration digests for the exact owned
  resource name/location/tags/SKU/admin/tenant/principal/client/scope/role
  attributes, before/after lineage and state serials, encrypted backup and key
  references, locking and writer-quiescence proofs, unchanged unmapped state,
  retained custody/disposal obligations, zero resource mutation during
  mapping, a zero-change/no-destroy bounded plan, and a post-apply no-change
  plan;
- requires exact immutable-image Container App readback, managed identity,
  active 100% revision traffic, provider resource inventory, credential-free
  HTTPS backend output, and bounded `/health` HTTP-200 evidence represented
  only by byte count and SHA-256; and
- blocks frontend and worker-bearing workloads because the admitted artifact
  source proves only one backend image.

The private provider surface is durability-split rather than a single
ambiguous `execute` call. A write dispatch requires an engine-owned,
digest-bound pre-effect intent and callbacks for accepted-handle and terminal
checkpoints. Recovery/observation is a separate method and can start from
either the exact accepted handle or an intent-without-handle state; neither
path may redispatch. Read-only staging/production observation is separately
typed with Azure read only and state-read/state-write/dispatch/import/move/apply
all fixed false. Result states distinguish no-effect blocking from
intent-only uncertainty, accepted effects, post-acceptance failure with the
original handle, terminal failure with a durable terminal checkpoint, and
fully completed proof. Terminal provider status must be checkpointed before
fallible export, readback, health, or verification work, so a later failure
cannot erase the original ID/status/time/plan or become a second dispatch.

Validation on the exact source bytes passed:

- Qualified Node 24.21.0 plus npm 12.0.2 TypeScript build.
- Ten focused deployment-source tests.
- 121/121 adjacent deployment/artifact/ownership/environment tests.
- Focused source coverage:
  statements **256/295 (86.77%)**,
  branches **422/475 (88.84%)**,
  functions **73/74 (98.64%)**,
  lines **250/289 (86.50%)**.
- Package smoke with the exact qualified Node/npm execution paths.
- Repository policy.
- Strict OpenSpec validation.
- `git diff --check`.

An earlier whole-suite run used the pre-durability draft and was deliberately
stopped when contract review identified the missing accepted/terminal
checkpoint channel. It is not qualification evidence and was not relabeled.
The bounded focused/adjacent checks above cover the final committed source.

Task 14.2 remains unchecked. There was no real Azure, GitHub, OpenTofu,
registry, RBAC, state, cost, health, or global effect. No production provider
is registered. The canonical generated HCL currently omits predecessor-owned
resource-group/registry/identity tags, so a real protected plan must fail
closed with `configuration-mismatch` rather than remove those tags or claim a
no-change import. Coordinator review explicitly kept any generator/source
inventory repair and shared-port insertion serialized behind the current-5
owner audit. Current-5 owner source
`d38d86c0f4f61d1e034cbc0d0b879ffdae371bcb` is published with admitted
`5d51b796` as second parent but is not yet admitted for consumption.

Downstream evidence remains separately owned. Group-10 PR 163 run
`38392481282` completed successfully across all reported platform shards,
native development packages, runtime bundle, HCL parser, coverage, telemetry,
template, and aggregate jobs; this does not advance its real-manager,
public-asset, identity, or minimum-host task flags. PR 161 repair head is now
`f0fd79ae533749ad5bf922900abe10ff9f9cf336`, removing the still-failing Windows
module/command discovery path while preserving the existing timers, process
settlement, error preservation, Win32/C# behavior, and frozen evidence. Its
fresh exact-head whole CI remains required before stack 162 can land. OpenSpec
progress remains 82/136.

### Task 14.2 private proof correction, 2026-10-13

The initial private source milestone has a validated corrective descendant:
`a18bbbe37f962a61dbc979dd3d81489b4394b7d0`
(`fix: harden protected application execution proofs`), tree
`abae7841c76dcddaefa8815b1ab9a74e73a3bba0`. It changes only
`src/governance-activation/application-deployment.ts` and
`tests/governance-application-deployment.test.ts`; no shared transition port,
current-family allocation, graph, phase, authority, schema, provider
registration, generator, runtime wiring, or task checkbox changed.

The private contract now retains independently engine-owned intent, accepted,
and terminal checkpoints. A first dispatch whose pre-effect intent is durable
but whose provider acceptance is unknown returns intent-only uncertainty
rather than a false no-effect block. Observation can never redispatch that
intent. Accepted and terminal results must byte-match the independently
retained original checkpoints, so a producer cannot replace handle A with a
coherently rebuilt handle B or regress a terminal handle to running.

Execution provenance is now checked against an independently supplied source
authority. The only accepted workflow ref is the full lightweight-tag ref
`refs/tags/liftoff-execution-<sourceSha>`, where `sourceSha` is the exact
lowercase 40-hex reviewed commit SHA. The bare execution ref, repository ID
and name, workflow path, source commit, independently approved tree SHA,
workflow and execution-source digests, qualified host/runner/group/network
and custody identities, active update-and-deletion/no-bypass barrier evidence,
lightweight commit object observation, and current provider admission are all
bound. Branch refs, raw SHA refs, alternate tag namespaces, annotated-tag
indirection, and digest-derived substitutions fail closed. This is an
observer-only private source contract; it grants no tag writer or protection
mutation authority and makes no public execution qualification claim.

State mapping is now bound to one authoritative original protected-backend
state identity and one reviewed mapping batch. Every fixed move/import proof
must share the same original lineage, serial, state digest, encrypted backup,
lock, writer-quiescence, unchanged-unmapped-state identity, batch digest, and
single after-mapping state. The protected plan consumes that exact mapped
state, and completion must preserve the lineage and unmapped identity while
advancing from the mapped pre-apply state to a later final state. Independently
rehashed but disconnected per-resource lineages are rejected.

Read-only staging/production observation no longer recycles completion health.
It requires a fresh bounded protected HTTP observation after completion,
bound to the admitted operation, exact execution authority and provenance,
current Azure Container App FQDN, active revision, immutable image, and the
source-declared `GET /health` JSON contract. Only media type, byte count,
raw-body SHA-256, parsed semantic digest, revision, immutable image, endpoint,
status, and observation time cross the private port; no response body is
exported. A prior HTTP 200 followed by a current 500, or an unknown/malformed
HTTP-200 body, remains health-unverified.

Validation on the exact corrective source bytes passed:

- Qualified Node 24.21.0 plus npm 12.0.2 TypeScript build.
- Ten focused deployment-source tests.
- 121/121 adjacent deployment/artifact/ownership/environment tests.
- Focused source coverage:
  statements **300/344 (87.20%)**,
  branches **557/615 (90.56%)**,
  functions **77/78 (98.71%)**,
  lines **294/338 (86.98%)**.
- Package smoke with the exact qualified Node/npm execution paths.
- Repository policy and supported-stack checks.
- Strict OpenSpec validation.
- `git diff --check`.

No unfiltered whole-suite result is claimed for this corrective descendant.
The private coordinator audit and shared current-family-5 serialization remain
prerequisites before any shared insertion or fresh exact-commit whole-suite
qualification. The canonical HCL ownership-tag mismatch remains
`configuration-mismatch`; it was not mutated or waived. Task 14.2 remains
unchecked, and no real GitHub, Azure, OpenTofu, state, registry, RBAC, cost,
health, or global effect occurred.

The exact private source has a further narrowly coupled successor:
`1c131a35279e628622c70bab1670baf60208e0c5`
(`fix: bound application health freshness`), tree
`ad07c5037afcf030d9d97a320a7218c9b1536c3e`. Its actual direct parent is the
documentation successor `755f076bcd92c412d86b7a3b622f22ea6ab7f409`;
`a18bbbe3` remains an ancestor. No source ancestry was lost.
Audit after the first correction found that a health observation was required
to occur after completion but was not bounded to the current protected
readback clock. The successor adds a five-minute maximum age, rejects
future-dated observations, and requires the health observation to fall between
completion and the current readback time. This prevents an arbitrarily old
post-completion HTTP 200 from qualifying staging or production. The focused
suite now includes an explicit stale-health negative.

Renewed exact-source validation passed:

- Qualified Node 24.21.0 plus npm 12.0.2 TypeScript build.
- Ten focused deployment-source tests.
- 121/121 adjacent deployment/artifact/ownership/environment tests.
- Focused source coverage:
  statements **304/348 (87.35%)**,
  branches **561/620 (90.48%)**,
  functions **77/78 (98.71%)**,
  lines **298/342 (87.13%)**.
- Package smoke, repository policy, supported-stack, strict OpenSpec, and
  `git diff --check`.

This successor supersedes `a18bbbe3` for private source audit and any future
shared serialization. All task flags, real-effect blockers, ownership-tag
mismatch, and no-shared-wiring constraints remain unchanged.

Renewed private audit accepted the five original proof families in `1c131a35`
and identified one final bounded runtime-union gap. The corrective source
successor is `4c7efd104b26167125076c976cb34e3f143c1188`
(`fix: close application result discriminants`), tree
`17a3d25eaa9d690a2fccf92e9518de5bc7319550`, with actual direct parent
`3e7ee56d98482c69e7428e1f87e50b2a3a88baee`.

Write-result validation now accepts only the declared
`blocked`/`uncertain`/`accepted`/`failed`/`completed` runtime statuses,
explicitly requires the final proof branch to be `completed`, and accepts
only `accepted` or `terminal` effects for failed results. Read-result
validation accepts only `blocked` or `completed` and no longer treats an
arbitrary nonblocked status as completion. The complete declared failure
reason set is runtime-enforced for blocked, uncertain, and failed results.
Focused controls use fully populated, internally coherent objects with an
unknown write status, unknown read status, failed unknown effect, and unknown
blocked/uncertain/failed reasons; missing-field or stale-hash proxies are not
used for those cases.

Renewed exact-source validation passed:

- Qualified Node 24.21.0 plus npm 12.0.2 TypeScript build.
- Ten focused deployment-source tests.
- 121/121 adjacent deployment/artifact/ownership/environment tests.
- Focused source coverage:
  statements **317/356 (89.04%)**,
  branches **586/634 (92.42%)**,
  functions **78/79 (98.73%)**,
  lines **311/350 (88.85%)**.
- Package smoke, repository policy, supported-stack, strict OpenSpec, and
  `git diff --check`.

This exact source supersedes `1c131a35` for renewed private admission. It
does not alter shared/current-family-5 contracts, generator/HCL, runtime
wiring, production authority, task flags, or any real effect. The ownership
tag mismatch remains fail-closed and task 14.2 remains unchecked.
