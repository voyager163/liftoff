# Liftoff modernization handoff

This file is the continuation guide for another GitHub Copilot session on
another machine. It records the repository state, decisions, validation,
remaining work, and cautions needed to continue the OpenSpec change
`modernize-liftoff-platform` without reconstructing the prior conversation.

## Start here

- Repository: `voyager163/liftoff`
- OpenSpec change: `modernize-liftoff-platform`
- Working branch: `feature/state-custody-readiness`
- Ultimate base: `develop`
- Base commit used by this branch:
  `48609df1954221c296ab4bd8bfe0c382a27f01ef`
- Protected-custody implementation commit:
  `c23d1842` (`feat(governance): implement protected state custody`)
- The branch tip containing this file is the handoff commit. After fetching,
  run `git rev-parse HEAD` to record its full SHA.
- OpenSpec progress before checking task 13.5: 78/136 tasks complete.
- Task 13.5 intentionally remains unchecked until full source-complete
  qualification is rerun on the committed bytes.

Recommended checkout on the new machine:

```bash
git fetch origin
git switch --track origin/feature/state-custody-readiness
git status --short
git log --oneline -5
openspec status --change modernize-liftoff-platform --json
openspec instructions apply --change modernize-liftoff-platform --json
```

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
  `2e214353fe73edeea246dac49aa5126c3d1e50afb853703`.
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
- No final full-suite or source-complete coverage result exists for `c23d1842`.

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

1. Fetch and check out `origin/feature/state-custody-readiness`.
2. Confirm the implementation commit `c23d1842` is an ancestor of `HEAD`.
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
