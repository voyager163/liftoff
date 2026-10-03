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
| `liftoff-workstation-bootstrap` | `application/initialize/`, `application/workstation/`, `domain/workstation/`, `adapters/filesystem/host-environment.ts`, workstation/framework registries | Runtime/package-manager constraints and independent consent | Retirement, correction, extraction |
| `liftoff-project-migration` | `domain/migration/`, `scan.ts`, `migrate-plan.ts`, `application/migrate/` | Complete inventory, target overrides, source preservation, cleanup-last | Correction, extraction |
| `liftoff-template-ownership` | `domain/project/artifact-lifecycle.ts`, `reconcile.ts` | Exact ownership, create-only provisioning and force refusal | Retirement, preservation |
| `liftoff-manifest-contract` | `domain/project/manifest/`, `application/project/manifest.ts` | API/GenAI v2-v7 readers, retirement and historical identity boundaries | Retirement, correction, extraction |
| `liftoff-project-update` | `application/update/`, `adapters/filesystem/` | Collisions, recovery, concurrent edits, modes and layout gates | Correction, extraction |
| `liftoff-project-doctor` | `application/diagnose/` and shared probes | Honest readiness, invalid boundaries and no-write diagnostics | Retirement, correction, extraction |
| `liftoff-cli-self-upgrade` | `application/upgrade/`, `domain/distribution/`, `adapters/distribution/`, `cli/commands/upgrade.ts`, `stable-release.ts` | Scoped registry precedence, isolation and failure classification | Correction, extraction |
| `liftoff-npm-distribution` | Package metadata and packaging/release scripts | Packed CLI entry point, asset resolution and historical surfaces | Retirement, preservation |
| `liftoff-repository-governance-profile` | `generators/governance/`, `domain/governance/policy/` | Fixed policy, real workload boundaries and exact managed inventory | Retirement, preservation, extraction |
| `liftoff-governance-activation-engine` | `domain/governance/activation/`, `application/governance/`, `cli/commands/governance.ts`, `governance-activation/` | Current-input/body binding, retries, selected paths, Spec Kit seed | Correction, extraction |
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

Production executors for unavailable activation phases, public credential
enrollment with independent readback, and missing GenAI specializations remain
deferred; `liftoff governance approve` refuses phases whose producer is unavailable. Local baseline evidence, read-only assessment,
and successful generated-file checks must not be described as those capabilities.

## Activation version vector

Current deterministic setup contract, published by Liftoff 0.12.0:

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
29-phase graph bytes, spanning from local readiness through `bootstrap-workflow-source-ready`
to final lifecycle disposal. When documenting unreleased work before the final graph is
known, use a clear placeholder such as `<sha256-of-canonical-phase-graph-json>`;
do not fabricate a historical value.

The generated `liftoff.manifest.json` records this as manifest `artifactVersion`
7 plus the activation identity fields shown above. Compatibility metadata uses
schema version 4 in its own document, not a new required manifest field.
Assessment report/catalog, graph, supersession, and credential-policy schemas
remain at version 1; normative policy remains 6.

`src/domain/governance/policy/identity.ts` is the version authority;
`src/domain/governance/activation/graph.ts` computes the canonical graph hash and
phase digests. Documentation tests compare this example with the source identity,
rather than blessing an obsolete hardcoded tuple.

| Axis | Tracks |
| --- | --- |
| CLI SemVer | Published implementation and npm package behavior. |
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
It is not part of the activation version vector above. The package remains at 0.12.3;
new application repair and locked preparation capabilities are unreleased. There is
no released minimum version yet: tools and integrations must negotiate the actual
capability contract and preparation matrix directly rather than fabricating a release version.

| Document or behavior | Current identity |
| --- | --- |
| Repair capabilities | schema 1 |
| Repair result, expiring approval preview, new history receipt, repair transaction journal | independent schemas 2 |
| Application inventory, patch input/nested report, verification result/receipt, private backup index/chunks | independent schemas 1 |
| Azure local transformation | recipe `azure-local-layout`, version 1; sources `azure-flat-root-v1` / `azure-partial-independent-v1`, target `azure-independent-roots-v1` |
| Reviewed application-file patch | recipe `application-layout-patch`, version 1; source `explicit-project-file-mapping-v1`, target `liftoff-application-artifacts-v1` plus exact workload/artifact-inventory digest |
| Shared update transaction | schema 1, unchanged |

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

Released-v3 record readers share structural validation with the current validators
through `domain/governance/activation/record-validation.ts`, selecting the exact
frozen identity, graph and released values. The read-only
`readReleasedV3SourceHistory` checks original journal/index/copy relationships for
v3 -> v1, v3 -> v2, and v3 -> v2 -> v1. It audits a live released-v3 source, not
permanent original-manifest provenance or execution readiness. Current v3 remains
executable; these readers do not add it to the v1/v2 historical selector.
The shared record reader imports approval value normalization directly from
`domain/governance/activation/approval-values.ts`, not the current approval
engine. Its three stable value interfaces and six normalizers preserve existing
fields, ordering and diagnostics; current interfaces and facade exports reuse
them. Historical v1/v2 normalization is different and remains separate.
`record-contracts.ts` supplies versioned field shapes shared by current interfaces.
Released records bind their own identity, schema and 26- or 29-phase vocabulary
through nested state, evidence, approval, plan, credential and graph fields;
they no longer derive those shapes from mutable current record interfaces.
The single structural reader preserves those bindings, while current facade
annotations retain the existing public types. Reconciliation shape readers
still support explicitly recognized graph hashes; this does not make every
recognized hash the canonical released identity.
Released identity selectors compare their own registered rows, independently of
current compatibility-key fields. Published journal-1 readers pin their original
phases, statuses, history namespace and exact source/target lanes; their exported
record types no longer derive from the current migration journal.
The captured `tests/fixtures/activation-v3/records.json` retains its original CRLF
bytes through an exact `-text` Git attribute; never regenerate or normalize it.
Released compatibility schema 4 now selects its own exact identity rows,
successor lanes and managed name/path inventories through a shared structural
parser, without falling back to installed catalogs. Historical metadata routing
explicitly selects schemas 1, 2, 3 or 4; future schemas reject. Original partial
and empty inventories, current schema-2/3 normalization quirks, raw source bytes
and modes retain their existing behavior. This metadata does not promote
historical proof to current execution.
`readFrozenActivationManifestHistory` verifies an existing activation-history
reference from stored v1/v2 indices and copies without reading the live successor's
manifest, state, journal or proof stores. It validates the original raw digests,
complete source inventory and at most one v1 predecessor of a v2 source, including
completed revalidation links without retention state. Original source modes and
paths stay separate from the returned physical copy/index observations.
`readFrozenV3ActivationManifestHistory` separately verifies an index-1 snapshot
of an exact released-v3 source, including v3 -> v1, v3 -> v2 and v3 -> v2 -> v1.
It admits three source nodes; the v1/v2 entry point retains its two-node limit.
This new pairing does not imply that a released v3 snapshot writer existed.
Both entry points share physical capture and inventory validation. The v3 reader
checks original manifest identity and stored plan, evidence, approval, projection,
output and retention references in their distinct digest domains. A later policy
or task edit does not invent an unavailable earlier preimage or current readiness.
Shared pure source-value helpers preserve current normalization and evaluation
order without calling current execution engines as historical validators.
These verifiers admit at most 8 MiB per file, 32 MiB total raw bytes and 1,024
unique files, including indices. These inclusive operational ceilings do not
change old readers or stored formats; exceeding them rejects without truncation,
fallback or origin reset. Required state JSON is captured last so empty records
can fit at the exact total-byte limit. The bounded reader's EOF probe and decoder
overhead are not an exact process-memory ceiling. Returned Buffers are owned
observations, not immutable authority, and require locked revalidation before
effects. Shared source-descriptor validation also rejects negative-zero original
modes without changing the legacy index parser.
The reader establishes and rechecks the actual canonical nonlink root but makes
no atomic confinement claim against hostile ancestor replacement. Planned
same-transaction candidates, public caller integration and new writers remain
separate work. Advancing current constants still requires the authoritative
successor identity/context and coordinated record/writer integration. No v8/v4
writer switch is implied.

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

## Contract baseline and coverage gates

`tests/fixtures/contract-baseline-0.12.3/` freezes the public contracts before
modernization. `node scripts/contract-baseline.mjs capture` built the exact
baseline commit from `git archive` (independent of uncommitted work), retrieved
the published `@msn-control/liftoff` packages read-only with `npm pack` after
checking their registry integrity, and ran every capture with isolated
temporary home, XDG, `APPDATA`, and `LOCALAPPDATA` directories, `CI=true`,
`LIFTOFF_TELEMETRY=0`, and `DO_NOT_TRACK=1`, without credentials or accounts. It
records:

- `cli-text.json`: every command and subcommand help screen, reference output,
  and rejected-syntax message at 80 columns;
- `cli-json.json`: `validate`, `update --check`, `repair --capabilities`,
  `repair --check`, `repair --inspect-layout`, `governance status`,
  `governance plan`, and `governance assess` JSON for an isolated fixture
  project; values that differed between two isolated captures are stored as
  `<volatile>` with their JSON pointers;
- `rendered-artifacts.json`: per-artifact digests for all nine GenAI patterns,
  three standard stacks, Spec Kit with a Claude default, three agents,
  governance `none`, and the Copilot cloud agent;
- `manifests/`: the exact manifest bytes written by the last or first published
  writer of each supported version (0.3.4 v2, 0.4.1 v3, 0.7.0 v4, 0.8.0 v5,
  0.9.9 v6, 0.10.0, 0.11.3, and 0.12.3 v7), and `manifest-readers.json` with the
  0.12.3 reader interpretation of those files and the existing v2-v4 fixtures;
- `activation-identities.json` and `history.json`: the current and historical
  activation identities, successor lanes, governance handoff digests from each
  published writer, and the original graph hashes. The published 0.10.0, 0.11.3,
  and 0.12.3 graphs hash to the historical v1, historical v2, and current
  identities.

`provenance.json` pins the baseline commit, the published tarball integrity and
digest, the comparison between the baseline build and published 0.12.3 (all
surfaces identical), and the SHA-256 of every fixture file. The capture refuses
to overwrite an existing baseline, and `tests/contract-baseline.test.ts` pins the
provenance digest.

```bash
npx vitest run tests/contract-baseline.test.ts
```

The test compares the current source with the frozen capture. Help and JSON
comparisons are enabled on macOS and Linux. The capture itself ran on macOS
(darwin/arm64), so the Linux comparison remains unrun until CI executes it
natively; Windows host paths, modes, and shell renderings were not captured, so
those comparisons are skipped and labeled there. Provenance records each published
writer's explicit governance observation (`rendered` or `none`) and one documented
pre-acceptance metadata correction; `node scripts/contract-baseline.mjs observe-writers`
re-reads the published writers read-only for review without writing the baseline.
A deliberate change to
a frozen surface needs one entry in `tests/fixtures/contract-baseline-changes.json`
with its `surface`, `key`, owning `task`, `reason`, `baselineSha256`, and
`currentSha256`; stale, mismatched, or duplicate records fail. Never regenerate
the baseline to accept new behavior.

The same file labels observed rejections. `historical-v5-v6-governed-manifest-rejected`
is a known defect owned by task 3.2: the 0.12.3 readers reject authentic
governed v5 and v6 manifests because they require governance artifacts first
published in 0.10.0. The frozen rejection records current behavior, not a
promise that those versions are unsupported. The retired Power Apps manifest is
an intended rejection.

Coverage gates are documented in
[CONTRIBUTING.md](CONTRIBUTING.md#coverage-gates). The CLI and telemetry gateway
reports are separate evidence: `coverage/cli/coverage-evidence.json` and
`coverage/gateway/coverage-evidence.json` identify their revision, change set,
source inventory, tool versions, and invocation, and neither can satisfy the
other. Code coverage is not native, packaged, generated-project, or live-provider
qualification.

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
openspec validate stabilize-and-modularize-liftoff --strict
```

Before release, run:

```bash
npm run check
npm run coverage:cli
npm run coverage:gateway
npm run smoke:package
npm run verify:standard-node-templates
npm run verify:generated-containers
npm run verify:release-identity
```

## 0.12.3 release checklist

- Package metadata, lockfile metadata, `liftoff --version`, and tag agree on
  `0.12.3`. Preparing these files is not publication or permission to create a tag.
- Activation package identity remains `0.12.0`; no phase semantics or graph
  identity change is introduced by patch-release preparation.
- Release notes identify reviewed `liftoff repair` for supported undeployed Azure
  infrastructure, exact project-bound approval, preserved source/provenance,
  recoverable transactions, and the update/native setup handoff. Deployed or
  unknown infrastructure remains plan-only; no public stateful cutover is claimed.
- Manifest writes use artifactVersion 7; readers accept v2-v7.
- Policy version is `"6"`; activation contract/state/evidence-header/approval
  remain v3. Compatibility metadata is v4; preview receipts,
  transaction approvals, history indexes, and migration journals are v1. Graph,
  supersession, credential-policy, assessment report, and assessment catalog
  schemas remain v1.
- Independent infrastructure provenance explicitly admits generation versions
  `0.11.0`, `0.11.1`, `0.11.2`, `0.11.3`, `0.12.0`, `0.12.1`, `0.12.2`, and `0.12.3`, including mixed component histories.
  Unknown releases remain blocked rather than being accepted through a version range.
- No setup-skill version exists in manifests, JSON status, docs, or generated
  integrations.
- Doctor states and remedies cover seed-incomplete, phase-blocked,
  evidence-stale, credential-expiring, reconciliation-required,
  identity-incompatible, enforcement-incomplete, and disposal-pending.
- Package contents include `DEVELOPER.md`, docs, assets, governance artifacts,
  schemas, compatibility metadata, and setup templates.

## Trusted npm publishing overview

The `Release Liftoff` workflow qualifies and packs the exact source revision
without publishing credentials. Qualification runs the CLI and telemetry gateway
coverage gates before packing and stores their evidence as a separate workflow
artifact; a failure in either blocks the tarball and publication.
Tag-triggered publication requires a canonical
version tag reachable from `main`; manual dispatch is verification-only.
The tarball, source commit, workflow run, package identity, and SHA-256 digest
are bound together before upload. A separate job downloads that artifact by
its immutable workflow artifact ID, revalidates its identity, and waits for
explicit approval through the GitHub `npm-release` environment before publishing
with trusted publishing and provenance. It publishes the qualified tarball,
not a rebuild; afterward the existing verifier builds its helper code and
checks the canonical dist-tag.

The sole maintainer may approve their own release, without an administrator
bypass. This is deliberate confirmation, not independent review. Use merge
commits for `develop` to `main` promotion and ancestry-preserving sync PRs as
described in [GOVERNANCE.md](GOVERNANCE.md). Prepare immutable GitHub releases
as drafts with all assets attached before publication.

npm account, publisher, token, and 2FA settings are outside the repository-setup
change, as is the planned distribution migration. Preserve the existing
repository/workflow publishing identity; GitHub environment approval does not
prove npm-side restrictions. Non-publishing verification does not exercise a
real OIDC publication.

Do not place npm tokens, registry credentials, PATs, cloud secrets, or
signing material in repository files, workflow logs, chat, screenshots, or
evidence. Failed post-publish verification requires a dist-tag correction when
the immutable package is correct, or a corrected patch release; do not unpublish
as routine recovery.

## Functional engines and implementation boundaries

Liftoff remains one npm package and a modular monolith. It has eight functional
responsibility groups, not eight separately deployed services or classes named
`Engine`. Workloads, patterns, activation phases, and assessment controls are
different dimensions; adding a template does not create another engine.

| Subsystem | Current implementation |
| --- | --- |
| Project planning and generation | `domain/project/`, `application/project/`, bundled plugin composition, bound `generators/`, verified packaged template assets |
| Workstation/framework bootstrap | `application/initialize/`, `application/workstation/{probe,remediation}.ts`, `domain/workstation/` rules, workstation registry, framework adapters, `init-filesystem.ts`, dependency setup |
| Source migration | `domain/migration/`, `scan.ts`, `migrate-plan.ts`, `application/migrate/` |
| Managed project maintenance | `application/update/{planning,reporting,use-case}.ts`, `reconcile.ts`, filesystem transactions |
| CLI self-upgrade | `application/upgrade/{use-case,self-upgrade}.ts` orchestration, `domain/distribution/` rules, `adapters/distribution/` npm inspection/install/verification, `cli/commands/upgrade.ts` presentation and stable release lookup |
| Diagnostics | `application/diagnose/`, pure manifest contracts, shared runtime/framework/governance checks |
| Governance activation | `domain/governance/{policy,activation}/` rules, `generators/governance/` rendering, `application/governance/` inspection/verification, CLI presentation and `governance-activation/` execution composition |
| Governance assessment | `domain/governance/assessment/` comparison/report contracts and `governance-assessment/` read-only collection |

Telemetry, terminal presentation, process execution, catalogs, and filesystem
access support those subsystems rather than constituting additional business
engines.

### Canonical entry points and ports

| Responsibility | Entry point or data contract |
| --- | --- |
| CLI parsing/dispatch | `src/cli/args/parser.ts`, `src/cli/commands/dispatch.ts` |
| Typed use-case requests | `src/application/context.ts`, `src/application/initialize/use-case.ts`, `src/application/update/use-case.ts`, `src/application/migrate/use-case.ts`, `src/application/upgrade/use-case.ts` |
| Upgrade execution and presentation | `src/application/upgrade/self-upgrade.ts`, `src/adapters/distribution/npm.ts`, `src/adapters/distribution/upgrade-host.ts`, `src/cli/commands/upgrade.ts` |
| Workstation probes and remediation | `src/application/workstation/probe.ts`, `src/application/workstation/remediation.ts`, `src/adapters/filesystem/host-environment.ts` |
| Pure plans/catalog/manifest rules | `src/domain/project/contracts.ts`, `src/domain/project/catalog.ts`, `src/domain/project/planning.ts`, `src/domain/project/manifest/reader.ts` |
| Release composition | `src/application/project/catalog.ts`, `src/application/project/manifest.ts` |
| Bundled plugin contracts and validation | `src/plugins/contracts.ts`, `src/plugins/registry.ts` |
| Built-in declarations, core identities and release expectations | `src/plugins/builtin/index.ts`, `src/plugins/builtin/core.ts`, `src/plugins/builtin/release.ts` |
| Plugin composition and renderer bindings | `src/application/project/plugins.ts`, `src/application/project/plugin-renderers.ts`, `src/domain/project/artifact-path-tokens.ts` |
| Generator assembly and resolved subsets | `src/templates.ts`, `src/generators/context.ts` and its renderer families |
| Governance rendering and context | `src/generators/governance/`, `src/domain/governance/policy/policy-contract.ts`, `src/domain/governance/policy/context.ts` |
| Governance command transport | `src/cli/commands/governance.ts`, `src/cli/commands/governance-output.ts` |
| Governance inspection and verification | `src/application/governance/inspection.ts`, `src/application/governance/verification.ts` |
| Installed-package assets | `src/adapters/packaged-assets/package-root.ts`, `src/adapters/packaged-assets/plugin-assets.ts`, compatibility `src/adapters/packaged-assets/template-assets.ts`, `src/adapters/packaged-assets/governance-policy.ts`, `src/adapters/packaged-assets/skill-sources.ts` |
| Governance record reads | `src/adapters/filesystem/governance-records.ts` |
| Bounded file observations | `src/adapters/filesystem/bound-project-files.ts` |
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
  plugins/             # release-owned built-ins, core identities, release records and pure validation
  domain/
    distribution/      # package identity, schema-1 upgrade results and npm-lane rules
    workstation/       # requirement contracts, probe classification and remediation
    project/           # injected catalogs/planning, manifest contracts and ownership
    migration/         # declaration parsing, inventory and placement decisions
    governance/
      policy/          # version identities, policy validation and workload context
      activation/      # graph, approval, applicability, evidence and readiness rules
      assessment/      # observations, comparison, coverage and report rules
  generators/
    common/            # shared files, frontend, configuration and workflow seeds
    standard/          # Python, Node.js and Go implementations
    genai/             # configuration, backend, patterns, database and functions
    containers/        # Compose, images and build-context exclusions
    infrastructure/    # independent Azure roots and resource naming
    governance/        # guidance, agent integrations and governance artifact assembly
  adapters/
    distribution/      # npm global inspection, registry parity, exact install and verification
    filesystem/        # guarded discovery/read/write, transactions and locks
    packaged-assets/   # one installed-package root and resolved release assets
    process/           # shell-specific literal command formatting
assets/governance/     # immutable policy bundles, catalogs and compatibility data
assets/skills/         # shared setup, governance-assessment and repair instruction bodies
```

Activation planning, process transport, outcome persistence, and phase handlers
are real modules, not callbacks into a monolithic dispatcher.
`phase-bootstrap-state.ts` handles retention/disposal boundaries, not the missing
`bootstrap-local` cloud-provisioning executor. `transition-process.ts` centralizes
command outcomes; `transition-records.ts` commits the reviewed plan/evidence/state
contracts through guarded filesystem operations.

`bound-project-files.ts` validates portable paths beneath a caller-established
canonical root without returning a reusable safe pathname. Reviewed transactions
select `transaction-compatible`; `single-link` additionally rejects hard links
before open, on the handle and after reading. Reads are size-bounded; only native
pre-open `ENOENT` establishes absence, never a caller's diagnostic rejection.
The existing transaction's 8/16/32 MiB budgets remain unchanged. These observations
are not atomic ancestor confinement or write approval; generic path helpers and
historical-state readers are not replaced by this extraction.

`reviewed-update-journal.ts` owns the shared persisted representations, validation
and canonical header/frame encoding. Measurement uses actual payload bytes and
only the three protocol-fixed fingerprint, UUID and digest widths; the real
encoder checks that its emitted header has exactly that size. The adapter now
refuses forward work whose complete header, mutation frames and commit frame
exceed 32 MiB, before approval seals, journal creation or destination writes.
This check follows cooperative locking and plan validation, not public consent.
The limits remain 8 MiB per file, 16 MiB for every mutation's original plus target
without deduplication, 1,024 mutations and 4,096 supplied preconditions.
Captured supplied conditions remain separate from merged destinations; read-only
condition bodies and external seals are not journal snapshot bytes.
Zero-mutation work retains its validated no-journal outcome. Recovery shares
the record parser but does not require a hypothetical remaining forward budget,
so supported bounded older journals remain recoverable. This is not whole-migration
pre-approval admission: callers still need real target, provenance and context
bytes, complete observations and exact authorization.
Ordinary updates now call `inspectReviewedUpdateCandidate` before issuing an
eligible receipt or asking for approval. Normal and force candidates are admitted
independently using their actual mutations, supplied conditions, complete journal
size and physical directory identities. The saved candidate binding is checked
again under the mutation lock before effects. Whole-inventory consistency checks
run after the complete reserved-temporary inspection, before the first approval
seal, and again immediately before journal creation; their read count does not
grow once per mutation. Released-family activation-successor and finite-revalidation
candidates remain explicitly not materialized by this admission path, not silently
approved. The separate private advancing-family publisher below uses prepared
receipt2 and journal2 to avoid the embedded approval-fingerprint/target-byte cycle;
it does not change the released migration or revalidation contracts.

`commands.ts`, `args.ts`, `file-system.ts`, `self-upgrade.ts`, `package-identity.ts`, `repository-governance.ts`,
`governance-activation/commands.ts`, and the project/catalog entry modules
are compatibility facades. `templates.ts` assembles actual renderer modules;
it must not regain backend, container, infrastructure, or workflow implementation.
New or migrated internal callers use canonical modules
rather than routing back through facades. Remaining callers retain their facades
until their imports are migrated.
`workstation.ts` re-exports the probe/remediation engine but still owns requirement
selection and readiness; their Manual-workflow changes are deferred to stage 4
of `modernize-liftoff-platform`.

CLI handlers parse syntax and pass typed `ProjectOptions`, `MigrationRequest`,
`UpdateRequest`, and `UpgradeRequest` to application use cases with
`ExecutionContext` ports from `application/context.ts`.
Application code does not call back into CLI parsing. Pure rules receive data or
narrow context explicitly: `createProjectCatalog`, `buildProjectPlanWithCatalog`,
and `createManifestReader` do not discover files, run processes, or contact
providers. `application/project/catalog.ts` composes the release catalog;
`domain/project/catalog.ts` remains the pure factory.
`domain/project/manifest/layout.ts` validates layout metadata against the
installed project-artifact/component descriptor composed by
`resolveManifestLayoutDescriptor`. Unresolved bindings are explicitly empty;
bound bindings may still be partial. Canonical ordering and digests preserve
original path spelling while rejecting aliases, overlaps and reserved names.
Metadata's 32-part/255-byte-per-part/4096-byte path limits do not replace the
file adapter's separate operation limits or on-disk checks. Neither metadata
validity nor its digest grants file ownership, completeness, execution or write
permission. These helpers do not change v7 manifest readers/writers or enable
Manual/team targets.
`resolveInstalledManifestBindingContext` obtains plugin metadata and that layout
descriptor from one lazy installed composition; the older layout helper delegates
to it. It retains the registry's full resolution digest, which includes selection
and contribution semantics, rather than hashing just plugin identity rows.
`domain/project/manifest/plugins.ts` recognizes closed, bounded plugin metadata
and compares normalized records exactly. Recognition, including a syntactic
Manual ID or unknown positive content version, proves neither a released source
nor installed compatibility. Plugin rows use registry category/lexical-ID order,
not the project's agent order. No historical plugin data is synthesized, no v8
reader is enabled, and no Manual/team descriptor is installed by these helpers.
History and plugin readers share `fields.ts:exactRecord`; older field helpers
retain their existing semantics.
`domain/project/manifest/v8-project.ts` adds an independent, closed
`{ project, framework }` metadata leaf, not a complete v8 manifest. It recognizes
Manual with explicit `not-required` framework state and optional agents, while
preserving external-framework legacy uncertainty and initialized agent/default
rules. It shares the existing workload and external-framework readers, returns
independent frozen values, and rejects unknown fields and accessor-backed input.
Public manifest reading/writing remains v2-v7; this leaf alone does not enable
Manual generation, installed framework capability or successor publication.
`resolveManifestV8SourceContract` validates that leaf, its explicit profile and
mandatory recorded plugin metadata against one actual installed composition.
Both full resolution digest and exact plugin rows must match. Its frozen result
contains the selected layout descriptor, managed inventory, required handoff
names and finite readable project names; retired readable names do not become
active bindings or file authority. Genuine legacy-empty selections need no fake
scaffold plan. `composeManifestPlugins` shares the existing materialization and
verification engine while preserving the original scaffold evaluation order.
The plugin digest does not bind every framework/default/name/region field; the
successor activation identity must separately bind the complete source context.
Unavailable Manual/team declarations still reject, and this producer alone is
not a complete v8 reader or a target-selection fallback.
The separate `resolveModernManifestV8SourceContract` uses the same composition
engine with private Manual, single-maintainer and team declarations. Its lazy
`modernSourceRegistry` verifies all 16 declared asset byte streams, literal
release digests, the exact canonical six-row source table, raw policy hashes
and actual graph hashes. Failed initialization is not cached. Importing these
APIs or using the original registry does not read the new source assets.
The two profile policies and source table are exact packaged files, not
runtime-generated substitutes or permission to discover project plugins.
`modernActivationSourceContracts` supplies six profile/workflow-specific graph-3
source contracts. `createModernActivationIdentityReader(catalog)` validates
their closed 17-field identities against the full project/framework selection
and independently supplied plugin/layout digests. Manual has explicit native
local completion; Spec Kit does not claim OpenSpec archiving. Team requires an
independent human PR approval without inventing a deployment reviewer; both
profiles preserve stronger existing controls. The `0.13.0-dev.0` source row is
unpublished. `createManifestV8Reader` now validates a complete independent v8
root using the actual modern source resolver and identity factory. It checks
the exact profile/policy/plugin/layout context and generated-versus-partial
handoff inventory for all six enabled source contexts and governance `none`.
Generation provenance and adoption observations remain separate historical
records, not current ownership; legitimate historical paths may differ from or
be repurposed by active bindings. Adoption observations contain only
`logicalName`, `pathParts` and `observedHash`, with an independent 16,384-entry
ceiling. A source-history reference is syntax only, never evidence of stored
bytes or fresh origin. Outputs are independent frozen values; no filesystem
access, defaults or mutation authority are supplied by this reader.
`createManifestV8Candidate` provides an independent origin-aware candidate writer
with closed `fresh`, `historical-successor` and `maintenance` inputs. Fresh
provenance comes only from a complete supplied artifact inventory. Historical
succession preserves normalized original v2-v7 project/provenance data and
requires an explicit layout and original history reference; layout data is
checked without invoking hooks before any digest calculation. Maintenance
preserves the source's original reference or absence, selection, layout and
observations, and rejects contract-identity drift. Every prior managed entry
requires an explicit disposition. Static modern policy/graph checks cover both
new bytes and retained hashes; retiring an exact old setup alias is metadata
disposition, not permission to delete its file.
The result contains an immutable validated manifest, pretty JSON with one final
LF and the raw SHA-256 of those exact UTF-8 bytes. The last-writer version is the
actual local CLI version, distinct from the unpublished activation source.
Other managed content still requires its real producer/semantic checks. This
candidate is not storage proof, publication, approval or installed readiness.
`createModernActivationRecordContract` provides independent state4, evidence4,
approval4, plan3, credential2 and supersession2 readers and supplied-value
constructors. These share the current/released decoder engine without changing
its old contracts. Record encoding requires an explicit kind. Terminal outcomes
bind their referenced evidence to the exact saved plan; direct state intake
checks the selected execution plan and consent. Blocked recovery may retain
distinct dispatch plans and older output receipts. Local completion references
verified baseline evidence with the same original baseline SHA, without claiming
current freshness or requiring equal phase-specific input digests.
Compatibility5 reads complete source manifests and derives metadata from a
validated complete v8 root. `buildModernCompatibilityMetadataForSource` also
validates an explicit selection, plugin resolution and layout before using
the same metadata assembly. This permits real compatibility bytes before
manifest content hashes exist, without a placeholder root; the complete-root
validator then checks the resulting W1 candidate. Its same-intent successor lanes are
source-contract-only, not installed execution capabilities. Pure constructors
supply no clocks, randomness, provider observations or publication authority.
`createModernGovernanceSourceContract` supplies private source-metadata2 values
bound to the complete selected identity, graph and external workflow. It requires
every phase mapping, distinct evidence references and explicit supplied
acknowledgment/fact metadata. It does not verify those references as execution
proof. Its pure checkbox projection preserves unrelated bytes and CRLF, rejects
ambiguous markers, and bounds task input to 256 KiB of UTF-8. Evidence references
are capped at 128 and use the same portable-name and native-alias rules as
modern manifest paths. Manual has no external source or task projection.
`src/application/governance/source-rendering.ts` shares the existing deterministic
OpenSpec/Spec Kit artifact rendering without changing schema1 output.
Modern source-metadata2 publication and runtime task projection remain
unavailable; the graph does not allocate the checkbox mutation, and installed
preflight still rejects unimplemented active-source bindings. Pure metadata and
rendering helpers do not establish approval, storage ownership or readiness.
`buildModernManagedCore` now produces immutable managed content from an explicit
validated selection, plugin resolution and active layout. It uses the real
modern registry's exact policy bytes, canonical graph, source-context
compatibility5, managed context2, credential schema2 and modern guidance. Only
selected native setup/assessment/repair integrations are emitted. Enabled
profiles have six common files plus three per selected agent; `none` emits only
selected repair integrations, and `none` with no agents emits nothing. Manual
creates no framework, seed or task files.
`createModernGovernanceContextContract` binds context2 to the actual source,
layout, plugins and 17-field identity. Its `source-contract-only` interpretation
does not infer filesystem observations, generation provenance, readiness or live
enforcement. This managed context is not activation source-metadata2.
`renderModernCredentialPolicySchema` binds schema2 to that validated identity;
it does not enroll credentials. The schema body and native repair instructions
are shared mechanically while preserving existing schema1 and integration bytes.
Modern guidance stops on unsupported v8 execution rather than inventing commands
or retagging metadata. These producers supply content to an explicit candidate,
not a project writer: complete managed prerequisites, stored history, reviewed
successor publication and current execution support remain separate gates.
`readModernActivationSuccessorSource` captures actual released activation
v1/v2/v3 sources and their complete declared ancestry without writing. The
shared canonical-root, single-link capture engine preserves original bytes,
modes, history references and retention times. Its independent source-history
limits are 8 MiB per file, 32 MiB total retained bytes and 1,024 captures,
including indexes. Planned indexes and copies count toward those limits;
valid existing indexes retain their exact bytes rather than being reformatted.
`planModernActivationSuccessor` binds that capture to a validated same-intent
target, actual managed-core content and explicit byte/retain/retire dispositions,
then returns the literal v8 candidate and semantic input digest. This private
lane supports single-maintainer projects with the same external workflow; it
does not enable Manual/team transitions or future-source migration. Complete
applicable managed-core content is required, and retained content must match
independently captured original bytes.
`prepareActivationHistorySuccessor` reconstructs the plan against those captures
and exact literal manifest bytes before producing pending state4, journal2,
history writes and active-proof retirements. New asynchronous entry points copy
bounded caller-owned inputs synchronously before their first await, including
nested paths, indexes, buffers, options and target data. Supplied preparation1
contains a genuinely issued UUIDv4, timestamp and local repository anchor;
`observedAt` is explicit. No constructor reads a clock, issues randomness,
resets retention or inherits execution authority.
Journal2 recomputes semantic input and its digest, graph/mapping/policy digests
and supplied preparation. Every named evidence reference resolves the actual
phase, repository, state reference, result and validated record/plan; only
complete phases require verified outcomes. Running/blocked phases may reference
genuine failed evidence. Historical completion does not assert current
freshness. The journal contains no approval fingerprint, transaction or commit
timestamp, and initial phases remain pending.
These asynchronous source/plan/preparation APIs neither publish nor grant
transaction admission. A caller must combine all actual managed, history,
manifest, state, journal and retirement effects exactly once, then perform
physical revalidation through `inspectReviewedUpdateCandidate`. Its separate
16 MiB original-plus-target snapshot limit is not the 32 MiB source-history
budget; captures and semantic digests are not approval or current storage
proof.

`previewModernSuccessorUpdate` and `applyModernSuccessorUpdate` now compose those
private APIs for same-workflow, single-maintainer activation-v1/v2/v3 sources.
They do not enable a public CLI target or cover manifest-only/no-activation
successors. Safe transaction-presence checks precede source interpretation.
Reconciliation consumes the captured file/absence observations rather than
classifying one filesystem read and approving another. Normal and force remain
distinct; force never grants ownership of an unowned destination.

The ordering is actual source/manifest, semantic transition **T**, once-issued
preparation **P**, complete target bytes, physical candidate **C**, then full
review fingerprint **F**. Prepared preview schema2 retains T, source binding,
P and the eligible descriptors in the existing guarded 64-KiB preview store.
P supplies actual construction time and UUIDv4 values, preserving an existing
valid local repository anchor. Apply reloads P before reconstruction and never
substitutes a new target timestamp or UUID. Future times and changed bindings
are refused; no preparation TTL is invented. Ordinary previews remain schema1
and are not accepted as prepared-successor authority.

After explicit approval, the separate `update-successor-approval` namespace
retains the first approval's T/P/C/F, method and actual approval time. Its closed
schema1, write-once 64-KiB record is an audit, not an unforgeable capability,
commit timestamp or recovery seal. Missing audit on another machine remains
unavailable audit. Preview consumption never removes that retained record.

Publication uses the existing sealed update transaction, with exact candidate
and source revalidation under its lock. All history copies and their index
precede managed-core replacement, proof retirement, pending state4/journal2
and the final manifest write; original bytes are checked before replacement.
Recovery binds the observed fingerprint and transaction digest under lock, uses
existing transaction seals and does not start another successor. A stopped
process's stale lock still requires explicit ownership review; the publisher
does not automatically reap locks.
Postcommit cleanup failure reports the committed successor rather than
downgrading it. Successful publication returns `committed-incomplete`: local
revalidation remains separately reviewed work, not inherited historical proof.
Public routing, manifest-only successor publication and modern finite
local revalidation remain unwired for this modern lane.

Public catalog, v2-v7 readers, v7 writer, activation-v3 and policy-6 behavior
remain unchanged, including original graph/policy bytes and generation output.
`domain/project/manifest/history.ts` defines pure source-only history metadata
for manifest versions 2 through 7, bounded to 1 through 8 MiB of original bytes.
Its schema-1 index records raw source digest, byte length and original mode;
the source-only snapshot ID excludes the complete index digest and any target,
approval, time or root. Canonical index bytes end with one LF. History digests
are raw lowercase 64-hex, not the prefixed layout/plugin digest format.
The syntax-only reference distinguishes standalone manifest history from
activation-owned history; only the former derives paths under
`.liftoff/manifest-history/<snapshotId>/{manifest.json,index.json}`.
Callers must separately verify actual bytes, stored links and filesystem
observations, then obtain exact transaction approval. These helpers perform
no I/O, preserve no source by themselves and do not change current writers.
`validateManifestHistorySource(unknown)` exposes the same strict four-field
descriptor validation directly, without creating an index or hashing a snapshot
ID. It returns an independent frozen descriptor, not proof that its source bytes
exist or that a reference is safe to reuse.
`application/update/manifest-history.ts` prepares standalone preservation from
supplied file and directory observations. It copies the actual Buffer view
without invoking caller conversion, iterator or species hooks, then uses the
existing strict raw and historical manifest readers. Exact absent destinations
produce two proposed mode-0600 writes; complete canonical history with identical
original bytes produces none. Partial or conflicting history rejects rather than
being repaired. Original source mode stays in the index; observed physical modes
and paths stay in separate preconditions. Preparation performs no per-call project
I/O (its application imports still load packaged assets), publishes nothing, and
does not prove physical capture, activation-record absence, aggregate transaction
admission or approval. Those checks and locked revalidation remain caller work.
`application/update/manifest-history-capture.ts` collects real observations for
that preparer without writing. It requires the selected root's exact physical
canonical spelling and comparable bigint directory identities. Source-derived
paths share the preparer's decoder; missing directories never substitute for
independent missing-file reads. Two fixed passes compare the three bounded,
single-link file observations, with namespace and root checks around collection;
changes reject without retrying or selecting another source. Stable partial
history remains observable and is rejected by preparation. These finite reads
are not atomic confinement, a wall-clock/global-memory bound, activation
classification, transaction admission or approval. No production caller is
wired yet; Windows file-symlink cases still need separate native qualification.
Root generator composition accepts `PackagedTemplateAssetContext` and calls
`createGeneratorContext` in `generators/context.ts`. Pure renderers receive narrow
resolved subsets and do not import adapters. Composition lazily builds the
built-in registry and obtains verified template texts through the packaged byte
reader, anchored at `installedPackageRoot`. The eager `packagedTemplateAssets`
compatibility export remains available through `template-assets.ts`, but no
static or literal-lazy CLI import path reaches it. Governance artifact composition likewise loads
the packaged policy and supported stack through adapters; its domain context
builder receives the supported stack explicitly. The policy adapter preserves
the existing eager, once-per-module policy read.

Packaged template dependency sets live in
`assets/plugins/<plugin-id>/<set>/`; the shared frontend set lives in
`assets/templates/common/frontend/`. The deeply frozen `builtinAssets` table in
`src/plugins/builtin/assets.ts` declares each file once by its explicit owner and
asset id. The compatibility asset adapter resolves those declarations without
scanning directories and preserves its existing eager read order. Directory
placement grants no whole-directory ownership. TypeScript renderers remain in
`src/generators/`; no renderer or template engine moved with these text assets.
Governance assets, the supported-stack baseline and the PowerShell helper keep
their existing core paths and readers. Five legacy egg-info files remain
explicitly unowned under `assets/locks/python-genai/`, retained byte-for-byte in
the repository and excluded from the package.

The current public Liftoff integration bodies have one shared source each in
`assets/skills/setup.md`, `governance-assessment.md` and `repair.md`. The packaged
skill adapter uses the existing bounded, installed-root reader (16 KiB per
source), rejects missing or malformed text, and caches only successful reads.
The governance renderer supplies host-specific native headers and substitutes
repair schema/recipe constants; unknown or missing placeholders fail explicitly.
The initial extraction preserved generated bytes, logical names, paths and managed
hashes. The subsequent capability-negotiation change advances public agent
content versions to 3 and updates their release digests; version 2 is already
allocated to the distinct private modern handoff. Only setup/assessment guidance
and its managed hashes change. Exact before/after records in
`tests/fixtures/contract-baseline-changes.json` account for the intentional
rendering changes without rewriting frozen captures, the extraction harness or
the 165-case composition snapshot. These core ancillary assets have no
separate skill SemVer or broader ownership. Private modern source-only handoff
guards remain distinct from executable public setup; their repair reference uses
the same canonical repair body.

Capability negotiation has a separate bounded preamble: under 700 characters
for setup and 500 for assessment, including line breaks. The complete original
protocol and native header retain their existing 3,000/2,500-character limits
and byte-identical historical instruction bodies; the repair limit stays 8,000.
Tests check both portions, the total and all hosts. Do not omit review, interactive
repair or recovery steps merely to make room for a new capability check.

`scripts/template-dependency-security.mjs` adds ecosystem, advisory coverage
and baseline-view metadata to the six C1 dependency sets without duplicating
their paths or release hashes. The audit preflight checks every member's
presence, regular-file type and exact package declaration before any npm
request. Only the npm graphs receive advisory scans; Python, Go and OpenTofu
sets are explicitly reported as not audited, not as clean.
`tests/dependency-set-inventory.test.ts` checks the baseline/content relations,
including shared Python views, the Function export, Go tool pin and provider
subset.

`scripts/package-smoke-contract.mjs` independently requires the 13 template
assets and twelve core ancillary assets, including the two modern profile policies,
their canonical source-contract table and three shared skill sources. The smoke enforces exact declarations
and packed entries, compares installed asset bytes with the checkout, excludes
`assets/locks/`, and checks five installed plan contracts across Node, Python,
Go and GenAI RAG, with and without the frontend. Four cases run outside the
package from a directory with spaces. Offline contract tests exercise these
same helpers; they do not replace installed-package or native qualification.

The npm archive has a 12 MiB unpacked-size ceiling, measured from the actual
`npm pack` inventory and enforced by the shared smoke contract. Source maps,
type declarations, assets and documentation remain packaged. This packaging
budget is separate from the unchanged history and transaction resource limits;
compressed archive size is not a substitute for the unpacked measurement.

The bundled plugin registry accepts explicit release-owned descriptors, asset
bytes, and independently recorded release expectations. It validates stable
identities, API compatibility, asset digests, supported combinations, host-aware
artifact collisions, and core-owned operation references before returning a
registry. Selection and composition are separate validation stages; composition
recomputes declarations rather than trusting a supplied resolution. Asset
locations do not change content identity, and equal bytes do not imply shared
ownership.

Project generation now uses the bundled plugin registry through
`application/project/plugins.ts`. Static built-ins register Python/FastAPI,
Node/Fastify, Go/Huma, Azure, OpenSpec, Spec Kit, and the `github-copilot`,
`claude` and `codex` agents. Renderer bindings remain application-owned; the
existing Vue option and nine GenAI foundation patterns keep their output and
maturity limits. There is no filesystem discovery, dynamic plugin loading,
environment lookup, or provider effect in registry construction or selection.
Bundled plugins are trusted first-party code, not a security sandbox;
validated contributions and matching digests never grant mutation approval.

The normal generation path reads all 13 declared template assets on first use
and caches the successfully validated registry and texts. Failed construction is
not cached. CLI startup, help and version do not read these template assets;
this does not eliminate the separate eager governance-policy reads. The byte
reader validates paths and positive safe-integer bounds before I/O, rejects
non-regular opened files and over-budget sizes before buffer allocation, handles
short reads and close failures, and probes one extra byte for observed growth.
That probe is not an atomic snapshot and cannot detect later changes. The
composition factory rejects malformed or raised limit overrides before calling
the reader; the registry owns UTF-8 and content-digest verification.

Composition resolves a selection consistently across the declared host tags,
materializes reserved bootstrap path tokens, and checks concrete path collisions
before invoking renderers. It verifies rendered identities before returning any
artifacts. This host-neutral comparison is not native platform qualification.
`PluginCompositionError` distinguishes pre-render and post-render failures;
reader and registry errors propagate through the existing command boundary.
The release record is reviewed literal data, not computed from current assets at
startup. Content digests do not hash renderer implementation; a renderer behavior
change requires a reviewed `contentVersion` advance.

`tests/import-boundaries.test.ts` enforces an exact reviewed map for runtime
imports into plugins. Its current adapter exception is the template asset reader
consuming the inert `builtin/assets.ts` data leaf. Its one application consumer
is the composition root, `application/project/plugins.ts`; plugin modules never
import registry code. Plugin code may use plugin
modules, pure domain rules and named `node:crypto` hashing, not filesystem or
ambient I/O. Literal lazy edges participate in direction checks; the cycle check
remains static-only. Authored runtime module specifiers must name source modules,
Node built-ins or declared runtime dependencies, and direct code-loading
primitives are rejected.
The composition-root, renderer-binding and byte-reader checks also reject
directory enumeration/watch bindings, filesystem namespace imports and direct
ambient effects. They inspect each listed module's own source, not transitive
path provenance, aliases or reflection.

`tests/plugin-execution-isolation.test.ts` exercises covered source commands
beside generated plugin-looking files and package shadows, with fake external
tool runners. Negative-control loaders verify the exact owned file before
executing it. These are syntactic guards and bounded behavior evidence, not
complete data-flow analysis or installed-startup isolation. Dependency internals,
Node preloading and external toolchains remain outside those guarantees.

`tests/plugin-native-paths.test.ts` exercises portable composition identities,
native sibling-name materialization, destination link rejection and preservation
of unowned neighbors. `tests/plugin-packaged-lookup-native.test.ts` covers the
different packaged-lookup trust boundary: release-tree links and hard links are
permitted, containment is lexical, and the registry verifies content. Lexical
containment is not realpath confinement. This is distinct from init's refusal
to write through destination links.

`tests/fixtures/native-path-capabilities.ts` probes the temporary directory's
case and normalization behavior, directory links and hard links. It records
owned roots for cleanup and labels unavailable capabilities explicitly. Pure
Windows-form assertions are host-neutral, not native Windows evidence.
Sibling groups are materialized flat; the destination test logs its path-length
selection omissions and uncovered directories. Neither establishes a MAX_PATH
or full-depth guarantee. Report these observations per host and filesystem;
local macOS results do not qualify unrun Windows, Linux or macOS CI lanes.

The registry accepts an empty agent selection for existing legacy-update and
agentless-repair rendering, but only within scalar/host combinations supported by
at least one bundled agent. Construction has validated those combinations, and
removing agents only removes positively conditioned contributions. No agent is
implicitly selected or emitted. Fresh-project planning still requires an agent;
this compatibility rule does not enable the planned Manual workflow.
Malformed plain data and exceeded validation budgets fail with structured
errors. Accessors are not invoked, byte views are copied into owned memory, and
hostile proxies are outside the release-owned-data trust boundary.

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

### Private modern local verification

`application/governance/modern-local-inputs.ts` exposes asynchronous
`inspectModernLocalVerification`, `planModernLocalVerification` and
`reinspectModernLocalVerification`. They observe a complete v8/G1 managed
context, reconstruct checks from copied raw snapshot bytes, and independently
reinspect physical identities, modes, membership and bytes. Snapshot3, plan1
and recipeSet1 remain private contracts: `planned` always carries
`execution: "not-authorized"`, not approval, tool readiness or local completion.
The planner reads no project paths; its fixed parser computation uses installed
resources and an owned temporary workspace. It does not run project code.

Application capture is bounded to 512 files, 1 MiB per file and 8 MiB total,
with separate control-file limits. Required-input closure is bounded to 2,048
references and 500,000 semantic visits. Literal TypeScript inheritance and
project references are followed through all captured basenames. Compose service
`label_file` and `credential_spec`, `templatefile`, and excluded inputs under
recursive OpenTofu formatting are explicit blockers. Ordinary Compose labels
are data, not source declarations. Source-bound static HCL object keys support
the documented finite parser subset; computed or ambiguous keys remain blocked.
Provider/cache-dependent HCL, installed activation payloads and retained source
history remain blocked in the original MR1 entrypoints. The separate installed
preflight below does not remove provider/cache or execution prerequisites.
Manual skips external-framework checks; governance `none` alone does not.

`adapters/hcl/isolated-parser.ts` launches only its packaged sibling
`parser-child`: `.ts` with native Node type stripping in source, `.js` in a
compiled installation. Policy2/protocol2 admits only darwin/arm64/Node24.21.0;
other runtimes reject before spawning, while empty parser input needs no child.
The fixed limits are 128 MiB per WASM memory, 128 MiB V8 old space, 8 MiB semi
space, 10 seconds per child and 60 seconds per derivation. One child runs at a
time with no queue, bounded transport and a clean environment. Success requires
exit, close and owned-PID absence; unconfirmed shutdown after the 1-second
observation allowance latches computation unavailable and retains its workspace.
These are not a total-RSS cap, an OS sandbox or arbitrary process-tree control.

The complete computation and required-input-closure policies bind recipe
identity. Caller-supplied ASTs, callbacks, booleans or digests cannot replace
raw-input reconstruction. Original legacy predicates are shared without changing
released behavior. This read-only layer does not execute or finalize; the
private execution prerequisite below still does not publish activation records.
Source-metadata2 is not implemented, and public v8 migration remains gated. See the
[portable/native qualification split](CONTRIBUTING.md#isolated-hcl-qualification);
a local parser run does not qualify another runtime or an installed package.

### Installed preflight and durable local publication primitives

`inspectModernInstalledActivation` captures actual current/released records and
stored source history. `validateCapturedModernInstalledActivation` independently
reconstructs their relationships from copied bytes, not supplied success flags.
Fresh, current, successor, governance-none and released-source classifications
are distinct. Pending update, repair or local-verification journals block before
manifest interpretation. Original retention times and state/key paths remain
preservation obligations; payloads are not read or disposed.

`inspectModernLocalRuntime`, `planModernLocalRuntime` and
`reinspectModernLocalRuntime` combine that preflight with the original source
checks without exposing an `allowInstalled` bypass. Stored inputs have separate
1,024-file, 8-MiB/file and 32-MiB raw-total limits. Existing copied-data structural
and encoded-text limits still apply to the combined envelope. Raw/physical
bindings are rechecked; unsupported active source-metadata/projection and
reconciliation relationships remain blockers. Record-format acceptance is not
evidence that tools executed.

The shared durable engine separately provides `inspectLocalVerificationCandidate`,
`applyLocalVerificationTransaction`, `inspectLocalVerificationTransaction` and
`recoverLocalVerificationTransaction`. Its outer journal schema 3 at
`.liftoff/local-verification-transaction.json` is not activation migration
journal2. `LocalVerificationTransactionAuthorityStore` binds the dedicated
`local-verification` kind and exact canonical project root. Update, repair and
foreign-project authority stores cannot authorize this operation, including
recovery. Attribution and method references are captured before awaiting work.

Publication requires an exact candidate binding, physical preconditions and
locked current-input checks before admission, publication and commit. The last
check must compare approved target controls plus unchanged protected inputs,
not expect original controls to survive their own approved replacement. The
caller still owns genuine execution results, separate publication consent and
the finite write allowlist. A durable commit seal wins lost acknowledgement;
recovery never reruns tools or finalization, and fresh readback is still required
for readiness. Stale locks are not automatically reaped.

These are private prerequisites, not a wired execution/publication journey
by themselves. The separate local completion coordinator below connects them.
The runtime envelope still reports `execution: "not-authorized"` and
`publication: "codec-unavailable-not-authorized"` because it is not connected to
the standalone publication engine. No public recovery command, modern migration
selector, provider authority or other-platform qualification is implied.

### Private modern local execution and consent

`prepareModernLocalExecution`, `approveModernLocalExecution`,
`executeModernLocalExecution` and `inspectModernLocalExecution` provide a separate
private execution path. Preparation reconstructs the installed/source preflight,
the complete selected check set and actual tool identities. Its compact preview
binds raw and physical inputs, recipes, output roles, dependency preparation,
issuance/expiry and, for governed projects, a genuine pre-execution plan3.
Governance-none does not invent an activation plan or identity.

Consent separately acknowledges project-code execution and its host/network
capabilities, dependency preparation and dependency network access. A private
workspace and offline flags are not a sandbox. `workflowFinalization` and
`publishLocalRecords` remain false; network preparation is rejected even with
consent until separately qualified. `LocalExecutionRecordStore` binds immutable
`operationKind: "local-execution"` and the canonical project root. Its preview,
consent, result, workspace-authority and CAS-state namespaces are distinct from
update, repair and local-publication authority, with a 64-KiB record limit.

Execution rederives the preview before its one-shot claim. It records activity
before dispatch, requires process-tree settlement and checks original/staged
inputs, tools, controls and frozen dependencies around actual commands. No
caller-selected subset can count as the full baseline. Results distinguish
failed, blocked and uncertain work; complete requires every applicable check
and successful owned-workspace cleanup. Uncertainty retains the workspace and
prevents replay; no PID/age-based automatic recovery is provided.

Current bounds are 32 checks, 120 seconds and 64 KiB output per check, 180 seconds
per preparation and 600 seconds per operation. Previews expire after 15 minutes.
Actual local qualification covers Manual, preinitialized Spec Kit and OpenSpec contract
fixtures across governance-none, single-maintainer and team profiles, using real
Node/frontend/Compose/provider-free OpenTofu checks. Empty-lock offline npm
preparation is separately qualified for Manual. These framework fixtures do not
prove official initializer provenance or run `specify` or `openspec init`. This does not newly
qualify downloaded dependencies, Python/uv/Go dependency execution, OpenSpec
finalization, other platforms or hosted CI. Offline npm may legitimately create
no `node_modules` for an empty lock; only proven-empty successful preparation creates that declared empty root
before dependency freezing.

Execution receipts do not publish evidence/state or confer readiness. The separate
local completion coordinator below connects these results and original consent to
finalization, a second approval of observed publication bytes, the dedicated
local-verification transaction and independent
postcommit readback. OpenSpec main-spec synchronization/archive remains separate
work.
Public migration stays gated.

#### OpenSpec distribution identity and blocked previews

OpenSpec inspection uses a complete canonical package-tree commitment, not just
the launcher and package metadata. Two matching bounded passes capture every
file, directory and internal relative symlink, including physical identities and
dependency metadata. Current use reconstructs the inventory; a stored digest is
not sufficient. Hardlinks, escaping links, unsafe ancestor/bin traversal and
unsupported dependency layouts fail closed. Node and launcher association remain
separately bound. This is not publisher authentication, a complete loaded-runtime
or OS-library inventory, a sandbox, or an atomic filesystem lease.
Relative link text is retained byte-for-byte; Windows separators are interpreted
only on Windows and targets must still resolve wholly inside the captured tree.
Absolute, drive-relative and UNC targets remain inadmissible.

The OpenSpec-only distribution policy admits at most 8192 files, 4096 directories,
1024 symlinks and 128 MiB total, with an 8-MiB per-file bound and 30-second scan
deadline. Full inventories remain transient; compact commitments fit the existing
64-KiB preview limit without increasing other workflows' limits.

These read-only contracts do not qualify private workspace execution on Windows.
The POSIX owner/mode requirements in modern local workspaces and OpenSpec
initialization controls still fail closed there. Their POSIX-only positive tests
are explicitly unrun on Windows; native Windows negative tests assert the actual
refusal and absence of published workspace authority instead.

`prepareModernLocalExecution` still issues OpenSpec previews using private schema2 and
`openspec-workflow-inputs-unqualified`. They can be saved and inspected, but
consent, execution, direct workspace creation and completed-result authority all
remain permanently blocked. The separate schema3 API below does not promote or
reinterpret a saved schema2 preview.
Legacy OpenSpec schema1 stays historically readable, not newly executable, and
complete historical results still require matching finished progress. Manual and
Spec Kit execution schema1 remain unchanged.

The two installed-metadata tests are explicitly opt-in; default/auto and portable
runs leave them unrun, even if budget variables exist. Follow
[OpenSpec identity qualification](CONTRIBUTING.md#openspec-identity-qualification)
for the qualified runtime, installed tools and bounded native invocation.
These tests execute metadata only, not OpenSpec project validation, initialization,
synchronization or archive.

#### Private OpenSpec read-only execution

`prepareModernOpenSpecExecution(root, { kind: 'verify-openspec-local', preparation })`
creates a new private schema3 preview with `openSpecInputs`. Its consent schema2
binds `openSpecInputDigest`; result schema2 retains the exact validated machine
JSON observations and their output commitments. Snapshot schema3, progress
schema1, existing store namespaces and general execution limits stay unchanged.
Direct workspace creation requires the same fresh exact consent before CAS.
Current completed-result readback reconstructs the inputs, recipes and complete
installed distribution instead of treating a saved success as current authority.

The supported read set includes `openspec/config.yaml`, complete active changes,
current main specs, selected integration markers, and directory presence and
membership. The selected bootstrap change must match the project's workload
capability and packaged `spec-driven` schema. Unrelated nonoverlapping active
changes and main capabilities are included, not ignored. Custom schemas,
references, store metadata, nonempty archives, archived execution, overlapping
active capabilities, unknown members and ambiguous subjects reject before tools.
An empty or absent archive is represented explicitly; it is not archive support.

After source-consistency and in-process framework-source checks, execution runs
the exact read-only recipes in order: `status --change <selected> --json`,
`instructions apply --change <selected> --json`,
`validate <selected> --strict --json --no-interactive`, then
`validate --all --strict --json --no-interactive --concurrency 1`.
Only then may the original applicable project checks run. JSON validation binds
the planning home, project/change roots, artifact graph, context paths, original
task descriptions and checkboxes, exact selected/all subject sets and warning-free
totals. An invalid unrelated subject therefore blocks project checks even when
the selected change passes.

Every OpenSpec command uses a fresh owned empty HOME/config/data/cache, cleared
inherited loader settings and telemetry opt-outs. Original/private source and
complete distribution checks surround commands. This is not a sandbox. The
read-set descriptor is limited to 16 KiB and retained JSON proofs to 32 KiB,
within the existing 64-KiB records.

The native fixtures demonstrate read-only execution and independent readback for
governance-none, single-maintainer and team profiles. They are preinitialized
contracts, not official initializer provenance. Original tasks remain unchanged:
an unchecked OpenTofu initialization task stays unchecked. This path performs no
`tofu init`, task writes, synchronization, archive, publication, provider or Git
effects. OpenSpec finalization remains unavailable; a complete read-only result
does not authorize it or public migration. See
[OpenSpec execution qualification](CONTRIBUTING.md#openspec-execution-qualification)
for the separate explicit native lane.

#### Private OpenSpec initialized-baseline execution

`prepareModernOpenSpecInitializedBaseline(root, { kind: 'verify-openspec-initialized', preparation })`
creates a separate private schema4 preview. Its dedicated
`approveModernOpenSpecInitializedBaseline` API issues consent schema3, binding the
initialization descriptor and requiring `dependencyPreparation: true`,
`dependencyNetwork: false`, and both `bootstrapScopeAttestation` fields:
`generatedBaselineReviewed: true` and `domainBehaviorDeferred: true`.
`approveModernLocalExecution` cannot grant this consent. Result schema3 reports
`initialization-obligations-observed`, not finalization or archive readiness.
Existing schema1 behavior, permanently blocked OpenSpec schema2 and read-only
schema3 execution retain their original meanings.

This bounded selection supports standard Node/Fastify with exactly GitHub Copilot
and no Copilot cloud. Schema, context, rules and `githubCopilot.cloudAgent: false`
must match the actual generated configuration. The complete generated task ledger
must match, including every description; unknown, missing or duplicate tasks
reject. Existing checkbox states and CRLF are preserved, and task `3.1` must
remain pending. Existing markers carry
`observed-existing-marker-contract-not-historical-initializer-proof`: recognizing
their current contract does not invent historical initializer provenance.

After the read-only OpenSpec observations, each selected application/environment
root runs `tofu init -backend=false -input=false -no-color` before its matching
validate check in the same protected workspace. Only provider-free, no-module,
no-resource inputs are admitted. This does not qualify full generated Azure
infrastructure or authorize provider/network preparation.
Each `TF_DATA_DIR` must be the same fresh owned empty directory before init.
An immutable CLI configuration selects an empty provider mirror; inherited
environment settings are cleared. Exact source, tool, environment and initialized
output commitments are checked around the dependent commands. This is not a
sandbox or an atomic filesystem lease.

The initialization descriptor is limited to 16 KiB and 4 roots. Each output
inventory independently allows at most 32 files and 16 directories, including its
data-root directory, with a combined 48-entry bound. Files are at most 64 KiB,
total file bytes at most 256 KiB, and relative depth at most 4.
Both writer and reader enforce these bounds. Genuine provider-free init can
produce no cache files: its empty owned data-root inventory is recorded rather
than fabricated provider output.

The official initializer fixture runs only in owned staging. No original project
is initialized; task bytes/modes remain unchanged and task `3.1` is not completed.
Synchronization, archive, publication, finalization and public routing remain
unavailable for this path. See
[OpenSpec initialization qualification](CONTRIBUTING.md#openspec-initialization-qualification)
for the separate native opt-in and the limits of its evidence.

### Private local completion and attributed recovery

`prepareModernLocalFinalization`, `approveModernLocalFinalization` and
`finalizeModernLocalCompletion` consume the original complete execution result,
consent and finished progress. Historical verification checks the actual
execution interval, complete check set and current inputs without reviving
expired execution permission or rerunning tool metadata probes. Finalization
requires its own limited consent; it does not execute project code, prepare
dependencies, run an external workflow or publish project files.

For fresh or supported current single-maintainer/team Manual or Spec Kit projects,
this produces three local plans, three evidence records, state4 and a native receipt.
The original pre-execution baseline plan and state hash are preserved. A new
input plan precedes actual reinspection, and local phase dependencies must be
satisfied before completion evidence is produced. Existing repository facts
remain unchanged; fresh state uses a local UUID and the explicit `undiscovered`
branch sentinel, not an observed Git branch. Governance-none produces only
`.liftoff/local-completion.json` as its native completion record,
never activation state, identity or approval4. Spec Kit may also publish its
separately approved task changes; governance-none does not bypass that consent.

Spec Kit requires an initialized matching framework, the complete bootstrap
spec/plan/tasks bundle, `.specify/init-options.json`, `.specify/integration.json`,
all ten native skill files per selected agent and the selected default
integration (plus Codex configuration when selected). The full execution
baseline includes the planned in-process `framework-source` check; it is not
marked inapplicable, and no `specify` probe or initializer is implicit.

Manual retains schema1 and its unchanged policy. Spec Kit uses private schema2
preview/consent/result, workflow-original artifact and native receipt branches,
without another namespace. Its first consent requires `workflowWrites: true`
only for the fixed `specs/000-liftoff-bootstrap/tasks.md` protocol.
`completedSpecKitTasks` changes only B001-B006 checkbox characters; project-code,
dependency, network and publication scopes remain false. Original task bytes
and mode are retained in one bounded workflow-original artifact. CRLF/LF,
unrelated checkboxes and prose are preserved. Identical helper output means no
task operation or target, preserving the task file's physical identity.

The completion plan binds concrete task `fileChanges` and evidence
`inputBindings`, while retaining the original execution plan, state hash and
timestamps. Readback checks the preserved original artifact, helper output,
approved target and installed bytes, plus unchanged bundle/marker/default
semantics. This is not official initializer provenance or arbitrary user-task
completion.

`approveModernLocalPublication` requires a second exact-byte consent binding
the observed paths, bytes, modes, original absences and candidate.
`publishModernLocalCompletion` uses only those stored artifacts. Locked checks
compare untouched originals before publication and exact approved target controls
before commit. No parser, renderer or tool runs inside those callbacks.
Independent installed-state and protected-input readback, not a receipt flag,
establishes `local-complete-current`; it is local-only, not deployment readiness.

`inspectModernLocalCompletion` and `recoverModernLocalCompletion` inspect the
actual transaction before interpreting installed records. Recovery supplies
`expectedTransaction` with the observed publication fingerprint and transaction
digest. Both are captured before awaits and checked under the same mutation lock,
before rollback, journal cleanup or seal removal. A replacement or disappeared
expected journal is blocked. Returned attribution is checked again before
clearing cleanup state. Recovery never repeats execution, finalization or
publication and never reaps stale locks.

A committed checkpoint records `cleanup-pending` before engine cleanup. Only
observed successful cleanup clears it durably. If the journal disappears and that
observation is lost, the result stays `committed-cleanup-pending`; target-looking
bytes do not authorize inferred cleanup or residual-seal disposal.

The six private finalization/publication namespaces use 64-KiB records, including
base64 overhead, at most 12 artifacts/mutations and separate 15-minute approvals.
Oversized records block rather than being truncated or chunked. A changed,
governed Spec Kit completion uses at most 11 artifacts within that bound.
This private path admits Manual and fixed Spec Kit bootstrap completion only.
OpenSpec finalization, history/retention progression,
source-metadata2/task projection, public routing, provider effects and
other-platform qualification remain separate gates.

## Activation completeness and separate follow-up plan

The activation engine is not yet an end-to-end production provisioning engine.
Of its 29 declared phases, 11 have built-in handler paths, 2 require an injected
GitHub ruleset adapter that the public CLI does not currently supply, and 16
fall back to an explicit missing-production-adapter blocker.

The missing production phase handlers are `bootstrap-workflow-source-ready`,
`provider-ready`, `state-path-selected`, `existing-private-path`, `bootstrap-local`,
`runner-ready`, `private-backend-proof`, `remote-import-verified`,
`application-prerequisites-ready`, `application-artifact-ready`,
`application-foundation`, `workflow-source-ready`, `dev-proof`,
`staging-qualified`, `production-rehearsed`, and `green-red-proof`.
`rulesets-applied` and `live-readback` have adapter contracts but need production wiring.

Built-in handler presence does not establish a complete user journey.
`liftoff governance approve` persists exact approval envelopes, but it refuses a
phase whose capability is unavailable or blocked before writing any approval,
authority record, or plan. `governance apply-next --execute` likewise stops before
any saved plan, intent, or producer effect for such a phase and reports its
blocker; an earlier approval does not change that. Only an explicitly injected
trusted phase adapter, or the GitHub ruleset adapter for `rulesets-applied` and
`live-readback`, can execute those phases, and that test seam is not production
qualification. `provider-ready` and `state-path-selected` no longer report
synthetic verified success, provider registration, or a selected state path; they
stay blocked as missing production adapters. `credential-ready` and the public
`governance credential-enroll` path remain unavailable pending independent
credential readback: they refuse before reading a credential or writing a remote
secret or secret-derived credential policy. The enrollment adapter revokes only the
ephemeral token it minted and reports when that revocation cannot be confirmed.
Current activation inspection now binds real
baseline/input snapshots, reviewed plans, state references, and evidence bodies.
Historical placeholder-bound records remain diagnostic-only, never current
proof. Do not fabricate state, approvals, or evidence to get past capability gaps.

Complete this work separately from the read-only assessment feature:

1. Implement secure credential enrollment with independent readback before
   `credential-ready` can be approved or executed, with narrow consent and
   selected-agent command contracts.
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
  mode preservation, and conflict-preserving recovery are implemented. Init
  preflight and apply revalidation refuse destination aliases using
  NFC-plus-lowercase comparison, including aliases beside exact entries. A
  successful lookup without a listed match also refuses; it can indicate a native
  alias or a listing/stat interleaving. Unlistable ancestors fail closed. Migrate
  treats aliases as existing content under its new-or-empty guard. These checks
  do not establish universal Unicode equivalence or native short-name coverage.
  Stronger
  no-follow/fd-relative isolation against noncooperating processes replacing
  ancestors between validation and mutation remains future hardening. Existing preflight/rollback
  safeguards are not a complete adversarial-filesystem isolation mechanism.

Treat these as separate reviewed changes with workload/runtime acceptance
criteria. Do not enlarge a patch into a production platform rewrite or claim
that unavailable behavior has been implemented.
