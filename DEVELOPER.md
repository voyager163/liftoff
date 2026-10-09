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
| Historical-manifest application-file patch | recipe `application-layout-patch`, version 1; source `explicit-project-file-mapping-v1`, target `liftoff-application-artifacts-v1` plus exact workload/artifact-inventory digest |
| Current-manifest application-file patch | recipe `application-active-layout-patch`, version 1; source `explicit-active-file-mapping-v1`, target `liftoff-active-application-artifacts-v1` plus exact workload/active-target digest |
| Current active-binding publication | recipe `application-active-binding-publication`, version 1; source/target `liftoff-active-application-artifacts-v1`; separately approved manifest-last metadata publication after a committed verified move |
| Shared update transaction | schema 1, unchanged |

The application target is derived from current explicit generator declarations,
not an invented legacy version. Source provenance remains historical.
Generation hashes do not authorize moving or replacing application files.
For v8, explicit artifact and component bindings select current paths; missing
bindings are not inferred from generator placement. The current recipe supports
none/single-maintainer profiles, excludes bound infrastructure/control trees,
and admits a bound-artifact move only when the exact logical identity is retained
and every affected reference has its own reviewed mapping. The verified
application transaction commits first and records immutable binding intent.
`application-active-binding-publication` then reconstructs a second exact plan
from the preserved manifest, committed repair receipt, current target bytes/modes
and source absences. Its repair-lane transaction writes the publication receipt
before `liftoff.manifest.json`; it cannot contain or repeat application moves,
change generation/adoption provenance, or issue activation evidence. Bare current
repair is read-only inventory, including Manual/no-agent projects.
It cannot transform current infrastructure or manufacture governance state.
Both application recipes share the same separately approved verification and
file-transaction boundaries; exact recipe/source/target identities cannot be
substituted in previews or receipts.
The thin native `/liftoff-repair`/`$liftoff-repair` integrations use managed
content hashes, not a separate skill SemVer or activation/policy bump.
Historical rendering retains its original recipe by default. Current rendering
selects the new recipe explicitly, and older owned v8 guides use ordinary
reviewed managed-core maintenance. A changed guide is not new activation proof.

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
- Keep all three agent-host wrappers equivalent and limited to
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

### Shared current source interpretation

Current source metadata is interpreted through
`src/application/project/source-context.ts`. Reuse its strict
`resolveModernProjectSourceContext` or `resolveModernManifestSourceContext`
instead of independently resolving selection, recorded plugins and active
layout. Finite component/artifact lookups return only explicit bindings;
missing bindings remain unknown even when a canonical template path exists.
Custom paths are preserved, and historical generation paths/hashes are not
current-path authority. `resolveModernManagedCoreInput` remains a compatible
entry point into this same interpreter. Expected managed bytes still come from
`buildModernManagedCore`, not from an invented second renderer.
Manifest writers admit managed decisions only through the resolved source's
explicit managed declarations, not desired-current composition. Historical
maintenance preserves its original bodies and metadata; an undeclared new
contribution must be rejected rather than silently discarded.

Update, application repair, doctor, installed/local inspection and assessment
share this metadata interpretation while retaining their independent admission
rules. Partial bound repair scope is not complete doctor scope, and validated
v8 metadata does not enable the narrower governance assessment's unsupported
managed-core/activation proof interpretation. This service performs no project
observation or execution and grants no ownership, approval or mutation authority.

### Whole-project assessment and private inventory

Fresh whole-project guidance uses one `assets/skills/assessment.md` body with
native headers from `renderProjectAssessmentIntegration`. The independent
`projectAssessmentAgentIntegrations` catalog defines exact selected-host
`liftoff-assess` paths; it is not a fourth governance operation or completion
requirement. Manual/no-agent generation has a CLI-only fallback, and governance
`none` does not suppress this independent read-only integration. Tests cover all
three hosts, advertised workflow/profile combinations and negotiation/remediation
boundaries; instruction assertions do not claim actual LLM behavioral qualification.

`src/application/assessment/inventory.ts` exposes `inspectProjectInventory` as
one private observation source for the bounded public `liftoff assess` producer
in `application/assessment/engine.ts`. Inventory alone is not conformance,
adoption or execution support. The existing `governance assess` contract is
unchanged. A missing manifest may now recommend the separately registered,
read-only `liftoff adopt --check` surface; this does not change assessment
authority or make compatibility/publication available. The local engine does
not perform provider collection. Explicit live metadata uses a separate coordinator.

The caller selects one explicit real root. The inventory reuses `ApplicationFiles`
for confined, sorted directory observations, portable alias checks, bounded
no-follow regular-file reads and revalidation. It never searches parent roots,
follows Git worktree pointers or descends into nested Git/Liftoff projects.
Unsafe boundary markers, links/junctions, hard-linked declarations, special modes,
inaccessible paths and concurrent observed changes fail inspection rather than
falling back to another project.

Only package.json, pyproject.toml, requirements.txt, setup.cfg and go.mod outside
control/state/output trees are read, for static dependency-name extraction.
Executable setup.py, application source, locks, workflows, native agent files,
CI, infrastructure and documentation are metadata observations only. Credential,
state, installed-dependency and output exclusions are not read or traversed.
These exclusions are intentionally distinct from repair's editable-file scope:
infrastructure and agent presence can be observed without granting their payloads
to an application repair recipe.

Limits are 512 files, 256 directories, 256 entries per directory, 4,096 total
entries including exclusions and enumerated nested-boundary directories,
depth 12, 1,024 relative path bytes,
1 MiB per declaration, 8 MiB combined declaration bytes and 2,048 extracted
names per declaration. Hitting a limit records the exact unobserved scope and
sets `complete: false`. Metadata traversal stops at the first limit; later
unvisited scopes are not evidence of absence. An unenumerated root marker is
`not-observed`, not absent. The remaining overall entry budget is passed into
directory enumeration, not checked after an unbounded collection.
Malformed dependency metadata also remains explicit. A complete inventory means
only that this bounded observation scope completed. It does not establish active
bindings, installed/resolved versions, reference coverage, syntax correctness,
runtime behavior, conformance, cloud proof, provenance or mutation authority.

Inventory digests are deterministic local observations, not approvals or
activation evidence. Unread payload changes are outside their revalidation
scope. No project script, package-manager/Git/framework command, network,
telemetry/disclosure, consent, receipt or project write is performed.
Run the focused inventory/repair/import tests with:

```bash
npx vitest run tests/project-assessment-inventory.test.ts tests/repair-application.test.ts tests/import-boundaries.test.ts --maxWorkers=2
```

The public producer separately validates the nearest safe Liftoff/Git boundary,
or one explicitly selected non-Git root. Discovery observations are retained
and revalidated; malformed or unsafe inner metadata never selects an outer
project. An advisory comparison profile preserves the recorded manifest and
uses the installed policy and plugin/layout contracts, not registry latest.
Historical manifests stay historical; their generation paths never become
current bindings. Exact v8 managed bytes come from `buildModernManagedCore`.
Only the manifest and finite renderer-declared managed files are read beyond
the inventory's dependency declarations. Parent directories receive bounded
metadata inspection; this does not grant neighboring-file access. Release-owned
managed metadata under `.liftoff` can be compared separately, but activation
state, evidence, credentials and other excluded payloads are not opened.

The independent schema-1 whole-project report lives in
`src/domain/assessment/report.ts`; do not reuse the narrower governance report's
target or proof scope. Findings retain observed absence, actual differences,
unknown applicability and unsupported proof. Two bounded inventory passes and
exact metadata/file revalidation fence observed drift. Unread payload changes
remain unobserved. Current production reports remain partial because runtime
constraints, reference compatibility, agent behavior, effective governance and
deployment proof are not evaluated. Local matches are not full compliance.
`application/assessment/live-report.ts` composes explicit live reports without
duplicating the existing domain assembler. The bounded effect adapter is
`adapters/assessment/live.ts`, reusing the existing scoped collector and Git
inspection. Neutralized ambient Git selectors/configuration, bounded process
results and verified credential-free origin/push bindings fence local metadata.
Only the exact repository's GitHub metadata, applicable ref families, declared
current environments and fixed GitHub Actions app metadata are requested.
There is no account/runner/Azure discovery or credential enrollment.
Provider availability, values, facts and first-class source location/time/digest
remain independent from unsupported current-profile evaluation. Local JSON,
classification and digest assembly stay unchanged. An observed provider value
does not become conformance or activation proof.
Two complete local reports, manifest revalidation and final Git reads detect
observed drift, not atomic confinement. Failures retain actual provider-dispatch
attribution; they cannot claim no access after collection. Git overflow, abort,
signal and unsettled results with a zero exit are unobserved, not passes.
All assessment/help paths bypass disclosure and every telemetry hook.
Recommendations identify only real preview routes and their separate consent;
their argument arrays bind the selected project rather than the caller's cwd.
Non-Liftoff projects may receive the read-only adoption preview. Unavailable
workflow/profile/plugin transitions, provider activation and deployed-state
work have no executable recommendation.

```bash
npx vitest run tests/project-assessment-report.test.ts tests/project-assessment-engine.test.ts tests/project-assessment-command.test.ts tests/project-assessment-live.test.ts --maxWorkers=1
```

## Release integrity requirements

`scripts/native-bundle.mjs` and its bounded inventory contract build a separate
[runtime-inclusive development artifact](docs/native-development-bundles.md).
Reuse the existing packaged-asset inventory and locked production dependencies;
do not copy Homebrew Node and infer that its external dylibs are bundled.
The launcher keeps private Node off `PATH`, so workload readiness cannot inherit
it as an external tool. Development manifests remain unsigned local consistency
records, with explicit false release/installer/OS-floor qualification fields.
Pinned HCL notices preserve its embedded module inventory and its upstream
modified-source disclosure; they are not a reproducible-build attestation.

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
| Concrete phase handlers and persistence | `src/governance-activation/seed-lifecycle.ts`, `src/governance-activation/phase-publication.ts`, `src/governance-activation/github-discovery.ts`, `src/governance-activation/azure-discovery.ts`, `src/governance-activation/phase-governance.ts`, `src/governance-activation/phase-bootstrap-state.ts`, `src/governance-activation/transition-records.ts` |
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
`parseProjectManifest` / `loadProjectManifest` dispatch supported source families
2-8 to their existing independent readers; `parseManifest` / `loadManifest` and
their historical version list remain limited to 2-7 for source-history callers.
Unknown versions are refused without downgrade or inner-family interpretation.
Public `liftoff validate` now accepts v8 source: it checks actual managed
core/control/history consistency through the guarded installed inspector, then
checks recorded initialized framework markers. Manual's `not-required` framework
does not trigger a framework check. These are read-only source checks, not local
execution, approval, current workload verification or permission to write.
`governance status`, `resume`, and `verify` dispatch modern records before
historical activation-input or preview reads. Their schema-3 report separates
bounded installed-source consistency, stored phases and independently
reconstructed local completion. Successor proof requires an explicit
`--revalidation-publication` fingerprint; the observer never discovers one from
matching installed bytes. Exact original execution, publication consent,
committed progress, source preservation and tool identity are checked by the
existing native/publication inspectors, without executing or recovering work.
An interrupted local transaction remains visible with its actual commit bit and
identifiers. Inspection failure leaves completion indeterminate rather than
inventing a successful or absent receipt. Historical schema-2 output and
execution remain separate; the capability catalog distinguishes the specific
modern read-only routes from explicit modern local verification. Manifest-selection failures retain the historical
verification failure envelope without falling through to historical execution.

Historical provenance is not reused as an active filesystem layout. Public v8
writers/update routing remain gated until the remaining consumers are integrated.
The v8 `dev` / `infra` helpers print commands from explicit active bindings only,
after control/history and path inspection. Compose uses the bound file's directory;
OpenTofu uses the selected bound environment and, for plan/apply, its bound variables
file. Missing bindings, links, nested project/repository boundaries, unselected
environments and preserved state/key overlap stop command emission rather than
falling back to old generated paths. Bound-directory observation uses the existing
256-entry local input limit and fails explicitly if it cannot finish.
Printing a command does not execute it, approve its effects or guarantee future
path identity; developer review and any operation-specific permissions still apply.
V8 doctor uses the same source reader and bounded local input capture rather than
the historical graph, default `backend` paths or project configuration commands.
It reports unresolved bindings and actual capture failures, and explicitly
separates observed source inventory from unexecuted native verification. Manual
workstation selection has no external framework contract or fallback to Spec Kit;
selected workload and agent requirements still apply. The npm CLI's Node runtime
requirement is unchanged; this is not native-bundle qualification.
`createManifestV8Candidate` provides an independent origin-aware candidate writer
with closed `fresh`, `adoption`, `historical-successor` and `maintenance` inputs. Fresh
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
The private `adoption` origin accepts explicit selection, bound layout, exact
managed-byte decisions and imported `adoptionObservations`. Every bound artifact
requires one observation at the exact active path; unbound observations,
unresolved layouts, retain/retire decisions and legacy framework claims are
rejected. Observations are sorted by logical identity without changing supplied
hashes or paths. Imported files acquire no `projectArtifacts`, generation hashes
or source/activation history. Later maintenance preserves these observations and
bindings rather than treating current templates as the original application.
Own-data copying rejects accessors and proxies before invoking their hooks.
These candidate inputs still require independently captured bytes/modes,
compatible application checks, authenticated external transaction ownership and
separate approval before publication. This private writer does not register
`liftoff adopt`, create a manifest on disk or establish deployment absence.
`application/adoption/inventory.ts` adds private manifest-free observation of one
explicit canonical nonlink root and an independently validated installed source
selection/layout. It refuses existing or aliased Liftoff control/transaction
boundaries instead of reading them or selecting an outer project. The shared
bound application-target interpreter uses registered declarations, not starter
rendering or a fabricated manifest. It preserves existing repair's separate
historical infrastructure exclusions.
The inventory captures bounded actual bytes/modes and literal reference
locations, keeps private snapshots out of JSON, and derives observations only
for exact bound readable files. Missing/excluded bindings and unmapped files
remain explicit. Compatibility is `not-verified` and deployment is
`planning-only`; no consent, staging, check execution, adoption publication or
new public capability follows from this observation.
`application/adoption/candidate.ts` connects those actual bounded observations
to the separate imported candidate writer using a validated source copy taken
before asynchronous root reads. Missing bound files produce explicit blocked
results without constructing a comparison manifest. Complete observations
produce only an unverified private candidate; managed source hashes describe
proposed content, not observed destinations or authorized effects. Original
bytes/modes remain unchanged and candidate bytes/snapshots are excluded from JSON.
The report retains compatibility/deployment limits and names the outstanding
semantic, core-destination, integration, permission, ownership, staged-check and
lock/recovery obligations. This is not a saved preview, consent or public adopt
approval capability, and it does not publish metadata or prepare/execute project
code. The later public command may serialize this report only as bounded
discovery.
The shared modern own-data boundary rejects root, nested, array and revoked
proxies before reflection; legitimate plain JSON record bytes and identities
are unchanged. Source observation cannot execute a proxy hook as validation.
`application/adoption/preview.ts` gives these actual observations their own
schema-1 review contract, current CLI identity, complete fingerprints and
15-minute validity interval. Its optional user-local `adoption-preview` record
is separate from update/repair previews and approval stores. Revalidation
repeats the real bounded inspection and compares the exact captured source,
inventory, proposed managed source and candidate. Changed included bytes,
modes, entries, bindings or source identity invalidate the review.
Saved and successfully re-observed comparisons remain unverified and grant no
preparation, project-code, network, file-write or recovery authority. Excluded
payloads and dynamic references remain unobserved, not silently verified;
source hashes still do not observe managed-core destinations. There is no
approval or execution capability from this private contract.
The inherited inventory eligibility remains governance `none` or
`single-maintainer-gitflow`; a valid team-profile metadata identity does not
enable team adoption or repair before its distinct implementation qualifies.
`application/adoption/destination-plan.ts` revalidates that review and reads
each finite proposed managed-core/manifest destination with single-link,
case/Unicode-collision, regular-file and size checks. Absent destinations are
private proposed writes; byte-identical existing files remain explicitly
`matching-unowned`; any different unowned destination blocks the entire write
inventory. The plan fingerprint also binds all included application and
destination snapshots, but those private bytes/preconditions stay out of JSON.
The manifest-free application remains untouched and the plan is only
`ready-for-independent-verification`: it requests no approval and exposes no
transaction candidate. Preparation, project-code execution, declared network
and a later distinct file-transaction permission remain independent.
Only a freshly re-observed ready report can be stored in the private
`adoption-destination-plan` namespace. Loading requires its same saved adoption
review and rebuilds the private effects/preconditions from current project
bytes; saved metadata never supplies old transaction bytes, verification or
consent.
`application/adoption/compatibility-plan.ts` consumes that saved current
destination identity plus an explicit schema-1 application review. Every
bounded file needs its exact digest/mode, current-path or move decision and
active-binding/custom identity; every observed literal reference needs an
unchanged or update disposition. Missing files/references, unresolved scope,
dynamic-reference review gaps, moves or reference updates remain blocked.
Compatible current paths can become only
`ready-for-independent-verification-staging`, with exact bounded check and
optional preparation declarations. This status performs no preparation,
project-code or network effect and still reports compatibility as
`not-verified`. Moves require a later external staged-patch contract; private
source bytes remain non-serializable. The plan has no file approval,
transaction, binding-publication, recovery, deployment or public-command
authority.
Only a current ready report can be stored in the private
`adoption-compatibility-plan` namespace. Loading requires the same saved
adoption review and destination plan, then rebuilds the review and private
source snapshots from current project/source bytes before accepting the exact
stored report. Saved compatibility metadata supplies no preparation,
project-code, network, verification, approval, transaction, recovery,
deployment, binding-publication or public-command authority.
`application/adoption/verification-plan.ts` reloads that saved compatibility
identity, re-observes the same private source snapshots, resolves registered
preparation inputs and exact installed tool identities, and repeats current
input/tool checks before saving a private verification-plan report. Tool
metadata probes require proven process settlement, but no candidate preparation
or project check runs. The stored report contains only digests and declared
permissions, not source bytes, executable paths or the private resolved policy.
Its ready status requests later independent dependency-preparation,
project-code and declared-network permission as applicable; it is not
compatibility success, file approval, transaction/recovery authority,
active-binding publication, deployment permission or a public command.
`application/adoption/verification-consent.ts` records only an exact,
same-plan, expiring grant for the displayed dependency-preparation,
project-code and declared-network scopes. Missing required scope and unused
extra scope are both rejected. Consent reloads the current verification plan
and adoption review before use; it does not run a command or assert check
success, compatibility, file approval, transaction/recovery authority,
publication or deployment.
`application/adoption/public-command.ts` and `cli/commands/adopt.ts` expose the
separate schema-1 public discovery coordinator. It resolves the nearest exact
Git/Liftoff boundary unless a non-Git root is explicitly selected, routes an
existing manifest to update/repair, derives an installed target selection from
the ordinary project flags, saves only current review/destination records
outside the repository, and preserves all candidate/destination blockers.
Bare JSON and non-TTY use remain preview-only. Exact approval and recovery
syntax is registered but fails before project/receipt access until later tasks
produce a complete public plan and authenticated transaction. Do not bridge
that boundary by treating a private plan/consent/result fingerprint as the
public file-plan identity.
`createAdoptionVerificationWorkspace` allocates the later executor a distinct
authenticated `liftoff-adoption-verification-workspace` record with the current
CLI and adoption-verification contract identity. It reuses the repair
workspace's fixed private roles, owner settlement, bounded activity inventory,
identity-pinned cleanup and recovery machinery without accepting a repair
identity or changing existing repair records. Exact project-code,
dependency-preparation, network and lifecycle scopes are checked before an
operation callback runs. The workspace is disposable execution confinement,
not a sandbox, consent record, successful verification result, file approval
or transaction authority; this constructor alone runs no adoption checks.
`executeAdoptionVerification` reloads the exact current plan and consent,
re-observes compatibility inputs and installed tool file identities before
each effect, copies bounded source snapshots into that workspace, and runs only
the resolved registered preparation and check commands. An authenticated
compare-and-exchange claim admits only one attempt for the exact plan; a
concurrent or later caller never dispatches the commands again. Every process
requires process-tree settlement; uncertain scope is retained rather than
cleaned or reported as success. A non-authoritative verified draft is saved
before owner release and cleanup. If final receipt storage is interrupted, a
later caller may only finish identity-pinned workspace/staging cleanup and seal
that exact draft; it cannot rerun checks or invent success from elapsed time,
PID state or an incomplete workspace. A passed result is persisted only after
every declared check passes, protected inputs remain current, the owner is
released and authenticated cleanup completes. Its receipt is HMAC-bound to the
settled `verified` adoption workspace record and is revalidated against current
plan, consent, source, destination and tool identities on read. Failed,
expired, changed or uncertain work stores no success receipt. Even a current
receipt is only declared-check compatibility evidence: file approval,
transaction, recovery, active-binding publication and deployment remain
unauthorized.
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
private APIs for same-workflow, single-maintainer activation-v1/v2/v3 sources
and manifest-only v2-v7 sources with no activation. They do not enable a public
CLI target. Safe transaction-presence checks precede source interpretation.
Reconciliation consumes the captured file/absence observations rather than
classifying one filesystem read and approving another. Normal and force remain
distinct; force never grants ownership of an unowned destination.

The manifest-only path requires observed absence of state, migration journal,
credential-policy and baseline records and empty active record collections.
Presence is checked without reading rejected control-file contents; malformed
or orphaned records cannot be reclassified as an unstarted activation.
Complete collection enumeration is bounded to 1024 entries, including non-JSON
members, rather than silently omitting an unread suffix. Active collections are
checked again after capture and immediately before the final manifest write.
The existing standalone history collector and
`prepareManifestSchemaSuccessor` preserve original
manifest bytes and recorded mode, retain legacy framework uncertainty and
project provenance, and reject a workflow/profile/agent/project switch.
The shared prepared-preview and sealed-transaction path publishes the history
copy and index before core and manifest changes. It creates no activation state,
migration journal, execution evidence or telemetry identifier. An explicit
no-activation source has no repository anchor to inherit; its new preparation
anchor remains user-local and is not written into the manifest.

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
precede managed-core replacement and the final manifest write; original bytes
are checked before replacement. Activation successors additionally retire exact
old proof and publish pending state4/journal2; manifest-only successors do not.
Recovery binds the observed fingerprint and transaction digest under lock, uses
existing transaction seals and does not start another successor. A stopped
process's stale lock still requires explicit ownership review; the publisher
does not automatically reap locks.
Postcommit cleanup failure reports the committed successor rather than
downgrading it. Successful publication returns `committed-incomplete`: local
revalidation remains separately reviewed work, not inherited historical proof.

The same private APIs support current-v8 metadata with observed absence of
activation under `core-manifest-maintenance-only`. The shared managed-core
input resolver normalizes valid project/plugin/layout values before comparison;
reordered compatible bindings are not a layout change. Preserved standalone
history is independently read using the same reader as installed preflight.
Maintenance preserves project provenance, adoption observations, plugin
identity and layout; it creates no new history snapshot or activation records.
Only required core writes and semantically changed manifest metadata enter
the transaction. A current manifest's original formatting is not rewritten.

No-op apply reports `current` without a prompt, audit or project write.
Approved maintenance reports `committed`, with the usual distinct committed
cleanup-failure outcome. `not-required-no-activation` describes the lack of
activation revalidation for this scoped operation, not application readiness
or successful deployment. Active record collections are rechecked before each
maintenance mutation and before commit; fixed source/history preconditions retain the existing
transaction checks.

Active v8 projects use the separate `active-core-manifest-maintenance-only` scope.
`inspectModernMaintenanceSource` validates actual active/history relationships
while allowing captured managed-core drift; it returns source data, not installed
execution readiness. The strict installed preflight continues to require exact
current core. Reviewed maintenance protects existing record bytes and rechecks
the captured JSON collection membership before every mutation and commit.
Reserved transaction journals are checked at admission, not supplied as ordinary
data preconditions. The update codec owns its journal's absence-to-present
transition; competing repair/local-verification journals must remain absent
during maintenance.

Before the first metadata-changing maintenance of an activation-history
successor, the transaction preserves the actual original target manifest under
`.liftoff/activation-target-history/<reference-digest>/manifest.json`. The strict
optional `activationTargetHistory` reference binds its raw digest, length and
mode; the complete reference determines the reserved path. Exact existing
material can be reused, never overwritten. Later reads check the actual copy,
unchanged project/framework/profile/plugin/layout/provenance intent, and the
original journal2 transition against those bytes. The original transition,
preparation, successor anchor, source history and proof remain unchanged.
No-op/core-only maintenance creates no copy, and fresh active projects acquire
no invented migration history. An existing reference is preserved, not chained.

Active maintenance reports `committed-incomplete` with separately required
revalidation; preservation is neither proof nor permission to execute.
Public update uses the recorded-project-intent selector for all four lanes.
`modern-update-selection.ts` captures the actual manifest and optional
`liftoff.config.json`, reuses data-only configuration validation, and preserves
recorded plugin/layout selection. Missing configuration is an observed absence,
not a generated file. Manual/team/empty-agent parsing is isolated from the
unchanged historical configuration loader. Unsupported configured transitions
are refused; legacy framework agent requests are explicitly deferred.
The config observation joins review preconditions without replacing original
source-history binding. Apply resolves it again under transaction validation.
The public selector cannot enter private compatibility callers' implicit
recovery branch, including when a journal appears after the command's first
inspection. `recoverModernSuccessorUpdate` selects the exact fingerprint and
observed transaction digest before reading any manifest/configuration data.
Its result is recovery progress, not completion of a fresh update.
An observed commit remains reported if locked recovery is refused or throws;
uncertain effects do not become a false rollback claim.
Public reports use schema 4 and distinguish requested execution, known commit,
uncertain effects, scoped completion and separately required local verification.
Finite revalidation of an
independently admitted existing successor has its separate public interface below.

Historical catalog, v2-v7 readers, v7 writer, activation-v3 and policy-6 behavior
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
`assets/skills/setup.md`, `governance-assessment.md`, `repair.md` and the independent
whole-project `assessment.md`. The packaged
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

The reviewed security refresh pins urllib3 2.8.0 in both Python locks and PyJWT
2.15.1 in GenAI and its reproduced Functions export. Node uses Fastify 5.12.5,
root fast-uri 3.1.8 and npm's compatible nested fast-uri 4.2.1. Regenerate locks
with their package managers, canonicalize official PyPI artifacts, reproduce the
Functions export, synchronize supported-stack metadata, and advance changed
stack content versions and literal release hashes together. The unchanged
drizzle-kit loader now uses an exact, `@esbuild-kit/core-utils`-scoped esbuild
0.25.12 override; it does not globally replace other esbuild releases. The
corresponding development-server exception is removed after an actual npm audit,
and its advisory is tracked as resolved for the Node backend. Standard generated
Node qualification additionally runs Drizzle generation and journal checks under
each supported npm version. An audit is a dated observation, not a permanent
claim of zero vulnerabilities.
CI generates projects on supported Node.js 24.20, then runs their dependency,
build, test and Drizzle metadata commands on the captured native Node/npm pair
(22.12.0/10.9.4 or 24.20.0/12.0.2). The schema-2 report records both actual
runtime versions and exact command argv; an older generated-project compatibility
lane does not qualify execution of Liftoff itself on Node 22.
The npm audit does not cover PyPI. The generated Python integration case runs
`tests/fixtures/pyjwt-options-regression.py` against the installed frozen GenAI
environment: unsigned decoding must not mutate reused options or disable
subsequent verified expiration checks in either decode API.

`plugins/builtin/modern-historical-release.ts` preserves the exact metadata-only
pre-refresh v8 family from revision `289e7033`; `modern-previous-release.ts`
additively records the accepted post-security-refresh family from `77762b75`.
`modern-pre-assessment.ts` additionally freezes the actual declarations, release,
selection space and operation inventory captured before whole-project guidance.
The real generic registry reconstructs that family from bounded, verified assets;
`tests/fixtures/pre-assessment-guidance-source.json` preserves genuine original
metadata, layouts and every managed body. Historical interpretation composes those
old declarations, never current declarations with old hashes. Its layout protects
only the captured old inventory, while the current family's exact assessment paths
are protected for all hosts without acquiring whole-directory ownership.
Modern source interpretation accepts complete historical families only while their declaration digest, shared assets,
selected identities and reconstructed resolution digest match. It does not
accept version ranges, mixed families or plugin IDs alone, bundle old templates,
or grant mutation authority. Ordinary maintenance preserves those recorded
identities, provenance and layout; it does not upgrade application dependencies.
Fresh generation records current identities. Project telemetry refuses to label
a readable historical selection with changed stack identity as the currently
installed template bundle. Historical snapshots and generated captures remain
immutable; exact additive reviewed rendering records account for current bytes.

Legacy activation-to-v8 publication captures the exact new assessment destination
for each already-recorded agent before planning, including physical absence.
The original immutable history index still contains only original released files.
New guidance is separately included in the approved target transaction; missing
physical observations, foreign files and concurrent changes remain blockers.

`scripts/package-smoke-contract.mjs` independently requires the 13 template
assets and thirteen core ancillary assets, including the two modern profile policies,
their canonical source-contract table and four shared skill sources. The smoke enforces exact declarations
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

The historical generation path reads all 13 declared template assets on first use
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
The retained historical plugin family's agent descriptors use content version 4 for the shared v8-aware setup
protocol, advancing the earlier capability-first version 3. The distinct modern
current source descriptors retain version 2 and their exact recorded digests; the
public guidance change does not retag an existing project's plugin identity.

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
implicitly selected or emitted. Historical fresh-project planning still requires
an agent. Current planning uses a separate development-workflow catalog with
Manual and all eight agent subsets; external workflows retain the original rules.
Malformed plain data and exceeded validation budgets fail with structured
errors. Accessors are not invoked, byte views are copied into owned memory, and
hostile proxies are outside the release-owned-data trust boundary.

Public `plan`, `init`, and `migrate` use `currentProjectGenerator` and real v8
templates. `historicalProjectGenerator` keeps v7 application entrypoints and
historical fixtures explicit; there is no dummy external framework for Manual.
Shared workload rendering preserves application bytes, while current generated
guidance and managed core use their actual source contracts. Fresh component
bindings come from exact installed declarations; runtime-excluded artifacts keep
their generation provenance without becoming readable inputs. The fresh writer
validates an explicit complete runtime layout against those declarations.
Omitting that optional layout retains its earlier artifact-only candidate
semantics; maintenance and historical-successor layout rules are unchanged.

The running runtime is observed without spawning `node --version`. Current
workstation selection adds external Node/npm only for applicable workload,
frontend, or framework operations. Manual agent prompts do not discover
unselected executables or framework markers. Source-valid generation is not
native local completion or provider authority.

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

`planClosedManualLocalInputs` is a separate **source-only** Manual planner.
It binds bounded YAML aliases, literal-default interpolation and implicit
environment lookups to explicitly absent project variables. Execution-control
names, required/nested interpolation, dotenv, credential sources and dynamic
paths remain excluded. A root build context means only the captured directory
for `compose config`; it grants neither recursive context reads nor a build.
Standalone Dockerfiles must match explicit active Dockerfile bindings.
Formatting names captured `.tf` files with `fmt -check -write=false`, never
recursive traversal through excluded tfvars. This planner does not replace
`verify-local`: provider/module preparation and validation remain blocked, and
no new execution, finalization or publication authority is registered.

`planManualNativeLocalRuntime` additionally revalidates the installed inputs and
derives a distinct Manual recipe for the qualified OpenTofu/AzureRM baseline.
It binds each environment's exact packaged lock, default provider configuration
and one captured local application module. Application validation is attributed
to those environment roots, not an invented standalone module run. Its HCL
interpretation distinguishes Terraform backend blocks from resource names and
adds only the generated pure `regex`/`urlencode` functions; historical recipes
are unchanged. Native input planning is still **not execution authority**.
The separate private `prepareModernManualNativeExecution` path emits preview6;
`approveModernManualNativeExecution` requires consent5 with independent
infrastructure-preparation and provider-distribution network scopes. Ordinary
dependency consent cannot authorize those effects. The engine rederives the
inputs and tools, checks consent before allocation, initializes only locked
environment roots, and captures immutable owned provider/module output before
dependent validation. Result5 carries that proof through completed-record
readback. Existing preview1-5 and their consent/result contracts remain distinct.
Public `verify-manual-native` and `approve-manual-native` requests delegate to
this distinct protocol through verification report7. Completion report5 and
successor-revalidation report6 keep their existing report kinds and semantics.
Installed capabilities expose the exact native provider/host limits without
probing. Verification alone never authorizes finalization or publication.
The owned scratch path is expressed relative to the approved OpenTofu cwd to
avoid the qualified macOS provider's Unix-socket path limit without relocating
the workspace. The separate streamed file-digest reader supports bounded large
provider files; it does not widen the 32 MiB buffered snapshot limit, establish
provider ownership, or provide atomic filesystem confinement.

`createManualInfrastructureEnvironment` supplies the separate owned-control and
output-capture primitives. It admits only the selected native provider layout,
rejects unknown entries before reading their contents, streams large regular
single-link files, and rechecks ownership, modes, identities and the captured
module graph. These primitives do not dispatch initialization or supply consent.
The opt-in `LIFTOFF_MANUAL_PROVIDER_TEST_LANE=native` test lane downloads the
locked provider and validates through the real tool in a newly owned fixture.
It requires the qualified host and OpenTofu version; it performs no backend,
plan, apply or Azure credential operation. An incomplete diagnostic retains its
own fixture rather than claiming cleanup. This is primitive-level qualification,
not qualification of a public verification/finalization route.

`LIFTOFF_MANUAL_ENGINE_TEST_LANE=native` separately opts into actual generated
application dependency preparation and locked provider execution through the
private engine. It requires the qualified host/tools and independently approved
preparation/network scopes. Its completion cases exercise separate finalization
and exact-byte publication approvals; they do not authorize Azure operations.
Both network test lanes default to `off`.
Protected completion indexes use artifact3 with bounded raw-DEFLATE encoding:
the original index and its serialized wrapper each remain at most64KiB. This
avoids base64 expansion excluding full agent/frontend/environment selections.
Artifact1 target/index and artifact2 Spec Kit-original decoding remain intact;
targets are never compressed, and the decoded index still has its exact original
digest and physical/file/directory comparisons. Invalid streams, trailing data
and expansion beyond64KiB are rejected before publication. This storage encoding
does not change finalization/publication approvals or their policy digests.
`tests/modern-manual-public.test.ts` uses the engine opt-in for actual public
request/approval/execution, independent finalization/publication, and current
inspection with no-agent/none and all-agent/single-maintainer selections.
`tests/modern-manual-records.test.ts` supplies explicitly synthetic wire-codec
coverage, not native proof. Control tests prevent project/network dispatch while
checking actual owned-control changes and preserve unknown settlement.
Current Python and GenAI health-test templates provide explicit local settings
through a pytest fixture before importing the app. They do not need a developer
`.env`, database, Redis service or cloud credential. Historical template bytes
and runtime configuration behavior are unchanged. Current GenAI tracing and
orchestration unit tests additionally isolate known settings environment names,
the dotenv lookup and the cached getter for each test. The real settings
validator still runs; explicit model/tracing configuration errors are tested
without requiring unrelated database/Redis configuration.

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
application execution path. Preparation reconstructs the installed/source preflight,
the complete selected check set and actual tool identities. Its compact preview
binds raw and physical inputs, recipes, output roles, dependency preparation,
issuance/expiry and, for governed projects, a genuine pre-execution plan3.
Governance-none does not invent an activation plan or identity.

The public adapter `cli/commands/governance-local.ts` exposes these engines only
through `governance <plan|approve|apply-next> --scope local --local-operation verify`.
`cli/args/governance-local.ts` shares its explicit flag boundary with the parser;
`application/governance/modern-local-request.ts` decodes closed request/consent
objects. The existing bounded, no-follow public input reader is reused, retaining
historical activation decoding and errors. Input files belong outside the
captured project. Each request kind selects one engine; no fallback searches
historical, finalization, publication, or successor stores.

Schema-4 command output keeps requested effects, operation success, captured
verification, and unpublished readiness distinct. Initialized OpenSpec requires
the dedicated attestation and reports generated obligations only; successful
execution does not make `verificationComplete` true for that mode. Nonexecuting
`apply-next` observes saved progress without source-current proof. API-result
specimens in `tests/modern-local-commands.test.ts` exercise routing only.
Its separate seven-case actual-host group requires
`LIFTOFF_PUBLIC_LOCAL_TESTS=1`, actual macOS ARM64 Node 24.21.0, admitted HCL
computation, and real installed tools. It executes Manual, Spec Kit, active,
initialized and archived OpenSpec, plus missing/stale consent and actual test
failure. Framework markers are controlled contract fixtures, not claims of
official historical initialization. This group has no dependency-network or
provider operations, no public finalization, and no publication qualification.
Run the whole file when explicitly selecting that group; its case inventory is
checked. Existing native dependency preparation has its separate qualification.

Consent separately acknowledges project-code execution and its host/network
capabilities, dependency preparation and dependency network access. A private
workspace and offline flags are not a sandbox. `workflowFinalization` and
`publishLocalRecords` remain false. Registered preparation uses the same
credential-free source, private-cache and lifecycle-disabled environment as
application repair. Network access requires the exact saved preparation
descriptor and its separate affirmative consent; it does not authorize an
unrequested provider or dependency set. Subsequent checks restore all package
managers' offline settings, while arbitrary project code still has the
acknowledged host capabilities. `LocalExecutionRecordStore` binds immutable
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
preparation is separately qualified for Manual. Explicit native preparation
fixtures additionally exercise real generated Node backend and Vue dependencies
from npmjs, Go dependencies from the Go proxy, and the generated Python wheel
lock from PyPI with an explicitly confined FastAPI application. They retain
source bytes/modes, verify actual checks and readback, and distinguish missing
consent, a fresh-cache miss, stale input and a later source change after actual
preparation. Preparation does not publish local-completion records.

The genuine `[tool.pytest.ini_options].pythonpath` can use the exact literal
`".."` as the immediate selected Python component's **package search namespace**.
Its parent must already be in the captured directory inventory. This does not
add input roots, scan or copy sibling source, or expose excluded controls.
Directory membership and physical identities remain bound. Other escaping
references, including `testpaths = [".."]`, remain blocked. The interpretation
is bound into required-input closure policy revision3; earlier recipe approvals
cannot silently authorize the new semantics. Dependency permission cannot
expand that source boundary.

Explicit native cases exercise unchanged generated standard Python application
bytes, configuration and locks at project-root and nested component bindings.
They add a captured project-owned `tests/conftest.py` with two explicit test-only
loopback database/Redis settings; generated settings require those values.
No original `.env` or workstation credentials are read or injected. This is
not qualification of an unconfigured generated application.
An actual import from an uncopied sibling must fail after successful preparation,
without local-completion proof or changes to original source. The separate
confined fixture retains `pythonpath = ["."]`; it is not a substitute for these
generated-layout cases. Neither case proves arbitrary sibling imports,
whole-project runtime equivalence or GenAI worker execution.

These framework fixtures do not prove official initializer provenance or run
`specify` or `openspec init`. The preparation fixtures do not qualify Microsoft
mirror network paths, other hosts, hosted native execution, OpenSpec
finalization or provider preparation. Run the complete explicit native
preparation selection with the documented qualified host and pinned tools:

```bash
LIFTOFF_HCL_TEST_LANE=native LIFTOFF_MODERN_PREPARATION_NATIVE=1 npm test -- tests/modern-local-dependency-preparation.test.ts --maxWorkers=1 --no-file-parallelism
```

Without that explicit selection these network cases are unrun, not passing
qualification. Offline npm may legitimately create
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

#### Private archived OpenSpec revalidation

`prepareModernArchivedOpenSpecExecution(root, { kind: 'verify-openspec-archived', preparation })`
creates private preview schema5 with `archivedOpenSpecInputs`. The shared
`approveModernLocalExecution` entrypoint issues consent schema4, binding
`archivedOpenSpecInputDigest`; result schema4 retains exact current-validation
JSON and its command-output commitments. Existing schemas1-4 keep their meanings:
generic OpenSpec schema2 remains blocked and active schemas3/4 still reject
nonempty archives. This is a separate read-only protocol, not initialization or
permission to replay an inactive change.

The complete bounded capture includes configuration, all supported active changes,
all archives, main capabilities, selected integration markers and directory
membership. Exactly one matching archived bootstrap and its concrete synchronized
main capability must remain; an active bootstrap, ambiguous source, missing
artifact, unsupported member or overlapping active capability blocks admission.
Archive/main correspondence tolerates CRLF and OpenSpec's blank-line compaction
immediately after `## Purpose`, not changes to Purpose or requirement bodies.
Raw source bytes remain bound by capture and consent; formatting changes after
approval still require a fresh preview.
Configuration supports packaged `spec-driven`, text context, text-only rules for
the packaged artifacts and an optional boolean `githubCopilot.cloudAgent`.
That captured preference does not authorize cloud-agent setup or other effects.
Custom schemas, stores and external configuration references remain unsupported.
Current subjects and archives share a 64-subject ceiling; each archived task list
must contain 1-256 nonempty completed tasks. Liftoff does not rewrite their bytes;
a successful result requires unchanged original source.

After the two in-process source checks, three exact commands run in order:
`validate <capability> --type spec --strict --json --no-interactive`,
`validate --all --strict --json --no-interactive --concurrency 1`, and
`validate --archived --strict --json --no-interactive --concurrency 1`.
Only then may the applicable approved project checks run. Output validation
requires the exact workspace, complete subject sets, issue-free results and
matching totals, including an explicit zero-change total when no active change
exists. Archived task validation observes current source, not historical task
execution or original initializer provenance.

Approval, workspace admission, per-effect recapture and completed-result readback
use this same distinct input contract. The fresh empty OpenSpec home, complete
installed-tool identity, source protection, settlement, deadlines and existing
16-KiB descriptor/32-KiB JSON/64-KiB record limits are unchanged. Approved project
code retains host capabilities; this is not a sandbox.
An already-installed activation successor can use the completed native result
for private revalidation publication, with separate exact-byte approval and
independent installed readback. Original transition/preparation identities,
archived/main source and retention obligations survive unchanged. Source-only
archive recognition cannot supply that native proof.

Fresh OpenSpec synchronization/archive, deployment-state work and public v8
routing remain separate. See
[archived qualification](CONTRIBUTING.md#archived-openspec-revalidation-qualification)
for the explicit native selection and portable evidence boundary.

### Public successor revalidation

`cli/commands/governance-local-revalidation.ts` exposes the existing finite
successor engine through `--scope local --local-operation revalidate-successor`.
Closed requests in `application/update/modern-revalidation-request.ts` select
one completed verification or one saved publication review. Construction writes
external metadata only; publication needs independent approval containing only
the four private authorization fields, not the public discriminator.

`inspectModernRevalidationProgress` is selected saved inspection, not the fresh
`inspectModernSuccessorRevalidationPublication` readback. It rejects foreign
transactions before opening result authority, rejects construction-key aliases,
and keeps `recordedProgressIsCurrentProof: false`. Explicit public recovery
performs that selection check before dispatching the private recovery producer.
Exact UTF-8 target text is shared with completion review through
`application/governance/modern-publication-review.ts`; output remains credential
screened and no base64 representation bypasses the review boundary.

Schema-6 reports separate requested effects, actual commit, uncertain effects,
operation completion and current revalidation. `revalidation-incomplete` returns
exit 2 only with actual commit, independent current readback and no rollback or
cleanup failures. It records attention-required rather than success or failure
and preserves the active successor. Complete revalidation needs those same
conditions. Saved progress never establishes completion; clean explicit rollback
is recovery success only. Failure or output withholding never implies rollback.
Activation and lifecycle completion, providers, successor creation, workflow
finalization and general v8 update routing remain outside this interface.

See [public successor qualification](CONTRIBUTING.md#public-successor-revalidation-qualification)
and the [exact public request shapes](docs/cli-reference.md#modern-successor-revalidation).

### Private local completion and attributed recovery

The public adapter `cli/commands/governance-local-completion.ts` exposes this
coordinator through explicit `--scope local --local-operation finalize` and
`--local-operation publish`. Closed schema-specific requests in
`application/governance/modern-local-completion-request.ts` keep workflow
finalization consent separate from exact-byte publication consent. Only the
authorization body, not the public discriminator, reaches the closed private
publication approval API. No historical or successor authority-store fallback
is permitted.

Schema-5 command reports separate requested effects, observed commit,
uncertain effects, operation completion and current local completion.
`inspectModernLocalFinalization` and `inspectModernLocalPublication` inspect
selected saved progress with `recordedProgressIsCurrentProof: false`;
they do not replace the fresh `inspectModernLocalCompletion` reader.
Publication review exposes exact UTF-8 target text and descriptors through the
existing credential-screened output boundary. Wrong transaction attribution
blocks before reading another operation's authority. A finalization fingerprint
is not accepted as a public publication selector.

Planning, approval and execution remain separate. Publication `recover` needs
the exact selector and `--execute`; without execution it is read-only.
Successful explicit rollback is recovery success, not local readiness. Failure
or withheld output never implies that requested effects were rolled back.
See [public completion qualification](CONTRIBUTING.md#public-modern-local-completion-qualification)
and the [public request shapes](docs/cli-reference.md#modern-local-completion).
Successor revalidation uses its separate public interface above. OpenSpec
finalization, generation and general v8 writers remain separate rollout gates.

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
