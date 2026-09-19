# Private-state and runner activation adapters

These candidate `0.13.0` implementations are **UNQUALIFIED**. Fixture tests do not authorize Azure/GitHub effects, prove a supported live provider/host combination, or authorize publication. Shared governance planning, approval, phase dispatch and lifecycle integration remain owned by the activation coordinator. No additional CLI command or blanket approval is introduced.

## Native host contracts under implementation

The existing private-state implementation is macOS-specific. Linux and Windows
support is required work, not enabled by changing a platform label or supplying
a fixture. The original macOS protocol tuple and digest remain unchanged.

The source-audited lock inventory is in
`src/domain/repair/native-state-protocols.ts`. It is not native execution or
qualification evidence:

- OpenTofu 1.12.6 uses POSIX process-associated `F_SETLK`/`F_WRLCK` locking from
  offset zero through EOF/future growth on the registered Unix architectures.
  Closing any descriptor for the same inode in the lock-owning process releases
  those locks; `flock` and OFD lifetime semantics are not equivalent.
- Its Windows implementation uses `LockFileEx` flags `3`, offset zero,
  `lengthLow=0`, `lengthHigh=0xffffffff`, and releases by closing the locking
  handle. Reads/writes must use that handle; a second handle or spawned child
  does not inherit access to the locked region.
- Both implementations mutate the existing state object in place. The
  `.lock.info` file is metadata, not lock authority. The pinned state manager
  logs deferred sync failures instead of propagating them, so a zero exit alone
  is not durable-write proof. Partial writes and independent backups need their
  own protected readback and recovery.

These facts bind the immutable [Unix lock source](https://github.com/opentofu/opentofu/blob/b4305e5a5dd2fb79a27897ae30784a181d3a26cb/internal/flock/filesystem_lock_unix.go),
[Windows lock source](https://github.com/opentofu/opentofu/blob/b4305e5a5dd2fb79a27897ae30784a181d3a26cb/internal/flock/filesystem_lock_windows.go),
and [state manager](https://github.com/opentofu/opentofu/blob/b4305e5a5dd2fb79a27897ae30784a181d3a26cb/internal/states/statemgr/filesystem.go).

The storage/key audit leaves explicit implementation gates:

| Host | Audited candidate | Boundary still required |
| --- | --- | --- |
| Linux | Existing ext4/fscrypt-v2 policy/key-status observation through retained descriptors and anchored path resolution | This proves per-object coverage, not whole-volume encryption. A distinct coverage contract, bounded local backing topology and durable, protected external-key provider are still required. |
| Windows | Handle-bound local volume identity, current BitLocker status methods, and read-only lookup of an existing Generic Credential | BitLocker methods require an already authorized administrator context and packet-private WMI. `CredReadW` returns protected bytes even when only a descriptor is wanted; it cannot run as unapproved metadata-only planning. |

Generic [Secret Service](https://specifications.freedesktop.org/secret-service/latest/ch10.html)
availability does not prove backend encryption or access controls, and ordinary
kernel keyrings do not supply reboot-durable custody. They are not admitted as
a plaintext or ephemeral fallback. See the [fscrypt API and protection limits](https://www.kernel.org/doc/html/latest/filesystems/fscrypt.html).

The specific GNOME Keyring audit also leaves existing-daemon admission blocked.
It examined GNOME Keyring commit
`da00f9621eaf263d5ed4236df9c22798ea8021d2` (four commits after release 51.0)
and libsecret commit `a5cd57f103038c06b64d5f6ebfd0e627bb40af4e` (one commit
after release 0.21.8.2), not those release tags themselves. Targeted, nonmutating
reads over an explicitly encrypted session are possible, but do not establish
the selected key's durable encrypted persistence:

- Secret Service exposes no authoritative backing filename or saved-generation
  binding. Reconstructing a filename from an item path or the caller's
  `XDG_DATA_HOME` is not evidence of the daemon's actual storage.
- GNOME's PKCS#11 `CKA_TRUSTED` predicate observes a nonempty currently loaded
  master password. It is not a Secret Service property or proof of a particular
  saved encrypted generation. The save implementation can choose plaintext
  persistence for an empty master password.
- A unique D-Bus owner and exact item lookup do not prevent same-owner key
  mutation. A read gives one key snapshot, not an immutable version.
  libsecret's plaintext session fallback must be rejected before secret loading.

See the pinned [collection password predicate and persistence implementation](https://github.com/GNOME/gnome-keyring/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/pkcs11/secret-store/gkm-secret-collection.c),
[public collection interface](https://github.com/GNOME/gnome-keyring/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/daemon/dbus/org.freedesktop.Secrets.xml),
and [session fallback](https://github.com/GNOME/libsecret/blob/a5cd57f103038c06b64d5f6ebfd0e627bb40af4e/libsecret/secret-session.c).
The audit blockers are `gnome_collection_persistence_binding_unavailable` and
`gnome_encrypted_saved_generation_unverifiable`; these are descriptive audit
labels, not new executable provider registrations. A controlled-store admission
or enrollment/restart-recovery design would require separate review and effect
authorization. No daemon launch, password change, unlock or key enrollment
follows from this audit.

The controlled launch specification is now modeled separately in
`src/domain/repair/controlled-keystore.ts`. It binds exact foreground
`secrets`-only arguments, isolated HOME/XDG locations, a private session-bus
address, a disabled ordinary system-bus address, bounded protected stdin and
non-inherited environment. It is explicitly **not execution authority or
observed custody**, and does not launch a daemon or request a password.

The pinned [daemon entrypoint](https://github.com/GNOME/gnome-keyring/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/daemon/gkd-main.c)
and [login implementation](https://github.com/GNOME/gnome-keyring/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/daemon/login/gkd-login.c)
make several admission requirements essential: `--unlock` can create a missing
login collection, can initialize other uninitialized native slots, and may fail
to unlock while the daemon continues running. The
[control-directory implementation](https://github.com/GNOME/gnome-keyring/blob/da00f9621eaf263d5ed4236df9c22798ea8021d2/daemon/gkd-util.c)
can fall back to another location after an invalid requested directory.
Consequently, startup/exit status is never readiness, all slot storage needs
confinement, actual control-location readback is required, and restart must
enforce persisted-store write denial rather than rely on an existence check
or ordinary file modes. These execution and persistence gates remain
unimplemented/unqualified until their native mechanisms pass.

`LinuxReadonlyProcessGuard` now supplies a fail-closed source primitive requiring
Landlock ABI 3 or newer, including truncation mediation. It denies newly opened
file-content and directory-entry mutations outside three fresh, private,
disjoint, same-mount writable trees and retains existing owned-process
supervision. It is not an encrypted-storage observation or a keystore receipt.
Metadata changes, network/IPC, received descriptors and external writers remain
outside its guarantee.

The complete restart coordinator must establish its bus/control/scratch state
inside that admitted process boundary, with correct daemon environment and
fresh identity checks. Passing an existing unqualified IPC endpoint or writable
descriptor to a guarded child is not a supported shortcut.
[Native source run 35382671458](https://github.com/voyager163/liftoff/actions/runs/35382671458)
passed the actual POSIX/OpenTofu locking and Landlock write-denial/cancellation
cases on Linux x64 and arm64 using nonsecret disposable fixtures. This proves
the exercised primitives, not encrypted custody, GNOME enrollment, minimum-host
coverage or final installed-artifact qualification.

For Windows, use the documented [BitLocker provider security requirements](https://learn.microsoft.com/en-us/windows/win32/secprov/win32-encryptablevolume#security-considerations)
and [CredReadW semantics](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw).
`CRED_PERSIST_LOCAL_MACHINE` means the same user's later logons on that machine,
not a machine-wide grant. Target names are mutable lookup identities, not
immutable key versions. No vault mutation, unlocking, elevation or real
credential access is authorized by this source audit.

The existing Windows controller's ordinary temporary stdout/stderr files are
not private-state transport. Protected pipes/handles, bounded I/O, key snapshots,
actual native contention/cancellation and separately authorized host fixtures
must be implemented and qualified before either new writer is enabled.

The Linux key-client decoder consumes a bounded `LKC1` stream and clears its
input. It accepts only the registered metadata fields and creation sequence,
retains bounded returned identities through partial/error output, and releases
an opaque one-use key snapshot only after complete output and settled process
success. Returned paths are observations, not ownership, retry or deletion
authority. Key snapshots reject JSON serialization and clear owned bytes after
use or release.

Owned private-process supervision can feed a bounded private stdout observer
before discarding output on interruption. This preserves already decoded
nonsecret effect metadata without publishing raw stdout, stderr or key bytes.
It does not authenticate the helper or establish encrypted persistence or
readiness; those remain separate coordinator and native qualification gates.

The native C client in `native/linux-keystore-client` now compiles on Linux x64
and arm64 against the exact pinned crypto-enabled libsecret source and an
explicit private prefix.
[Run 35388541555](https://github.com/voyager163/liftoff/actions/runs/35388541555)
also passed all 70 parser/framing/source-interface cases per architecture.
That run deliberately did not execute the production helper or contact a
service/store. Runtime dependency admission, synthetic private-service behavior,
authenticated invocation and actual controlled-store persistence/recovery remain
unqualified; compilation does not enable enrollment.

Follow-up [run 35390417800](https://github.com/voyager163/liftoff/actions/runs/35390417800)
passed all 84 cases on each native Linux architecture, including 13 compiled-
client behavior cases against a fresh private in-memory synthetic service.
Actual loader/dependency identities, encrypted-session negotiation, prompt/plain
refusal, owner/PID/GUID binding, exact item validation and post-write identity
retention were exercised. This was not a real GNOME daemon or persistent
keystore; it does not qualify password-protected persistence, encrypted host
storage, enrollment or restart recovery.

`inspectControlledGnomeBinary` provides bounded structural inspection for the
pinned writer's single-key binary format, rejecting plaintext, unknown headers,
truncation, excessive counts/lengths, duplicate attributes and trailing data.
Its output binds the complete byte digest without publishing collection labels
or attribute values. The underlying format uses AES-128-CBC and an MD5 content
checksum, not authenticated encryption; the returned result explicitly grants
no authentication, durability or readiness proof. Pairing a persisted generation
with the actual application key still requires private readback and fresh-process
verification, not a matching header.

`createManagedKeystoreKeyBinding` consumes the original opaque application-key
snapshot and produces a fresh-nonce AES-256-GCM binding to the exact project,
host/principal, enrollment/store/item, software and persisted-generation context.
`verifyManagedKeystoreKeyBinding` consumes a separately supplied snapshot and
rejects changed context, key or binding bytes. Both dispose of owned key bytes.
This is an application-key binding, not a master-password verifier or evidence
that the second snapshot came from a fresh daemon or durable storage. Its result
explicitly retains `freshProcessVerified: false` and `readiness: false`; the
coordinator must establish those independent native observations.

The opt-in source fixture in `native/linux-keystore-client/gnome-*` now exercises
the pinned daemon against fresh private test scopes and generated test inputs.
Its restart coordinator creates its private IPC inside the read-only process
guard, rechecks the persisted generation and compares a fresh key snapshot.
Only settled owned scopes may be removed; uncertain settlement preserves them.
This fixture has not yet passed actual Linux execution. In particular, native
auxiliary dotlock writes denied by the guard must remain failures, not permission
to make the persisted store writable. Source/refusal checks on macOS do not
qualify Linux persistence, encrypted host storage or production enrollment.

## Exact plans and authority

`private-resource-plans.ts` exports:

- `planBootstrapArmResources(BootstrapAccessInputs)`
- `planRunnerArmResources(RunnerNetworkArmInputs)`
- `privateArmInventory(PrivateArmResourcePlan)`

The pure plans contain actual ARM resource IDs, types, API versions, request bodies, body digests and dependencies. They bind the subscription, tenant, principal, repository ID, region, configuration and expiry. Source digests bind the executable planner and recipe definitions; plan digests also bind the exact configured resources. Provider readiness consumes this actual inventory alongside the selected HCL roots when `phases.state-path-selected.statePath` is `bootstrap-local`, rather than guessing namespace names. This early declaration selects the inventory only; it neither changes the active state path nor authorizes the later bootstrap.

Bootstrap operations carry software/recipe provenance as `inputs.producerSourceDigest`. The generic evidence contract reserves top-level `inputs.sourceDigest` for an expected provider readback digest; a recipe digest is not that digest. Actual resource body/readback matching remains independently enforced, while the separate inventory's `sourceDigest` retains its software-source meaning.

Bootstrap creates only access-establishing network resources: NSG, routes, public IP/NAT, VNet/subnets, private endpoint/DNS and `GitHub.Network/networkSettings`. Existing storage ownership, private TLS settings, versioning and soft delete are read first. Storage accounts, resource groups, RBAC, application resources and placeholder images are not implicitly provisioned.

Creation is conditional and new-only. Existing names/tags are not permission to replace resources. Default PUTs remain blocked until `BootstrapConditionalCreateQualification` independently admits the **exact provider/API/binding**: a provider that ignores `If-None-Match` cannot be made safe by inspecting its update response afterwards.

Every mutation checks the canonical reviewed phase operation, current configuration/expiry, real project mutation lease and released project-bound private approval issuance. New private effect checkpoints use the released immutable `governance-operation` store, without altering repair or historical activation formats. Returned provider IDs remain distinct from locally generated correlation IDs.

## Producer contracts

| Phase | Planner / executor | Input configuration |
| --- | --- | --- |
| `existing-private-path` | `planExistingPrivatePath` / `executeExistingPrivatePathVerification` | `{ target: PrivateStatePathTarget }` |
| `bootstrap-local` | `planBootstrapLocal` / `executeBootstrapLocal` | `{ principalId, expiresAt, access: { resourceGroup, storageAccountResourceId, network, runner }, custody }` |
| `runner-ready` | `planPrivateRunner` / `executePrivateRunner` | Exact organization/actor IDs, network/group/runner names, image/machine/concurrency, network-only source, optional published `backendSource` / `applicationSources`, explicit owned-group `reconciliation`, expiry |
| `private-backend-proof` | `planPrivateBackendProof` / `executePrivateBackendProof` | Exact backend source, existing-blob lease challenge and audit workspace/reader under the registered exact lease actions |
| `remote-import-verified` | `planRemoteImportVerified` / `executeRemoteImportVerified` | Exact target, custody, separate read-only provider key reference, configuration root/provider mirror, declared mappings, explicitly retained ARM-only IDs, expiry |
| External custody disposal | `planPrivateCustodyDisposal` / `executePrivateCustodyDisposal` | Exact immutable private custody handle; artifact-only policy requires its distinct coordinator-owned action and lifecycle linkage |

`bootstrapArmPlanForInspection` exposes bootstrap and runner network plans before execution. Runner networking is established in `bootstrap-local`; `runner-ready` does not disguise Azure provisioning as a GitHub operation.

### Existing private path

The default adapter uses scoped in-memory Azure credentials, ARM account/container/endpoint/NIC/DNS-link observations, private DNS resolution, certificate-validated TLS and IP-pinned HTTPS metadata requests. It rejects public resolution, changed resource/principal/owner bindings and missing versioning/encryption/retention.

This phase performs **metadata reads**, not raw state reads or lease mutations. Its output explicitly distinguishes blob lease **capability** from an **acquired exclusive lease**. A permission observation or `lease-status` header does not prove successful lock acquisition.

### Dedicated runner and source-bound observations

The runner producer sequentially creates a GitHub network configuration, a non-default/non-inherited group restricted to one private repository and the exact published workflows, then a supported larger Linux runner definition. Each effect has durable custody and independent ID-based readback. Foreign controls are not adopted or changed; existing owned workflow access changes require the separate exact reconciliation path below.

The default mutation session privately captures one administrator credential and verifies its actual actor before use. Credential values never enter arguments, public evidence or diagnostics. Report downloads remain read-only, size-bounded and HTTPS-scoped; credentials are not forwarded to signed artifact-storage locations.

`renderPrivateRunnerWorkflow` produces a **network-only** reachability recipe. The caller supplies the exact reviewed upload-artifact action SHA. Its `PrivateRunnerReachabilityTarget` contains only hostname, endpoint address, private endpoint/subnet/VNet resource IDs and region. The target IDs must match current bootstrap resource readback.

There is no Azure login, Azure token retrieval, OIDC permission, Blob HEAD/GET, state metadata read, checkout or project execution in this workflow. It observes exact private DNS, certificate-verified TLS handshakes, routes and outbound TLS connectivity, reads its actual GitHub job identity and uploads one `private-runner-reachability-report`. That report has no Azure principal, backend metadata or locking assertion. The older mixed network/backend recipe is not silently reinterpreted; its changed source and report contract require newly reviewed publication.

`observePrivateRunnerRun` consumes the actual retained provider operation and reuses the publication owner's `readBoundWorkflowRun` and `readBoundWorkflowArtifact` checks for current attempt/triggering actor, immutable source, GitHub Actions check/app/job and provider-bound archive. It adds the exact network-only recipe, raw runner/group/labels, strict report schema, DNS/TLS/routes and freshness checks. A hosted-runner **definition** ID is not mistaken for the job's actual **runner** ID. ZIP digest integrity is not state, OCI or runtime qualification.

The pure `readPrivateReportArchive(archive, expectedFilename?)` decoder can also read another exact safe JSON basename; its default remains `private-path-report.json`. It retains the same single-entry, regular-file, checksum, UTF-8, 512 KiB archive and 128 KiB expanded limits. It returns `unknown`, not a private-runner or application proof; each consumer must independently verify its source, provider digest and exact semantic report contract.

`extractPrivateReportArchive(archive, expectedFilename?)` is a thin private-policy wrapper over the shared `extractWorkflowReport` ZIP/ZIP64 extractor. It retains the private 512 KiB archive / 128 KiB expanded limits and exact safe basename, and inherits shared CRC/header/descriptor, UTF-8, Unix-link and DOS-directory checks. Both private helpers live in `private-report-archive.ts` and remain exported from `private-runner-workflow.ts`; there is no independent private ZIP parser. Extraction returns the exact UTF-8 bytes without JSON parsing, duplicate-key collapse or whitespace normalization. The caller owns and must wipe the buffer, enforce any stricter report-size ceiling, and validate canonical/duplicate-key rules before using its byte digest. Known shared archive/options errors retain the private wrapper's error contract; unexpected failures propagate. The existing JSON reader retains its default and decoding behavior and wipes the extracted bytes.

Workflow dispatch uses shared `dispatchApprovedWorkflowRun` with registered primary action `github.runner.reachability-dispatch`, exact reviewed `inputs.workflow` and `inputs.dispatchInputs`, the pinned administrator transport and existing private storage. The action belongs only to `runner-ready`; dispatch cannot be relabeled as a read/write. The helper owns the actual REST `2026-03-10` run receipt, pre-effect checkpoint and bounded recovery; this producer no longer implements a second workflow POST path.

The recipe requires string input `liftoff_operation_id` and `run-name: liftoff-${{ inputs.liftoff_operation_id }}`; `configuration_digest` separately binds public configuration. The helper's prepared checkpoint supplies the nonce. The returned provider operation and original plan digest are retained verbatim, and a completed/settled failed run is never accepted as successful proof.

If a response is lost, or an older transport supplies only `204`, the shared helper can recover only an exact source/ref/actor/workflow/correlation-matching provider run. Ambiguous or unobservable outcomes are not redispatched. An existing older `private-access` dispatch checkpoint blocks the switch to the shared checkpoint namespace; it is not ignored or retagged into a fresh operation. Rendered-source changes require newly reviewed publication and digests, never rewriting prior source or checkpoints.

The producer also checks retained legacy dispatch plans and the recorded phase operation before GitHub access. A known workflow run requires its original shared pre-effect custody and consistent provider identity; an empty shared namespace is not absence proof. A recorded hosted-runner allocation is kept distinct and can continue through its exact creation/readback path. No legacy checkpoint is manufactured into a shared receipt.

### Complete private metadata admission

The released scoped record store now has additive `listKeys(options?)` and `readAll(options?)` inventory methods for the exact `governance-preview`, `governance-approval` or `governance-operation` metadata namespace. Existing `read`/`write` record formats and authority semantics are unchanged. Inventories bind the selected canonical project and its creation identity, exact namespace, sorted keys, entry count and byte count. `readAll` additionally returns the original metadata records without rewriting or normalizing them into another protocol.

Enumeration stays in the selected private store directory without recursion. Other project/namespace, backup, ciphertext and credential-payload filenames are only counted, not opened or inspected. Selected metadata must be bounded, singly linked, ordinary owner-only regular files; project/directory identity and permissions, opened descriptors, current paths and final file/directory stamps are rechecked. Declared original project/creation identities must agree. Keys alone are not a coherent metadata read; runner admission uses the complete `readAll` result.

Hard ceilings are 8,192 directory entries, 1,024 selected records, 8 MiB selected bytes, 2 MiB filename bytes, 64 KiB per record and 10 seconds of monotonic time. Callers may lower but never raise these limits. Missing, changed, incomplete, overflowing, timed-out, aborted or unsupported inventories throw `ScopedMetadataEnumerationError`; they never become an empty inventory. The selected filesystem must supply the optional directory iterator and raw byte-read capabilities plus creation/owner metadata. There is no fallback to Node behind a custom filesystem. The default Node metadata iterator currently requires POSIX descriptor/private-mode support; unsupported native profiles remain blocked.

Node private read opens use `O_NONBLOCK` on POSIX so a regular-file-to-FIFO race cannot hang before descriptor validation. The regression exercises the actual adapter in a bounded owned child process, not a mock read.

Before any GitHub access in both runner creation and assignment reconciliation, admission scans only that project's `governance-operation` metadata. It blocks original private-access workflow dispatch records, their retained legacy run bindings, unsupported private-access formats and orphaned results even when old workflow IDs and public plan/run pointers are missing. Original keys, actions and receipts are preserved; no retrospective prepared record, execution alias or inferred absence is introduced. This inventory is read-only evidence, not mutation authority.

### Published application workflow assignment

`applicationSources` admits at most four `PrivateRunnerApplicationSource` bindings. Each has `schemaVersion: 1`, `kind: environment-runtime | staging-security`, the actual repository/repository ID, registered workflow ID, full published source SHA, short ref, actor ID, canonical workflow-content digest, and the corresponding closed `EnvironmentRuntimeRecipe` or `StagingSecurityWorkflowRecipe`. Arbitrary YAML, guessed workflow IDs, wildcard refs, duplicate selectors and mismatched recipes are rejected. Default reads verify the actual active workflow registration, exact branch SHA, Git blob and complete rendered source bytes.

Admitted environment-runtime and staging-security source routing contains only the exact group name and label. It must not require a future ephemeral runner ID or a pre-creation group/definition ID, including a nullable stand-in. Either published recipe can be selected at initial runner creation; actual numeric identities come separately from settled provider creation and assignment readback. Template-only future artifact/FQDN fields do not replace the actual published workflow binding and are not executed by runner assignment. Older source/receipt fields are not backfilled or silently reinterpreted; changed rendered bytes require fresh reviewed publication.

For an existing group, set `reconciliation: { originPlanDigest, groupId, definitionId, networkConfigurationId, expectedWorkflows }` alongside the desired source bindings. `originPlanDigest` is the original **saved governance creation plan**, exposed as `runner.creationPlanDigest`, not the internal resource-plan digest. That plan must remain in the inspected reviewed-plan inventory with privately issued approval and independently settled network/group/definition creation receipts. Names or a live group ID alone are insufficient.

Reconciliation plans a separate `github.runner.ensure-ready` read operation and GH-write operation with step `reconcile-workflow-assignment`. Execution performs only the documented ID-addressed group PATCH with the unchanged required name, `restricted_to_workflows: true`, and the exact selected workflow list. It never creates or replaces the network/group/definition, modifies repository membership, or dispatches application, backend, reachability or DAST work.

Every group revision has an immutable bounded private index and pre-effect checkpoint before PATCH. The before-state must match the original private creation/reconciliation chain and fresh provider reads. Provider-read-only controls, foreign repositories/fleets/networks, moved refs and changed source bytes block. Actual returned request IDs are retained; successful writes require independent bounded group/network/definition/source readback. Matching controls produce zero PATCH. Known rejections require a fresh issued revision; missing/unknown responses and returned ambiguous server errors are never blindly retried, even if the group appears to match later.

`verifyPrivateRunnerAssignment(client, binding, { authorize, now?, sources?, run? })` is a GET-only helper exported from `private-runner-assignment.ts` and `producer-runner.ts`. The binding names exact repository/organization, group, network settings/subnet/region, hosted definition/image/machine/concurrency and workflow allowlist. It rejects mixed or extra runner fleets. Every GET requires current exact phase/effect read authority; original creation approval does not authorize these reads. `sources` independently checks selected published recipes. Optional `run: { workflow, operation }` reuses bound-run/check verification and returns a `PrivateRunnerJobObservation` with actual run/attempt/job/check IDs, runner ID/name, group ID/name and bounded exact labels. The second job observation must retain the independently verified source, name, status, conclusion, check and steps. Missing or changed provider metadata blocks; definition IDs and configured routing labels never replace actual job runner IDs or names.

`PrivateRunnerAssignmentBinding` and `validatePrivateRunnerAssignment` also have a standalone import boundary in `private-runner-assignment-binding.ts`; existing re-exports remain compatible. That module does not import the runner producer or environment/staging workflow renderers. A valid binding is metadata, not private issuance, custody, successful execution or qualification.

Optional run observation preserves the original published `producerSourceSha` separately from the approved execution `sourceSha`. Both immutable commits must contain the same exact registered workflow bytes. `readPrivateRunnerApplicationSource(client, source, { refSha? })` admits an explicitly bound current ref SHA, never an inferred latest commit; the run verifier supplies only its validated execution SHA. Default creation/reconciliation source reads retain their original exact-ref requirement. Changed bytes, producer bindings, refs or actors block rather than force unrelated commit SHAs equal or retag a prior witness.

The observation corroborates current single-definition group/network controls and actual job group/routing metadata. GitHub job metadata does not expose an individual hosted-instance-to-definition ID mapping or a historical NIC/private-route attestation; neither is invented. This readback is assignment evidence, not network, application, DAST, backend-lock or host qualification. Consumers still need their own independently bound source/artifact/network/resource witnesses and original private assignment custody.

`assertPrivateRunnerAssignmentCustody(input, { reference, binding, sources? }, { authorize })` is the separate metadata-only admission exported from `producer-runner.ts`. It accepts `PhasePlanningInput` with optional `clock`/`lease`; an executing plan or an execution-input cast is not required. `reference` is the exact original `QualificationEvidenceReference`, not an asserted plan digest or current matching group ID. Admission joins the authoritative original runner receipt and retained plan, its original privately issued approval at `header.producedAt`, three independently settled private creation receipts and their original approvals at `preparedAt`, the actual retained shared network-run identity, and the complete bounded private assignment revision chain. A genuine no-op needs its original issued plan but no invented mutation checkpoint; a resumed returned effect keeps its original request/plan custody.

The admission requires the actual current cooperating project lease and an explicit current authorization callback. It issues no provider requests, writes no records, and returns no new authority token. Original plans are reconstructed against the canonical runner phase only to validate historical custody, never executed under that phase's past approval. It reads the selected original Azure/private-effects store and the selected GitHub/shared-workflow store; a custom GitHub store without an explicitly selected original private metadata store is refused rather than falling back to the user's home. Original approvals, including shared workflow issuance, remain checked in their corresponding selected store.

The supported inventory is bounded to 128 retained runner plans, 32 assignment revisions and ten seconds, with the released metadata scanner's entry/byte/private-file limits and remaining time budget. Missing issuance, unresolved or ambiguous effects, a missing index or revision gap, unindexed group effects, unsupported custom filesystem enumeration, source/allowlist drift and overflow all block new application admission. No ciphertext, state, credential payload or foreign project namespace is opened.

`readPrivateRunnerAssignmentForConsumer(input, client, { reference, binding, sources? }, { authorize, run? })` composes that admission with the current authorized GET-only observer and checks original custody again before returning the observation. The caller supplies its current scoped client and per-request authority callback. No old phase is executed, no lease is acquired, and no provider write or dispatch is possible through this composition. The actual existing project lease must already be held. Optional `run` accepts an original recorded provider run identity without inventing a terminal status; actual run/job/check conclusions still come from provider readback. This composition does not replace the consumer's separate dispatch-custody, artifact, network, resource or qualification gates.

Both runner outcomes expose `evidencePayload.assignment` as `PrivateRunnerAssignmentObservation`; reconciliation is explicitly `workflow-assignment-only` and does not relabel old network observations as fresh proof. The cooperating project lease does not fence an unrelated organization administrator, and the API contract does not claim cross-client CAS or atomic rollback.

Private network/backend recipes now embed canonical JSON, so persisting an exact plan cannot change its rendered source merely by reordering object keys. Changed rendered bytes require newly reviewed publication; older source and effect receipts are retained, not retagged.

### Exact backend lease proof

`private-backend-lease.ts` implements one fixed protocol: metadata-only observation of the exact existing blob/version, a 60-second owned lease, an explicitly planned competing acquire that must be rejected, one renewal, held metadata, one bounded release and released metadata. The workflow embeds this same protocol implementation. It never creates an absent blob, downloads state contents, changes blob contents, breaks a foreign lease or treats conditional-create capability as acquired locking.

`renderPrivateBackendWorkflow` is a separate privileged dispatch-only recipe. It exchanges the bound GitHub OIDC assertion for the exact Azure storage principal in memory, verifies the actual job/runner and private transport, runs the fixed lease protocol and uploads `private-backend-lease-report.json`. The lease ID never enters arguments, logs, dispatch inputs or reports. A successful workflow result means the diagnostic report was collected; only a verified semantic report plus independent audit can complete the phase.

The phase configuration is `{ source: PrivateBackendWorkflowSource, challenge: { challengeId, expectedEtag, expectedVersion, activeUntil, releaseUntil }, audit: { workspaceResourceId, workspaceId, reader: AzureArmBinding } }`. The active and cleanup deadlines are distinct and must fit inside the actual issued approval. Public client request IDs are derived from a pre-known lease-intent digest, not mistaken for provider IDs.

Reviewed blob destinations, existing-path/import effects and independent audit matching all use the released `azureStateUrl` builder. The backend workflow embeds its blob and lease URLs as fixed, reviewed source values from that same builder; they are not dispatch inputs. Runtime checks retain the exact private hostname, decoded key and lease-only query. The released binding still rejects reserved-character, traversal and empty-segment keys; no broader key policy is inferred. These workflow bytes require fresh source publication rather than retagging an older recipe.

Each acquire, competing acquire, renew and release has a durable exact private pre-effect record before the shared workflow dispatch. Actual returned Azure request IDs are retained from the strict source/run/job/artifact-bound report. `PrivateBackendAuditClient` performs bounded default ARM and Log Analytics reads, matching documented `StorageBlobLogs` client request IDs, operations, principal/client/tenant, exact target, private caller address, run/nonce user agent and time window. It does not query state/authentication hashes or invent a `RequestId` column; log `CorrelationId` is not relabeled as the Azure response request ID.

The audit uses the storage-log spelling `TLS 1.2`/`TLS 1.3`, distinct from Node's socket observation, and compares only the exact ARM account/service IDs case-insensitively. The [resource-log reference](https://learn.microsoft.com/en-us/azure/storage/blobs/monitor-blob-storage-reference#fields-that-describe-the-operation) links the service's logged lease operation names; the [TLS monitoring guidance](https://learn.microsoft.com/en-us/azure/storage/common/transport-layer-security-configure-minimum-version#query-logged-requests-by-caller-ip-address-and-user-agent-header) defines the log-query spelling. These schema checks are not live audit qualification.

An unknown effect stays unresolved, even if another cleanup effect succeeds. Cleanup releases only a positively accepted owned lease within its separate deadline; a merely proposed ID after a lost or rejected acquire is not ownership authority. An unresolved finite lease is left to its provider-enforced expiry, without claiming that expiry was observed. Read-only recovery uses original checkpoints and real provider run IDs; it does not invoke the dispatcher to adopt an independently submitted run or grant new lease mutations. Missing original checkpoints or audit corroboration block completion.

Runner creation can include one exact, independently published backend workflow through `backendSource`. Its registered source and the resulting exact group workflow allowlist are read back. Existing differing group assignments are not implicitly patched or widened; they need distinct reconciliation authority.

## Protected import and custody

The import implementation reuses the released encrypted state workspace, private file/process supervision, Azure Blob backend, scoped access, leases and no-resource-change invariants. Its default native profile uses the existing macOS/APFS FileVault and external Keychain contracts. Other native host profiles are not implied to be supported.

Only a bounded explicit network configuration root and pinned local AzureRM provider mirror are admitted. Uninspected modules/data sources, provider auto-registration, project programs, backend changes and application resources are rejected. Import blocks use declared actual IDs; any create/update/delete/replacement in the saved plan blocks execution. The provider identity used by OpenTofu is independently read-only and distinct from the scoped state writer.

Existing state is privately backed up and preserved. An already matching backend is independently verified without a state PUT. New publication uses the released conditional-create/lease protocol; existing publication requires the held lease and exact ETag. Fresh no-change verification runs against independently re-read remote bytes before success.

State bytes, private saved plans and their content hashes stay inside protected custody. Public proof includes only public mappings, source/tool/configuration bindings, actual provider request IDs and a payload-free no-change projection.

New import journals use private schema 2 and prerecord the exact backup/candidate artifact descriptor before encrypted creation. A lost protected-create return is resolved against that same descriptor, not by creating another original backup. Fresh verification does not retain an unnecessary candidate copy. Older private schema-1 journals lack a complete material inventory and remain blocked for explicit custody reconciliation; they are not retagged and their workspace is never scanned for guessed disposable files.

Original retention/disposal dates are immutable. Resume/recovery neither resets the deadline nor recreates disposed material. Known persisted writes can be reverified under a fresh issued recovery approval without another state write. Unknown dispatch outcomes retain their checkpoints and require attributable recovery; there is no cross-provider atomic rollback or automatic resource/state deletion.

A null original journal entry means **not yet observed**, not an empty or absent backend. Fresh approved recovery may observe it only when no state write, candidate, proof or original backup was recorded. Verified absence is a separately validated metadata snapshot. A missing original observation after progress, or missing/mismatching backup material for an existing original, blocks before further backend access; current remote state is never adopted as a replacement original.

### External custody lifecycle linkage

Successful import emits `PrivateExternalCustodyReference`: a versioned `protected-external` handle, exact workspace/key-provider references, original dates, owned material references and `keyDisposition: retain-preexisting-external-key`. `backend.custodyHandle` exposes the opaque lookup handle. The key reference identifies provider metadata, not a hash of the encryption key. Actual descriptor content hashes and the opening configuration remain in the released project-bound private record store, never in public disposal operations or evidence.

`privateExternalRetention(record, previous?)` binds the immutable import evidence and preserves the original dates, including a retention period longer than thirty days. It neither fills project-relative path arrays nor replaces a prior disposed status. Changed reference/history bindings require explicit reconciliation.

The artifact-only disposal implementation opens the original protected workspace under a real project lease and privately issued destructive lifecycle approval. It checks every original descriptor before removing any material, uses released `removeExact`, and retains each durable pre-delete checkpoint and independent absence readback. Missing material before an intent, changed content, unknown still-present outcomes, and missing custody block rather than trigger a sweep or blind retry. No workspace directory is recursively removed.

The original external Keychain key predates this artifact inventory and has no proven exclusive ownership or released destruction API. It is preserved. Artifact removal does **not** claim cryptographic erasure, APFS snapshot deletion, or destruction of that key. The distinct `local.bootstrap-custody.dispose-artifacts` action and current external-retention mapping require coordinator admission before common lifecycle execution; the old key-destruction/path contract is not a substitute.

## Frozen-contract and qualification boundaries

The current unpublished manifest/policy/activation/graph/compatibility/output/protocol identities are `8/8/4/3/5/3/1`, with credential-policy schema 2; the computed graph hash is `7ae2149bfe39b3983bd09c14f0b11ebb84f82ad276170f12cc2c250d780301e9`.
The exact pre-amendment policy-7/schema-1 candidate remains historical and needs
its reviewed successor transition. That transition grants no sensitive-state or
credential-use authority, does not retag private custody, and cannot reset retention
or disposal dates. Fresh credential approval binds actual provider grants and
their broader read scope; see [credential permissions](credential-permissions.md).

- The reviewed current graph declares backend read/write effects for `private-backend-proof` under exact `activation-plan` approval. Execution still requires the registered lease action, admitted target, private issuance and per-effect records; the graph alone grants no operator authority or qualification. Lease proof does not authorize backend initialization, arbitrary state writes or reuse of a past probe as a current lock. No read alias, Boolean grant or historical tuple is changed to make it pass.
- `runner-ready` allows GitHub/network-runner operations, not Azure/backend metadata reads. Its source is strictly network-only; backend metadata belongs in a separately authorized backend phase, and TLS reachability does not prove it.
- Shared dispatch uses the registered primary `github.runner.reachability-dispatch`. There is no fallback to a hidden delegated dispatch implementation.
- The operation registry explicitly permits the `github-read` form of `github.runner.backend-proof` for already-dispatched run readback. This does not authorize a lease mutation or turn network reachability into backend readiness.
- Released protected custody uses external workspace/key-provider references. The owned lifecycle producer now exposes exact handles, private descriptors and bounded artifact deletion; common state/approval routing must admit that distinct artifact-only policy or remain explicitly blocked. No older project-relative state/key disposal array is fabricated.
- ARM conditional-create behavior, actual GitHub organization/account capabilities, current outbound networking, FileVault/Keychain/tool/provider combinations, private data-plane access and live recovery still require independently authorized qualification.

Exact operator targets, identities, permissions, permitted effects, spending and time bounds are prerequisites for live qualification. They are not inferred from this implementation, its tests or a monthly infrastructure cost approval.
