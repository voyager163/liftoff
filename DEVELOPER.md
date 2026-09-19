# Liftoff developer guide

This guide covers release-owned compatibility, deterministic setup, and package
publishing. General contribution setup remains in [CONTRIBUTING.md](CONTRIBUTING.md).

## Stabilization acceptance matrix

The `stabilize-and-modularize-liftoff` change separates retirement, mechanical
extraction, and behavior corrections. This matrix identifies acceptance targets,
not a claim of production readiness. Its OpenSpec task checklist is the progress
authority; the locations below identify the extracted implementation, not its
temporary compatibility facades.

| Capability | Canonical implementation area under `src/` | Acceptance evidence | Change kind |
| --- | --- | --- | --- |
| `liftoff-cli-workflow` | `cli/args/`, `cli/commands/`, `domain/project/inputs.ts`, `interactive.ts` | Command, interactive, help and lifecycle cases | Retirement, correction, extraction |
| `liftoff-power-apps-code-apps` | `domain/project/retired-workload.ts` and manifest/input guards | Retired-manifest rejection and explicit retirement inventory | Retirement |
| `liftoff-project-scaffold` | `generators/{common,genai,containers}/`, `templates.ts` assembler | Template, generated-stack and seed-lifecycle cases | Retirement, correction, extraction |
| `liftoff-standard-projects` | `generators/standard/`, `adapters/packaged-assets/` | Three-stack startup/configuration and container cases | Correction |
| `liftoff-supported-stack-baselines` | `domain/project/supported-stack.ts`, `adapters/packaged-assets/supported-stack.ts` | Baseline identity, integrity and freshness cases | Retirement, correction |
| `liftoff-template-dependency-security` | Audit/freshness scripts and explicit package inventories | Template dependency/security and inventory cases | Retirement |
| `liftoff-infrastructure-governance` | `generators/infrastructure/`, `domain/project/infrastructure-layout.ts`, `cli/commands/helpers.ts` | Per-environment roots, state, naming and sender/receiver cases | Correction, extraction |
| `liftoff-workstation-bootstrap` | `application/initialize/`, `domain/workstation/`, workstation/framework registries | Runtime/package-manager constraints and independent consent | Retirement, correction |
| `liftoff-project-migration` | `domain/migration/`, `scan.ts`, `migrate-plan.ts`, `application/migrate/` | Complete inventory, target overrides, source preservation, cleanup-last | Correction, extraction |
| `liftoff-template-ownership` | `domain/project/artifact-lifecycle.ts`, `reconcile.ts` | Exact ownership, create-only provisioning and force refusal | Retirement, preservation |
| `liftoff-manifest-contract` | `domain/project/manifest/`, `application/project/manifest.ts` | API/GenAI v2-v7 readers, retirement and historical identity boundaries | Retirement, correction, extraction |
| `liftoff-project-update` | `application/update/`, `adapters/filesystem/` | Collisions, recovery, concurrent edits, modes and layout gates | Correction, extraction |
| `liftoff-project-doctor` | `application/diagnose/` and shared probes | Honest readiness, invalid boundaries and no-write diagnostics | Retirement, correction, extraction |
| `liftoff-cli-self-upgrade` | `application/upgrade/`, `self-upgrade.ts`, `stable-release.ts` | Scoped registry precedence, isolation and failure classification | Correction, extraction |
| `liftoff-npm-distribution` | Package metadata and packaging/release scripts | Packed CLI entry point, asset resolution and historical surfaces | Retirement, preservation |
| `liftoff-repository-governance-profile` | `repository-governance.ts`, `domain/governance/policy/identity.ts` | Fixed policy, real workload boundaries and exact managed inventory | Retirement, preservation |
| `liftoff-governance-activation-engine` | `domain/governance/activation/`, `governance-activation/` | Current-input/body binding, retries, selected paths, Spec Kit seed | Correction, extraction |
| `liftoff-governance-assessment` | `domain/governance/assessment/`, `governance-assessment/`, read-only Git/GitHub/Azure adapters | Any-Git coverage, effective enforcement, partial reads and no writes | Correction, extraction |
| `liftoff-user-documentation` | README, developer guide and packaged docs | Links, accurate capabilities, ownership and compatibility guidance | Retirement, correction |

Mechanical extraction must preserve the existing supported help, JSON and
generation fixtures except for separately reviewed intentional changes. The
pre-change capture includes all nine GenAI patterns, three standard API stacks,
Spec Kit, and a frontend-enabled production-only case. A new directory or
forwarding callback does not establish a new implementation boundary.

The explicit non-generative retirement inventory is
`tests/fixtures/power-apps-retirement.json`. It separates whole-file removal,
source/reference edits, shared cases to port, and the historical manifest kept
only as negative input. Do not expand that inventory into blanket deletion of
unknown files or user projects.

Production executors, public approval/credential enrollment, and missing GenAI
specializations remain deferred. Local baseline evidence, read-only assessment,
and successful generated-file checks must not be described as those capabilities.

## Canonical capability metadata

Each of the six engines defines capability metadata once in
`src/application/<engine>/capabilities.ts`. Its `index.ts` re-exports those
descriptors, and `src/application/engine-composition.ts` registers the same
objects. Update supported profiles, command flags, effect classes, and
qualification states in the canonical file, never in a parallel barrel copy.
Registry presence alone is not implementation or qualification evidence:
execution must still reach the owning use case and its actual approval,
transaction, verification, and recovery machinery.

Each ownership entrypoint also exports a frozen runtime object containing its
concrete use cases. `composeApplicationEngines()` lazily assembles those six
objects; it does not execute a supplied callback or infer permission from a
capability descriptor. The main CLI dispatcher uses `composeExecutionContext()`
for operational commands, and command adapters call the selected owner's real
use case. Help, version and capability discovery do not initialize that runtime.
Existing direct command callers without a composed context use the same default
composition.

The composed context preserves the runner, consent hooks and original
`updatePreview` object. Governance's `storage` defaults to that existing private
boundary only when an explicit `storage` was not supplied. Repository/Azure
provider bindings travel through the existing governance adapter context, not
the custom `phases` override; capability, exact-plan, provider ordering,
verification and recovery gates remain in the shared coordinator.

Runtime consumers import governance rendering and policy definitions from their
owning application/domain modules, not the retained `repository-governance.ts`
compatibility facade. Import-boundary checks enforce that separation.

## Activation version vector

Unpublished candidate 0.13.0 deterministic setup contract, as implemented by the current source (activation contract 4, policy 8, credential policy 2, graph 3):

```json
{
  "liftoffVersion": "0.13.0",
  "manifestArtifactVersion": 8,
  "policyVersion": "8",
  "activationContractVersion": 4,
  "phaseGraphSchemaVersion": 3,
  "phaseGraphHash": "7ae2149bfe39b3983bd09c14f0b11ebb84f82ad276170f12cc2c250d780301e9",
  "activationStateSchemaVersion": 4,
  "evidenceHeaderSchemaVersion": 4,
  "approvalEnvelopeSchemaVersion": 4,
  "supersessionSchemaVersion": 1,
  "credentialPolicySchemaVersion": 2
}
```

The published historical 0.12.0 activation vector (retained in historical reader fixtures):
```json
{
  "liftoffVersion": "0.12.0",
  "manifestArtifactVersion": 7,
  "policyVersion": "6",
  "activationContractVersion": 3,
  "phaseGraphSchemaVersion": 2,
  "phaseGraphHash": "2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703",
  "activationStateSchemaVersion": 3,
  "evidenceHeaderSchemaVersion": 3,
  "approvalEnvelopeSchemaVersion": 3,
  "supersessionSchemaVersion": 1,
  "credentialPolicySchemaVersion": 1
}
```

`phaseGraphHash` is the lowercase SHA-256 hex digest of the canonical packaged
phase graph bytes, spanning from local readiness through repository and Azure
phases to final lifecycle disposal. When documenting unreleased work before the
final graph is known, use a clear placeholder; do not fabricate a historical value.

The generated `liftoff.manifest.json` records this as manifest `artifactVersion`
8 plus the activation identity fields shown above. Compatibility metadata uses
schema version 5 in its own document, not a new required manifest field.
Assessment report/catalog and supersession remain at version 1.
Credential-policy schema 2 and normative policy 8 explicitly represent the
actual `organization_administration:read` grant, including broader organization,
billing and Actions-settings reads, not hosted-runners-only access. The exact previous
policy-7/schema-1 candidate is preserved by a separate immutable reader, not
accepted as current execution authority merely because its activation number is 4.
Its frozen graph hash is
`00226d3a7e74b760f463e510847676b11baac432be013062cccda19fb77bcca2`;
do not replace that historical identity with the current graph hash.

Fresh exact plan-bound approval must bind the observed provider grants,
broader-read disclosure, principal, repository/organization, workflow restrictions,
intended operations and applicable expiry. Changed observations require new
review. The broader grant authorizes no incidental reads or writes; Liftoff
remains confined to the exact reviewed endpoints and resources. Original policies,
private ownership receipts and approvals are preserved, never reused or retagged
as schema-2 authority. See [credential permissions](docs/credential-permissions.md).
Exact PAT bearer/lifetime proof and conditional secret creation remain blocked;
GitHub's create-or-update API does not authorize automatic secret upsert.
WinGet read-only inspection, native/live qualification, signing and publication
gates remain independent blockers for this unpublished candidate.

`src/domain/governance/policy/identity.ts` is the version authority;
`src/domain/governance/activation/graph.ts` computes the canonical graph hash and
phase digests. Documentation tests compare this example with the source identity,
rather than blessing an obsolete hardcoded tuple.

| Axis | Tracks |
| --- | --- |
| CLI SemVer | Published implementation and native package behavior; npm distribution is historical-only. |
| Policy version | Normative GitFlow, governance, security, infrastructure, and documentation rules. |
| Activation contract | Phase order, gates, approvals, evidence meaning, invalidation, rollback, and transition semantics. |
| Schema versions | JSON serialization for graph, activation state, evidence headers, approval envelopes, supersession records, credential policy, and manifest artifacts. |
| Graph hash | Exact canonical graph bytes shipped by the release. |

There is no separate `/liftoff-setup` skill version. The setup integration is a
thin managed artifact; its managed content hash plus the activation contract and
graph hash are sufficient identity.

The same rule applies to `/liftoff-governance-assess`: it has no independent
assessment-skill version. Report schema v1 and the packaged assessment catalog
schema identify read-only data contracts, not a new policy or activation identity.

## Repair identity and compatibility

Repair has an independent authority in `src/domain/repair/identity.ts`, exposed
by `liftoff repair --capabilities --json`. Repair contract 1 records eligibility,
interactive/exact approval, validation, completion and recovery guarantees.
It is not part of the activation version vector above. Repair contract 1 was released
in 0.12.3. Tools and integrations negotiate the actual capability contract and preparation
matrix directly (`liftoff repair --capabilities --json`) rather than fabricating capability
support from package SemVer alone.

| Document or behavior | Current identity |
| --- | --- |
| Repair capabilities | schema 1 |
| Repair result, expiring approval preview, new history receipt, repair transaction journal | independent schemas 2 |
| Application inventory, patch input/nested report, verification result/receipt, private backup index/chunks | independent schemas 1 |
| Azure local transformation | recipe `azure-local-layout`, version 1; sources `azure-flat-root-v1` / `azure-partial-independent-v1`, target `azure-independent-roots-v1` |
| Azure baseline settings | recipe `azure-baseline-settings`, version 1; sources `azure-independent-roots-v1`, target `azure-independent-roots-v1` |
| Reviewed application-file patch | recipe `application-layout-patch`, version 1; source `explicit-project-file-mapping-v1`, target `liftoff-application-artifacts-v1` plus exact workload/artifact-inventory digest |
| Shared update transaction journal | schema 1 (unchanged) |

## Contract identity and evolution

Liftoff maintains explicit contract versions across each independent axis. Historical
records are preserved byte-for-byte; newer releases do not retag historical receipts or
fabricate unreleased graph hashes.

| Axis | Current contract | Historical contracts / readers | Scope and notes |
| --- | --- | --- | --- |
| Manifest writer | 8 | Readers accept 2 through 8 | Manifest v8 records explicit profile and adoption provenance; v2-v7 readers preserve original receipts/hashes |
| Governance policy | 8 | 5, 6; pre-amendment candidate 7 | Normative GitFlow, security, ruleset, verification and disclosed provider-grant rules |
| Credential policy | 2 | 1 | Actual provider grants and broader-read disclosure; original records and approvals remain unchanged |
| Activation contract | 4 | 1, 2, 3 | Phase order, gates, evidence headers (v4), approval envelopes (v4), and transition semantics |
| Phase graph schema | 3 | 1, 2 | Canonical phase graph serialization schema |
| Compatibility metadata | 5 | 1, 2, 3, 4 | Activation compatibility metadata schema in its own document |
| Governance output | 3 | 1, 2 | Deterministic governance status and verify output schema 3 (exit 0 complete, 2 consistent incomplete) |
| Public protocol | 1 | — | Public capability envelopes and typed command protocol (`src/protocol/`) |
| Repair contract | 1 | 1 | Contract 1 was released in 0.12.3; the candidate adds `azure-baseline-settings` v1 alongside the retained recipe identities |
| Repair report / preview / journal | 2 | 1 (journals) | Independent schema-2 repair reports, approval previews, and transaction journals |
| Update report / output | 3 | 1, 2 | Deterministic project update report output schema 3 |
| Update transaction journal | 1 | 1 | Unchanged schema-1 `.liftoff/reviewed-update-transaction.json` journal serializer |
| Update preview receipt | 1 | 1 | Schema-1 external preview receipt stored under user state directory |
| Update transaction approval | 1 | 1 | Schema-1 external transaction approval record |
| Adoption records | 1 | — | Schema-1 in-place adoption provenance and journal |
| Native release manifest | 1 | — | Schema-1 native release manifest binding immutable final signed bytes |
| Native auxiliary build-info | 1 | — | Exact CLI/target/runtime identity; `resourcesDigest` binds the full template catalog and `profilesDigest` binds the full profiles catalog |
| Installation inspection / migration | 1 | — | Non-mutating inspection and legacy npm-to-native handover plan/checkpoint |

Build-info's two semantic catalog digests are not interchangeable with the
native release manifest's resource-byte `inventoryHash`. Metadata readers
recheck bounded current bytes and path identity before using a cached parse.
Only confirmed absent metadata in a non-native development layout yields the
explicit unqualified development form; malformed, linked, replaced, or missing
native metadata cannot silently downgrade. These checks do not establish
native signature, ownership, or host qualification.

The application target is derived from current explicit generator declarations,
not an invented legacy version. Source provenance remains historical.
Generation hashes do not authorize moving or replacing application files.
The thin native `/liftoff-repair`/`$liftoff-repair` integrations use managed
content hashes, not a separate skill SemVer or activation/policy bump.

Preview fingerprints bind exact CLI/contract/recipe/layout identity, project,
bytes/modes, directory inventory, external staging, reference dispositions,
validation and expiry. Default-No interactive approval binds the displayed
immutable fingerprint internally; optional exact flags retain the same gates.
Check/JSON/non-TTY never implicitly execute or consume piped consent. Preserve
update's original prompt wording and JSON stdout/stderr behavior when extending
the shared approval helper.

Continuation arguments are checked before resolving them against their recorded
working directory. Ordinary relative paths remain supported; drive-relative
Windows paths, incomplete UNC shares, and device paths are rejected before
normalization can hide their ambiguous target.

Application verification is independently authorized and occurs in a bounded
copy, **not a security sandbox**. Obtain script and any declared network consent
before checks; show their result before distinct file approval. A later No must
report earlier verifier effects. Exit zero proves only the declared checks.
Application patches cannot mutate provenance/control/state/secret files; the
Azure recipe still performs its explicitly registered manifest/history writes.

Schema-1 previews are historical and non-executable. Preserve schema-1 history
without normalization. Explicit recovery compatibility admits only sealed
legacy repair schema 1 or exact registered repair schema-2 contract/recipe/layout
combinations; original CLI/identity fields stay unchanged. Recovery replays only
recorded effects and does not authorize a fresh recipe. Unknown identities or
concurrent edits block recovery. Update's schema-1 format and authority remain
separate, including old journals without a lane field.

## Bump rules

| Change | Required bump |
| --- | --- |
| Normative governance rule, fixed GitFlow decision, approval policy, or credential policy meaning changes | `policyVersion` |
| Phase dependency, applicability, gate, mutation, evidence semantics, invalidation, rollback, or terminal-state behavior changes | `activationContractVersion` |
| Repair eligibility, approval, validation, completion or recovery guarantees change | `repairContractVersion`, with explicit old/new execution and recovery compatibility |
| Repair transformation, supported source/target identities or preservation semantics change | affected recipe version and layout identity; also review repair-contract implications |
| JSON shape or strict validation changes incompatibly | the affected schema version |
| Managed setup, assessment, repair or alias wording changes with no behavior change | managed content hash only |
| CLI-only bug fix with no policy, contract, schema, or managed graph change | CLI SemVer only |

One source change may bump multiple axes. Never advance one axis to hide required
changes in another.

## Compatibility maintenance

- Update the explicit compatibility map for every supported tuple. Do not rely
  on numeric less-than comparisons.
- Preserve v2-v7 manifest readers and v7 writers unless an OpenSpec change
  explicitly replaces that contract.
- Future manifest, policy, contract, schema, or graph identities must block
  without rewriting state and must report the exact field, found value, supported
  identity, and minimum Liftoff remedy.
- Manifest composition injects `validateReadableActivationIdentity` only at the
  manifest boundary. Exact known v1 identities remain readable without retagging;
  state, evidence, approval, readiness, and scope use strict current validation.
- Known v1 activation remains non-executable. The exact packaged successor lane
  requires update preview and approval, preserves original history, and creates
  new v2 proof only through current validation. Never add v1 to the executable map.
- Compatibility metadata v3 distinguishes successor eligibility from execution;
  retain strict schema-2 input reading without treating it as migration authority.
  Update report v3 distinguishes local commit from incomplete revalidation.
- Preview receipts are external user-local metadata, never approval. Persist
  transaction approval separately after explicit consent; recovery must validate
  that external binding rather than trust project-local JSON claiming approval.
- Durable history stays inside the project and outside managed-core ownership.
  It preserves historical state and evidence byte-for-byte. After migration
  commits, repair/resume blocked v2 rather than restore v1.
- The eight flat-root OpenTofu identities are an explicit new-output-only
  exception to append-only naming in 0.11.0. Preserve historical records and
  files; use the exact [retirement inventory](docs/azure-deployment.md#explicit-flat-root-identity-retirement),
  never aliases, prefix ownership, or force conversion.
- A CLI-only patch does not retag activation history. When unchanged renderer
  semantics support a new CLI generation, add that exact version to the
  infrastructure generation compatibility inventory and cover mixed old/new
  component provenance; do not infer compatibility from a SemVer range.
- Never fabricate history: prose, filenames, timestamps, or checked tasks are
  not evidence.

## Read-only assessment maintenance

The pinned target is the installed CLI's packaged policy, activation identity,
phase graph, and control catalog, never registry latest. The local-only
`liftoff governance assess --json` path must make no network requests or require
cloud credentials. Only an explicit `--live` request authorizes bounded
read-only GitHub/Azure metadata using existing permissions and validated scope.
No mode may enroll credentials, run project scripts, mutate configuration,
update or upgrade anything, or write state, approvals, or evidence.
Every assessment invocation, including `--live` and `--help`, must skip telemetry
and disclosure entirely. Local Git reads use only repository root, HEAD, and
origin metadata; never call `git status`, whose clean filters can execute code.
Azure scope and evidence-backed applicability require a current active-baseline
and referenced, validated saved-plan/evidence receipts. Reject placeholder
digests, future-dated approvals, and inferred bindings. Missing bindings remain
`not-observed`; remediation must never suggest manually fabricating activation
state, baselines, receipts, or evidence.
Use `inspectCurrentActivationEvidence` from
`src/governance-activation/read-only.ts`: its contexts include actual input
snapshots, reviewed immutable plans, and state evidence references. Consume
validated selected payloads, never reselect an unvalidated raw duplicate.
`bodyDigest` commits payload and normalized readbacks; `planDigest` binds semantic
inputs and `savedPlanDigest` binds the complete saved plan, including clocks.
Writing receipts does not invalidate their own source-input snapshot.

Reports distinguish target, recorded baseline, declared configuration, and
observed enforcement with expected/observed values, provenance, impact, and
ownership-aware advisory remediation. Preserve all seven classifications:
`aligned`, `outdated`, `missing`, `conflicting`, `approved-exception`,
`inapplicable`, and `not-observed`. Coverage must expose unknown applicability,
unobserved live proof, stale evidence, and unsupported evaluators.
Exit 0 means fully observed aligned or explicitly disabled not-applicable
governance, not interchangeable claims; exit 2 means partial coverage or
differences including approved exceptions; exit 1 means error. An assessment
cannot advance a phase or supply approval for a future governance upgrade.
Show the project policy version when available and expected/observed values.
Optional normalized observation `facts` retain sanitized details alongside
evaluator predicate values without retaining raw provider payloads.

When adding a control or evaluator:

- Use unique stable control IDs, normative policy references, explicit expected
  values, applicability/proof layers, valid phase IDs, and narrow exception scope.
- Bind the catalog digest to the canonical policy digest; test policy/catalog
  coherence and non-empty enabled coverage. Keep every normative policy family
  in the reviewed inventory, including explicit unsupported coverage.
- Add deterministic fixtures for equivalent reordered facts, known differences,
  stale/denied/unknown/incomplete observations, and scope-bound exceptions.
  Unknown proof must not become missing, inapplicable, or aligned.
- Prove read-only behavior with filesystem fingerprints and injected operation
  logs, including failure paths and unsupported identities. Test redaction
  before retention/truncation and fixed live read allowlists and limits.
- Cover Windows/macOS/Linux paths, CRLF, spaces, case handling, and
  symlink/junction rejection; never execute project YAML, hooks, or scripts.
- Keep both agent wrappers equivalent and limited to
  `liftoff governance assess --json` or, after explicit live consent,
  `liftoff governance assess --live --json`. Keep `/liftoff-setup` primary.
- Append exact `liftoff-governance-assess-copilot` and
  `liftoff-governance-assess-claude` ownership identities and portable paths.
  Older supported inventories must load and expose safe new drift. Test
  unowned collision protection under force, managed conflict handling,
  transactional rollback, and unchanged state/evidence bytes.

Assessment diagnoses unsupported activation mappings without weakening mutation
loaders or claiming a migration exists. A future governance upgrade must collect
fresh observations, produce its own authoritative plan, and obtain approvals.
See [assessment guidance](docs/repository-governance.md#read-only-governance-assessment).

## Release integrity requirements

- Validate the canonical graph, graph hash, per-phase contract digests, and
  compatibility metadata together.
- A graph byte change with unchanged phase semantics needs a compatibility
  mapping for unchanged phase digests; a semantic phase change needs the contract
  bump and affected descendant invalidation.
- Generated OpenSpec seeds must include metadata, proposal, design, tasks, and
  declared capability specs, and must pass strict validation immediately.
  Test external archival before activation as well: the baseline must retain
  every applicable local check and validate synchronized specs rather than an
  inactive change name. A persisted archived-baseline blocker is retryable only
  through a new explicit execution, never by fabricating evidence on resume.
- Copilot and Claude `/liftoff-setup` integrations must be behaviorally
  equivalent, command-only, model-agnostic, and free of skill-version fields.
  They must distinguish the read-only `apply-next --json` preview from
  `apply-next --json --execute`, and execute only when approval status is
  `not-required` or `reused`.
  Use `selectedPhase` and `executedPhase` for the apply-next attempt; read the
  subsequent status or verify result for post-transition `nextReadyPhase`.
- Governance verification must report state consistency separately from setup
  progress. A consistent `not-started` or `in-progress` result is not complete;
  completion requires every phase to have a successful terminal state.
- Credential tests must prove PAT/App policy equivalence, exact workflow/job
  allowlists, masked input, no command-argument/file/log/evidence leaks, and
  compromised revoke/rotate guidance.
  OpenSpec failure diagnostics must be bounded, stripped of terminal controls,
  and screened for credential-shaped content before truncation or persistence.
- Path tests must cover Windows, macOS, and Linux path-part arrays, symlink
  rejection, atomic state writes, and rollback.

## Focused commands

Run the smallest focused command while iterating:

```bash
npx vitest run tests/documentation.test.ts
npx vitest run tests/templates.test.ts tests/repository-governance.test.ts
npx vitest run tests/governance-activation.test.ts tests/governance-commands.test.ts tests/governance-credentials.test.ts
npx vitest run tests/seed-lifecycle.test.ts
npx vitest run tests/governance-assessment.test.ts tests/governance-assessment-engine.test.ts
npx vitest run tests/commands.test.ts tests/file-system.test.ts tests/contract.test.ts tests/update.test.ts
npm run build
openspec validate modernize-liftoff-platform --strict
```

Before release, run:

```bash
npm run check
npm run smoke:package
npm run verify:standard-node-templates
npm run verify:generated-containers
npm run verify:release-identity
```

The native routing and Azure configuration cases require uv, Go, OpenTofu and
Checkov on the contributor host. `UV_PATH`, `GO_PATH`, `PYTHON_PATH` and
`CHECKOV_PATH` select existing tools without changing global installations.
CI pins Checkov 3.2.495 for the five cited Azure controls; a newer tool that no
longer executes `CKV2_AZURE_47` is not equivalent qualification. Dependency
restoration honors the operator's approved package registry and still uses
frozen locks; it does not force canonical tarball hosts past mirror policy.

Windows source acceptance has both focused and complete-boundary manual modes
under `diagnostic_windows_only`. Select
`windows_diagnostic_scope=complete-boundary` for the full original boundary plus
the remaining repair/toolchain/continuation source cases in three conserved,
one-worker shards. This includes the historical read-only Git metadata
revalidation case without increasing its deadline. The actual Windows
Node/npm/Git acceptance suite records installed executable identities and
rejects conflicting aliases, project shims and changed executable copies.
Undefined case aliases cannot shadow canonical child-environment variables.
Case-insensitive Windows overrides and explicit clears also replace inherited
aliases rather than leaving an ambient alternative in the final child block.
Its incompatible-version negative uses a deliberately changed copy of npm's
manifest, not a fabricated native version result.

All shards must pass for complete boundary source evidence. These results do
not establish final installed bundles, minimum hosts, enterprise-policy
coverage or a missing Windows private-state foundation; report those as
separate blockers. See [Windows diagnostic commands](CONTRIBUTING.md#validate-a-change).

Collect CLI and telemetry coverage independently, then validate both complete
source inventories and exact raw counts:

```bash
npm run test:coverage -- --maxWorkers=2
npm --prefix services/telemetry-ingest run test:coverage -- --maxWorkers=2
npm run gate:coverage
```

Source CI divides the complete root suite into three built-in Vitest 5 shards
on every OS. Each Linux shard enables V8 and writes a blob report containing
its actual coverage map, including unimported production sources and both
`activation-v3-reader` and `activation-v4-policy7-reader`. The coverage job
waits for all nine source-test shards to succeed, downloads exactly the three
Linux blobs from the current run/source SHA/attempt, rejects missing or empty
reports, and uses the pinned runner's own merge operation:

```bash
npx vitest run --merge-reports=source-test-blobs --coverage --reporter=default
```

Vitest merges file-level measurements, not percentages or summary totals.
Telemetry is measured independently afterward, before the unchanged
`npm run gate:coverage` command. Do not combine its denominator with the CLI's.
For a workflow rerun, rerun all jobs: successful blobs from an earlier attempt
are deliberately not accepted. The retained `source-coverage` artifact is
source-only evidence, not native, live-provider or publication qualification.

The optional `diagnostic_native_posix_locks_only` dispatch exercises only native
Linux x64/arm64 POSIX locking on synthetic local state with explicitly selected
Python/OpenTofu binaries, plus nonsecret per-process Linux read-only guard
fixtures. Exact selected-file preparation may remove group/other write bits
only from runner-owned executables; before/after UID, GID, mode, file identity
and byte digests are retained, with failure closed on unauthorized or changed
inputs. It never copies Python alone, changes broader toolcache permissions or
relaxes production admission. Actual host architecture metadata accompanies each
test report; configured runner labels alone are not execution evidence, and an
unavailable arm64 result remains pending. This lane does not establish encrypted
storage, key-store custody, enrollment or release readiness. It may combine with
the Windows and native Go diagnostic flags, but any diagnostic selection omits
the full source matrix and coverage gate. Default, push and PR coverage stays
unchanged; see the [diagnostic routing table](CONTRIBUTING.md#validate-a-change).

Default source CI also builds `native/linux-keystore-client` on native Linux
x64 and arm64 from exact libsecret commit
`a5cd57f103038c06b64d5f6ebfd0e627bb40af4e`, with the crypto-enabled library in an
explicit private prefix. These two jobs supplement rather than replace the
complete suite and separate coverage gates. The
`diagnostic_linux_keystore_build_only` input selects those build/synthetic-source
checks, or combines them with explicitly selected diagnostics. The initial
dependency-free protocol run remains separate. After a successful pinned build,
the explicit `LIFTOFF_LINUX_KEYSTORE_SYNTHETIC=1` run exercises the compiled client
against a fresh private no-autostart bus and an in-memory synthetic service with
nonsecret fixtures. Its loader/private dependency checks remain required.
No real GNOME, ordinary desktop/system service or keystore is used; production
enrollment is not enabled. Distinct bounded JSON summaries and the original
`build-identity.json` separate compile identity from synthetic behavior; no raw
helper output or binary is uploaded. Real provider, custody, enrollment,
installed-artifact, runtime closure and release admission remain unqualified.

Actual GNOME restart/persistence testing is a separate, default-false manual
`diagnostic_linux_gnome_persistence_only` lane, never part of ordinary push/PR
or default full-source execution. It builds exact clean daemon commit
`da00f9621eaf263d5ed4236df9c22798ea8021d2`, reuses the pinned private libsecret
client and admitted CPython, and first requires compiled-client loader and
managed-key-binding contract tests. The daemon target alone is copied into
the private test prefix; no upstream service/PAM/autostart installation occurs.
Its exact-file runtime preparation also observes canonical `process.execPath`
for the Node coordinator: retained metadata precedes any runner-owned
group/other-write-bit correction, with identity and byte verification afterward.
No unknown historical permissions are assumed and production admission stays
unchanged.
Fresh owned processes, private buses/stores and generated test passwords/keys
exercise actual persistence/restart without using existing keyrings or user
credentials. Sanitized JSON outcomes retain source/architecture bindings and
leave host encryption, provider/cloud/release qualification explicitly
`not-performed`. Uncertain process settlement does not become cleanup proof.
The same manual native step also selects
`LIFTOFF_LINUX_READONLY_NULL_TEST=1` for the separately bound null-sink profile
tests. Both the actual GNOME persistence suite and
`opt-in Linux null-sink profile nonsecret fixtures` must run with zero failed
or skipped applicable cases. Fixed-device 1:3 admission, strict-profile refusal,
continued write/device denial and cancellation remain source-fixture checks,
not permission to widen the original helper or alter a host device/ACL.
Reports separately leave minimum-host and installed-artifact qualification
`not-performed`.
The 18 default jobs and their independent coverage denominators are unchanged;
see the [manual routing and build prerequisites](CONTRIBUTING.md#validate-a-change).

The standalone gate reads only the two canonical coverage-summary paths through
bounded, identity-checked reads. Its `ok` covers **TypeScript/JavaScript
measurements only**, not native helpers or release readiness. Missing reports,
source roots, unimported production files, and caller-selected smaller
inventories cannot pass. All four metrics must satisfy
`covered * 100 > total * 80` separately in each package.

Native helpers remain explicitly unqualified here even when a supplied report
claims success, zero active processes, or a native run ID. The coordinated
release gate independently verifies final signed bytes, registered host runs,
helper behavior, provenance, and the other required qualification. A standalone
V8 pass never promotes those claims into release proof.
The current helper inventory contains the Windows controller, Windows PE
launcher and POSIX launcher. Historical npm command shims remain installation
handover inputs, not an additional shipped native batch launcher.

The three-OS source CI lane measures the Go launcher's existing filesystem and
receipt fixtures separately with Go's statement coverage and retains each
host's `.coverprofile`. Run the same source tests locally with:

```bash
go test -count=1 -cover scripts/distribution/windows-launcher.go scripts/distribution/windows-launcher_test.go
```

This measurement includes unexecuted launcher branches but does not measure the
PowerShell controller or POSIX launcher, run a signed PE, or establish Windows
image-lock, cancellation, policy, or minimum-host qualification. Its percentages
are never merged with either package's V8 counts.

Each native target also requires a separately authenticated minimum-host report,
with measured OS/kernel/libc values and an exact registered execution job.
Copied policy floors or successful execution on a newer hosted image cannot
qualify the minimum; see [native host evidence](docs/native-builds.md#runtime-and-target-facts).

## 0.13.0 release checklist

- Package metadata, lockfile metadata, `liftoff --version`, and tag agree on
  candidate `0.13.0` against exact baseline v0.12.3 commit `70d10881b46d873118d825735696f39b6d35ebe0`.
  Preparing these files is not publication or permission to create a tag.
- The historical baseline retains activation package identity `0.12.0`; current
  candidate code uses `0.13.0`. No phase semantics or graph identity change is introduced
  without independent contract/graph bump review.
- Release notes identify native distribution cutover, candidate/unqualified status
  until signed releases and verified channels are available, and one-time legacy npm handover.
- Manifest writes use artifactVersion 8; readers accept v2 through v8, preserving historical
  v2-v7 records and source receipts.
- Policy version is 8; credential-policy schema 2; activation contract 4; phase graph schema 3; compatibility metadata 5;
  governance output schema 3; public protocol schema 1; repair contract 1 (released in 0.12.3).
- Strict test coverage requires lines, branches, functions, and statements strictly above 80%
  independently for CLI and telemetry service, evaluated from actual numerator/denominator counts.
- Source-only qualification ≠ real native/provider/dashboard qualification; missing credentials,
  signing, or live infrastructure remain explicit blockers.
- Branch policy preserves only `main` and `develop` as permanent branches while active
  temporary PR branches remain valid. Two active worktrees are checked out with no deletions
  authorized; `assets/qualification/source-preservation.json` records the preservation plan.
- Doctor states and remedies cover seed-incomplete, phase-blocked,
  evidence-stale, credential-expiring, reconciliation-required,
  identity-incompatible, enforcement-incomplete, and disposal-pending.
- Package contents include `DEVELOPER.md`, docs, assets, governance artifacts,
  schemas, compatibility metadata, and setup templates.

## Historical npm publishing and native cutover

The v0.12.3-and-earlier npm artifacts and provenance remain historical recovery
inputs. Contributor package smoke checks do not authorize a new npm publication,
bridge package, or mutable npm-latest discovery for native installations. The
candidate package is private; future delivery uses the separately approved
native artifacts and owner channels behind the coordinated release gate.

Do not place npm tokens, registry credentials, PATs, cloud secrets, or signing
material in repository files, workflow logs, chat, screenshots, or evidence.
Historical npm recovery is explicit-version and owner-specific. A native
handover does not rewrite projects, and a failed publication never authorizes
unpublishing historical packages or replacing another installation owner.

## Functional engines and implementation boundaries

Liftoff remains one package and a modular monolith. It identifies six capability
engines and one shared execution kernel (`application/execution`), which is not a
seventh capability engine. Workloads, patterns, activation phases, and assessment
controls are different dimensions; adding a template does not create another engine.

| Capability engine | Application ownership | Principal responsibility | Current implementation |
| --- | --- | --- | --- |
| Standards and Assessment | `application/standards-assessment` | Profile selection, bounded inventory, standards findings and evidence coverage | Runtime entrypoint binds actual assessment and `application/diagnose/` use cases |
| Project Generation | `application/project-generation` | Compose and stage approved new-project artifacts | Runtime entrypoint binds project preview and `application/initialize/`; generation keeps its existing catalog/resource composition |
| Project Evolution | `application/project-evolution` | Adoption, existing fresh-target migration, managed update and reviewed repair | Runtime entrypoint binds adoption and `application/migrate/`, `application/update/`, `application/repair/` |
| Repository Governance | `application/repository-governance` | GitFlow, source workflows, checks, approved settings/rulesets and repository readback | Runtime entrypoint binds governance assessment and the existing GitHub phase planner/executor |
| Azure Activation | `application/azure-activation` | Explicit environment discovery, approved provisioning/deployment and qualification | Runtime entrypoint binds the existing Azure and composite phase planners/executors; individual producers retain their authority checks |
| Distribution and CLI Upgrade | `application/distribution` | Installation ownership, release discovery, native upgrades and installation handover | Runtime entrypoint binds owner-preserving upgrade, installation inspection/migration/recovery and skill delivery |

The shared kernel belongs in `application/execution`; it is not a seventh capability engine.
Pure rules, identities, schemas and compatibility maps remain in `domain`. `cli`
parses, routes, and presents. `protocol` owns versioned external request/result schemas.
I/O stays in explicit adapters.

The packaged profile/template catalogs bind their semantic metadata and actual
resource bytes. `scripts/generate-catalogs.mjs` reads canonical GenAI pattern
declarations with the existing TypeScript-capable AST parser instead of keeping
a second maturity/worker inventory. Pattern names never imply completed retrieval
or streaming features. Composition requires exactly one selected component
owner for each emitted logical artifact; shared content belongs to its common
component, and pattern-specific content belongs to the selected pattern.

Catalog reads recheck bounded regular-file bytes even when a parsed object is
cached. Missing, damaged, linked, or malformed dependencies block actual artifact
generation. A caller-rehashed catalog cannot register arbitrary deletions:
retirement identity, category, path and replacement must agree with the supported
reader's canonical retirement registry. Native installed-artifact qualification
remains separate from these source-level catalog and composition checks.

`application/azure-activation/component-role-mapping.ts` is metadata-only
(`authority: "none"`). It uses actual manifest component identities and canonical
worker selection to distinguish generated image, API, frontend and function
source defaults. Adopted components remain unbound: no inferred build directory,
port, endpoint, hosting or worker absence. Generated function triggers are
skeletons, not processing proof. Source, artifact, native/runtime and provider
readers must independently establish the actual bindings and qualification;
this module is not another HTTP-response or deployment verifier.

Public schema validation rejects malformed nested data, duplicate identities,
inconsistent qualification claims, and mismatched engine ownership. Human-only
`init`/`migrate` descriptors have no JSON result schema. Typed command payloads
require their command-specific decoder; framing alone grants no execution
authority and never changes retained report bodies.

Continuation arguments, native paths, configuration digests, scope and rendered
command must agree. A reference without a digest, a dropped scope/configuration,
or a different target fails admission. The shared literal shell implementation
lives in `domain/execution/shell-command.ts`; the existing process adapter
re-exports it, preserving released formatting without a parallel quoting path.
Project-scoped skills metadata is checked against the parsed `--project` target,
or canonical `cwd` when explicit `--scope project` omits that selector. Dropping
selectors cannot reinterpret project metadata as the CLI's default personal scope;
installation migration metadata is checked against the parsed `--destination`.
These are context-consistency checks, not execution permission: actual private
plans, command-specific consent and native ownership admission remain authoritative.
`requiresInput` templates and unaddressable personal targets are nonexecuting
guidance. Native-path string tests on one host do not qualify another host or shell.

Telemetry, terminal presentation, process execution, catalogs, and filesystem
access support those subsystems rather than constituting additional business
engines.

### Canonical entry points and ports

| Responsibility | Entry point or data contract |
| --- | --- |
| CLI parsing/dispatch | `src/cli/args/parser.ts`, `src/cli/commands/dispatch.ts` |
| Typed use-case requests | `src/application/context.ts`, `src/application/initialize/use-case.ts`, `src/application/update/use-case.ts`, `src/application/migrate/use-case.ts`, `src/application/upgrade/use-case.ts` |
| Pure plans/catalog/manifest rules | `src/domain/project/contracts.ts`, `src/domain/project/catalog.ts`, `src/domain/project/planning.ts`, `src/domain/project/manifest/reader.ts` |
| Release composition | `src/application/project/catalog.ts`, `src/application/project/manifest.ts` |
| Generator assembly and resolved subsets | `src/templates.ts`, `src/generators/context.ts` and its renderer families |
| Installed-package assets | `src/adapters/packaged-assets/package-root.ts`, `src/adapters/packaged-assets/template-assets.ts` |
| Guarded mutations | `src/adapters/filesystem/project-lock.ts`, `src/adapters/filesystem/atomic-write.ts`, `src/adapters/filesystem/project-transaction.ts` |
| Exact infrastructure inventory/layout | `src/domain/project/infrastructure-layout.ts` |
| Current activation observations | `src/governance-activation/inputs.ts`, `src/governance-activation/read-only.ts` |
| Activation planning/execution ports | `src/governance-activation/transition-planning.ts`, `src/governance-activation/transition-ports.ts`, locked coordinator `src/governance-activation/transitions.ts` |
| Concrete phase handlers and persistence | `src/governance-activation/seed-lifecycle.ts`, `src/governance-activation/phase-publication.ts`, `src/governance-activation/phase-discovery.ts`, `src/governance-activation/phase-governance.ts`, `src/governance-activation/phase-bootstrap-state.ts`, `src/governance-activation/transition-records.ts` |
| Pure evidence/availability contracts | `src/domain/governance/activation/evidence.ts`, `src/domain/governance/activation/capabilities.ts` |
| Read-only assessment | `src/governance-assessment/project.ts`, `src/domain/governance/assessment/`, `src/adapters/git/governance-assessment.ts`, `src/adapters/github/governance-assessment.ts`, `src/adapters/azure/governance-assessment.ts` |

The source boundaries are:

```text
src/
  cli/                 # parsing/help and per-command transport
  application/         # typed requests, execution ports and workflow orchestration
  domain/
    project/           # injected catalogs/planning, manifest contracts and ownership
    migration/         # declaration parsing, inventory and placement decisions
    governance/
      policy/          # shared version identities
      activation/      # graph, approval, applicability, evidence and readiness rules
      assessment/      # observations, comparison, coverage and report rules
  generators/
    common/            # shared files, frontend, configuration and workflow seeds
    standard/          # Python, Node.js and Go implementations
    genai/             # configuration, backend, patterns, database and functions
    containers/        # Compose, images and build-context exclusions
    infrastructure/    # independent Azure roots and resource naming
  adapters/
    filesystem/        # guarded discovery/read/write, transactions and locks
    packaged-assets/   # one installed-package root and resolved release assets
    process/           # shell-specific literal command formatting
assets/governance/     # immutable policy bundles, catalogs and compatibility data
```

Activation planning, process transport, outcome persistence, and phase handlers
are real modules, not callbacks into a monolithic dispatcher.
`phase-bootstrap-state.ts` handles retention/disposal boundaries, not the missing
`bootstrap-local` cloud-provisioning executor. `transition-process.ts` centralizes
command outcomes; `transition-records.ts` commits the reviewed plan/evidence/state
contracts through guarded filesystem operations.

`commands.ts`, `args.ts`, `file-system.ts`, and the project/catalog entry modules
are compatibility facades. `templates.ts` assembles actual renderer modules;
it must not regain backend, container, infrastructure, or workflow implementation.
Internal callers use canonical modules rather than routing back through facades.

CLI handlers parse syntax and pass typed `ProjectOptions`, `MigrationRequest`,
`UpdateRequest`, and `UpgradeRequest` to application use cases with
`ExecutionContext` ports from `application/context.ts`.
Application code does not call back into CLI parsing. Pure rules receive data or
narrow context explicitly: `createProjectCatalog`, `buildProjectPlanWithCatalog`,
and `createManifestReader` do not discover files, run processes, or contact
providers. `application/project/catalog.ts` composes the release catalog;
`domain/project/catalog.ts` remains the pure factory.
Root generator composition accepts `PackagedTemplateAssetContext` and calls
`createGeneratorContext` in `generators/context.ts`. Pure renderers receive narrow
resolved subsets and do not import adapters. Only composition loads
`packagedTemplateAssets` through the canonical `resolvePackageFile` /
`resolvePackageFileUrl` resolver.

Manifest grammar, workload normalization, artifact authority, and governance
compatibility have separate project-domain modules. Filesystem discovery,
path safety, file access, and transactions live in distinct adapters.
`withProjectMutationLock` coordinates writers, while snapshots and path/content
preconditions still protect reviewed mutations and conflict-preserving rollback.
Its operation receives a lease with `assertHeld()`; nested same-root mutations
reuse it, while read-only paths do not acquire a lock.
Read-only assessment receives read capabilities, never activation executors or
mutation adapters.

When changing a feature, update its narrow rule/renderer first, wire the
application and CLI boundary, then extend the existing focused cases. Add exact
artifact lifecycle/provenance identities; do not infer ownership from folders.
The import-boundary suite checks cycles, domain I/O, application-to-CLI coupling,
and facade use. Packed smoke covers runtime asset lookup outside this checkout.

## Activation completeness and separate follow-up plan

The activation engine is not yet an end-to-end production provisioning engine.
The canonical graph and `domain/governance/activation/capabilities.ts` enumerate
every phase and distinguish built-in implementation, missing implementation,
and unqualified provider execution. Do not freeze an implementation count in
documentation or treat a newly registered handler as completed qualification.

Required producer and qualification lanes include `bootstrap-workflow-source-ready`,
`credential-ready`, `provider-ready`, `state-path-selected`, `existing-private-path`,
`bootstrap-local`, `runner-ready`, `private-backend-proof`, `remote-import-verified`,
`application-prerequisites-ready`, `application-artifact-ready`,
`application-foundation`, `workflow-source-ready`, `dev-proof`,
`staging-qualified`, `production-rehearsed`, `green-red-proof`, `rulesets-applied`,
`live-readback`, `repository-workflow-source-ready`, `repository-checks-qualified`,
`repository-rulesets-applied`, and `repository-live-readback`.

Full-enforcement readback consumes the original same-scope enforcement authority
and source-check custody; a readback plan does not acquire new mutation authority.
Renewed approvals are selected by the exact envelope recorded in the saved plan,
not by whichever matching phase approval is found first.

Private rehearsal checkpoints use bounded chunks when their original records
exceed one private-store entry. Preserve original record identities and the
shared 64 KiB entry limit; chunking is transport, not permission to rewrite proof.
Pending dispatch, lost responses and rollback retain their original operation
identity and separately reviewed recovery authority.

Built-in handler presence does not establish a complete user journey.
Approval, private credential enrollment, provider effects, and independent
readback remain separate authority boundaries. Missing implementations and
unqualified lanes stay explicit blockers. Current activation inspection binds real
baseline/input snapshots, reviewed plans, state references, and evidence bodies.
Historical placeholder-bound records remain diagnostic-only, never current
proof. Do not fabricate state, approvals, or evidence to get past capability gaps.

Complete this work separately from the read-only assessment feature:

1. Add explicit approval-persistence and secure credential-enrollment entry
   points with narrow consent and selected-agent command contracts.
2. Define a separately reviewed reconciliation workflow for historical activation
   identities and placeholder-bound history
   without rewriting immutable evidence or inventing completion.
3. Supply production implementations for the missing phase adapters and the
   GitHub ruleset adapter, enforcing resource, permission, cost, and destructive
   bounds at execution.
4. Design phase-specific production retry/rollback behavior without blanket
   remote or destructive retries. Explicit local seed/baseline/finalization
   recovery and cooperating-writer locking are already implemented.
5. Prove the entire activation and upgrade/reconciliation path with
   end-to-end positive and negative cases, then gated live readback where
   explicitly authorized.

This stabilization can ship independently while these fail-closed
limitations remain documented; it must not advertise them as completed
production capabilities.

## Broader audit follow-ups

The following work remains outside this stabilization, despite the repaired
runtime configuration, infrastructure generation, and local safety boundaries.
Rendering, unit tests, package smoke, and OpenTofu syntax validation alone do not
establish these production capabilities:

- **GenAI capability completeness:** all nine catalog entries now say
  `foundation` and describe actual behavior. Retrieval/citations, conversation
  history, tools, prompt-file loading, worker processing, coordination,
  fine-tuning, workflow stages, and incremental streaming remain project work.
  Generic has no pgvector package/extension or application-worker requirement.
- **Azure deployment completeness:** RAG publisher configuration and queue-scoped
  sender/receiver separation are implemented. Function code packaging/deployment,
  dependency readiness,
  authenticated ingress, private connectivity, environment-specific safeguards,
  and regional service settings still need reviewed implementation and verification
  before treating generated applications as production-ready.
- **Baseline prerequisites:** keep dependency installation separately
  consented. Python test settings and npm dependency preparation need explicit
  validated recipes; an unprepared baseline must block with a remedy, not pass
  vacuously.
- **Persistent validation coverage:** preserve framework delivery validation,
  retired-workload rejection, and shared safety coverage, and strengthen deep
  readiness rather than equating liveness with dependency health.
- **Supply-chain delivery:** configured-registry version parity is not proof
  that its bytes equal the canonical release. Plan canonical artifact integrity
  verification before self-upgrade installation, with an explicit trust model
  for dependencies and approved mirrors. Pin or package mutable runtime/CDN
  assets as part of that work.
- **Filesystem concurrency:** cooperating-writer locks, guarded transactions,
  mode preservation, and conflict-preserving recovery are implemented. Stronger
  no-follow/fd-relative isolation against noncooperating processes replacing
  ancestors between validation and mutation remains future hardening. Existing preflight/rollback
  safeguards are not a complete adversarial-filesystem isolation mechanism.

Treat these as separate reviewed changes with workload/runtime acceptance
criteria. Do not enlarge a patch into a production platform rewrite or claim
that unavailable behavior has been implemented.
