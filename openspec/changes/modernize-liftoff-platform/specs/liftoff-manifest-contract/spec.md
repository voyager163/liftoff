## MODIFIED Requirements

### Requirement: V7 manifests separate managed-core authority and project provenance
The ownership separation introduced by v7 SHALL remain intact in historical readers and current v8 writers. New manifests SHALL record exact writer SemVer, deterministic workload/workflow/agent/profile identity, managed-core content hashes and separate project provenance. Current output SHALL exclude retired setup aliases and SHALL not assign managed-core hashes to desired-state, framework or seed content. V8 SHALL additionally use the explicit plugin/layout and Manual-state contracts without converting provenance into authority.

#### Scenario: Generate a v7 manifest
- **WHEN** a released v7 fixture is interpreted
- **THEN** its original ownership fields remain valid historical data without rewriting the fixture
- **AND** new generation writes v8 with the same ownership separation

#### Scenario: Managed-core hashes match written files
- **WHEN** a written managed artifact is hashed
- **THEN** its recorded content hash identifies the exact bytes

#### Scenario: Project hash records provenance only
- **WHEN** a generated project file is changed, moved or deleted
- **THEN** its generation provenance does not grant reconciliation authority

#### Scenario: External framework and seed output have no core hash
- **WHEN** framework or seed content is produced
- **THEN** it remains outside managed-core ownership

### Requirement: Manifest readers accept schemas 2 through 7
Readers SHALL continue accepting supported API/GenAI schemas 2 through 7 and SHALL additionally accept schema 8; current generation and approved schema upgrades SHALL write only v8. Unsupported versions SHALL fail before artifact access with found/supported/remedy information. Legacy normalization SHALL use explicit lifecycle declarations, preserve uncertainty and generation hashes, and grant no ownership to unknown entries. Exact retired setup aliases remain readable only through their declared bridge; wrong names/categories/paths remain invalid. Recognized retired workloads SHALL fail before deeper interpretation.

#### Scenario: Read a current manifest
- **WHEN** a valid v8 manifest is read
- **THEN** workflow, plugins, layout, profile, ownership and provenance are strictly validated

#### Scenario: Read a supported v5 manifest
- **WHEN** a supported v5 project is inspected
- **THEN** its selections and generation hashes are preserved and only explicit core identities gain core interpretation

#### Scenario: Read a supported v4 manifest
- **WHEN** a supported v4 project is inspected
- **THEN** workload/integrations remain intact and non-core entries remain provenance

#### Scenario: Read a supported v2 or v3 manifest
- **WHEN** a legacy source is valid
- **THEN** declared historical normalization and framework uncertainty remain intact

#### Scenario: Reject an unsupported manifest version
- **WHEN** artifactVersion is outside the declared reader inventory
- **THEN** access stops with exit 1 and an explicit supported-version remedy

#### Scenario: Read exact retired setup aliases for migration
- **WHEN** an exact historical alias identity is recorded
- **THEN** it is accepted only as reviewed migration debt, not current output

#### Scenario: Reject non-exact retired alias identity
- **WHEN** an old alias has the wrong name, path, category or provenance placement
- **THEN** loading fails before mutation

#### Scenario: Retired workload manifest is rejected at the boundary
- **WHEN** a manifest identifies Power Apps
- **THEN** it is rejected without deeper access or generic-Git fallback

### Requirement: Manifest migration releases broad legacy ownership atomically
A reviewed update from a supported v2-v7 source SHALL atomically write the current ownership-aware v8 manifest while preserving original source metadata and project provenance. Only exact current core identities retain reconciliation authority. Existing broad non-core ownership becomes provenance without restoring modified/absent project files. Exact clean retired aliases can be removed only under their existing reviewed retirement rules. New plugin/layout fields SHALL not be invented from path resemblance.

#### Scenario: Rewrite a v5 production project
- **WHEN** an approved source-to-v8 metadata migration commits
- **THEN** source, container, database, environment, documentation and infrastructure entries remain project provenance and their files remain unchanged

#### Scenario: Manifest transaction fails
- **WHEN** the approved manifest/history transaction cannot commit
- **THEN** it reports bounded recovery without claiming migration success or altering unowned files

#### Scenario: Older CLI reads v7
- **WHEN** a historical reader encounters a version beyond its declared support, including a v8 target
- **THEN** it must reject rather than fall back to broader legacy ownership

### Requirement: V5 through V7 manifests distinguish governance handoff from enforcement
Historical v5-v7 and current v8 manifests SHALL distinguish generated/partial handoff from live enforcement. Enabled profiles SHALL record the exact selected profile/policy and only owned written/adopted managed artifacts; unowned conflicts remain omitted and visible. Current v8 SHALL support single-maintainer and team profiles and zero selected agents under Manual. Disabled governance SHALL record none without a policy version or governance-specific handoff, while independently selected repair/whole-project-assessment integrations retain their own exact ownership. Observations and historical receipts SHALL not become managed core or prove live enforcement.

#### Scenario: Record enabled governance
- **WHEN** either enabled profile has a complete owned handoff
- **THEN** the manifest records that exact profile/policy and handoff-generated, not active enforcement

#### Scenario: Record partial governance adoption
- **WHEN** unrecorded handoff destinations contain differing bytes
- **THEN** the manifest omits those destinations and records handoff-partial until a later reviewed resolution

#### Scenario: Record protected retired alias
- **WHEN** an exact retired alias is modified
- **THEN** existing normal/forced reviewed retirement rules remain intact without directory-wide ownership

#### Scenario: Record disabled governance
- **WHEN** governance none is selected
- **THEN** no policy/setup/governance-assessment authority is recorded merely to enable independent local tools

#### Scenario: Host GitHub state differs
- **WHEN** identical plans are rendered against different or unavailable live GitHub state
- **THEN** deterministic manifest bytes do not incorporate that observation

#### Scenario: Upgrade an older managed inventory
- **WHEN** supported old metadata lacks a current integration
- **THEN** it becomes collision-safe reviewed additive drift rather than inferred installation or ownership

#### Scenario: Assessment destination is unowned and modified
- **WHEN** an applicable integration path contains unowned different bytes
- **THEN** force cannot acquire it or overwrite it

### Requirement: CLI outputs follow shared exit-code and JSON conventions
Commands SHALL preserve documented per-command scopes and use versioned JSON. Governance schema 2 SHALL distinguish consistency from completion: complete is exit 0, consistent-incomplete is exit 2, inspection/integrity failure is exit 1; status/plan/resume inspection can succeed with incomplete work. Update retains schema 3 and repair retains its current schema 2 unless their structures change incompatibly. New capabilities/assessment/adoption/workflow results use schema 1 and owner-aware upgrade uses schema 2. Changed representations SHALL advance their own schemas rather than silently reinterpret historical output.

#### Scenario: JSON output is versioned
- **WHEN** a command emits JSON
- **THEN** it includes its numeric schemaVersion and one uncontaminated result

#### Scenario: Exit codes are consistent across commands
- **WHEN** a scoped operation completes or remains partial
- **THEN** its documented result/exit classification distinguishes expected attention from execution failure and full completion

#### Scenario: A committed update still needs revalidation
- **WHEN** metadata commits but current proof remains incomplete
- **THEN** update returns exit 2 with both outcomes visible

#### Scenario: Governance output changes next-phase semantics
- **WHEN** apply-next executes
- **THEN** attempted/executed phase and freshly observed next readiness remain separate

#### Scenario: Repair has committed but local verification is blocked
- **WHEN** repair has persisted effects but incomplete follow-up
- **THEN** its current report schema identifies those effects and returns partial rather than silently restoring history

### Requirement: Activation identity changes are committed with their migration history
A supported modernization successor SHALL preserve original manifests and exact activation records before atomically publishing the compatible v8 manifest, active successor and linked migration record. Identity migration SHALL not overwrite project source, turn history into current proof, or authorize cloud/OpenTofu-state movement. Already compatible same-contract maintenance SHALL not create unnecessary successor history.

Metadata-changing maintenance of an activation-history successor SHALL preserve its actual original target manifest before replacement, with a strict optional `activationTargetHistory` reference binding the raw digest, byte count and mode to a deterministic path in the reserved `.liftoff/activation-target-history` namespace. The reference and copy SHALL preserve the original transition relationship, not create a migration or grant execution authority. Fresh projects, no-op maintenance and core-only maintenance SHALL NOT manufacture this history.

#### Scenario: Active successor metadata changes without changing its execution contract
- **WHEN** exact reviewed maintenance changes a successor manifest's permitted metadata
- **THEN** original target bytes and mode are preserved before replacement
- **AND** the current manifest links to that original while the migration transition, preparation, source history and active proof remain unchanged

#### Scenario: Original target preservation is damaged or contradictory
- **WHEN** a declared original target copy is missing, changed, unsafe or belongs to different immutable project intent
- **THEN** maintenance and installed interpretation reject it rather than derive original bytes from a journal or approval audit

#### Scenario: A historical project is migrated
- **WHEN** an exact supported source is approved for the current successor
- **THEN** target identity and linkage agree while original source/provenance bytes remain preserved

#### Scenario: Revalidation fails after commit
- **WHEN** current proof cannot be established after commit
- **THEN** the successor remains active, blocked/resumable and linked to unchanged history

#### Scenario: Existing current v2 metadata is maintained
- **WHEN** a historical execution family receives only permitted same-contract maintenance
- **THEN** CLI SemVer alone does not retag proof or create an invented successor

#### Scenario: Historical source metadata is not an execution target
- **WHEN** a history reference is followed
- **THEN** it remains historical data and cannot become the active boundary

### Requirement: Manifests record project type and API stack
Readers SHALL preserve supported v4-v7 discriminated workload identity and current writers SHALL emit v8 with the same supported genai/standard meanings. GenAI records Python/FastAPI, pattern and applicable cloud/frontend/environments; standard records its approved API stack without a GenAI pattern. Missing/inapplicable fields and retired Power Apps remain rejected.

#### Scenario: Record a standard project
- **WHEN** a standard Node project is generated
- **THEN** v8 records standard/node-fastify without a GenAI pattern

#### Scenario: Record a GenAI project
- **WHEN** a RAG project is generated
- **THEN** v8 records genai/python-fastapi/rag without inventing specialization

#### Scenario: Record a Power Apps project
- **WHEN** a retired workload is requested
- **THEN** no supported current manifest is created

#### Scenario: Reject a retired project identity
- **WHEN** desired state or manifest names Power Apps
- **THEN** rejection precedes artifact or activation interpretation

#### Scenario: Reject an invalid project identity
- **WHEN** workload fields are missing or contradictory
- **THEN** loading reports the invalid combination with no writes

### Requirement: Manifest readers normalize legacy GenAI identity
Supported v2/v3 inputs SHALL retain historical GenAI/Python and flat-standard normalization. Current approved writes SHALL use v8, preserve project bytes and provenance, and never reinterpret a retired workload or invent initialized framework state.

#### Scenario: Read an existing v2 GenAI manifest
- **WHEN** a valid v2 source records a chatbot pattern without type/stack
- **THEN** consumers interpret GenAI/Python without a manual metadata edit

#### Scenario: Read an existing v3 standard manifest
- **WHEN** valid v3 metadata records standard/go-huma
- **THEN** that workload and its actual integration state are preserved

#### Scenario: Rewrite normalized identity
- **WHEN** an approved legacy metadata update commits
- **THEN** v8 records normalized identity without changing application files

### Requirement: Legacy v2 manifests normalize framework state without false claims
Valid v2 manifests SHALL remain readable with explicit legacy framework uncertainty. A current v8 rewrite SHALL not infer officially initialized agents/frameworks or reinterpret uncertainty as Manual. Only an explicitly supported and approved workflow transition can establish Manual or a newly initialized framework.

#### Scenario: Read v2 project identity
- **WHEN** a v2 source lacks framework contract and agents
- **THEN** it remains legacy/unknown with no invented integration

#### Scenario: Rewrite v2 without fabricating agents
- **WHEN** reviewed metadata maintenance runs without framework initialization
- **THEN** legacy uncertainty and no configured agents are preserved in v8

### Requirement: Current activation identities are explicit and historical v1 state is diagnostic-only
Current execution SHALL use one release-owned exact profile/workflow-aware compatibility inventory with manifest v8, advancing activation/schema identities where semantics or representations change, and computed graph hashes. The released `0.12.0` activation family and earlier v1/v2 records SHALL remain historical declared inputs, not the mandatory target of new generation. Independent report, repair, policy and graph identities SHALL not be conflated, and unknown identities SHALL fail closed.

#### Scenario: Generate the current identity set
- **WHEN** current governance metadata is generated
- **THEN** the tuple matches actual packaged constants/profile/workflow/graph bytes without placeholders

#### Scenario: Historical v1 activation remains readable but not executable
- **WHEN** known v1 records are found
- **THEN** only their declared diagnostic/migration contract applies

#### Scenario: Managed-core maintenance does not silently rewrite historical state
- **WHEN** current tools inspect historical records
- **THEN** they preserve the original identity and require separate successor approval

#### Scenario: Historical v2 is upgraded
- **WHEN** a complete exact source is approved
- **THEN** its history survives and fresh target proof is required without recreating existing resources

### Requirement: Reviewed repair records honest current provenance without a new manifest shape
Repair SHALL retain the existing supported manifest format unless its exact approved operation includes the declared v8 successor or active-binding publication. It SHALL preserve original provenance before publishing actual repaired bindings; unchanged entries retain original producers/hashes. Local application patches SHALL not write manifests or claim generation provenance; deterministic metadata publication needs its own registered reviewed operation. Pre-existing deployment state cutover remains publicly deferred.

#### Scenario: Infrastructure active inventory changes through repair
- **WHEN** an eligible approved local infrastructure recipe commits
- **THEN** the current inventory describes actual repaired files and original records remain in history

#### Scenario: Stable tfvars identity moves to an environment root
- **WHEN** an approved repair changes its path
- **THEN** the logical identity remains stable and the prior path/hash remains historically available

#### Scenario: Project code outside the repair changes
- **WHEN** repair affects only infrastructure or integrations
- **THEN** unrelated code and provenance are not retagged

### Requirement: Codex extends agent identity without changing existing selections
Canonical agent identities and relative order SHALL remain github-copilot, claude and codex. External-framework selections remain nonempty/unique with an applicable selected Spec Kit default and real framework markers. Manual permits an empty list or any unique supported subset, with Liftoff-native integration validation only and no fabricated framework initialization.

#### Scenario: Read an existing two-agent manifest
- **WHEN** an old project selected Copilot and Claude
- **THEN** Codex is not added implicitly

#### Scenario: Record all three integrations
- **WHEN** a supported approved operation installs all three selected agents
- **THEN** each appears once in canonical order and an applicable Spec Kit default belongs to the selection

### Requirement: Artifact rendering is deterministic
Identical plans within one release SHALL render byte-identical Liftoff-owned content, including the current v8 manifest. Content SHALL not depend on host observations, time, randomness, filesystem enumeration or mutable upstream sources. Framework/plugin/profile/layout target identities SHALL come from the packaged validated catalogs. Explicit telemetry enrollment is a separate mutation outside deterministic rendering.

#### Scenario: Double render is byte-identical
- **WHEN** identical plans render with different compatible mocked host versions
- **THEN** every generated artifact has identical bytes and logical identity

#### Scenario: Framework contract remains deterministic
- **WHEN** an external framework is selected
- **THEN** its packaged tested contract is recorded rather than an observed host version
- **AND** Manual records no external framework version

#### Scenario: Packaged catalogs remain deterministic
- **WHEN** the same plan is rendered online and offline
- **THEN** catalog/plugin/profile identities and bytes remain unchanged

#### Scenario: Starter contract remains deterministic
- **WHEN** a retired Power Apps request is supplied
- **THEN** it is rejected before an upstream starter is loaded

### Requirement: Manifest v4 separates common integration identity from workload identity
The separation introduced by v4 SHALL remain readable historically and current v8 writers SHALL retain it: project/workload identity is distinct from workflow, agents, applicable external-framework default/contract and governance identity. Manual records not-required framework state and optional agents. Observed host runtime, package-manager, Docker, infrastructure-tool and agent versions SHALL not enter deterministic manifests.

#### Scenario: Record a standard project with OpenSpec and both agents
- **WHEN** current generation selects that combination
- **THEN** v8 retains separate workload/integration fields without a default-agent requirement

#### Scenario: Record a GenAI project with Spec Kit default agent
- **WHEN** Spec Kit selects both agents and Claude as default
- **THEN** v8 records that real tested integration independently of workload identity

#### Scenario: Record Power Apps with OpenSpec and both agents
- **WHEN** a retired request is supplied
- **THEN** workload rejection precedes metadata generation

#### Scenario: Record Power Apps with Spec Kit default agent
- **WHEN** a retired request includes a framework default
- **THEN** it is still rejected before initialization

#### Scenario: Host versions do not affect v4 bytes
- **WHEN** historical fixtures or current equivalent plans are interpreted under different compatible hosts
- **THEN** historical bytes are preserved and current rendered identity excludes observed host versions

### Requirement: Generic is an explicit stable GenAI pattern identity
Generic SHALL remain a stable explicit GenAI pattern in configuration, supported historical manifests, current v8 output and applicable guidance/context. Uncertainty SHALL not be represented by missing pattern identity or another pattern. Other eight pattern meanings remain unchanged.

#### Scenario: Generate a generic project manifest
- **WHEN** generic is selected
- **THEN** current configuration/manifest record it explicitly and application artifacts remain project-owned

#### Scenario: Read a generic project manifest
- **WHEN** a supported historical or v8 manifest records generic
- **THEN** strict catalog interpretation preserves that identity

#### Scenario: Reject missing GenAI pattern identity
- **WHEN** pattern is omitted from required GenAI metadata
- **THEN** validation fails instead of silently substituting generic

#### Scenario: Preserve append-only pattern identifiers
- **WHEN** catalogs or plugins are restructured
- **THEN** all nine identifiers keep their existing meanings

## ADDED Requirements

### Requirement: V8 records explicit plugin and active layout bindings
V8 SHALL identify selected bundled plugin API/content identities and validated finite active component/artifact bindings. Bindings SHALL use portable project-relative path parts and establish interpretation, not write authority. Adopted files SHALL record actual adoption observations rather than fabricated generation hashes. Historical generation paths/hashes SHALL remain distinct from approved current bindings. Invalid, overlapping, incompatible or unknown binding identities SHALL block dependent work.

#### Scenario: Preserve a compatible customized backend
- **WHEN** approved adoption establishes its supported noncanonical location
- **THEN** the active binding records that location without moving source or claiming it was generated there

#### Scenario: Binding escapes on Windows
- **WHEN** a binding contains traversal, drive/UNC parts, embedded separators or a junction/link escape
- **THEN** all supported hosts reject it before file access

### Requirement: Manual state and telemetry identity remain explicit and separate
Manual SHALL record external framework as not required rather than legacy, initialized or a dummy version. Optional agent identity remains independent. Project telemetry enrollment SHALL use its separately inventoried consented record and SHALL not add random values to deterministic template/manifest rendering or become required for project validity.

#### Scenario: Render the same Manual plan twice
- **WHEN** identical plans are rendered on different supported hosts
- **THEN** bytes and explicit no-framework identity match without telemetry UUID generation

#### Scenario: An opted-out project is validated
- **WHEN** no telemetry enrollment exists
- **THEN** validation does not require or fabricate a project reporting ID
