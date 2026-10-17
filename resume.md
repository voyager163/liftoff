# Liftoff modernization handoff

This file is the continuation guide for another GitHub Copilot session on
another machine. It records the repository state, decisions, validation,
remaining work, and cautions needed to continue the OpenSpec change
`modernize-liftoff-platform` without reconstructing the prior conversation.

## Shared reconstruction correction, 2026-10-17

This isolated continuation is a bounded shared-core correction rooted directly
at `a05fbb79c0280226f10c84658f590edb0faee846`. Production source commit
`28c9f77de53642136fc10dda76b016ea82628113`, tree
`9418cfa5800049016b5f40b172e4feef09b8f842`, removes deterministic duplicate
source reconstruction without introducing a cross-request cache:

- `buildModernManagedCore` resolves the source once and supplies that exact
  result to its context and compatibility subproducers only when their
  canonical source request matches. A different request is rejected rather
  than served stale data.
- `inspectModernInstalledActivation` still performs a new filesystem,
  physical-identity, manifest, record and currentness observation on every
  invocation. Within one inspection only, its collected managed-core render can
  be reused during validation when it is bound to the exact captured manifest
  SHA-256. Public snapshot validation still reconstructs independently.
- Provider reads, current records, authority, approvals, leases, source
  selection and filesystem observations are not retained between requests.
  Source5 public interfaces and its owning fixture/orchestration files are
  unchanged.

Focused verification of `28c9f77d` passed 171 managed-core/preflight cases,
28 import-boundary cases, repository policy, strict OpenSpec validation and the
complete 62-case Source5 matrix file. The six original sequenced timeout
controls passed under their unchanged 30-second deadlines: preparation 1.619s,
component sealing 9.346s, lease acquisition 2.768s, all-12 matrix observation
7.577s, component pending/resume 7.057s and finalization fresh-lease/CAS
13.199s. A same-process diagnostic, not qualification or hosted timing credit,
measured the source-resolution portion at a 10.448ms prior-path median versus
2.671ms with operation-local reuse.

The exact clean qualification of `28c9f77d` started at
2026-10-17T03:38:38Z and stopped after the unfiltered suite at
2026-10-17T04:44:19Z. Supported-stack and build passed. The suite reported 357
passing files, three failing files, six skipped files, 12,757 passing tests, 11
failing tests and 148 skipped tests. No gateway or CLI coverage command
started, and no fresh report or percentage exists for this revision.

- One failure was a coupled source-family instrumentation expectation that
  still required 11 redundant resolutions. Separate successor
  `75c209e42bd2c506fd16f5394fa35e13f4a3c217`, tree
  `f31738dc7faa764e0eefc1da0ce394c4188f48cb`, changes only that test. It now
  asserts one validated source per managed-core operation while each
  independent installed inspection still performs exactly four source
  resolutions, its own filesystem opens and a separately captured
  snapshot/files/directories. Legacy and selected lookup copying remains 24
  complete rows versus four selected rows. Exact clean committed bytes pass all
  79 cases, build, repository policy and strict OpenSpec validation.
- Ten failures in `tests/modern-manual-execution.test.ts` were environment
  discovery failures because no compatible executable was exposed as
  `python`. The preserved qualified executable is
  `/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/macos-toolchain/python/cpython-3.14.7-macos-aarch64-none/bin/python3.14`.
  The preserved uv 0.12.7 executable is under
  `files/macos-toolchain/uv/venv/bin/uv`. Use an isolated temporary `python`
  launcher and PATH; do not mutate system tools.
- `tests/telemetry-dashboard.test.ts` could not collect because declared
  dependency `@kusto/language-service-next/bridge.js` is absent from this
  worktree's `node_modules`. Exact npm 12 `npm ci` is justified only after the
  currently reserved Source original-program readset releases the shared heavy
  lane. Do not mutate a dependency or tool root while that readset is active.

The failed-run packet is retained at
`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/shared-core-28c9-full-qualification`.
`coverage-not-run.txt` has SHA-256
`380e2fb06b4510aec1d2eb998acd37693a5d489585915518cc74e3e7335d1136`;
the corrected ledger has SHA-256
`03ae70de234f236f710a2795434de00f8759ae1171fd8774864d11fca9a9fb7d`.
An initial finalizer copy of pre-existing ignored `cdadc391` reports was removed
from this packet and explicitly recorded so it cannot be attributed to
`28c9f77d`.

Neither commit completes an OpenSpec task. Progress remains 87/136 and no
source, coverage, readiness, provider or phase-completion claim is made. Root
has received the two bounded commits for preserving intake. The shared heavy
lane was explicitly released by this session at 2026-10-17T04:44:19Z. Source
exact `f720a151ba41944f168c3f7fe09129f16245267c`, tree
`1249bb2fa40ace4ca8df33d89f244280cbbb365f`, then completed its one real
original-program build/pack/private-install plus ten genuine consumers from
2026-10-17T04:47:01.095Z through 2026-10-17T04:49:36.198Z: 10 passed, zero
failed, with 21 regex-unselected request cases. It used the required official
gzip producer input with SHA-256 beginning `bed7eea`, retained the prior xz
checksum refusal separately, reverified unchanged HEAD/tree/files/modes and
explicitly released the lane.

The queued application prerequisite selector then ran only exact
`1486a43b0e5c0c780841233d6202ad557f259f38` from
2026-10-17T04:51:50.282Z through 2026-10-17T04:52:41.301Z. Its sole V8 include
was `src/governance-activation/application-prerequisites.ts`; all 142 owning
tests passed. Statements were 146/160 (91.25%), branches 150/168 (89.28%),
functions 21/21 (100%) and lines 141/154 (91.55%), above the unchanged 80.01%
floor. This is targeted evidence only, not full or global coverage. Receipt
`files/task141-acceptance/prerequisite-v8-1486/receipt.json` in session
`68be53ea-3101-4b13-b2a8-e520cecb7a48` has SHA-256
`45e2990af4463eef02b8bca57af03ccc07983d6bb247723fae2b4ee69c35709f`.
That session reverified all 1,724 source bytes/modes and released the lane with
no child process left.

The exact-clean successor qualification is complete on
`8fb50e2ea0efd84d717a0608b5cbd18a906ef9aa`, tree
`68ec73d0d9be4495deef00158e33fad159ad5dfb`. This revision adds only
documentation above executable/test successor `75c209e4`.

- Exact npm 12 `npm ci` used this worktree's regular `node_modules` directory
  and an isolated temporary cache. It restored the declared Kusto package
  without changing repository bytes. The first focused attempt used an
  executable npm wrapper that was not the registered inspectable
  `npm-cli.js` identity and therefore failed 13 native Manual cases at the
  protected tool-inspection boundary. Replacing only that environment wrapper
  with a link to the exact npm 12 launcher cleared the refusal. The three
  formerly failing files then passed together: 116 passed, zero failed and 15
  unchanged native-engine skips.
- Supported-stack and build passed. The unfiltered one-worker suite ran from
  2026-10-17T04:56:33Z through 2026-10-17T06:19:16Z and passed 360 files with
  six skipped files; 12,799 tests passed and 134 were skipped. There were no
  failed files or tests. Its shared-host duration is retained as observation
  only, not performance credit.
- Gateway source-complete coverage and independent saved-evidence verification
  passed 211/211 tests against four files, digest
  `sha256:28c6816b535eefab7c3b45144c239975898fd458093d0a148492f3164873bf58`.
  Statements were 245/262 (93.5114%), branches 191/234 (81.6239%), functions
  64/68 (94.1176%) and lines 235/248 (94.7580%).
- CLI source-complete coverage and independent saved-evidence verification ran
  from 2026-10-17T06:19:48Z through 2026-10-17T07:50:17Z. All 12,799 tests
  passed with 134 skips against 569 executable TypeScript-build files, digest
  `sha256:5c8840351bea369467f5b3197b73a15239b19e53eb6b2512ee2a519da0f0df00`.
  Statements were 46,607/52,117 (89.4276%), branches 42,595/49,625 (85.8337%),
  functions 8,699/9,141 (95.1646%) and lines 41,231/44,997 (91.6305%).
- Repeated gateway and CLI evidence verification, installed-package smoke for
  `@msn-control/liftoff@0.12.3`, repository policy, strict change validation,
  strict all-OpenSpec validation (24/24), whitespace, exact HEAD/tree and final
  clean-tree checks passed. The final gate completed at
  2026-10-17T07:51:30Z and released the shared heavy lane.

The sealed packet is
`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/shared-core-8fb50e2-qualification`.
`receipt.json` has SHA-256
`d57c383acf8342249632cbc63399d3cdc43138dd64db3822704c42b0e4f86e03`;
its 51-file ledger has SHA-256
`5c79706ee45c62a455f8c0c11e915547dc35b1302a470f23aab5328bb2cd3ba2`.
The isolated npm cache was removed after sealing.

Attribution remains exact: this qualifies the original `8fb50e2e` 569-file
TypeScript-build inventory only. It does not qualify Root's later `.13`
integration or five additional shipped raw-JavaScript coverage inputs. Public
Root EF already contains `28c9` and `75c`; the commits above `75c` here are
documentation-only. Root therefore needs a fresh combined full and
source-complete run after preserving integrations.

Terminal EF failure mapping found no missing executable 8fb delta. The genuine
Root/integration debt is the `.13-dev` version not satisfying the current
stable/alpha/beta/rc telemetry version contract, version/native-package coupled
expectations, and new infrastructure guidance changing frozen historical
template bytes. Preserve the reviewed retained-family4 fixture corrections and
current5 refusals, update only deliberate current-version expectations, and
gate new guide text to the current source family rather than refreshing the
historical baseline. Coverage guidance and application publication-handle
binding were corrected independently after EF. Source owns remaining
matrix/finalization timing assessment. EF's 45-minute CLI coverage job produced
no artifact; it cannot inherit this smaller-inventory result.

The subsequently requested exact-`800b56c3` Source consumer slot was removed
before launch after coherent EF evidence superseded the diagnostic need. It
remains historically unrun and receives no EF credit. No Source slot remains
queued behind this completed sequence.

## Canonical assertion recovery, 2026-10-16

This preserving test/documentation correction follows Root
`645f35e77553a7102bd917dca9defd52bdcde4c3`, tree
`a2dab10f693a2e5f5b3ebe8ac2a07626fcc1c62e`. Production source, admission,
family allocations, public routing, frozen records and task flags are unchanged.
No later Checkov or declaration SOURCE milestone is intaken.

- The completed exact-clean 645f canonical CLI run failed: 362 executed test
  files, 12,588 registered cases, 12,397 passed, 48 failed and 143 pending.
  No fresh CLI coverage summary or final coverage JSON was produced. The
  complete original report, streams, command/input records and explicit missing
  files are preserved in `root-645f35e7-canonical-results/receipt.json`,
  SHA-256 `ad92a6900d684b87b193205c705aae1d7da66e1818c0b399eef9cb4e5e38af54`.
  This is distinct from the earlier incomplete IPC and unqualified-runtime runs.
- The separately completed clean-645f gateway run passed all 211 cases in nine
  files. Its actual statement/branch/function/line counts are respectively
  245/262, 191/234, 64/68 and 235/248, each above 80.01%. Both raw gate reports
  record Node 24.21.0 and `npm: null`; the enclosing wrapper separately observed
  npm 12.0.2 before/after. Do not rewrite those fields or transfer this result
  to the next commit.
- The 34 active-maintenance failures selected current5 plugins for already
  linked retained family4 sources. Their fixture now explicitly selects the
  existing retained registry and checks its recorded identity, plugins and
  layout. Three added controls prove current5 reselection still refuses without
  project or external-preview effects. The production same-intent guard is
  unchanged.
- Reader isolation now mocks the actual `modernActivationSourceIdentityTables`
  construction seam. Its original historical-isolation and modern-unavailable
  assertions remain unchanged; the stale mock of a different exported factory
  no longer masks which reader was selected.
- The three obsolete public historical-to-current5 publication expectations are
  explicitly replaced, not relabeled as preserved positive cases. Each new
  refusal case checks preview, bare apply, force and supplied-fingerprint modes,
  actual unchanged project/home inventories, no plan and no completion claim.
  Apply without a saved preview remains `preview-missing`; its conservative
  requested/uncertain report fields are not fabricated as known no-effects.
  Independent explicit retained-family4 publication positives remain exercised.
- Ten Manual prerequisite failures were environmental. Adding the existing
  Python 3.14 bin path first exposed a separate incompatible global uv 0.13.1.
  Selecting the existing checksum-bound uv 0.12.7 prefix made those same ten
  unchanged cases pass. No installation, global-tool mutation, policy/budget
  relaxation, added skip or native network-engine permission was used.
- Coherent nine-file verification passes 307 cases with zero failures and 15
  unchanged explicit engine-lane skips. Of the 319 original literal cases,
  256 prior passes remain passed, 45 prior failures now pass and 15 skips remain;
  the three obsolete failed public positives are replaced by three differently
  named refusal cases, alongside three new same-intent controls. No aliases or
  assertion-preservation claim is made for the replaced positives.
  Strict compilation covers nine roots and 806 distinct actual regular files,
  including JSON. Project noEmit, policy, strict OpenSpec and whitespace checks
  pass. Receipt `root-canonical-recovery-qualified-qualification.json` has
  SHA-256 `aca17ff957d36aa5864db5bb1fcca074506a5b235585f2c29151eb1fd29853c2`.
- The user-interrupted first qualification, both new refusal-test assertion
  mistakes and the new regression's initial correlated-union typing refusal
  remain separately retained with their original inputs/streams. They are not
  original production defects or completed qualification. The final regression
  uses the existing validating project reader rather than a cast.

These are bounded recovery checks, not fresh complete CLI coverage or native,
provider, currentness or release qualification. Rebuild the development fixtures
and rerun independent canonical CLI/gateway gates on the exact committed
successor. Progress remains 87/136; tasks 14.3 and 18.2 remain unchecked.

## Root qualification recovery, 2026-10-16

This checkpoint is a test-only successor to owning Root
`9b4547227c60e2eee9689f49d8c39bea9f873868`, tree
`ba6b10ea6e0e30f731c1e33df53cb6990ff4026d`, on
`feature/state-custody-readiness`. It does not intake the later private
Checkov SOURCE milestone or change production admission rules.

- The mutable Homebrew Node path now resolves to Node 24.22.0, and its prior
  canonical Node 24.21.0 executable is absent. The running canonical CLI
  coverage attempt used that unqualified runtime and was stopped. Its partial
  streams and four observed process settlements are retained; there is no
  completed-suite result or coverage qualification from that attempt.
- The original uninstrumented full-suite attempt remains an independently
  retained `ENOTCONN` failure without a final assertion report. Its cause is
  not established. Do not retrospectively attribute it to tool drift or invent
  assertion counts.
- The clean-9b45 gateway run retains its actual 211 passing cases and four
  passing coverage metrics. Its original evidence records Node 24.22.0 and
  unavailable npm-version observation, not the pinned native runtime tuple.
  Do not reinterpret that report as Node 24.21.0/npm 12 qualification.
- The already-retained Node 24.21.0 Darwin/arm64 archive was rehashed against
  `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`
  and restored only under the Root session's owned artifact prefix. Its
  executable SHA-256 is
  `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`;
  the existing npm 12.0.2 tool is selected through an owned-prefix link.
  No global tools, source policy, deadlines, pools or thresholds changed.
- The 24 failures in `tests/update-prepared-successor.test.ts` independently
  reproduced on restored Node 24.21.0/npm 12.0.2. They were a separate fixture
  selection defect: retained family-4 successor cases selected the current
  family-5 registry, for which automatic successor lanes intentionally remain
  unallocated. The fixture now explicitly selects the existing pre-workflow
  registry. A new application-level control verifies the actual family-4
  selection, the distinct current family-5 selection, and refusal of the latter
  without preview, audit or project effects.
- The coherent three-file baseline was 125 passed/24 failed. After the
  fixture-only correction, the same three files pass 150/0/0: all 149 prior
  literal identities and multiplicities remain, all 125 prior passes remain,
  the 24 original failures pass, and one current-family refusal control is
  added. Strict typing covers three roots and 627 actual distinct regular
  compiler files, including JSON; project noEmit, repository policy, strict
  OpenSpec validation and whitespace checks pass. Qualification receipt
  `root-prepared-family4-fixture-qualification.json` has SHA-256
  `5181bc449767d0f93e90f65080612c34475aa4281ccd75967ba994bfa6c41f49`.
  The original reviewer-only revision-bookkeeping refusal is retained
  separately; it started no test commands.

These are scoped fixture checks, not a completed current Root full-suite,
CLI-coverage or native qualification. The original frozen released records,
family allocations, public routing, protected journals and task flags remain
unchanged. OpenSpec progress remains 87/136; tasks 14.3 and 18.2 stay unchecked.
Continue qualification serially with the owned, pinned runtime rather than
the mutable Homebrew path.

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
- OpenSpec progress is 87/136 tasks complete; 49 remain.
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

### Task 14.2 serialized current-5 integration proposal, 2026-10-13

Coordinator review admitted exact private source
`4c7efd104b26167125076c976cb34e3f143c1188`, tree
`17a3d25eaa9d690a2fccf92e9518de5bc7319550`, for bounded source reuse and
preparation of a serialized modern/current-5 integration proposal. This is
not shared/public/native/cloud execution admission and does not complete task
14.2.

Read-only inspection of current-5 owner source
`d38d86c0f4f61d1e034cbc0d0b879ffdae371bcb`, tree
`78a15d31fed00c2d1f7ffc64eb0df3c995f8c3d6`, confirmed:

- the current source family uses activation contract 5, graph schema 3,
  saved-plan schema 3, state/evidence/approval schema 4, compatibility
  metadata schema 5, and six profile/workflow-specific graph hashes;
- compatibility still declares execution `source-contract-only`;
- `application-foundation` still declares `application-foundation.v1`;
- source-5 `staging-qualified` and `production-rehearsed` payloads are the
  workflow-only `.v2` allocation;
- the existing transition/runtime surfaces remain legacy
  `PhaseAdapterExecutionInput` contracts and cannot be cast into or borrowed
  by a modern application engine; and
- staging/production graph permissions still include Azure provision and
  backend-state-write even though the admitted private application read path
  is strictly observation-only.

The concrete proposal was sent to current-5 sole allocation owner session
`e1389524-41f1-47aa-8c43-4bf14b14cf20` and serialized coordinator session
`8d89d4b7-10db-4009-945e-b14397314a84`. No shared source was edited.

The proposed identity and graph change does not reuse or overwrite the six
`d38d86c0` graph hashes. It introduces a distinct
`application-foundation.v2` protected-deployment payload and combined
`staging-qualified.v3` / `production-rehearsed.v3` payloads rather than
overloading the admitted workflow-only `.v2` schema. The staging/production
application path retains GitHub read/dispatch and Azure read, but removes
Azure resource provision and backend-state-write; application-foundation
retains its exact Azure provision/read and protected backend read/write
permissions. These changes produce six new graph hashes and phase-contract
digests. They therefore require the sole owner to allocate either an exact
source-5 successor with `d38d86c0` frozen readable or a new activation
contract version; they cannot silently mutate the published current-5
identity. Saved-plan/state/evidence-header/approval fields need not change.
Compatibility must remain `source-contract-only` until genuine producers
qualify.

The proposed private `ModernApplicationExecutionCarrier.v1` is separate from
`PhaseAdapterExecutionInput`. Its serialized fields bind the complete modern
identity, phase and phase-contract digest, state/plan/saved-plan/operation and
approval commitments, original invocation times, and exact application
binding, source, artifact, backend, provider-lock, configuration,
customization, subscription, tenant, environment, resource, cost, custody,
and original-state-authority digests. It carries no raw state, plan, secret,
or health body and no runtime callbacks.

Runtime ownership remains outside the serialized carrier:

- an engine-owned durable checkpoint store loads and records pre-effect
  intent, first accepted handle, and terminal provider truth;
- a read-only immutable source/runner/network/custody producer supplies the
  independently qualified execution authority without borrowing workflow
  issuers, tag writers, auxiliary namespaces, or legacy callbacks;
- a protected-state producer supplies authoritative lineage, serial, state,
  unchanged-unmapped-state, backup, lock, and writer-quiescence digests;
- a private protected OpenTofu/Azure port performs the exact bounded dispatch
  or observation;
- a bounded actual HTTP observer returns only validated status/media/length
  and raw/semantic digests, never the response body; and
- a modern record writer creates evidence and advances state only after all
  required proofs are durable.

The modern application-foundation plan must contain exactly
`azure.application-foundation.apply` with its exact effects and static
application/source/backend/artifact/state-authority/approval commitments,
not the current `{ opentofu: true }` placeholder. Staging and production must
contain only their exact readback operation, admitted completion/handle/source
commitments, and no application apply/import/move/state effect.

Required write ordering is: decode and revalidate modern state, plan,
approval, and source; observe independent execution and state authority;
build the exact protected plan; fail `configuration-mismatch` before intent;
persist intent; dispatch once; persist the first accepted handle; observe
terminal provider truth; persist terminal truth before fallible export,
mapping, Azure readback, HTTP health, or evidence; then write modern evidence
and state. Source freshness is re-observed before the effect and before final
readback. Any failure after acceptance retains the original accepted or
terminal checkpoint and permits observation-only reconciliation, never a
second dispatch. Evidence or state-write failure likewise preserves terminal
truth and retries only final observation/evidence construction.

The proposed evidence receipts contain only binding, source, execution
authority, original-state authority, protected-plan, mapping-batch,
checkpoint-chain, completion, fresh-readback, custody, retention, and
disposal digests plus sanitized resources and exact operation identity.
Staging/production `.v3` retains the existing workflow proofs and adds the
admitted application completion and fresh Azure/HTTP proof. No protected
state/plan payload or health body crosses the carrier.

No qualified protected application dispatch port, authoritative original
backend-state producer, durable modern checkpoint store, or bounded actual
HTTP producer is currently admitted. Each remains a real qualification
blocker rather than a structural success. The canonical HCL
resource-group/registry/identity ownership-tag mismatch also remains
`configuration-mismatch`; a generator remedy requires a separate exact
allocation/intake. OpenSpec remains 82/136, task 14.2 remains unchecked, and
no real GitHub, Azure, OpenTofu, registry, RBAC, state, cost, health, or
global effect occurred.

The current-5 sole owner reviewed the proposal boundary and explicitly
withheld shared/current-5 consumption. The existing approved allocation
remains strictly activation 5 to activation 5 with unchanged `fce27` source,
six graph identities, workflow-only components, and no task-14.2 port or
callback wiring. The proposed foundation `.v2`, combined staging/production
`.v3`, and changed allowed effects are a separate normative contract
allocation. The owner's recommendation is activation contract 6 with
`d38d86c0` source 5 preserved readable, rather than two different phase and
recovery meanings labelled current 5. The serialized coordinator must choose
and authorize that allocation before any shared family, graph, payload,
compatibility, phase, or runtime edit. Existing immutable-ref observers remain
stable, and no generator/HCL intake is implied.

### Native stack 162 post-repair CI boundary, 2026-10-13

Read-only native-stack revalidation confirmed stack 162 remains open with
exact membership `[158, 159, 161]`. PR 161 remained open, non-draft, without
auto-merge, at exact live head
`dec2d477925ef2b00c03dd71004ebd54740cdda0`; its live branch ref matched.
Previously published Windows repair
`f0fd79ae533749ad5bf922900abe10ff9f9cf336` is the direct ancestor of
`dec2d477`, so the fresh result below is a genuine post-`f0fd79ae` failure,
not an integration omission.

Automatic whole-head run `38402156706` completed with successful Linux,
macOS, coverage, package, HCL, telemetry, repository-policy, and Windows
shard-1 gates. Windows shard 2 job `115312248354` failed one actual test:
`tests/repair-application.test.ts:225`, “executes native Node tests and real
reference checks against the candidate without applying the file
transaction.” The aggregate Windows job failed only because that shard
failed. Stack 162 must not land.

Exact retained runner metadata was:

- `exit: unknown`
- `timedOut: true`
- `errorCode: SUPERVISOR_TIMEOUT`
- `processSpawned: true`
- `processTreeSettled: false`
- `supervisorPhase: startup`
- `controllerStage: connected`

The dedicated boundary artifact is retained outside the repository at
`files/windows-boundary-38402156706/windows-boundary-tests.json`. It records
the failed test duration as **16,735.8205 ms** despite the declared 30,000 ms
target-command budget. Therefore the unchanged 15-second controller startup
supervisor fired after the controller connected, became ready, and received a
spawn request, but before any valid acknowledgement proved `CreateProcess` or
actual target start; the target budget did not begin. The same shard's
dedicated packaged-controller test passed in **686.4988 ms**, along with all
startup-boundary controls. Exact source tracing therefore remains bounded to
the post-request, pre-ack environment/job/stdio/attributes/`CreateProcess`
path under whole-suite load. Neither deadline may be extended or
back-attributed to target execution.

The owner independently retained the complete failing log with SHA-256
`ea351d8e9b2915d51a4920fbb4e1b2e040d666e5bfd18ccee36be8027d99718f`
and boundary ZIP `11819272407` with SHA-256
`c16eb655d8fb62e9f95b62fe6e9dc38bf56b050dea6e32f08149ff02a47db2d6`,
matching the Actions API artifact. The exact 55-file/1,937-test shard result
was 1,911 passed, 1 failed, and 25 existing skips. Native 18, OpenTofu 21,
and the complete Windows shard 1 all passed.

Exact evidence and ancestry were sent to PR-161 owning session
`dd2469fb-1715-433c-9155-925eee7eee4d`. That owner was asked to publish only
a root-cause successor preserving the 15-second startup supervisor, declared
30-second target budget, containment, settlement, grace, worker, skip, floor,
protocol, and frozen-history contracts. No repair code was edited in this
continuation, no CI rerun was requested, and no stack mutation or landing
occurred.

### Activation 6 decision and bounded private engine source, 2026-10-13

The serialized coordinator selected a separately authorized source-contract
activation 6. Exact source 5, `fce27`, all six current graph identities,
read-only original interpretation, and every historical family remain frozen
and readable. Foundation `.v2` and combined staging/production `.v3` are the
approved direction. Staging and production application authority is strictly
Azure-read-only: backend state read, backend state write, provisioning,
application dispatch, apply, import, and move are excluded. Retained GitHub
workflow read/dispatch authority does not delegate any Azure write.

The sole shared allocator remains
`e1389524-41f1-47aa-8c43-4bf14b14cf20`. It must first preserve and publish the
coherent approved 5-to-5 workflow bridge, then return the exact activation-6
identity, graph, phase-contract, capture, and edit set for coordinator review.
No shared identity, graph, phase, compatibility, runtime, issuer, namespace,
callback, or public wiring was edited here.

Within the separately allowed private scope, a version-neutral engine-owned
protocol was added in
`src/governance-activation/application-deployment-engine.ts`. It does not cast
modern records to `PhaseAdapterExecutionInput` and does not allocate any
activation identity. Its boundaries are:

- an independently durable checkpoint store loaded by exact request digest;
- no-effect preflight before any intent;
- durable intent before the one permitted provider dispatch;
- a first running accepted handle recorded by the engine;
- observation-only recovery from retained intent or accepted handle;
- terminal provider truth recorded before any fallible completion export,
  mapping, readback, health, or evidence construction;
- terminal and accepted checkpoint failure paths that retain the strongest
  durable truth and never redispatch;
- completed write construction only from separately supplied provenance,
  plan, mapping, and completion proofs; and
- read-only completion derived from a bounded actual observation object,
  with runtime shape and exact binding checks rather than a producer boolean.

Focused controls cover preflight blocking, one dispatch, ambiguous
intent/accepted/terminal checkpoint writes, acceptance-then-later failure,
intent-only observation, handle substitution, unsupported synchronous
terminal dispatch, terminal-before-finalization ordering, finalization
failure, malformed readback, and no second dispatch. This source remains a
private protocol; no qualified protected application, state, checkpoint,
HTTP, Azure, or OpenTofu producer is claimed.

The coordinator subsequently approved only the bounded private source form of
the canonical HCL ownership-tag remedy. The implemented contract is one closed
nullable object, `liftoff_activation_ownership`, with exact fields
`bootstrap_binding_digest` and `prerequisite_binding_digest`. Its default is
`null`; ordinary, Manual, governance-none, and not-yet-activated generation
therefore emits no reserved Liftoff ownership tags and requires no private
activation evidence. The object is forwarded through each environment root
but is never written into committed `<environment>.tfvars`.

Protected execution supplies the non-null object only in the ephemeral
`liftoff.auto.tfvars.json` overlay. Runtime admission requires exactly those
two keys, lowercase 64-hex values, and equality with the original verified
records. The resource-group tag authority is
`phaseOutputs['bootstrap-local'].values.bootstrapBindingDigest` plus verified
`bootstrap-local` evidence. `remote-import-verified` must preserve the same
digest as continuity evidence but is not substituted as the original tag
authority. The ACR/application-identity authority is the verified
`application-prerequisites-ready` binding digest. Null handling uses explicit
conditional digest/tag expressions: the null branch never reads object
attributes, while a non-null value must match the exact lowercase 64-hex
pattern before it can become a tag value. It does not rely on boolean
short-circuit behavior.

The generated resource group conditionally receives exact
`liftoff-managed-by=liftoff`, `liftoff-phase=bootstrap-local`,
`liftoff-environment`, and original bootstrap `liftoff-binding` tags. The ACR
and application identity conditionally receive exact environment and original
prerequisite binding tags. AcrPull remains exact; AcrPush remains externally
owned and absent from HCL. The private source observer now semantically parses
the committed module/root HCL and rejects changed names, locations, provider
attributes, forwarding, tag construction, lookalike literal tags, AcrPush, or
committed protected ownership values. The overlay validator rejects null,
missing, extra, malformed, recomputed, or mismatched protected objects before
provider execution.

The bounded changed surface is
`src/generators/infrastructure/azure.ts`,
`src/governance-activation/application-deployment.ts`, their exact tests, and
this handoff, plus one narrowly coupled Manual source-interpretation change:
`object` is admitted as a pure HCL type constructor alongside the already
admitted Manual-only pure functions. No `map`, unknown-object shortcut,
filesystem function, environment function, dynamic source, provider authority,
or parser-policy weakening was added. `renderTofuTfvars`, provider versions and
locks, artifact logical identities/layout, unrelated custom files/resources,
predecessor bytes, state, and role ownership remain unchanged. Infrastructure
repair preserves and forwards an ownership variable only when the existing
project already declares it; it does not inject private values or rewrite
old/custom projects. Focused application, generated-HCL,
Manual/no-governance, repair, isolated-parser, and reviewed governance controls
pass, including native OpenTofu null/valid/invalid/missing variable cases.
This source patch is not shared activation-6 allocation, apply authority,
brownfield import, existing-resource mutation, a configuration waiver, or task
14.2 completion.

Final pre-commit focused evidence under Node 24.21.0, npm 12.0.2 and restored
OpenTofu 1.12.6:

- build passed;
- application deployment, generated infrastructure, and native Manual
  OpenTofu checks passed 63/63;
- the 13-file adjacent generation/repair/source-inventory/governance set passed
  710 tests with three existing skips;
- private application source plus engine coverage passed with 88.74%
  statements, 91.98% branches, 99.09% functions, and 88.59% lines; and
- supported-stack, repository named-file policy, strict OpenSpec validation,
  and `git diff --check` passed; and
- reviewed task-14.2 successors now wrap the task-14.1 and complete earlier
  chains for `status-json`
  (`31988e7f08d48c0fdeebe1c5235d827f3221b41f24b0bea03454bc33c4f77c94`),
  `status-local-json`
  (`2a4dcfb30328068decc3add5db80b011334b6b5d8819e04978b933481406beaa`),
  `resume-json`
  (`490465574ee04fa753e23bc447fecb452302482f624dafce0d658bb3b539580a`),
  and `plan-json`
  (`cd5f9b8a8e832d472b67575caaa527dad6f6b2a01d1a628c336d36b57ad2ec60`).

Clean qualification of the preceding private-engine commit first exposed two
environment mistakes: direct npm-CLI invocation did not place the exact
12.0.2 launcher on `PATH`, and ambient Python was 3.14.8 rather than the
preserved 3.14.7 runtime. With the full isolated npm/Python/uv/OpenTofu profile,
all rerun failures cleared except a governance extraction record. Exact
parent/current comparison proved that mismatch predated the private engine and
was solely the admitted task-14.1 application capability disclosure changing
current `status-json`, `status-local-json`, and `resume-json` output from
unavailable to injected-only with a stronger fail-closed blocker. New
task-14.1 successor records wrap the complete existing task-13.5 and earlier
`priorChange` chains; frozen captures and historical records were not
regenerated, flattened, or rewritten.

The session-local OpenTofu path was later found to have been overwritten by
ambient 1.13.1 bytes. Exact 1.12.6 was restored from the official darwin/arm64
release archive. The archive SHA-256 is
`e083ee43790ab9e19ad66d9933e24a7244a1412e1d5728f37999ae2163fdac95`;
the extracted executable SHA-256 is
`0445d7cc114d24440af150b1ddec600f4e4c3e6af16ba63a9a7d42054ae970e3`,
matching the previously retained qualified binary identity. Subsequent native
HCL evidence must use the restored `tofu-1.12.6` directory and export the full
qualified `PATH`; a one-command environment prefix does not persist across a
later `&&` command.

After this HCL/private-source milestone is committed and qualified, the
coordinator-authorized ordinary preserving SOURCE integration order is now:

1. native9 `b65515ccfb83a19972574340ad45a11c09c79710`;
2. upgrade10 `def217170a70caaf8938221ab7c925e71a6f08e5`;
3. migration11 `0b9c61575af8959795ccc10a1b4f5aa6ed5aaaa7`
   (tree `d6aa57ad4dba22abcac05fdba76dcea1ffc0416a`);
4. project-telemetry16 `c477d24d50e906a98afd718682d6aa2466693515`;
5. Grafana17/Windows diagnostic candidate
   `c550a7290053965f3a77145e239fb5e7d14bd7a0`.

Root's independent migration11 receipt is
`beb0dd6a4780ff350dabd1205d10565d5d41a22905bb6b8efc7e6d338497e967`.
The telemetry/Grafana receipt is
`448eb3c3c290afb13ee6740f0dd799e461303ad2590decbd11531547bed34ef1`.
The green c550 Windows evidence is diagnostic only: it does not identify the
older pre-ack blocked call, prove its root fix, or qualify the dec2 repair.

Use one ordinary preserving merge per unit. Run small exact regressions and
identity/source-inventory checks after each merge. Stop shared
family/identity/graph/history conflicts for the sole allocator; never resolve
them with ours/theirs. After migration11, run a fresh combined complete
CLI/gateway/current selected native+migration gate; do not relabel inherited
native9/upgrade10 evidence as migration11 qualification. After telemetry16 and
Grafana17, run a distinct fresh combined CLI/gateway/relevant
installed/native/platform gate; do not relabel the 9-11 gate as 16/17 proof.
The source-intake authorization is not PR-stack landing, publication, cask or
provider registration, real migration, production telemetry/Grafana apply,
client enrollment, public channel enablement, or task-flag advancement.

Task 14.2 remains unchecked pending the exact allocator readback, separately
admitted HCL intake, qualified real producers, and genuine disposable
qualification.

### HCL ownership milestone qualification correction, 2026-10-14

The approved private HCL/source milestone was committed as
`841eddac4d7c91f78673ca8cd8295194210f507c`, tree
`23e4d04ed3b2913e422807cb30bb39b0a560a3ff`, with direct parent
`9a31b983cf398fa15b7a3f1da832e77526e35bd6`. Its first clean committed
qualification used Node 24.21.0, npm 12.0.2, restored OpenTofu 1.12.6 and
OpenSpec 1.11.0. Supported-stack and build passed. The unfiltered suite then
ran for 3,946.23 seconds and reported 304 passed files, five intentional
skipped files and three failed files; 10,138 tests passed, 117 were skipped and
169 failed. The chained source-complete coverage command did not run after that
suite failure.

The immutable raw log is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/hcl-ownership-841eddac/clean-qualification.log`

Its SHA-256 is
`876cdffb5331ad91152a5f7755e821ff1f2ab5d9e8dc1ae2559db49ab736163c`
and its byte length is 3,765,182.

The failure separated into two exact causes:

- the approved generator variable, forwarding, owned-tag and README changes
  had not yet received current reviewed successors for 165 plugin-generation
  matrix cases, 16 representative rendered-artifact cases and four current
  CLI JSON cases; and
- ambient `/opt/homebrew` OpenSpec 1.11.0 had the current registry resolution
  profile (2,590 files, 299 directories, two links and 11,849,959 bytes), not
  the frozen qualified cutoff profile. Version equality alone was
  insufficient.

The generated-output correction is test-evidence-only. Exactly 185 top-level
records now wrap their previous complete records as `priorChange`, retain each
original baseline digest, and bind the actual current output. No prior record
was flattened, regenerated or altered. A structural check proved all 236
top-level keys stayed in the same order and every changed record's nested
predecessor is byte-for-byte the former top-level record.

The requested native ownership correction also changes tests only. It extracts
the actual emitted ownership `locals` block from the generated application
module, evaluates all four emitted locals with provider-free OpenTofu, writes
saved plans and inspects their JSON. It proves ordinary null input produces
null digest/tag outputs, valid protected input produces the exact four-key
resource-group and two-key application maps, and malformed, missing,
uppercase and non-hex digest inputs fail.

OpenSpec was restored in a global-style isolated npm-12 prefix using the
required registry cutoff:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/macos-toolchain/openspec-qualified-cutoff-1.11.0`

`scripts/native-custody-qualification.mjs verify-openspec-profile` confirms
2,590 files, 299 directories, two links, 11,862,860 bytes and exact profile
`sha256:05d52efd0875c1ff0c1bd0aec13f7128a4baab787ea6b31f33fa7360cd53bde2`.
Use this prefix before every later native command; do not substitute a
same-version current-registry tree.

Focused successor validation passed:

- build;
- seven focused files with 353 passing tests and two existing skips, including
  the 165-case plugin matrix, frozen contract baseline, actual emitted HCL
  saved plans, private application binding, Manual interpretation, repair
  preservation and explicit native OpenSpec identity;
- supported-stack;
- repository named-file policy;
- strict OpenSpec validation; and
- `git diff --check`.

Session `68be53ea-3101-4b13-b2a8-e520cecb7a48` independently retained the
requested exact 94f0/5d normalized CLI observations, so no duplicate capture
generation is needed here. Its reported immutable receipts are
`parent-observation.json`
`dd026d3d42790a1dff70bda7fc0e5df405b0f07c4a9865cea501845802c262e9`,
`current-observation.json`
`67c0828f4dee362f360e6b1ea9d8ef82f92cdabfdacc36c9870cfaf04ed39eed`,
and `actual-cli-differences.json`
`34ee012ea18ea09f3551d1abd3f788adf98080798ca6dff33122979bfa0faac2`.
Only the three task-14.1 intermediate governance-extraction records are
reusable; the task-14.2 outer records and whole HCL head are not.

Commit this narrow successor, then rerun the complete clean committed
qualification sequence and its focused/package/policy/OpenSpec follow-ups.
Native9 and all later SOURCE intake remain held before every shared-file
resolution pending root review and sole-allocator per-file disposition.

### Qualified and published HCL ownership milestone, 2026-10-14

The test-only ownership correction was committed as
`12d2f4715d8f1901093676baa875f1422c5c5a90`, tree
`610e05452993b4fdafaad28cbe9a704cb55a4fc9`, with direct parent
`841eddac4d7c91f78673ca8cd8295194210f507c`. It was fast-forward pushed to
`origin/voyager163-liftoff-modernization`, and GitHub readback confirmed that
exact commit, tree and parent. The four required continuation ancestors remain
ancestors of the published head.

The first clean committed qualification attempt preserved the exact source and
failed after 4,031.10 seconds in two
`tests/modern-openspec-initialization.test.ts` cases. The shared complete
OpenSpec distribution scan exceeded its unchanged 30-second custody deadline;
the second selected test never reached its injected command because the same
scan failed first. The attempt reported 306 passed files, five skipped files
and one failed file; 10,305 tests passed, 117 were skipped and two failed.
The immutable log is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/hcl-ownership-12d2f471/clean-qualification.log`

Its SHA-256 is
`7817e22d4e9279b4a39368ef4058f6858aeea971f92ac580e6adb2d172d9ba37`
and its byte length is 2,261,131. An initial focused reproduction omitted the
ambient Docker and Go paths and failed before the OpenSpec scan; that was an
environment setup error, not a source defect. Both exact failing selectors
passed unchanged with the complete native tool path. The 30-second deadline,
custody policy, thresholds and source behavior were not weakened.

The second clean attempt on the same exact commit and tree passed:

- supported-stack and build passed;
- the unfiltered suite passed 307 files with five intentional skipped files;
- 10,307 tests passed, zero failed and 117 were skipped in 4,225.59 seconds;
- source-complete CLI coverage included 511 source files with inventory digest
  `sha256:77942f49cc57f9da92b06b09e81b412af754cb7ca36510e37cd0b224ddc6cbdd`;
- statements were 40,883/45,607, 89.6419%;
- branches were 36,463/42,533, 85.7287%;
- functions were 7,700/8,105, 95.0030%; and
- lines were 36,256/39,493, 91.8036%.

The successful raw log is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/hcl-ownership-12d2f471-retry/clean-qualification.log`

Its SHA-256 is
`4cd8748adeb4db63ada4465c9cae67fe182275493416bef21ee107912ca047c1`
and its byte length is 5,406,073. Coverage verification, seven focused files
with 353 passes and two existing skips, package smoke, repository policy,
strict OpenSpec validation, `git diff --check` and the final clean status also
passed. Their log is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/hcl-ownership-12d2f471-retry/follow-up-validation.log`

with SHA-256
`3706d14e6e838c17a68502dc9e43ce07aad98fe29bc695d910e31ec761b1eddc`.

Before later coverage could replace `coverage/cli/`, the exact successful
`12d2f471` raw coverage-final, coverage-summary, text report, test-results,
complete coverage evidence, and both successful logs were copied byte-for-byte
into a read-only session artifact:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/hcl-ownership-12d2f471-raw-qualification-sealed/manifest.json`

The manifest SHA-256 is
`fb7096ed188abecb9d9d4cbce75fb1693653c96a2043182c15ffb6b9bba7f7f4`.
It records each original subject path, copied path, byte length and SHA-256.
`coverage-evidence.json` contains the complete 511-source, 407-test and
five-configuration-file inventories plus exact revision, command, host/tool,
limits, test counts and integer coverage metrics. The copied bytes were
compared before the directory was made read-only.

Independent actual-output review remains retained separately:

- `hcl-independent-audit/comparison.json`,
  SHA-256
  `c3290feb7351b2ecd2b3dd35f18639433d5bdaf6a8bac405f8e1b85eeee2e5bc`;
  and
- `hcl-independent-audit/extraction-comparison.json`,
  SHA-256
  `b87cf61835c9678efb40085dc1bc6b4c1b8895718fac66e5721bee41ff16bb3f`.

Those receipts prove the bounded 181 generation and four generic CLI changes,
the unchanged frozen extraction harness streams, and the complete predecessor
chains. They do not admit native9, shared identities, task 14.2, provider
execution, publication or landing.

Root independently re-extracted the sealed raw reports and admitted exact
`12d2f471`, tree `610e054`, for the bounded corrective HCL
source/repository test and CLI coverage gate. Its final review is:

`/Users/jonathan/.copilot/session-state/8d89d4b7-10db-4009-945e-b14397314a84/files/hcl-12d2-final-independent-audit/review.json`

with SHA-256
`88d5e1256b7dce24bc524c125580e1147560dd0811c351eda1deca9b8ffbb55d`.
The review independently reconstructed all 511 source counter maps with the
pinned Vitest 5 Istanbul library, reproduced the four integer totals and
strict greater-than-80% floors, verified 10,307 passes, zero failures and the
unchanged 117 intentional skips, and rechecked all 1,550 clean source blobs.
It explicitly preserves six original negative derived branch counters as
uncovered under provider semantics. The admission does not extend to native9,
later shared identity/family/graph intake, task 14.2, private activation stages
5/6, provider effects, public/cloud qualification, or landing.

### Bounded documentation successor, 2026-10-14

After the exact `12d2f471` qualification was sealed, three independently
reviewed patches were integrated without editing their retained evidence:

- CLI reference correction patch
  `87abb6c20abfdd7a3e1d8972839a4bd72ce666057f4559848031f1d1480b2979`,
  handoff
  `3632f62d5181db1634b83fa7a04abbca2b27af82d4be2448f0e01b23773dce6e`;
- packaged fragment regression patch
  `f48d2ea2add1f0090115b654cc03a5f819a3624da2b9ce9653a7c860d932ee15`,
  handoff
  `d83fdbc36aad878557f908e277234409503cc7cb08f6306aa14929c4aeaaed2a`;
  and
- lifecycle synopsis regression patch
  `6ca9b18551b470ee37fba89223c5c52b49a8a52f8e2490b301bdad36c4e88777`,
  handoff
  `e38c4d4751dd0449041fc679b912c4fefdba4665a7a68620a9b151fa72c01503`.

The separately retained physical macOS spaces-path supplement is
`ae89aa93571b53727716003b672eee845e07fa5fe074beff95c83cde94b1cce6`.
These receipts are supporting evidence only; this checkout still had to
integrate and qualify one coherent successor.

The successor corrects the following bounded documentation contracts:

- `docs/cli-reference.md` no longer advertises an unsupported positional
  argument for `liftoff doctor`; it documents current-directory diagnostics;
- the same reference now states that current plan/init/migrate generation
  writes manifest v8 and reads v2-v8 while preserving the exact historical,
  unknown-tuple, phase-graph and activation-v1 restrictions;
- current generated modern governance guidance names the registered
  project-independent `liftoff capabilities --json` catalog as read-only
  installed-CLI metadata, while preserving no project acceptance, execution,
  repair-support or invented `supported-manifest` field claim;
- the packaged configuration guide now links to the packaged private staging
  and bootstrap retention section instead of an unpackaged source README; and
- maintained local-link tests cover all four maintained README files.

The generated guidance correction initially changed both current and frozen
pre-assessment source rendering. The broadened focused gate correctly rejected
21 historical managed-body hashes. The source resolver now retains the
already-determined release classification as `current` or `pre-assessment`;
managed rendering uses the truthful capability catalog only for current source
and reproduces the exact former guidance for genuine historical source. The
immutable `pre-assessment-guidance-source.json`, historical declarations and
all old captured bodies remain unchanged. No current plugin identity, public
schema, manifest format, graph, policy, parser, command behavior, provider
surface or historical source bytes were retagged.

Three executable regressions were added:

- `tests/documented-command-contracts.test.ts` checks the actual doctor parser
  contract and current public manifest-generation capability;
- `tests/documentation-fragment-links.test.ts` validates the closed plain-ASCII
  ATX fragment grammar and every declared packaged same-page/cross-page
  fragment without claiming general GFM, HTML, setext, Unicode or custom-ID
  support; and
- `tests/documented-command-synopses.test.ts` expands the lifecycle table's
  closed optional/value/enumerated notation, feeds every expansion to the
  actual parser, and compares documented commands/subcommands with the
  registered definitions.

The first focused documentation run passed 526 tests and failed two expected
review controls: the old negative capability assertion and the missing current
contract-baseline successor. After correcting both, the first broader run
passed 559 tests and failed the 21 historical source-body checks described
above. The final build and 13-file gate passed 580/580 with no skips, including
the frozen baseline, current managed rendering, complete pre-assessment source,
current-project repair, generated infrastructure, plugin-generation parity,
repository governance and all documentation regressions.

Exactly one frozen top-level contract record changes:
`cli-json` / `update --check --json`. A structural check with an increased
child-process buffer proved all 235 unrelated records are identical, the new
task-18.4 `priorChange` is byte-for-byte the complete former record, its
`priorCurrentSha256` is the predecessor's
`557a862cc73b531448ee43c88cb71cc45721787d6dd77ae34de2d714c0f85c0c`,
and the new current digest is
`d8891c94656d0206e0c0bef1af1e8fb679c77674b51b552c0ff6698b43ef9105`.
The initial structural helper failed only because `git show` exceeded its
default child-process buffer; no ledger assertion failed.

Actual predecessor/current normalized CLI captures were then run through the
unchanged contract-baseline harness. All other JSON records were byte-equal.
Both normal and force plans changed only:

- `.github/prompts/liftoff-governance-assess.prompt.md`;
- `.github/prompts/liftoff-repair.prompt.md`;
- `.github/prompts/liftoff-setup.prompt.md`;
- `.liftoff/governance/README.md`; and
- the resulting `liftoff.manifest.json` content digest.

Exit codes, stderr, volatility, plan eligibility, blockers, operation ordering,
paths, modes and unrelated operations remained unchanged. The immutable
receipt is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/docs-successor-cli-delta-12d2/manifest.json`

with SHA-256
`96b630a52e848335e38cdd0c36c4b78e97a2da021d207bbd7be21fb4c713b166`.
Its `comparison.json` contains both complete normalized records and every
before/after changed leaf; `before-all.json` and `current-all.json` retain all
captured JSON surfaces.

Package smoke passed for `@msn-control/liftoff@0.12.3`; repository named-file
policy passed; supported-stack remained current; strict noninteractive OpenSpec
validation passed; and `git diff --check` passed. OpenSpec apply remains
`ready`, schema `spec-driven`, at 82/136 complete. Task 18.4 remains unchecked
because this is only the bounded documentation-contract slice, not complete
generated/native/installed/public documentation qualification. Task 14.2,
native9 and later SOURCE intake, shared allocation, activation-6, provider
effects, PR-stack mutation, landing and public claims remain held.

The bounded documentation successor above was committed as
`4f8d6baa94c7da7653baa0e319c03e784f1125c5`, tree
`c2647a7b16a5c3fe7073cf57f1a26efec076f1a4`, with direct parent
`12d2f4715d8f1901093676baa875f1422c5c5a90`. It has not yet been pushed.

Exact-head clean qualification preserved the source but did not qualify that
commit. Supported-stack and build passed. The unfiltered suite ran for
7,331.49 seconds and reported 308 passed files, five skipped files and two
failed files; 10,324 tests passed, 117 were skipped and seven failed. Two
unchanged complete OpenSpec distribution scans exceeded the existing
30-second custody deadline, and five later revalidation cases exceeded their
existing 120-second test deadlines. No documentation, generated-source,
ledger or changed-source assertion failed. Coverage did not run because the
unfiltered suite failed. The immutable log is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/docs-successor-4f8d6baa/clean-qualification.log`

Its SHA-256 is
`32bd349f6c531198f30fc2064131a730e04df0ba23163c1f8a5af0ce7153f07f`
and its byte length is 2,582,751.

A file-level rerun of
`tests/modern-openspec-tool-identity.test.ts` passed 26 cases and failed only
its second complete-distribution scan under cumulative load. Each of the seven
originally failed cases then passed unchanged in a fresh process with the
complete native environment. The isolated evidence is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/docs-successor-4f8d6baa/isolated-failure-reproduction.log`

with SHA-256
`86302cd3aab92f62c134243f8bfa28a704cb25a25c825f74a6f038d82bb0c963`.
The file-level cumulative-load reproduction remains at:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/docs-successor-4f8d6baa/focused-timeout-reproduction.log`

with SHA-256
`e9f7eaa85713d388fed75fa26c7b5e23b2580aadbb66144a54bac656a7390581`.
No deadline, custody bound, source-complete threshold, test expectation or
scan scope was weakened.

### Packaged-command and ruleset-readback successor, 2026-10-15

A second bounded successor integrates two independently reviewed patches
without extending their evidence:

- packaged command-example regression patch
  `c1b950950039fed673a9cd9371aec71a0aca9db71efd79cc9ff21aa40f41c14c`,
  handoff
  `fbdbd7c0da4167b3df642c36b0ff621575d86f0874e8a9ae71ace9f592c7464f`;
  and
- immutable ruleset readback-input binding patch
  `e33add509832b52d7832fa18cc21723c3243e58a46b6fd2079948e3c81d3c17d`,
  handoff
  `082f3604d86f6053ab5eb79eae30137b149659d1e324d458b0805028176a2026`.

`tests/documented-command-examples.test.ts` derives the actual packaged
Markdown inventory from npm's package list and checks its closed set of
runnable command examples against the real parser. It keeps literal commands,
bounded redirection prefixes, documented notation, partial command families,
negative/historical examples and alternation distinct. It does not execute
shell commands or establish provider, native-host, installed-package or past
and future `npx` qualification.

The ruleset readback correction is deliberately narrower than task 14.4.
`executeRulesetPhase` now captures an originally requested `live-readback`
repository, source digest, evidence header, operation set, expiry, clock,
lease assertion, approval inputs and `readRuleset` callback before the first
await. A caller mutation across lease validation cannot convert that read into
enforcement, acquire an injected writer, replace the repository or identity,
or relabel proof after observation. The ordinary writer path after its
original envelope acquisition remains unchanged. Maintainer guidance records
that the production ruleset reader is injected and read-only; it does not
claim a production GitHub adapter or live qualification.

The current dirty successor passed:

- a clean build;
- 289/289 tests with no skips across the twelve focused documentation,
  governance, readback-binding and package-policy files;
- strict standalone TypeScript checking of both newly added regression files
  and their imported source;
- package smoke for `@msn-control/liftoff@0.12.3`;
- supported-stack and named-file repository policy checks;
- strict noninteractive OpenSpec validation; and
- `git diff --check`.

Task 18.4 remains unchecked. The bounded implementation gaps are now:

- qualify one exact coherent committed successor through the unfiltered native
  suite and source-complete four-metric coverage gate; the failed
  `4f8d6baa` run and isolated selectors do not substitute for that gate;
- replay the complete maintained/generated README inventory and package-link
  audit on that exact successor, including actual package bytes and physical
  paths with spaces, without inheriting the independently reviewed
  `12d2f471` candidate as current evidence;
- retain cross-host Windows, macOS and Linux link/path evidence for those same
  coherent bytes rather than extrapolating the macOS spaces-path supplement;
- explicitly close the final four-README/generated-source/related-guide
  disposition against stale npm-primary wording, invented archive/setup
  aliases, premature completion/public-stateful claims, and anonymous
  project-ID claims; and
- leave any still-unqualified native, installed, cloud, stateful or provider
  feature labeled unavailable/unverified until its owning gate is admitted.

No new schema, capability, command, default, graph, shared identity, provider
effect or public surface is allocated by this successor. Task 14.4 remains
unchecked because no production ruleset adapter or live read/write
qualification was added. Native9 and later source-family intake, shared
allocation, activation-6, task 14.2, public/cloud effects, PR-stack mutation
and landing remain held.

### Assessment scope and current-successor correction, 2026-10-14

The packaged-command/ruleset-readback successor above was committed locally as
`ed0d344d2414e8783d8aeb5dfe2a89c66c36b4c7`, tree
`39dc5c323c1a70ccad0189a2c7a3e16008f7ed09`, with direct parent
`4f8d6baa94c7da7653baa0e319c03e784f1125c5`. It remains unpushed.

The first `ed0d344d` qualification preflight accidentally resolved ambient
OpenTofu 1.13.1. It was stopped before the unfiltered suite and retained only
as invalid setup evidence:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/docs-ruleset-successor-ed0d344d/invalid-opentofu-1.13.1-preflight.log`

with SHA-256
`f9080cab32076193a54e75b954d567110c33f4eb969622110b98ffbdf4a357cb`.

The corrected attempt used Node 24.21.0, npm 12.0.2, OpenTofu 1.12.6,
OpenSpec 1.11.0 and the qualified OpenSpec content profile. Supported-stack
and build passed. The command setup still omitted the restored CPython 3.14.7
and uv directories, and the wrapper used `pipefail` without `errexit`. The
unfiltered suite therefore failed but the wrapper continued into coverage:

- 309 files passed, five were skipped and three failed;
- 10,353 tests passed, 117 were skipped and 13 failed;
- two unchanged activation-history cases exceeded their existing 30-second
  deadlines;
- ten Manual cases correctly refused the unqualified ambient Python identity;
  and
- the team-gitflow initialized-baseline case returned a truthful failed result
  before dispatching its remaining checks.

The unfiltered duration was 5,105.58 seconds. Coverage was interrupted by the
user-directed pause and produced no final report or metrics; only its temporary
directory existed. It cannot qualify the failed invocation. The preserved raw
log is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/docs-ruleset-successor-ed0d344d/clean-qualification.log`

with 4,823,618 bytes and SHA-256
`dd8406db9f63b1ba2f23b00dc5e4aa82952c4823b8676759012de9e8d847306c`.
The explicit partial receipt is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/docs-ruleset-successor-ed0d344d/interrupted-evidence.json`

with SHA-256
`46fc2464155e79a948fab9bf5ff6e4f170fad6eaf2a41ef688c9ff511de2fcda`.
The checkout was clean at the exact subject when stopped, no queued source unit
had been applied and no attributable worker remained.

The retained team-gitflow result had `failureCode: process-failed`,
`inputsUnchanged: true`, `cleanupComplete: true` and no nonzero or unsettled
recorded subprocess. Status, apply instructions and selected strict OpenSpec
validation all exited zero; the failure occurred before `openspec validate
--all` dispatch. A separately named exact-`ed0d344d` archive rerun with the
restored CPython 3.14.7 and uv 0.12.7 paths identified the boundary directly:
the complete qualified OpenSpec distribution scan exceeded its unchanged
30-second custody deadline in `observeModernLocalTools` before initialization
execution. Its log is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/ed0d-team-selector-diagnosis/run.log`

with SHA-256
`907ab29db3d9f6f3823b6b65abf3a6d15cffdba5e1cdaf3b86cd1cab167610c0`.
The interrupted coverage invocation later passed the same team case on the
same source, which supports variable native scan load but is not substituted
for full-suite admission. No deadline or scan scope was changed.

After the failed/interrupted evidence was sealed, six independently retained
ordinary source units were integrated in their required order:

1. team review ref-scope patch
   `723d2138c69c1ade59b20f060874406578b14676e653b38a9e99a3db2f656b91`,
   handoff
   `d515ae481bbff111ef32c3829add0f0cdb0e4342cc6837e4948ebaa323b4d1a9`;
2. single-maintainer review ref-scope patch
   `08972902cbacd58285b4eb3718ce87b70927e16a866b56dfb7262581c75ffa12`,
   handoff
   `26fe17f029d6d58666960ecf87dd2eb0ec03e1bf89582457dc75c24d4e784df2`;
3. assessment original-scope patch
   `2ed730bf0e7ad281a68ed119516642d118364ab16a92999a84d203749f452557`,
   handoff
   `604bc68d541aa81673eb80c0df462bf5edd1680df31c4899e136adf1907d2843`;
4. current-successor documentation patch
   `0ab1d037f40d2682f34afcb36d4a3db55ea99a339f7822c3964aa006dd130ad8`,
   handoff
   `10f5d2d8fbc01a1bf4c1451e0efbfe0e4116fca5740ae3e4c90c5967e0078cbe`;
5. profile-aware classic review patch
   `67eb07d7754d60b010d910769b9cc05b506220cdfb98a8edf616f68771fef8d9`,
   handoff
   `f1d51c142d87f4deffa2250c024694dea764a68d7cbc4e5119e654cce8f2e67a`;
   and
6. integer review-count patch
   `9236a231b6025de21d04d369b93a42ab17526e070409e55f34b8d38d292fb800`,
   handoff
   `212e4f4cac13075ad8d0a41a3d19d1128806c8c8fa269fafdbdfa776772d096c`.

The combined source correction:

- requires team and single-maintainer review rules to cover main, develop,
  release and hotfix families rather than accepting an unrelated branch;
- preserves the single-maintainer profile's global refusal of human,
  code-owner and last-push approval requirements;
- interprets classic protection using the selected profile while preserving
  force-push, deletion, required-check, stale-review and incomplete-metadata
  refusal;
- accepts only nonnegative safe-integer review counts in declared and live
  metadata;
- captures the originally requested local/live assessment scope and initial
  report before asynchronous observation, without adding new observers or
  write authority; and
- corrects public historical-successor wording to the advertised
  `schemas.currentUpdate` state4/journal2/v8 contract without claiming that
  update performs separate verification or publication.

No policy/catalog bytes, profile identity, graph, default capability, provider
write, activation authority or external evaluator was added. Existing
unsupported mandatory observations remain partial.

Coherent validation passed:

- build and project-wide no-emit;
- 25 selected files with 760/760 tests and no skips or unrun cases;
- strict no-emit for the complete 23 clean fixture/import files;
- the complete 25-file strict fixture check reproduced the exact 12 inherited
  diagnostics with SHA-256
  `6eca6fdb9dd24433d51c01f108fabcc5ed6fadabab22d04579d4e99a2406d598`;
- package smoke for `@msn-control/liftoff@0.12.3`;
- supported-stack and repository named-file policy;
- strict noninteractive OpenSpec validation; and
- `git diff --check`.

The retained selected-results report is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/assessment-docs-successor-ed0d-working/selected-results.json`

with SHA-256
`8fec6c124f1fbaa92415b94c5e5bdbbb3683a5098a0ec84aac1ece6f08732cc7`.
The exact committed source successor
`0e29ad80252b46520dc2cfa9337733b6f16a128d` was independently reviewed
against all six retained source units, parent blobs and modes. The review
rehashed all 18 subjects, reproduced the 760-test report and clean 23-file
strict check, and confirmed the complete 25-file diagnostic output remained
byte-identical to the 12 inherited errors. Its receipt is:

`/Users/jonathan/.copilot/session-state/8d89d4b7-10db-4009-945e-b14397314a84/files/canonical-0e29-review/review.json`

with SHA-256
`98e0d5667d6884ef400c01f7cb59ab108d4810b9d48518923cbfdaf0e5a297ba`.
This admits the bounded assessment/documentation source only; it does not
admit full-suite, coverage, provider or landing claims.

OpenSpec remains `ready`, schema `spec-driven`, at 82/136 tasks complete.
Tasks 14.7 and 18.4 remain unchecked: this source unit does not add every real
evidence producer or complete the same-revision cross-host/full/package-link
qualification. A future exact committed qualification must use the complete
qualified Python/uv path and a fail-fast wrapper so a failed unfiltered suite
cannot continue into qualifying coverage. No push, PR mutation, provider
effect or landing is authorized by this checkpoint alone.

### Bounded npm runtime surface correction, 2026-10-14

After preserving the assessment/documentation checkpoint as a distinct commit,
the independently retained package runtime patch was applied:

- patch
  `21f765098d65d2c98cbf4f571437507781328b1db46791c2c10616c6f553e602`;
  and
- handoff
  `74c92c4b24b9969003a60bb0ece251ab877ba88c0db2c38fe765e95e9708d50a`.

The npm package now declares recursive emitted JavaScript and declaration
surfaces instead of the whole `dist` directory. Local TypeScript builds still
produce source maps for development; only packed development maps are omitted.
The package smoke contract admits exactly `dist/**/*.js` and
`dist/**/*.d.ts`, rejects every other packed `dist` payload, and retains the
unchanged 13 MiB unpacked-size ceiling. Explicit packaged assets, runtime
modules, declarations, package lock and dependency set remain unchanged.
`CONTRIBUTING.md` intentionally gained maintainer guidance for the narrowed
published surface, and this ledger records the correction and its evidence.
The `2647869d` ledger sentence that said all documentation remained unchanged
was inaccurate; this additive documentation-only successor corrects that claim
without rewriting the admitted commit, source receipt or validation evidence.

Validation on the canonical successor passed:

- build and project-wide no-emit;
- `tests/package-identity.test.ts` and
  `tests/package-smoke-contract.test.ts`, 38/38 tests with no skips;
- strict ES2024/NodeNext no-emit for the complete selected test/import graph
  with existing JavaScript helpers;
- real npm 12 dry-run inventory with 1,076 packed files, 8,855,966 unpacked
  bytes, 4,775,522 bytes remaining below the unchanged limit, zero packed
  source maps, zero unreviewed `dist` extensions and all sampled runtime and
  declaration files present;
- installed-tarball package smoke for `@msn-control/liftoff@0.12.3`; and
- supported-stack, repository named-file policy, strict OpenSpec validation
  and `git diff --check`.

The first two local inventory summary helpers incorrectly assumed npm 12
returned either an array or a direct pack object. npm 12 returned an object
keyed by package name. The successful `npm pack --dry-run --json` bytes were
not rerun or rewritten; the corrected read-only parser used the existing
inventory and produced the measurements above. These helper failures are not
source or package failures.

The first OpenSpec validation command used the unsupported
`--non-interactive` spelling and exited 1 before validation. It is preserved
as `invalid-openspec-non-interactive-option.log`, SHA-256
`d6a21c62645df48e749cff356d93d783f3cdf91a5eb6e74812d7a946cde0e832`.
The OpenSpec 1.11.0 `--no-interactive` command then passed. A separate evidence
hash command also exited after hashing existing subjects because it named two
nonexistent convenience aliases; the subsequent complete hash inventory used
the actual retained filenames. Neither driver error changed repository or
package bytes.

The complete evidence directory is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/package-runtime-surface-0e29-working`

Its selected test report has SHA-256
`7bd3c6a333c4d47c1413249ff75b7265234cd52150ba38a76a497ce703674d6a`,
the npm inventory has SHA-256
`f006837c88043a736016abae914809c3fef35014d27701c4fb3808dcd0ce6e42`,
and the inventory verification has SHA-256
`3de3d95302a9a914b70fbdf1fa7420a7363269d28b96a2dc28c4dc4b0730f07b`.

The exact committed package successor
`2647869d2eac2da8b5cdb1b4ea51929461bb4837` was independently reviewed
against its admitted parent and all retained source/evidence subjects. The
review rehashed 21 subjects, all 1,560 tracked rows and modes, all five exact
parent/target source blobs, the 38-test report and the 1,076-path package
inventory. Its receipt is:

`/Users/jonathan/.copilot/session-state/8d89d4b7-10db-4009-945e-b14397314a84/files/canonical-package-264-review/review.json`

with SHA-256
`362b3876214c26dab1890c4b4de864541b174a774210ac70ade60b3c156e3269`.
The first independent verifier assumed only the five package-source files and
refused the additional `resume.md` ledger file. That failed verifier result was
preserved; the reviewer separately inspected the additive ledger and corrected
the verifier scope to the actual six-file commit. The resulting admission is
bounded source admission only, not full-suite, coverage, provider or landing
authority.

The first current-head replay of the 25-file assessment/documentation corpus
after the package correction exposed a tightly coupled test-inventory defect:
758/760 cases passed, but
`tests/documentation-fragment-links.test.ts` and
`tests/documented-command-examples.test.ts` rejected the newly admitted
`dist/**/*.js` entry as an unsupported nonliteral package declaration. The
failed report is retained under:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/source-draft-b1d70c3c`

The corrective successor imports the existing
`compiledPackageFiles` contract and skips exactly its two reviewed compiled
patterns while constructing the packaged Markdown inventory. Every other
wildcard, absolute path and parent traversal remains refused. It does not
change the package declaration, package budget, packed bytes or documentation
selection.

Validation of that correction passed:

- the two directly affected files, 20/20 tests;
- the complete 25-file coherent corpus, 760/760 tests with no skips or unrun
  cases;
- package identity and smoke contracts, 38/38 tests;
- project-wide no-emit; and
- `git diff --check`.

The successful correction evidence is retained under:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/package-doc-inventory-b1d-working`

This correction does not raise a budget, remove local debugging output, alter
runtime behavior, qualify native packages or satisfy source-complete coverage.
No broad native/full-suite rerun was performed for this package-only unit.
Task 18.4 remains incomplete pending the coherent same-revision maintained
README/package-link/cross-host audit, and tasks 18.1/18.2 remain responsible
for the complete advertised matrix and fresh coverage evidence.

### Typed package-documentation contract and bounded native replay, 2026-10-14

The runtime correction above was committed as
`e77686a1ff4bfc211221cb9d32aa394a27df6a95`, pushed normally on
`askhooli-modernization-continuation`, and published as source-only draft pull
request #168 against the explicitly verified
`voyager163-liftoff-modernization` base at
`12d2f4715d8f1901093676baa875f1422c5c5a90`. The pull request remains draft
and unstacked; this publication is not full-suite, coverage, landing, provider
or release authority.

Before any broad rerun, one bounded affected native invocation used the clean
pushed `e77686a1` bytes with `set -euo pipefail`, the original native flags and
unchanged limits. The qualified tools were Node 24.21.0, npm 12.0.2, CPython
3.14.7, uv 0.12.7, OpenTofu 1.12.6 and OpenSpec 1.11.0. Its selector retained
the two activation-history cases implicated by the earlier process boundary,
the complete generated Manual matrix and the team initialized-baseline
OpenSpec case. It passed 15 selected tests with no failure. The reporter also
listed 88 unselected cases as pending because of the name filter; those cases
were not executed and are not qualification credit. This selector was
slightly stronger than the original failure set because the generated Manual
pattern also selected the Node and Go variants. The earlier Python identity,
history-timeout and initialized-baseline failures did not reproduce in this
bounded successor gate. No unfiltered suite or coverage followed.

The native evidence is retained under:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/native-affected-e77686a1`

Its preflight, run log and JSON report have SHA-256 values
`99827a6bb11e74a73fe71fa5d59574e2d2ef91e9684e802955abe24d7f1c00d6`,
`2364722286a320bf918dfd809e7733c37a1933f510eb437630fbba9eb224a36d`
and
`6f5c19db5f435b3dbd231140a7387d520bdc080c0dc1ef9e13a2632ea15c1dcf`
respectively.

Independent strict fixture replay then found that both corrected documentation
tests imported the JavaScript-only
`scripts/package-smoke-contract.mjs` boundary. Under the original
ES2024/NodeNext `--ignoreConfig` flags, with no `allowJs`, each test produced
TS7016. The earlier runtime 20/20 and coherent 760/760 reports remain their
actual results, but they did not establish the required strict fixture typing.
Those two TS7016 failures are preserved separately and were not relabeled as
part of the inherited fixture diagnostics.

The first typed correction moved the exact compiled declarations into the
existing `src/plugins/builtin/assets.ts` metadata module and imported that
typed source from both the smoke contract and documentation tests. Leaving the
constant as a literal tuple produced two TS2345 diagnostics for
`.includes(entry: string)`. A typed predicate removed those diagnostics, but
the coherent runtime corpus then correctly refused the predicate as a function
inside the enforced data-only asset leaf: 759/760 passed and the single
failure reported
`plugins/builtin/assets.ts:23: FunctionDeclaration is not data`. Both failed
iterations are preserved as diagnostic evidence rather than semantic credit.

The final correction keeps the metadata module data-only and declares the
single shared value as `readonly string[]`. The smoke contract re-exports that
same value, and both documentation tests import the typed source module.
There are no duplicated pattern strings, casts, handwritten declarations or
weakened inventory refusals. Exact behavior remains limited to
`dist/**/*.js` and `dist/**/*.d.ts`.

Validation on the final working successor passed:

- the two affected strict ES2024/NodeNext imports with an empty log;
- the complete 23-file clean fixture/import strict set with an empty log;
- the complete 25-file strict set with exactly the same 12 inherited
  diagnostics and byte-identical SHA-256
  `6eca6fdb9dd24433d51c01f108fabcc5ed6fadabab22d04579d4e99a2406d598`;
- the two affected runtime files, 20/20 tests;
- the complete coherent source corpus, 25 files and 760/760 tests;
- package identity and smoke contracts, 38/38 tests;
- project-wide no-emit and the installed-tarball package smoke;
- supported-stack, repository named-file policy and strict noninteractive
  OpenSpec validation; and
- `git diff --check`.

The final and failed-iteration evidence is retained under:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/package-doc-typed-e776-working`

The already-pushed draft source is therefore superseded additively by this
typed-boundary successor. It must remain draft after publication. OpenSpec
remains at 82/136 tasks complete; no task checkbox is changed by this bounded
correction, and no full-suite or coverage qualification is claimed.

The exact source-and-ledger successor was committed as
`7578e54ef0db14689d6796ccf24776a1383e9c0e`, tree
`0e22cd05f9fb3c5dbeeef2786eedf39c0bd9c162`, with parent
`e77686a1ff4bfc211221cb9d32aa394a27df6a95`. Its sealed evidence manifest is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/package-doc-typed-7578e54e/manifest.json`

with SHA-256
`7f2a93ff11c004afba02c38aaaf82908494a06c8381bc30bdbac0b4329bce544`.
This receipt records the exact five source paths, their committed blobs, all
final validation subjects and both failed correction iterations. It remains a
bounded source receipt only.

Independent review accepted the `7578e54e` source and validation subjects but
found one receipt-label error: `manifest.results.coherentFiles` preserved
Vitest's nested passed-suite count of 64, not the actual test-file count. The
original manifest remains immutable. The source report has 25
`testResults` entries, 760 passed tests and zero failed tests. The correction
supplement is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/package-doc-typed-7578e54e/manifest-correction.json`

with SHA-256
`f1040ca35bc59b28f6d2f0d67c98889425e6492cdd3fd234bdc9870d59314df0`.
No ledger, draft description or qualification claim treats 64 as a file count.

### Explicit maintained and generated README audit, 2026-10-14

Task 18.4 now has a source-enforced explicit inventory:

- maintained repository paths:
  `README.md`, `infrastructure/opentofu/bootstrap/README.md`,
  `infrastructure/opentofu/telemetry/README.md` and
  `src/application/state-migration/README.md`; and
- generated logical families:
  `root-readme`, `opentofu-readme`, `functions-readme`,
  `function-worker-readme`, `pattern-prompt-readme` and
  `repository-governance-guide`.

The integrated audit uses `buildCurrentProjectPlan` and
`buildCurrentArtifacts`, not the legacy generator. It verifies the current npm
installation path remains truthful while no Homebrew cask or WinGet channel has
been published; unshipped work remains labeled unavailable; protected state
handover/custody and brownfield migration remain unavailable/planning-only;
telemetry schema changes remain undeployed and do not enroll a client; generated
setup is not a shell command or completion claim; Function and prompt scaffolds
do not claim missing processing/loading; and generated governance reports live
enforcement as unobserved. It also continues rejecting removed create/apply
syntax and anonymous-project-ID wording.

Validation passed:

- all 38 repository-local Markdown links across the four maintained README
  paths resolved: 37 from the root README and one from the private state
  migration guide;
- `tests/documentation.test.ts` passed 24/24;
- the complete ten-file maintained/generated documentation corpus passed 336
  tests with two existing intentional skips;
- the strict ES2024/NodeNext fixture import for `tests/documentation.test.ts`
  passed with an empty log;
- project-wide no-emit, strict noninteractive OpenSpec validation and
  `git diff --check` passed.

Evidence is retained under:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/readme-audit-a975-working`

Task 18.4 is complete. OpenSpec is now 83/136. This documentation audit does
not complete tasks 18.1, 18.2 or any native/provider/publication requirement.

The exact audit successor was committed as
`b34e4fc87c93a3b3fd66593dc9fc70e2a9e83ef1`, tree
`52e562b84a457465c45a0314546d2439c5338c8e`, with parent
`a975405a9faa288c1afdbcbc51730224a9121e74`. Its sealed evidence manifest is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/readme-audit-b34e4fc8/manifest.json`

with SHA-256
`e085c897144f3b299a30bbd87a8c96f9fa4f551e7f54627c418014414c588c5c`.
The manifest records 10 actual test files, 336 passes, two existing skips,
38 resolved maintained local links and zero failures.

### Exact-head qualification failure and package inventory fixture successor, 2026-10-14

The independent typed-boundary source review is retained at:

`/Users/jonathan/.copilot/session-state/8d89d4b7-10db-4009-945e-b14397314a84/files/canonical-package-264-review/typed-757-review.json`

with SHA-256
`46dc857809186cb60bba795bf117a34c287f87c293d4b54cb30951b243c6fa2b`.
It admits the bounded `7578e54e` typed source together with the additive
25-test-file/64-nested-suite receipt correction. It does not supply
full-suite, coverage, native publication, readiness or landing admission.

The earlier statement that pull request #168 was unstacked is historical and
has been superseded. Native stack 170 is now registered with exact
bottom-to-top membership `[168, 169]` and ultimate base
`voyager163-liftoff-modernization`. The registration receipt is:

`/Users/jonathan/.copilot/session-state/8d89d4b7-10db-4009-945e-b14397314a84/files/telemetry-source-stack-registration/receipt.json`

with SHA-256
`acdf016bb3fc9910029f9bef05c00c0c2ee98bc4e97982d9ec3d3695a0b591cb`.
Fresh readback found both members open and draft. Pull request #168 still has
base `voyager163-liftoff-modernization` at
`12d2f4715d8f1901093676baa875f1422c5c5a90` and published head
`d3f94a8af5f5b6e4fa12fe4b9ca1520de38c180e`; pull request #169 still targets
that exact #168 head and has head
`f0976474b2bd83041d17af68415853b76122cb39`. Do not recreate, unstack,
retarget, ready or merge either member independently.

One exact-current-head fail-fast qualification was run on clean committed and
pushed `d3f94a8af5f5b6e4fa12fe4b9ca1520de38c180e` with the qualified Node
24.21.0, npm 12.0.2, CPython 3.14.7, uv 0.12.7, OpenTofu 1.12.6 and OpenSpec
1.11.0 paths, the original native flags, unchanged limits and
`set -euo pipefail`. Supported-stack and build passed. The unfiltered
one-worker suite then failed after 15,953.51 seconds:

- 322 test files: 311 passed, six failed and five skipped;
- 10,598 tests: 10,462 passed, 19 failed and 117 skipped; and
- coverage did not start because the wrapper stopped at the failed suite.

The exact failed evidence is retained under:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/qualification-d3f94a8a`

Its raw full-suite log, failure summary and manifest have SHA-256 values
`e65d46884920bbfe7f5f6b9086ccec8e6e23622c2ca158746cec318594164b71`,
`d2bffe7149e18f1d3383702367664276c31113bf59cd2b09996c143d73457aec`
and
`01c5c3af17e064ff9c174f5c4a2d35f88753bbd7d06f00d65f3f34d214f93099`
respectively. This remains failed qualification, not coverage or release
evidence.

Two of the failures were fixture assertions in
`tests/plugin-asset-inventory.test.ts`. The admitted typed package contract had
added `compiledPackageFiles` as a second frozen data export and had added the
two exact compiled package globs, while this older inventory fixture still
expected only `builtinAssets` and treated every wildcard as an asset-tree
entry. The correction imports the shared typed declaration, admits exactly
those two frozen compiled patterns and preserves the wildcard refusal for
every other package entry.

A six-file focused replay with that working-tree correction passed the other
five previously failing files. It ran 232 passing tests and retained one
failure: the team initialized-baseline case exceeded its existing 300-second
test boundary after all commands through `tofu init` had succeeded. Its sealed
manifest is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/qualification-d3f94a8a-focused-fix/manifest.json`

with SHA-256
`bee84ae6752f640589eaf163d45e7b104401ff1f127e0b08c19872f3515ddc2f`.

One exact isolated replay of that team selector then completed without any
source or limit change. It passed in 277,502.223791 milliseconds, recorded 25
dispatches and 25 results, emitted its completion marker and ended with a
settled successful `tofu validate`. This establishes that the focused timeout
was timing variance on a successful path with only about 22.5 seconds of
remaining test-budget margin; it does not convert the failed unfiltered run
into qualification. The isolated disposition manifest is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/qualification-d3f94a8a-team-only/manifest.json`

with SHA-256
`36aaee81b976b9fde5d620e01ab278312a2b0fa673e5e24edb54e2f9e1f2248d`.
No timeout, custody limit, scanner guard or settlement check was raised,
cached, skipped or weakened.

Historical caveat: the isolated replay proves only its own successful result
and the approximately 22.5 seconds that remained within that run's unchanged
test bound. It does not establish the cause of the earlier focused timeout,
prove settlement or disposition for the other `d3f94a8a` failures, or convert
any failed receipt into qualification. The earlier wording and receipts remain
preserved as the original contemporaneous record.

The fixture-only package inventory source was committed locally as
`93a5946b2c60c9d9a00db7dae3a7fe9b07371b66`, tree
`da5f806e8c1eef6ea540643dd7788d71712c20d3`, with parent
`d3f94a8af5f5b6e4fa12fe4b9ca1520de38c180e`. Its exact validation passed:

- the current coherent corpus retained all 25 test files and passed its actual
  current count of 761 tests;
- the complete original 25-file strict graph retained exactly the 12 inherited
  diagnostics with byte-identical SHA-256
  `6eca6fdb9dd24433d51c01f108fabcc5ed6fadabab22d04579d4e99a2406d598`;
- the affected strict fixture import produced an empty log;
- package inventory, identity and smoke contracts passed 47/47;
- build, project no-emit and installed-tarball package smoke passed;
- supported-stack, repository named-file policy and strict noninteractive
  OpenSpec validation passed; and
- `git diff --check` passed.

The sealed fixture evidence manifest is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/package-inventory-93a5946b/manifest.json`

with SHA-256
`97036d97c498e184136d5b4e40fd99a8371fef97b91a594499f2ea6217e95ee5`.
This source commit and the following ledger commit remain local and unpushed:
the published #168 head and stack 170 membership are unchanged. Tasks 18.1 and
18.2 remain unchecked because the unfiltered suite failed and coverage never
started; OpenSpec remains at 83/136 complete.

The later exact clean parent `ce84792f8f28fb9e7ddd2a251e737e9f29461903`,
tree `7f314d55f47b205513e6c2ac33c41bdb0655b092`, then completed the same
fail-fast sequence without command, limit or worker changes. Supported-stack
and build passed. The unfiltered suite passed 10,481 tests with zero failures
and 117 skips across 317 passing and five fully skipped files in 4,193.90
seconds. Coverage then repeated the same test totals in 4,538.27 seconds and
bound 511 executable source files to
`sha256:24991953b5e97069aa3cfa1036eb6503838c5411a47122ab0913945e7cde2783`.
Its independent metrics all passed the strict greater-than-80-percent rule:
statements 40,993/45,679 (89.7414%), branches 36,572/42,600 (85.8497%),
functions 7,712/8,113 (95.0573%) and lines 36,336/39,554 (91.8642%).

The successful parent evidence is retained under:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/qualification-ce84792f`

Its sealed manifest has SHA-256
`4a68a8058628680ba068d3102e1d8ea6607a45495cf4b2466aa65ff593b99a99`;
the unfiltered log has SHA-256
`b1832f931dd4c86cc8af9974f4ec22756b35c85830597bb943dc28c3d5a0f125`.
This is exact qualification of the clean `ce84792f` parent only. It does not
qualify a later successor, supply native Windows/package publication evidence,
complete the five skipped native/disposable families, authorize publication
or landing, or by itself complete tasks 18.1/18.2.

Independent review of the preceding failure/correction chain is retained at:

`/Users/jonathan/.copilot/session-state/8d89d4b7-10db-4009-945e-b14397314a84/files/canonical-d3-failure-93a-independent-source-review.json`

with SHA-256
`2ff36d3a18e2fe94300ef2dabe7b61421e63168efa89b0525a557690927e1590`.
It admits only the one-file `93a5946b` typed-allowance fixture source and keeps
the original `d3f94a8a` failure, dirty-parent focused replay, isolated replay
and inherited strict diagnostics separate.

The inherited Windows shard failure on the published parent was
`tests/documented-command-examples.test.ts` comparing the native
`fs.promises.glob` key against a POSIX literal. The bounded successor changes
only that membership key to `path.join('docs', 'cli-reference.md')`; it keeps
the native key unchanged for `lstat`/read operations and does not alter package
inventory, production code, dependencies, budgets or selectors. This is a
source correction informed by the retained Windows evidence, not a new native
Windows qualification.

The Windows-key correction and the additive historical timeout caveat were
committed locally as
`1eaf882d412a6875e1987f95608e01dba5e0584a`, tree
`b789d459fb9da3a86c78c2016ccaa5d6d89a4648`, with parent
`ce84792f8f28fb9e7ddd2a251e737e9f29461903`. Its affected runtime file passed
15/15 tests, its strict ES2024/NodeNext import was empty, and repository policy,
strict OpenSpec validation and `git diff --check` passed. The bounded evidence
manifest is retained at:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/native-doc-key-1eaf882d/manifest.json`

with SHA-256
`02aeca3268bede32b46e151e345ffeaf770674b11d519b3c3d76202b1b7a9e9c`.
That correction remains local and is not a native Windows qualification.

### Complete strict fixture graph correction, 2026-10-14

The 12 inherited strict TypeScript diagnostics were corrected in only
`tests/governance-assessment-engine.test.ts` and
`tests/governance-transitions.test.ts`. The assessment fixture now removes
only an unreachable retired-workload comparison from a supported
GenAI/standard fixture, uses the existing `LiveReadbackProof` and
`EvidenceFreshnessContext` domain types for complete readback fixtures, and
preserves every literal value and assertion. Runtime retired-input coverage
elsewhere is unchanged. The transition fixture uses one typed complete
phase-record helper and renames only the subclass-local command-result helper
that collided with the base runner's private member. No `any`, `unknown`,
suppression, compiler relaxation, production source, normative contract,
schema, timeout, cache or selector change was introduced.

The exact test-only source commit is
`3ff7b31f0b4cb7f28b461b17cfbba9693b89cb9c`, tree
`1bec57879c222897d8ab20ab57b6bd09603d45fe`, with parent
`1eaf882d412a6875e1987f95608e01dba5e0584a`. Its two committed blobs are
`7cd2e923182274bace4ff3f0eaa538438d57aa29` and
`22f2b2dce0a8ab55f308f3e5b2d3f8acceceddb6`. The parent and successor have
the identical production `src` tree
`476e12a57cbfcfe3b5db0a056c35183f1ec1b7c2`.

Validation on those exact committed source bytes passed:

- the two affected strict ES2024/NodeNext imports with an empty log;
- both affected runtime files, 66/66 tests;
- the complete original 25-file strict import graph with an empty log, replacing
  all 12 old diagnostics without altering the immutable historical
  `sha256:6eca6fdb9dd24433d51c01f108fabcc5ed6fadabab22d04579d4e99a2406d598`
  receipt;
- the current complete 25-file runtime corpus, 761/761 tests and zero failures;
- exact test-identity comparison against the preceding 761-test corpus;
- build and project-wide no-emit;
- repository named-file policy, strict noninteractive OpenSpec validation,
  source parity and `git diff --check`.

Vitest reports 64 nested suites for that 25-file/761-test corpus; 64 is not a
file count. The historical `7578e54e` 25-file/760-test evidence remains
unchanged, and the later README audit case was retained rather than removed to
manufacture the older count.

Two command-name mistakes were preserved as failed setup attempts:
`npm run typecheck` and `npm run test:repository-policy` do not exist in this
package. They executed no project check. The actual repository commands,
`./node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false` and
`npm run check:repository`, then passed. Their failed and successful logs are
kept separately.

The sealed source receipt is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/strict-fixtures-3ff7b31f/manifest.json`

with SHA-256
`3171351b9ba3ca082b659454a32a6e0ec1d6de7098bcd83717c470700bdc3dee`.
It also preserves the exact patch, before/after blobs, commands, tool versions,
the immutable old diagnostic log, current test inventory, failed attempts and
OpenSpec status.

This successor has not been pushed and did not mutate pull request #168,
pull request #169, native stack 170, workflow flags, provider state,
publication readiness or landing state. No unfiltered full suite or coverage
was rerun for this test-only successor, and the exact `ce84792f`
qualification is not relabeled as qualification of `3ff7b31f`. OpenSpec
remains 83/136 complete; tasks 18.1 and 18.2 remain unchecked.

### Qualified coverage and failure-attribution integration, 2026-10-15

The reviewed exact-8eb coverage projection through final tree `53d08df8` and
the independent `a52c28b8` aggregate failure-attribution correction were
integrated as source commit
`9f9cb7941ea16726780b3e67505b94831eb4a723`. The seven changed paths are
`CONTRIBUTING.md`, `docs/cli-reference.md`, `scripts/coverage-gate.mjs`,
`src/application/governance/modern-local-execution.ts`,
`src/domain/governance/activation/modern-local-runtime.ts`,
`tests/coverage-gate.test.ts` and `tests/modern-local-execution.test.ts`.
The later exact three-file protected-custody correction
`f93a5c626de32c25f5eb42983a07a6cd27cbe52f` was then cherry-picked as
`bd7635d8c15988f1d701dd281ad691045224e3ce`; all three resulting files were
byte-identical to the reviewed owning commit.

The first frozen `9f9cb794` full-suite attempt remains failed evidence. It
used `/opt/homebrew/bin/openspec`, whose global package still reported
OpenSpec 1.11.0 but had 273 files differing from the preserved qualified
package and a total byte count of 11,849,959 instead of 11,862,860. The run
therefore failed only the two native OpenSpec distribution-identity bodies:
one file failed, 316 passed and five were skipped; 10,590 tests passed, two
failed and 117 were skipped in 4,798.22 seconds. Coverage did not start.
Rebinding to
`files/macos-toolchain/openspec-qualified-cutoff-1.11.0/bin/openspec`
made both bodies pass without any source, expectation, inventory or limit
change. The failed receipt remains under
`files/native-qualification-9f9cb794`; it is not qualification evidence.

The first clean `bd7635d8` retry used that preserved qualified OpenSpec
distribution. Its unfiltered one-worker suite passed 317 files with five
fully skipped files and passed 10,602 tests with 117 skipped tests in
4,127.01 seconds. Its first complete CLI coverage command also executed all
322 files and all 10,719 test records without a test failure, and all four raw
metrics exceeded the unchanged 80.01% floor. The new final-map validator
nevertheless rejected five genuine pinned-provider records because V8 had
emitted signed synthetic else-branch counters such as `[1024, -993]`. The
failed report, summary, test result and evidence bytes are retained under
`files/native-qualification-bd7635d8/failed-cli-report`, including their
`sha256.txt`. This was an introduced validator defect; the passing percentages
from that failed verdict are not qualification evidence.

Commit `cdadc3911519af0e19d2e2dbd7b9ed22db614a23`, tree
`8fb17cbc501bf62311da3b0176945760e1b8b403`, corrects only that defect. It
accepts signed safe-integer branch-hit counters that the pinned V8 provider
summarizes as uncovered while continuing to require nonnegative safe-integer
statement/function counters, complete matching hit maps, exact path identity,
and provider-derived agreement with the saved summary. The regression corpus
now distinguishes valid signed provider output from malformed, unsafe or
contradictory records. Syntax, affected strict checking, 155/155 coverage-gate
tests, build, project no-emit, repository policy and strict OpenSpec validation
passed before the final clean run.

The complete clean qualification sequence then passed on exact committed
`cdadc391` bytes using Node 24.21.0, npm 12.0.2, OpenTofu 1.12.6, CPython
3.14.7, uv 0.12.7, Go 1.27.0 and the preserved OpenSpec 1.11.0 cutoff. The
environment retained `CI=1`, `TERM=dumb`, `NO_COLOR=1`,
`LIFTOFF_OPENSPEC_B_TESTS=1`, `OB1_VERSION_REMAINING=2`,
`OB1_SUPPORT_REMAINING=10`, `LIFTOFF_OI_TESTS=1` and
`LIFTOFF_HCL_TEST_LANE=native`; source-complete invocations retained one
worker and every existing inventory, timeout and floor.

- Supported-stack and build passed.
- The unfiltered suite passed 317 files with five skipped files and 10,602
  tests with 117 skipped tests in 3,976.07 seconds.
- CLI coverage repeated the same test totals in 4,645.22 seconds and passed
  511 executable source files with digest
  `sha256:5890d41f355eb05a47162ff87bb11d5e2463547ae4bdea2ff024f5e5a2263fb3`.
  Statements were 40,996/45,681 (89.7440%), branches 36,587/42,614
  (85.8567%), functions 7,713/8,114 (95.0579%) and lines 36,339/39,555
  (91.8695%). Independent saved-evidence verification passed.
- The workflow's 15-file custody/history selection passed 485 tests with one
  unchanged skip in 60.61 seconds.
- Independent gateway coverage passed nine files and 211/211 tests in 3.57
  seconds. Its four-source digest is
  `sha256:3e32017987886b56fa30ecae1c890674c61f073b5d8b17bf1cfa43c9db8a2c8f`;
  statements were 243/258 (94.1860%), branches 182/223 (81.6143%),
  functions 64/68 (94.1176%) and lines 233/245 (95.1020%). Independent saved
  verification passed.
- Installed package smoke passed for `@msn-control/liftoff@0.12.3`.
  Repository policy, strict noninteractive OpenSpec validation,
  `git diff --check`, exact HEAD/tree/index identity and the final clean-tree
  check also passed.

The complete retained receipt is
`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/native-qualification-cdadc391`.
Its 29-file checksum ledger has SHA-256
`76402ffa39ea4ec6982aff8e9071e9bbc63f09612d7de9f2835d145563446880`.
The CLI and gateway evidence records have SHA-256 values
`0b7497a0a0bf257c614cf2f6fbc1b6334c6603ca737a72f677abd6bcfa5408fc`
and
`3131316c5cf3ee85adc7d75d1f5951cbe633482fd5d68a14f90016949c936685`.

This qualifies only the exact `cdadc391` source revision on the native Apple
Silicon host and its independent local telemetry-gateway package. It does not
qualify later Root unions, the five intentionally skipped native/disposable
families, live cloud providers, publication, signing, deployment, landing or
merge order. No OpenSpec planning checkbox was edited here; Root retains the
authoritative ledger and dependency-order integration.

### Original cdadc coverage report retention, 2026-10-16

Before any later dependency or coverage work could replace the ignored report
directories, the complete successful `cdadc391` CLI and gateway report sets
were copied byte-for-byte into:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/retained-native-qualification-cdadc391-coverage-reports`

The retention contains the five original files for each lane:
`coverage-final.json`, `coverage-summary.json`, `coverage.txt`,
`test-results.json` and `coverage-evidence.json`. All ten source files were
available; their retained total is 30,601,495 bytes. The manifest has SHA-256
`30cf39c76aa514b7e281a7ba0b5ba66a6ee71050ef166cbe7b74756b4ddbad65`
and the checksum ledger has SHA-256
`64b7f05d8f24a7cd85d8b8c2e1b4fa2d295d9c22663d70c1f6b7ba6f210cf7a4`.
The retained evidence files remain exactly
`0b7497a0a0bf257c614cf2f6fbc1b6334c6603ca737a72f677abd6bcfa5408fc`
for CLI and
`3131316c5cf3ee85adc7d75d1f5951cbe633482fd5d68a14f90016949c936685`
for gateway. No test, coverage, verification or qualification command was
rerun, and this retention does not transfer `cdadc391` qualification to any
successor.

### Scoped task 18.2 dependency-audit remediation, 2026-10-16

Exact npm 12 diagnostics on parent
`d3d13204d8a12bfe67f95cb5e0d29c01e84a2ca5` confirmed two genuine current
findings: root runtime `smol-toml` 1.8.0 had moderate
`GHSA-r4xh-jqrq-34v2`, and transitive `source-map-js` 1.2.1 had high
`GHSA-68fv-2mgg-jv7q` in the root, telemetry gateway, packaged Node backend
and packaged frontend lock inventories. The repository wrapper initially
refused the non-direct `source-map-js` finding because npm reported an empty
`effects` array; the raw reports remain the authoritative finding evidence.

Commit `03000610af80f8d72f5346f5ccb34e426db4307c`, tree
`6452f260991a623c3405d5708e023728e8115e43`, updates only the verified
dependency closure and its exact current identities:

- root `smol-toml` advances from 1.8.0 to 1.9.1 in the manifest, lock and the
  two corresponding supported-stack fields;
- `source-map-js` advances from 1.2.1 to 1.2.2 in exactly four locks;
- no parent package, override, audit exception or unrelated dependency was
  changed;
- the packaged Node backend and frontend lock SHA-256 identities advance to
  `e4a88cada73456bf1b0a3923d5e814313358c91b0b9b2a13d5fbf41632231369`
  and
  `494f2312ba163062c10164df363c49b0987109b529f320381ec5795bbf0ea689`;
- `node-fastify` advances from content version 3/digest
  `sha256:2140749905f08e15db0e18c0b0b97ffd72a9f7fb30ae5469c7678822e1dcee7c`
  to version 4/digest
  `sha256:741c6dc7221d9178db1ea88dee47c98e3bdb1ba382ba432dc76f277c705feb92`;
- the current built-in and modern registry literals advance to the exact
  recomputed values recorded in the retained contract delta;
- the immutable pre-assessment declaration/source capture, historical release
  files and frozen source fixtures are unchanged. A bounded compatibility
  bridge composes those frozen declarations with the current reviewed template
  closure while the old version-3 metadata is matched only as an exact
  metadata family; it never restores old executable template bytes or grants
  execution authority;
- only generator records `1/node-backend-lock` and `1/frontend-lock`, plus
  four induced CLI/rendered-artifact records, advance. Every complete
  `priorChange` chain is nested unchanged and no frozen baseline was
  regenerated.

Fresh validation on the successor passed:

- supported-stack coherence, build and project-wide no-emit;
- six current/historical release-contract files, 178/178 tests;
- the complete affected dependency/template/import/package/source set,
  27 files and 635 passed tests with one unchanged skip;
- exact generator and frozen contract baseline checks, 23/23 tests;
- the repository audit wrapper, reporting all four npm inventories clean;
- four independent npm 12 raw audits, each with an empty vulnerability object
  and zero info/low/moderate/high/critical/total findings;
- generated standard Node backend/frontend install, build, test and Drizzle
  metadata verification;
- installed package smoke and release-identity verification;
- repository policy, strict noninteractive OpenSpec validation and
  `git diff --check`.

The live supported-stack freshness command remains failed evidence, not a
baseline-refresh instruction. It encountered widespread external request
timeouts, unavailable MinIO authorization, and unrelated current upstream
container/action digest drift. Those external pins were not changed and the
command was not rerun after the scoped source passed.

The sealed remediation evidence is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/dependency-audit-remediation-d3d13204`

Its final manifest has SHA-256
`8eea96962dd2f4290c91a7720ba60dbc95cb76563b6bfb90902e25ecd76b452b`,
its checksum ledger has SHA-256
`ce15689f86307abf32cf80a92391f27d4a9a9b0fc3080142f7fd5e36a2538979`,
and its exact contract delta has SHA-256
`b449db379f083b7c2141b1064578f386c628348aeefb3e53c21f0609633fe214`.
The four zero-finding raw audit files have SHA-256 values
`ec03483f63274aa0ad8def8e1b49c31e392799f453037f1fcf2dceddbf1e99cf`,
`62bfb3b9578a6c8f5fd6391d5a22c34c16299445e2e8a98e16d2bbab176475a7`,
`836f5d1799154a294707df10937b34332602eb5a29206cfbff4e631f066f61a2`
and
`7f6f0b8ea6a4a2435d48667848a20c09eea6b68f7a1169e4c26235c654a53ebc`
for root, gateway, Node backend and frontend respectively.

This is scoped dependency remediation, not a fresh unfiltered full-suite or
coverage qualification. It does not complete task 18.2 in the authoritative
Root ledger, alter publication/provider state, ready or merge pull request
#168, retarget/restack the dependency chain, or authorize landing.

### Task 18.2 generated-lock contract-ledger correction, 2026-10-16

Draft pull request #168 CI run `38802595572` tested exact documentation head
`f01b4623f9d7f62ac6dac7dd90a2a5457815bdeb`. Both Ubuntu platform shards
duplicated the native plugin-path qualification and failed the same 57
`plugin-generation-parity` cases. The generated bytes were deterministic and
the source dependency identities were already correct; the scoped task-18.2
validation had omitted `tests/plugin-generation-parity.test.ts`, so the
reviewed-change ledger covered the representative frozen contract cases but
not every matrix case induced by the two updated lock assets.

Commit `9feb1c635b11e4f7b293a9f26dc6d35d71df7e45`, tree
`ccfe7f50d0b6f9ce1c57923a244ea38d0b24703c`, corrects only
`tests/fixtures/contract-baseline-changes.json`. Exactly 57 existing
`plugin-generation` records whose plans contain the generated Node backend or
frontend lock advance under task 18.2. Each successor retains the same key,
frozen-baseline digest and original `previous` hashes, binds its prior current
digest, and nests the complete previous record byte-for-byte as `priorChange`.
No record was appended or removed, no frozen baseline was regenerated, and no
unaffected matrix case changed. The corrected ledger is 1,673,431 bytes with
SHA-256
`aef216907200f063942408ad5e514ef8be13f19069ba8544c233979d8290b0ed`.

Clean committed validation passed:

- an independent structural comparison against parent `f01b4623` found exactly
  57 changed top-level records and verified every predecessor object,
  baseline digest and original-generation hash unchanged;
- the exact duplicated CI plugin-path selection plus the contract baseline
  passed five files, 226 tests and one unchanged skip;
- build and project-wide no-emit passed;
- the template dependency audit remained clean for all four npm inventories;
- installed package smoke, repository policy, strict noninteractive OpenSpec
  validation and the commit diff check passed.

Two command-attribution limits remain explicit. The first local strict OpenSpec
attempt used unsupported option `--non-interactive`; repository policy had
already passed, the command changed no bytes, and the corrected
`--no-interactive` invocation passed. The first evidence-only structural helper
assigned but did not export its evidence directory and failed before reading
the ledger with `ENOENT undefined/ledger-before.json`; the corrected helper
then passed without a source change. Both failures are retained rather than
relabeled.

The additive evidence directory is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/dependency-audit-parity-correction-f01b4623`

Its manifest has SHA-256
`7b9ba6350b53e7db7d62069081111c72b2df395a915454bc5cd58df0dc1ebf28`
and its checksum ledger has SHA-256
`17abf0c528f45c6205a3284cac3e8e5a607ea982212da96a51c85d831fa2a642`.
The packet retains both failed Ubuntu job logs, the initial local parity
failure, the exact 57-record enumeration and all corrected focused validation.

This correction does not borrow the exact-`cdadc391` complete qualification for
the dependency-adjusted successor. It does not complete task 18.2, change an
OpenSpec checkbox, ready or merge pull request #168, or imply provider,
publication, deployment, native-signing, readiness, retarget or restack effect.

### Task 18.2 project-telemetry identity correction, 2026-10-16

Replacement pull request #168 run `38805200563` confirmed the 57-record
plugin-generation correction, then exposed one further scoped omission in both
Ubuntu and macOS shard 2. The same 11
`tests/project-telemetry-source.test.ts` expectations still named the
pre-remediation modern registry digest
`sha256:1e9632b5200f945536955f1078ca4194c4f9a56bd712d810ec69f8faac7d61b0`.
Production correctly returned the already reviewed current registry digest
`sha256:452f988fcfe33b30fc6477ded97490ecc3968a52f2257f33886d05ed4ce0cc63`
from `modernSourceRegistry()`. The failure reproduced locally as exactly 11
failed and 28 passed tests; no runtime or source-registry correction was
required.

Commit `b003800f4ba8287b4c120c64c88d11ef282c3f15`, tree
`22ed31e95ca642246fe3936b82a2823714848457`, changes only the one test
constant to the reviewed current registry identity. Clean committed validation
passed:

- `tests/project-telemetry-source.test.ts`,
  `tests/telemetry-contract.test.ts` and
  `tests/modern-source-registry.test.ts`: three files and 109/109 tests;
- build and project-wide no-emit;
- the all-four-inventory template dependency audit;
- repository policy, strict noninteractive OpenSpec validation and the exact
  commit diff check.

The additive evidence directory is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/dependency-audit-telemetry-identity-correction-8abac600`

It retains both cross-host failed job logs and the clean committed correction
checks. Its manifest has SHA-256
`a3ba0cdf339567174a468e3b480d336d1ab5cfe43e751cc5f7cb622062ae579b`
and its checksum ledger has SHA-256
`7321c3c02b340ab11b9993292c86eac601198ffe187c6ba2be069d84d200acab`.

This is a test identity correction induced by the scoped dependency release
identity. It changes no telemetry policy, schema, transport, consent, project
identity, production byte or task flag. It is not a fresh full-suite/coverage
qualification and has no publication, provider, readiness or landing effect.

### Task 18.2 governance registry-ledger correction, 2026-10-16

Fresh pull request #168 run `38809462363` passed the two previously failing
shard-2 jobs, then macOS shard 1 exposed four further normalized governance
JSON records containing the same reviewed modern registry identity. The
darwin-only governance extraction parity test first reported `status-json`;
complete current-snapshot enumeration then identified the bounded set:
`status-json`, `status-local-json`, `resume-json` and `plan-json`. No other
governance extraction key differed. The induced changes are limited to the
recorded stdout byte count and SHA-256 for the first three, and stdout SHA-256
for `plan-json`; exits, stderr and all other normalized fields remain exact.

Commit `e82cc0c77ad00606188d4691013b543fe377032e`, tree
`da019043b62d34249289ccb6200520436888d95f`, changes only those four
existing entries in `tests/fixtures/contract-baseline-changes.json`. Every
successor preserves its key, frozen-baseline digest and complete former record
as `priorChange`; no record was added or removed and the frozen capture was not
regenerated. The resulting ledger SHA-256 is
`d194aec39b230a5452a0531938dd96eaacd267d91ad6ee4c0442bf87e97c8158`.

Clean committed validation passed:

- governance extraction, contract baseline, project telemetry source and
  modern source registry: four files, 119 passed and one unchanged skip;
- independent parent/successor structure verification of exactly four records;
- build and project-wide no-emit;
- all-four-inventory template dependency audit;
- repository policy, strict noninteractive OpenSpec validation and exact
  commit diff check.

The additive evidence directory is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/dependency-audit-governance-registry-correction-1f9a1d1c`

Its manifest has SHA-256
`22e8adcac26bdf5d376c7a179a985df0d7bb6d2e2379702db6802d20ee2ecf77`
and its checksum ledger has SHA-256
`7adbfe0d37091767fb31e18ad6d1d927e7e959f39acf2a97b09b7d6077077cf1`.

Replacement pull request #168 run `38815462840` then passed all 20 jobs
on exact pushed documentation head
`6d87dee383548a17c4dee3a62579ccec7af61272`, tree
`bd06bbf9b59f765bc3ac20cad53f8ecfaca95280`. The run-level evidence
directory is:

`/Users/jonathan/.copilot/session-state/5346ea6f-fb24-4527-af62-46fbce954a74/files/dependency-audit-ci-success-6d87dee3`

Its manifest has SHA-256
`2219d6032b38e442cf009e7cee938630c7b0aed1b916b50bc53ab4e7b3f85755`
and its checksum ledger has SHA-256
`38de9c9c2e3a3d3fb7c1ac13649b7e7db8646f6bfb28fdbd0a5ef29f615c0352`.
The successful required PR CI does not transfer the earlier
`cdadc3911519af0e19d2e2dbd7b9ed22db614a23` complete local
CLI/gateway coverage qualification to this dependency-adjusted successor.

This correction records only the already-reviewed dependency-induced registry
identity. It changes no governance runtime, capability, blocker, authority,
task checkbox, provider or publication state and is not a fresh complete
qualification.
