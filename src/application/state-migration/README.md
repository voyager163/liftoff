# Protected state migration API

`index.ts` exports the stateful service functions and concrete adapters. Shared
contracts live in `src/domain/repair/stateful.ts`. These functions do not inherit
authority from local repair, update, activation-record migration, `--yes`, or force.

## Coordinator integration

Every function takes `StateMigrationDependencies` and a typed request.
All shared request DTOs and capability ports are declared in `stateful.ts`;
adapter modules preserve their original type re-exports for compatibility.
The local repair coordinator can depend on the domain `StateMigrationService`
port and bind it with `createStateMigrationService(dependencies, retainedKeys?)`.
Its methods are `observeMetadata`, `inspect`, `plan`, `validate`, `execute`,
`inspectOperation`, `planRecovery`, `recover`, `planDisposal`, and `dispose`.
CLI parsing and private consent routing remain outside this module.

1. `observeStateMetadata` observes only the explicitly supplied backend bindings.
   Azure observation requires `live: true`. HEAD/stat observations are not state
   reads and cannot establish an instance mapping.
2. `inspectApprovedState` requires the exact current discovery fingerprint with
   `kind: "state-read"`, plus live permission for remote state. It returns an
   encrypted inspection reference and allowlisted metadata, not state.
3. `buildStateMigrationPlan` accepts that reference and complete, explicit
   `StateMigrationIntent` mappings. The saved encrypted plan binds context,
   configuration, artifacts, binary/recipe contract, backend versions, every
   instance disposition, writer scope, expiry, and recovery policy.
4. `validateStateMigrationPlan` and `executeStateMigration` require the exact
   plan fingerprint with `kind: "state-write"`. Eligibility is conditional on
   fresh under-lock preconditions and successful protected target planning;
   approval never waives those conditions.
5. For incomplete effects, obtain **new** metadata and approved sensitive
   inspection, then call `buildStateRecoveryPlan` and `executeStateRecovery`.
   Recovery requires its own exact `kind: "state-recovery"` fingerprint.
6. `inspectStateMigration` reads the encrypted historical journal only. It does
   not treat historical checkpoints as fresh backend/resource verification.

Use only the returned public projections in CLI JSON, receipts, logs, or agent
messages. Backend adapters, native driver inputs, artifact storage, command
capture, and configuration materialization are privileged **private** ports.
Their buffers, errors from external libraries, configuration, and commands are
not public output. Persist only opaque references in project repair records.

The writer coordinator must bind its current configuration observation to
`context.configurationDigest`. The target digest is the canonical SHA-256 of
the sorted `[configurationRef, configurationDigest]` pairs returned by the
inspected, backend-neutral configuration provider. `StateWriterCoordinator`
owns project locking, exact configuration commit, independently verified writer
cutover, and immutable inventory/provenance publication. Its operations must be
idempotent by operation ID and reject changed inputs, not act as success stubs.

## Implemented combinations

| Recipe | Sources | Destinations | Conditions |
| --- | --- | --- | --- |
| Address/module refactor | Local or Azure Blob | Same backend | Every instance is mapped, object kind/type and resource identity are unchanged |
| Backend relocation | Local or Azure Blob | Local or Azure Blob | One absent destination; unchanged addresses; complete source retirement |
| State partition | Local or Azure Blob | Explicit local/Azure Blob roots, including mixed targets | Every instance appears exactly once in targets or an explicitly preserved source |

Writable local files must be on an approved private encrypted volume outside
repositories. An explicitly named existing project state file can instead use
`readOnlySource: true`; this permits approved reads and conditional retirement,
never rewriting that file or leaving a residual state in the repository.

Unsupported backends, client-side OpenTofu encryption, non-v4 JSON state,
non-Azure providers, tainted/deposed objects, unknown provider constructs,
incomplete mappings, address collisions/cycles, and existing relocation/partition
destinations remain blocked. There is no arbitrary state adoption or resource
create/update/delete/replace authority.

## Native and backend protocol

Review executes read-only native planning/inspection, including `state mv
-dry-run` where applicable. It does not apply or migrate state. It retains the
reviewed source plan privately and records exact configuration and instance
mapping constraints.

After write approval, native transformations operate only on protected **local
copies**. Refactoring/partitioning uses `state mv`; its `-state`/`-state-out`
arguments are local files, never remote backend selectors. Relocation uses
controlled local-backend `init -migrate-state` inside that private workspace.
Backend-aware transport publishes the resulting bytes separately. Target saved
plans must contain no resource mutation; any allowed output/data-read state
updates are applied only to private copies, followed by a fresh no-change plan.
The CLI configuration permits only verified preinstalled filesystem provider
mirrors, not implicit registry/provider/module installation.

Known writers are quiesced before mutation. Local publication requires a
registered **OpenTofu-compatible OS lock** capability supporting conditional
replacement/removal, including absent destinations. A `.lock.info`/sentinel file
alone is insufficient. Azure uses per-blob leases, current ETags/versions, and
`If-Match`. An absent blob uses atomic `If-None-Match: *` creation, then leases
that exact created ETag before retirement. No container-wide lock, force-unlock,
state push, `-force-copy`, or `-reconfigure` safety shortcut is used.

Encrypted source/destination backups are verified before publication. Durable
intent checkpoints precede external writes, including cutover and provenance.
Destinations receive current mapping/no-change verification before source
retirement. Complete source/residual accounting, fresh final plans, and verified
configuration/writer cutover precede inventory publication and writer resumption.
Results explicitly deny cross-backend atomicity.

Recovery re-observes actual lineage, serial, digest and backend versions. Forward
recovery skips verified completed writes. Compensation can remove only exact
newly owned destinations while the unchanged source and original configuration
remain authoritative. Old snapshots never overwrite newer state.

## Protected storage and retention

`EncryptedStateWorkspace` uses authenticated AES-256-GCM envelopes with distinct
nonces and artifact/workspace/purpose/scope binding. Keys come from an explicit
external provider; raw key copies are cleared after use. Filesystem storage
requires an existing independently attested encrypted/private state workspace,
rejects repository paths and unsafe links, uses owner-only files/directories,
durable writes, bounded storage, and compare-exchange journals. Native scratch
files remain inside that encrypted workspace and are removed afterward.

`buildStateDisposalPlan` reports not-before/due scope without deleting anything.
`disposeRetainedState` requires exact `state-disposal` approval, current host/key
access and ownership, and verified conditional deletion of its recorded encrypted
backup inventory. Dedicated retained keys additionally require independent
exclusive-use/version attestation. A shared workspace/KMS key is **not** inferred
to be disposable. Disposal progress is separate from immutable migration history.
This API does not claim that disposing selected backups destroys the entire
private workspace; its other encrypted planning/working artifacts remain subject
to the registered host's bounded workspace lifecycle, not repository cleanup.

## Runtime prerequisites and qualification

Supply real encrypted-volume/key capabilities, native OS locking for local
backends, current Azure ownership/access/protection observations, a private
short-lived Azure token provider, an isolated read-only native execution host,
an inspected configuration/provider-mirror provider, and the project writer
coordinator. Missing capabilities are blockers, not plaintext/public fallbacks.

`StateRecipeQualification` must establish the exact recipe/backend/binary/host
combination before native execution. The tests in `tests/state-migration*.test.ts`
and `tests/state-backend*.test.ts` use deterministic synthetic state, transport,
native-command and lock capabilities. **They are not live qualification.** No
owner environment is contacted and no installed OpenTofu is executed by them.
Production registration still requires the separately approved disposable
qualification lane; no mocked result enables it by default.

## Bundled macOS existing-inode profile

The concrete `createDarwinLocalStateExecutionProfile` factory composes:

- `DarwinPosixStateLockProvider`: a registered CPython 3.14 helper holding a
  whole-file **POSIX `fcntl(F_SETLK)` record lock** in a separate process. It
  uses `lockf`, not BSD `flock`. Parent-process metadata/state readers can close
  their descriptors without dropping the helper's process-associated lock.
- `DarwinFileVaultVolumeAttestor`: current `df`/`diskutil -plist` observations
  of the actual device, APFS, completed FileVault encryption and unlocked
  status, together with owner-only directory modes and absence of extended
  ACL grants. No operator-supplied encryption/private-access boolean is used.
- `DarwinKeychainStateKeyProvider`: an existing explicitly named generic
  password item accessed through macOS Security.framework with user
  interaction disabled. It never creates an item, changes the search list,
  prompts for unlock, or falls back to a file/environment secret.
- `DarwinObservedStateHost` and `DarwinKeychainAzureReader`: private
  staging/HOME/config isolation plus an existing Azure reader credential.
  The reader obtains a token through the exact tenant endpoint, checks its
  principal/client/tenant, and observes current effective read-only permissions
  for the subscription and every ARM resource represented in the private state.
  Credential overrides and provider registration in staged provider
  configurations are rejected. This is **not an OS process sandbox**; the
  registered, inspected provider/module contract is still mandatory.

The required tools are an **already installed exact OpenTofu 1.12.6** and
registered **CPython 3.14**. No compiler, native addon, package download,
machine installation, account creation, role assignment or privilege elevation
is performed by these factories. Both executable paths and SHA-256 identities
are rechecked.

### Native locking source and limits

The protocol was verified against the immutable OpenTofu 1.12.6 commit
`b4305e5a5dd2fb79a27897ae30784a181d3a26cb`:

- [`internal/flock/filesystem_lock_unix.go`](https://github.com/opentofu/opentofu/blob/b4305e5a5dd2fb79a27897ae30784a181d3a26cb/internal/flock/filesystem_lock_unix.go)
  uses `F_SETLK`, `F_WRLCK`, start zero and length zero.
- [`internal/states/statemgr/filesystem.go`](https://github.com/opentofu/opentofu/blob/b4305e5a5dd2fb79a27897ae30784a181d3a26cb/internal/states/statemgr/filesystem.go)
  opens the state inode, locks that descriptor, and seeks/truncates/writes the
  same file rather than renaming a new inode over it.

The bundled production profile supports **same-backend address/module
refactoring of an existing external protected local state inode**. Its writes
are in-place and **not atomic against crashes/power loss**. Backups and durable
intent checkpoints are therefore essential; unknown/torn state remains
blocked for reconciliation rather than being blindly restored.

Creating an absent local destination, unlinking a local source, or replacing
its inode cannot retain this native boundary. The concrete provider rejects
those operations. Consequently this profile does not enable local
relocation/partition retirement, `readOnlySource` project-state retirement,
network filesystems, Windows or Linux by assumption. The generic Azure and
other recipe implementations retain their independent qualification gates.
The `.lock.info` file is only native-compatible metadata; the kernel record
lock supplies exclusion. Unknown pre-existing markers are not stolen.

### Actual disposable native qualification

`qualifyNativeLocalState({ pythonPath, tofuPath, scratchParent })` is an explicit
opt-in lane. It bootstraps only a fixed builtin `terraform_data` fixture in a
fresh private directory, with empty credentials and filesystem-only provider
installation. It then verifies real native/helper contention in both
directions, descriptor-close behavior, same-inode conditional publication,
stale-write rejection, an actual module address move, retained resource
identity/lineage and an actual no-change plan. Fixture state and plans are
removed afterward.

The lane also tests the rejected alternatives against the actual binary:
after a deliberately injected rename, native OpenTofu can acquire the new
inode while the old inode is still locked; after a deliberately injected
unlink, native apply can create and lock the new path while awaiting approval.
The qualification declines that proposal without executing it. The old holder must
report lock loss, preserve the newer writer's state/lock metadata, and never
treat its old descriptor as protection for that new path. These are negative
qualification results supporting the explicit operation exclusions, not
permission to enable rename, unlink, or placeholder creation.

Run the repository lane without an emitting build:

```sh
LIFTOFF_NATIVE_STATE_QUALIFICATION=1 \
LIFTOFF_TOFU_EXECUTABLE=/absolute/path/to/tofu \
LIFTOFF_STATE_PYTHON=/absolute/path/to/python3 \
node_modules/.bin/vitest run tests/state-backend-native-qualification.test.ts
```

The ordinary suite skips this lane unless explicitly enabled; a skipped test
is not qualification. The returned public result is allowlisted metadata,
labels its scope `synthetic-disposable-only`, and explicitly reports Azure
live qualification as not performed. Only results produced by the real lane
in the current process are accepted by `isActualNativeLocalQualification`;
deserializing or hand-writing a success-shaped JSON object does not grant
capability.

The factory takes that native result, an existing protected workspace root,
an existing keychain state-key reference (service
`org.liftoff.state.<owned-id>`, account equal to the project ID, value a
base64-encoded 32-byte key), and a separate reader reference under
`org.liftoff.azure-state-reader.<owned-id>`. Supply these through private
operator/enrollment channels, **never key/credential values in argv or chat**.
The writer coordinator and inspected configuration provider remain the repair
coordinator's inputs.

**Azure live/provider qualification is still a separate required gate.**
`liveQualification` must be supplied by the owner's verified qualification
provider; absent proof remains `unqualified-combination`. Native builtin
fixture checks are not Azure, credential, application or production cutover
evidence. Missing keychain items, locked keychains, an unencrypted/private
workspace failure or an unavailable reader account are explicit prerequisites,
not missing native lock implementations or plaintext fallback paths.

Protocol references:
[state mv](https://opentofu.org/docs/cli/commands/state/mv/),
[state push safeguards](https://opentofu.org/docs/cli/commands/state/push/),
[backend migration](https://opentofu.org/docs/cli/commands/init/),
[Azure backend](https://opentofu.org/docs/language/settings/backends/azurerm/),
[Azure Blob concurrency](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage).
## Owned native process lifetime

Private native commands and system helpers now use a dedicated owned POSIX
process group, following the process-group approach in `process-runner.ts`
without inheriting the caller's environment or public/string output path.
The subprocess and pipes remain referenced; this is not a detached daemon.
The supervisor owns the group, sends bounded TERM/KILL escalation, and requires
both group disappearance and closed inherited pipes before proving termination.
A successful root exit or a successful signal call alone is not that proof.
Lingering inherited-group descendants make an otherwise zero exit incomplete.

`PrivateStateCommandRunner.quiesce()` and `StateNativeDriver.quiesce()` provide
the cleanup fence. Native-operation timeout/cancellation waits for this fence
before returning to backend release. The built-in host also fences its private
system helpers. The legacy abstract `terminateProcessTree` hook is not used as
a fallback by the private command runner.

When termination cannot be established, the result is
`process-tree-termination-unproven`. Private scratch is preserved, known writers
stay paused, and owned backend leases are retained for explicit recovery.
Cancellation no longer independently releases an already acquired local lock
or disables an owned Azure lease's renewal. Recovery in the current process
can re-prove quiescence and release the original owned handles; after a host/CLI
restart, an unresolved process checkpoint requires host reconciliation instead
of guessing a PID or force-unlocking state.

Captured stdout chunks and private stdin copies are cleared where feasible;
stderr is drained privately, never streamed by the native runner. Output after
a rejected/unproven operation is discarded rather than accumulated.

The supported process contract requires registered providers/helpers to inherit
the owned group. Deliberately daemonizing/session-escaping workers are not a
qualified execution profile. Detectable escaped workers retaining inherited
pipes remain unproven, not falsely cleaned up. Windows requires a separately
qualified owned-job implementation and is rejected before private process
creation; a root-only kill or PID-reuse-prone fallback is not substituted.

`tests/state-migration-process.test.ts` uses disposable **non-state** Node
fixtures to exercise resistant grandchildren, root-exit/ignored-stdio cases,
cancellation, output limits and retained scratch on unproven cleanup. It does
not execute project scripts, access credentials or mutate provider resources.
