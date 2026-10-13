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
- OpenSpec progress remains 78/136 tasks complete; 58 remain.
- Task 13.5 remains unchecked after failed Windows full-suite/coverage
  qualification. Tasks 13.6 and 13.7 are also unchecked.
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

Do not squash, rebase, reset, regenerate baselines, or mark task 13.5 complete
before reading this file and the OpenSpec artifacts.

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

## Current focus: OpenSpec task 13.5

Task 13.5:

> Preserve due-time/custody/disposal obligations and unsupported-host
> admission; verify absent protected storage/keys/locking blocks rather than
> falling back to plaintext or an unapproved execution host.

The implementation is complete enough for focused validation, but repository
qualification and source-complete coverage remain pending. Therefore the task
checkbox is still open.

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
