## REMOVED Requirements

### Requirement: V7 manifests separate managed-core authority and project provenance
**Reason**: The current writer becomes schema 8 to represent explicit profile and adoption provenance without mislabeling existing custom bytes as generated output.
**Migration**: Preserve supported v7 reads and original provenance. Use a reviewed project transaction to write v8; CLI installation alone does not rewrite projects.

### Requirement: Manifest readers accept schemas 2 through 7
**Reason**: Schema 8 is the current writer and reader contract while supported v2-v7 source contracts remain historical inputs.
**Migration**: Read historical manifests through their explicit source schemas and migrate only through an eligible reviewed transaction. Unsupported or future schemas remain errors.

### Requirement: V5 through V7 manifests distinguish governance handoff from enforcement
**Reason**: The handoff-only guarantee must cover schema 8, additional explicitly registered integrations, and truthful adopted projects while preserving supported historical semantics.
**Migration**: Retain v5-v7 handoff interpretation and exact protected migration debt. Record current handoff through the v8 contract without claiming live enforcement.

### Requirement: Reviewed repair records honest current provenance without a new manifest shape
**Reason**: Current manifest writes use schema 8, but repair contract 1 and unchanged schema-2 records do not need a new repair format.
**Migration**: Preserve original generated or adopted provenance and registered historical repair recovery. A repair needing a new manifest write must use the reviewed eligible v8 transition rather than silently retaining a current v7 writer.

## ADDED Requirements

### Requirement: V8 manifests separate managed authority and truthful provenance
The system SHALL write current `liftoff.manifest.json` documents with `artifactVersion` 8 and the exact SemVer of the manifest-writing CLI. They SHALL record explicit supported profile/component identity and distinguish generated, adopted, and subsequently repaired provenance. Managed-core entries SHALL carry `contentHash` over the exact bytes Liftoff has recorded authority to reconcile; project observations, generation hashes, adoption baselines, and repair history SHALL NOT grant that authority. Newly generated current inventories SHALL exclude retired setup aliases. Desired-state, framework-owned, and seed output SHALL remain outside managed-core hashes.

#### Scenario: Generate a v8 manifest
- **WHEN** a developer initializes a supported project with `liftoff init`
- **THEN** the generated manifest declares `artifactVersion` 8 and the exact writer
- **AND** it separates managed-core entries, profile/component identity, and actual project generation provenance

#### Scenario: Managed-core hashes match written files
- **WHEN** a managed-core artifact is hashed with SHA-256
- **THEN** the result equals the hex portion of that artifact's manifest `contentHash`

#### Scenario: Project hash records provenance only
- **WHEN** a project artifact is genuinely generated
- **THEN** its manifest entry records the generating Liftoff version and generation hash
- **AND** changing, relocating, or deleting that file does not grant Liftoff reconciliation authority

#### Scenario: External framework and seed output have no core hash
- **WHEN** an official framework initializer or one-time Liftoff seed creates a file
- **THEN** the manifest does not present that file as a managed-core artifact

#### Scenario: Existing custom bytes are adopted
- **WHEN** an approved in-place adoption records pre-existing project files
- **THEN** it records actual observation and adoption provenance linked to the schema-1 adoption record
- **AND** it invents neither a historical generating version nor a template-generation hash for those bytes

### Requirement: Manifest readers accept schemas 2 through 8
The system SHALL read supported manifest schemas 2, 3, 4, 5, 6, 7, and 8, SHALL write new current manifests only as schema 8, and SHALL reject other `artifactVersion` values with the found version, supported versions, and remedy. Historical v2-v7 readers SHALL retain their exact supported standard/GenAI and framework semantics; v8 SHALL additionally validate the declared supported adopted-profile and provenance forms. Legacy lifecycle normalization SHALL not make unknown durable entries managed core. Exact retired setup-alias identities SHALL load only through the declared migration-debt bridge, never as new generation output. A retired workload discriminator SHALL be rejected before deeper artifact, activation, or live-setting interpretation.

#### Scenario: Read a current manifest
- **WHEN** a CLI command reads a valid manifest whose `artifactVersion` is 8
- **THEN** it validates applicable workload or adopted-profile, component, framework, agent, governance, managed-core, and provenance identity
- **AND** the current generated inventory contains no retired setup-alias identities

#### Scenario: Read a supported v7 manifest
- **WHEN** a CLI command reads a supported v7 manifest
- **THEN** it preserves its managed-core authority, recorded project provenance, selected agents, and exact historical activation identity
- **AND** reading alone performs no schema upgrade or profile/proof fabrication

#### Scenario: Read a supported v6 manifest
- **WHEN** a CLI command reads a supported v6 manifest
- **THEN** it applies the registered v6 source contract and explicit lifecycle declarations
- **AND** existing hashes and uncertain historical facts remain truthful rather than being retagged as v8 observations

#### Scenario: Read a supported v5 manifest
- **WHEN** a CLI command reads a valid v5 manifest
- **THEN** it preserves workload, framework, agent, governance, and recorded generation hashes
- **AND** normalizes only explicitly declared core logical names as managed core

#### Scenario: Read a supported v4 manifest
- **WHEN** a CLI command reads a valid v4 standard or GenAI manifest
- **THEN** it preserves the v4 workload, framework, and agent declarations
- **AND** defaults unknown or non-core durable entries to project provenance

#### Scenario: Read a supported v2 or v3 manifest
- **WHEN** a CLI command reads a valid legacy manifest
- **THEN** it preserves the existing workload normalization and framework uncertainty contracts
- **AND** defaults unknown or non-core durable entries to project provenance

#### Scenario: Reject an unsupported manifest version
- **WHEN** a CLI command reads a manifest whose `artifactVersion` is not 2, 3, 4, 5, 6, 7, or 8
- **THEN** it exits 1 before artifact access
- **AND** states the found and supported versions and corrective action

#### Scenario: Read exact retired setup aliases for migration
- **WHEN** a supported source records an exact retired setup-alias logical name with its retired governance category and path
- **THEN** the reader accepts it only as declared migration debt
- **AND** successful eligible update removes it according to the protected-conflict and separately approved force rules, not as a newly supported integration

#### Scenario: Reject non-exact retired alias identity
- **WHEN** a supported manifest records a retired setup-alias logical name under the wrong path, wrong category, project-artifact placement, or an unknown old launcher name
- **THEN** manifest loading fails before update can mutate files

#### Scenario: Retired workload manifest is rejected at the boundary
- **WHEN** a CLI command reads a manifest whose workload discriminator is `power-apps-code-app`
- **THEN** it exits 1 with an unsupported retired-workload error before deeper metadata, artifact-path, activation-state, or live-setting interpretation
- **AND** it does not reinterpret the project as generic Git or another supported workload

### Requirement: Current and historical manifests distinguish handoff from enforcement
Supported historical v5-v7 manifests SHALL retain their recorded governance profile and handoff semantics. Current v8 manifests SHALL record the append-only selected profile, exact packaged policy version when enabled, and `handoff-generated` only when all applicable registered handoff artifacts are established. Reviewed partial adoption SHALL record `handoff-partial`, retaining hashes only for written or identically adopted managed entries and exact protected retirement debt, never for preserved unowned conflicts. The current complete inventory SHALL include the six common governance artifacts and applicable selected-agent setup and governance-assessment integrations, plus other explicitly registered managed integrations such as repair. Older inventories lacking additions SHALL remain readable and show guarded additive drift. Disabled governance SHALL record `none` and disabled state without a policy version or policy/setup/governance-assessment authority; independently applicable repair or other non-governance skills SHALL retain their own explicit scope. No manifest field SHALL claim live branches, checks, rulesets, security features, deployment, monitoring, or release enforcement. Reports SHALL not become managed core or activation evidence.

#### Scenario: Record enabled governance
- **WHEN** the plan selects `single-maintainer-gitflow`
- **THEN** a complete initialization or approved adoption records that profile, the current policy version, and `handoff-generated`
- **AND** includes hashes for each applicable exact handoff artifact

#### Scenario: Record partial governance adoption
- **WHEN** update preserves different bytes at an unrecorded applicable handoff destination
- **THEN** the manifest records the selected profile, current policy version, and `handoff-partial`
- **AND** omits the preserved destination from managed ownership while retaining exact hashes for every handoff artifact written or adopted
- **AND** later update continues to classify that destination as an unrecorded conflict until the developer resolves it

#### Scenario: Record protected retired alias
- **WHEN** approved normal update protects a modified exact retired generated setup alias
- **THEN** the manifest records partial handoff and preserves the exact original alias identity only as migration debt
- **AND** removal still requires the separately previewed and approved `liftoff update --force` variant

#### Scenario: Record disabled governance
- **WHEN** the plan selects `none`
- **THEN** the manifest records disabled governance and omits its policy version and governance handoff entries
- **AND** separately applicable repair integrations do not imply enabled governance

#### Scenario: Host GitHub state differs
- **WHEN** identical generation plans are rendered while live GitHub settings differ or cannot be observed
- **THEN** their manifest bytes remain identical

#### Scenario: Upgrade an older managed inventory
- **WHEN** a supported manifest predates assessment integrations
- **THEN** update check identifies the applicable new integration paths without writes
- **AND** approved update can create or adopt safe destinations without running assessment or changing activation evidence

#### Scenario: Assessment destination is unowned and modified
- **WHEN** an applicable assessment path already contains differing unrecorded bytes
- **THEN** it remains an unowned conflict
- **AND** force does not acquire ownership or overwrite it

### Requirement: Profile and component provenance are explicit without invented history
Schema 8 SHALL bind selected standards/profile and component targets to release-owned schema-1 profile and resource identities independently from original generation or adoption provenance. Target selection SHALL not claim that existing code was produced by that target or meets its entire conformance contract. A supported Vue-only adoption SHALL identify the actual component without fabricating an API workload. Unknown historical producer or profile facts SHALL remain unknown. New adoption records SHALL use schema 1 and exact registered history identities; they SHALL not authorize application-patch submissions to write manifest or proof fields.

#### Scenario: A legacy generation profile is not reconstructable
- **WHEN** a supported historical manifest lacks an exact original component/profile revision
- **THEN** a reviewed v8 transition preserves the recorded generation facts and explicitly unknown original profile facts
- **AND** the selected current target is not substituted as the historical producer

#### Scenario: Adopt a standalone supported Vue application
- **WHEN** adoption establishes a supported Vue component without an API
- **THEN** schema 8 records that profile and its actual component boundary
- **AND** it requires no invented backend stack, cloud environment, or GenAI pattern to resemble a generated starter

#### Scenario: An adopted application is later changed
- **WHEN** a separately approved repair modifies explicitly mapped adopted files
- **THEN** the active provenance links the actual repair while preserving the original adoption observations historically
- **AND** neither adoption nor repair hashes create continuing template replacement authority

### Requirement: Reviewed repair preserves generated and adopted provenance
A new approved repair that writes a manifest SHALL use the eligible reviewed schema-8 identity and exact writer while preserving original manifest/provenance before superseding approved active entries. Repair contract 1 and unchanged schema-2 records SHALL remain independent. Local repair SHALL publish provenance only with its local commit; stateful repair SHALL publish only at verified coordinated state/configuration cutover. Unrelated provenance SHALL remain unchanged. Application-patch recipes that exclude manifest writes SHALL continue to preserve the original manifest. Registered historical recovery SHALL use its original serializer and authority rather than upgrade records while recovering.

#### Scenario: Infrastructure active inventory changes through repair
- **WHEN** a supported approved repair replaces retired flat-root files with independent module/environment artifacts
- **THEN** the active inventory describes the repaired files and their actual producer
- **AND** original logical names, paths, generating versions, and hashes remain available in preserved source history

#### Scenario: Stable tfvars identity moves to an environment root
- **WHEN** repair moves a selected environment's tfvars to its canonical independent-root path
- **THEN** its reviewed logical name remains stable and the old path/hash are retained historically
- **AND** the active entry is not silently relabeled without the repair record

#### Scenario: Project code outside the repair changes
- **WHEN** a repair affects only infrastructure or agent integrations
- **THEN** unrelated application provenance is not retagged to the current CLI
- **AND** unrelated files remain outside the repair write set

#### Scenario: Application patch commits without manifest authority
- **WHEN** a registered application patch changes approved project files but does not authorize manifest mutation
- **THEN** its repair bookkeeping records the actual effects without changing manifest generation or adoption identity
- **AND** a newer CLI does not implicitly perform a manifest migration

## MODIFIED Requirements

### Requirement: Manifest migration releases broad legacy ownership atomically
When an eligible reviewed update rewrites a supported v2-v7 manifest, the system SHALL atomically write schema 8 with the exact target profile and compatibility bindings. For v2-v6 broad legacy inventories it SHALL convert explicit current core entries to managed-core state, handle exact retired setup-alias entries through their migration rules, and preserve all other durable entries as project provenance. It SHALL preserve every recorded legacy generation hash and path even when a file is modified or absent, retain v7's already-separated authority, and keep unknown historical facts explicit. Reclassification SHALL perform no project-file mutation except separately approved deletion of eligible exact retired aliases. Merely reading a manifest or replacing the CLI SHALL NOT perform this transaction.

#### Scenario: Rewrite a v5 production project
- **WHEN** a v5 manifest records backend, frontend, database, container, environment, documentation, and infrastructure artifacts and the eligible v8 migration is approved
- **THEN** the rewrite records those entries as preserved project provenance
- **AND** only exact current core entries retain content-hash update authority

#### Scenario: Manifest transaction fails
- **WHEN** ownership migration cannot atomically replace the manifest
- **THEN** update exits 1 without claiming migration success
- **AND** no project file is changed

#### Scenario: Older CLI reads v7
- **WHEN** a historical Liftoff version that supports only schemas through v6 reads a v7 manifest
- **THEN** it rejects that unsupported schema before artifact access
- **AND** cannot fall back to broad legacy write authority

#### Scenario: Older CLI reads v8
- **WHEN** a CLI supporting only schemas through v7 reads a v8 manifest
- **THEN** it rejects the unsupported schema before artifact access
- **AND** it cannot reinterpret adopted provenance as old managed ownership

### Requirement: Governance identifiers and logical names are explicit
Governance profile/state identifiers and current logical names for policy, context, guide, phase graph, compatibility metadata, credential-policy schema, setup, assessment, and other registered integrations SHALL follow the reviewed explicit catalog. Existing logical identities SHALL remain stable until an explicit retirement; delivery-path changes SHALL require a reviewed compatibility migration. Codex SHALL retain `liftoff-setup-codex` at `.agents/skills/liftoff-setup/SKILL.md` and `liftoff-governance-assess-codex` at `.agents/skills/liftoff-governance-assess/SKILL.md` until that migration. Copilot SHALL retain `liftoff-setup-copilot` at `.github/prompts/liftoff-setup.prompt.md` and `liftoff-governance-assess-copilot` at `.github/prompts/liftoff-governance-assess.prompt.md`; Claude SHALL retain `liftoff-setup-claude` at `.claude/commands/liftoff-setup.md` and `liftoff-governance-assess-claude` at `.claude/commands/liftoff-governance-assess.md` under the same rule. Existing repair identities SHALL remain explicitly registered. Lifecycle, compatibility, modification, and deletion SHALL use exact lookups, not directory patterns. Retired aliases SHALL remain migration-only. Project paths SHALL be non-empty OS-neutral path-part arrays confined to the project. Skill content SHALL use managed hashes and capability/schema requirements without independent per-skill SemVer in activation manifests.

#### Scenario: Add a future governance profile
- **WHEN** a later release adds another repository-governance profile
- **THEN** existing `single-maintainer-gitflow` and `none` identifiers retain their meanings

#### Scenario: Validate governance paths on Windows
- **WHEN** a supported v5, v6, v7, or v8 manifest is loaded on Windows, macOS, or Linux
- **THEN** governance path parts resolve under the project root using platform-native handling
- **AND** embedded separators, traversal, drive-qualified parts, UNC parts, unsafe links/junctions, and ambiguous case or normalization aliases are rejected before access

#### Scenario: Validate assessment identities
- **WHEN** a manifest records an assessment integration
- **THEN** its exact logical name, lifecycle, selected agent, and path are validated
- **AND** a wrong path or unselected-agent identity is not granted managed-core authority

#### Scenario: Assess project-owned governance configuration
- **WHEN** assessment reads workflows, ruleset source, or infrastructure declarations
- **THEN** those files retain their prior ownership
- **AND** the report cannot add, alter, or expand manifest write authority

#### Scenario: Record selected Codex integrations
- **WHEN** a governed project selects Codex
- **THEN** its native setup and assessment skills have their own exact Codex identities and managed hashes
- **AND** neither is recorded under a Claude logical name or used to claim neighboring `.agents` files

### Requirement: Artifact rendering is deterministic
The system SHALL render identical Liftoff-owned template bytes for identical project plans within one CLI version; template output SHALL NOT depend on time, randomness, ambient host environment, filesystem enumeration, observed workstation versions, or mutable upstream templates. Double-render verification SHALL check byte equality. Exact framework, policy, profile, component, skill, lock, and workload identities recorded in schema 8 SHALL come from the packaged release catalogs. Adoption observations SHALL remain explicit plan inputs rather than fabricated deterministic generation history.

#### Scenario: Double render is byte-identical
- **WHEN** the same project plan is rendered twice with different compatible mocked workstation versions
- **THEN** every Liftoff-owned artifact's content is byte-identical across the renders, including the generated manifest

#### Scenario: Framework contract remains deterministic
- **WHEN** a project plan selects a spec workflow
- **THEN** the manifest records the exact framework contract pinned by that Liftoff version
- **AND** it does not substitute an arbitrary installed tool version into rendered content

#### Scenario: Packaged catalogs remain deterministic
- **WHEN** a standard or GenAI plan is rendered with or without network access
- **THEN** the manifest records the same packaged workload, profile/component, and governance identities
- **AND** rendered bytes do not depend on mutable upstream content

#### Scenario: Starter contract remains deterministic
- **WHEN** a retired Power Apps plan is requested with or without network access
- **THEN** it receives the same unsupported-workload result before loading an upstream starter
- **AND** network availability or upstream changes do not restore support

### Requirement: CLI outputs follow shared exit-code and JSON conventions
The system SHALL use exit 0 for successful completed scope or documented successful inspection, 1 for rejected/error execution or inconsistent/failed inspection, and 2 for differences or explicitly reported incomplete work according to the command's declared contract. Update SHALL retain schema 3 for its local core/successor transaction. Governance setup/execution command output SHALL use schema 3 with separate journey/local/repository/migration/activation/lifecycle progress, proof freshness, `consistent`, `complete`, and selected-scope `ok`; read-only governance assessment SHALL retain its independent report schema 1. Unscoped governance setup/execution SHALL retain activation as its effective scope, and repository-only success SHALL require explicit selection. Governance verify SHALL return 0 only for consistent complete selected scope, 2 for consistent incomplete scope, and 1 for inconsistency or inspection failure. Successful status, plan, and resume inspection SHALL remain exit 0 even when work is incomplete. Repair SHALL retain contract 1, current report schema 2, and unchanged schema-2 record semantics; registered historical records SHALL keep their original identities and meaning. New public protocol envelopes SHALL use their independent schema 1 without relabeling or wrapping existing command JSON bodies or rewriting stored results solely to match that envelope.

#### Scenario: JSON output is versioned
- **WHEN** a command emits JSON
- **THEN** it includes the appropriate numeric top-level `schemaVersion`

#### Scenario: Exit codes are consistent across commands
- **WHEN** a command completes
- **THEN** its exit code follows the documented success, error, or difference/partial classification without labeling partial readiness as full success

#### Scenario: A committed update still needs revalidation
- **WHEN** migration commits but local revalidation remains incomplete
- **THEN** update exits 2 and separately reports committed metadata and incomplete readiness

#### Scenario: Governance output changes next-phase semantics
- **WHEN** current schema-3 apply-next reports an executed phase
- **THEN** its next readiness comes from post-operation inspection, retaining the post-transition guarantee introduced by schema 2
- **AND** consumers can distinguish both from historical schema-1 selection semantics

#### Scenario: Repair has committed but local verification is blocked
- **WHEN** an approved repair commits and subsequent local checks do not complete
- **THEN** current schema-2 repair output returns exit 2 with separate commit, verification, and cleanup outcomes
- **AND** it does not claim complete setup or roll back historical identity implicitly

#### Scenario: A new protocol envelope references unchanged reports
- **WHEN** schema-1 capability negotiation describes update, repair, or governance assessment
- **THEN** their result identities remain update output 3, repair contract 1/report 2, and governance-assessment report 1
- **AND** current report bodies and registered historical records are not rewritten into a universal schema 1

#### Scenario: Repository completion does not change an omitted scope
- **WHEN** current repository enforcement is complete but activation remains consistent and incomplete and governance verify omits scope
- **THEN** the schema-3 result still evaluates activation with `ok: false` and exit 2
- **AND** a schema or manifest upgrade cannot silently turn that existing call into repository-only success

### Requirement: Activation identity changes are committed with their migration history
A supported current activation-contract migration SHALL write the approved schema-8 manifest identity while retaining original generated or adopted provenance and exact source manifest/state/evidence/plans/approvals through its registered history inventory. Active identity SHALL change only with the linked committed successor and migration record. Historical records SHALL not become managed-core authority or current proof. The local contract-migration approval SHALL not authorize cloud, Git publication, repository controls, or OpenTofu-state migration. Historical recovery SHALL retain its registered original formats instead of being globally converted.

#### Scenario: A historical project is migrated
- **WHEN** an approved supported source-to-current successor transaction commits
- **THEN** active manifest, state, and migration records agree with the target identity while the source snapshot retains exact bytes
- **AND** original project provenance is preserved unless separately changed by an approved project evolution operation

#### Scenario: Revalidation fails after commit
- **WHEN** the successor commits but current proof remains incomplete
- **THEN** it remains active and resumable with preserved source history
- **AND** neither complete governance nor automatic rollback to the historical identity is claimed

#### Scenario: Existing current v2 metadata is maintained
- **WHEN** a historical v2 project receives explicitly registered same-contract maintenance rather than an approved successor migration
- **THEN** no successor or new proof identity is fabricated solely from the CLI version change
- **AND** execution under current activation contract 4 still requires the separately approved declared transition

#### Scenario: Historical source metadata is not an execution target
- **WHEN** an inspector follows a validated history reference
- **THEN** it treats the source as historical data rather than selecting it as the active project boundary

### Requirement: Manifests record project type and API stack
The system SHALL preserve the discriminated generated-workload identity introduced in schema v4 when reading supported v4-v7 manifests and writing current schema-8 generated manifests. GenAI SHALL record Python/FastAPI, pattern, cloud, region, frontend selection, and environments; standard generated APIs SHALL record their selected API stack and applicable cloud/frontend/environment decisions without a GenAI pattern. Generated workload kinds SHALL remain `genai` and `standard`. Adopted v8 projects SHALL record actual supported profile/component identity and any valid applicable workload facts without fabricating generation-only fields. Readers SHALL validate the selected generated or adopted form strictly and reject retired `power-apps-code-app` identity before deeper interpretation.

#### Scenario: Record a standard project
- **WHEN** Liftoff generates a standard Node.js project
- **THEN** the manifest records workload kind `standard` and API stack `node-fastify`
- **AND** the workload object does not require a GenAI pattern

#### Scenario: Record a GenAI project
- **WHEN** Liftoff generates a RAG project
- **THEN** the manifest records workload kind `genai`, API stack `python-fastapi`, and pattern `rag`

#### Scenario: Record a Power Apps project
- **WHEN** a generation or manifest operation requests the retired Power Apps workload
- **THEN** it reports unsupported workload rather than writing or accepting a current Power Apps manifest

#### Scenario: Reject a retired project identity
- **WHEN** a manifest or desired-state configuration names workload kind `power-apps-code-app`
- **THEN** the CLI rejects the workload before interpreting starter metadata, activation metadata, or artifact ownership

#### Scenario: Reject an invalid project identity
- **WHEN** a manifest or desired-state configuration combines a generated workload or adopted profile with missing or inapplicable fields
- **THEN** the CLI identifies the unsupported combination and corrective action
- **AND** it does not fill the gap with a fabricated framework or backend

### Requirement: Manifest readers normalize legacy GenAI identity
The system SHALL interpret supported v2/v3 manifests and configuration containing a GenAI pattern without project type or API stack as GenAI using Python/FastAPI. It SHALL normalize valid flat v3 standard identity into the discriminated workload model introduced in v4 and preserved for generated projects in v8, without fabricating a retired workload or original profile revision. Approved current manifest writes SHALL use schema 8.

#### Scenario: Read an existing v2 GenAI manifest
- **WHEN** a current CLI reads a supported v2 manifest with chatbot pattern and no project type or API stack
- **THEN** validation, update, and doctor use GenAI with Python/FastAPI
- **AND** no manual manifest edit is required

#### Scenario: Read an existing v3 standard manifest
- **WHEN** a supported v3 manifest records standard with go-huma
- **THEN** downstream behavior preserves that normalized workload and its framework integrations

#### Scenario: Rewrite normalized identity
- **WHEN** reviewed current update successfully rewrites a supported v2/v3 manifest
- **THEN** it writes a v8 manifest with the normalized discriminated workload
- **AND** project-owned application files and original recorded generation provenance remain unchanged

### Requirement: Manifest artifact paths are structurally valid and project-confined
The system SHALL validate the complete shape of a supported manifest and prove every artifact path resolves inside the discovered project root before access or mutation. Equivalent Windows, macOS, and Linux validation SHALL reject traversal, absolute or drive/UNC-qualified artifact paths, embedded separators, empty segments, escaping symlinks/junctions, duplicate logical identities, conflicting destination claims, and ambiguous case or normalization aliases. Valid absolute project-root selection SHALL remain distinct from confined portable artifact path parts.

#### Scenario: Read a valid portable manifest path
- **WHEN** a supported manifest records non-empty platform-neutral path parts such as `["backend", "apis", "main.py"]`
- **THEN** the CLI resolves the path under the project root using the host platform and permits normal processing

#### Scenario: Reject parent traversal before filesystem access
- **WHEN** a manifest artifact includes `..` or another representation that resolves outside the project root
- **THEN** the command exits 1 before accessing the target and identifies the unsafe artifact path

#### Scenario: Reject Windows absolute and UNC paths cross-platform
- **WHEN** a manifest contains a drive-qualified or UNC artifact path, even on macOS or Linux
- **THEN** it is rejected as unsafe before artifact access

#### Scenario: Reject embedded separators
- **WHEN** one manifest path part contains `/` or `\` instead of exactly one segment
- **THEN** the CLI rejects it with guidance to use a valid supported manifest rather than normalize it into authority

#### Scenario: Reject a symlink escape
- **WHEN** a validated-looking path traverses a link whose resolved target is outside the project root
- **THEN** the CLI refuses the operation and leaves the project and external target unchanged

#### Scenario: Reject malformed manifest fields with guidance
- **WHEN** a supported-version manifest has missing or incorrectly typed metadata, arrays, logical names, categories, paths, hashes, profiles, provenance, or writer version
- **THEN** the CLI exits 1 with a concise manifest-validation error rather than a JavaScript type error

#### Scenario: Two artifacts claim an ambiguous destination
- **WHEN** logical entries collide by canonical path, filesystem case rules, normalization, or a Windows junction
- **THEN** validation refuses access or mutation under the ambiguous inventory
- **AND** it does not choose an owner from enumeration order or matching content

### Requirement: Manifest v3 records deterministic framework and agent identity
The integration contract introduced by schema v3 SHALL remain supported historically and preserved in current schema-8 writes: selected spec workflow, canonical ordered coding-agent identifiers, applicable selected default agent, framework adapter, and exact tested framework contract SHALL be distinct from workload/profile identity. New writes SHALL use v8, not create new v3 manifests. Host-specific runtime, package-manager, Docker daemon, infrastructure-tool, and agent versions SHALL NOT replace those deterministic identities.

#### Scenario: Record OpenSpec with both agents
- **WHEN** a new project is initialized with OpenSpec, GitHub Copilot, and Claude Code
- **THEN** the v8 manifest preserves the v3-introduced adapter, tested contract, and normalized canonical agent ordering
- **AND** it does not require a default-agent field

#### Scenario: Record Spec Kit default agent
- **WHEN** a new project is initialized with Spec Kit, both agents, and Claude Code as default
- **THEN** the v8 manifest records both normalized agents and Claude Code as the default

#### Scenario: Host versions do not affect manifest bytes
- **WHEN** identical plans are initialized with different compatible patch versions of Python, Go, Docker, or a coding agent
- **THEN** those observed versions do not change rendered manifest bytes

### Requirement: Legacy v2 manifests normalize framework state without false claims
The system SHALL continue to accept valid v2 manifests and normalize missing framework and agent metadata as explicit legacy state. A reader SHALL NOT infer official agent initialization. A reviewed v8 rewrite SHALL preserve that uncertainty unless a separately supported framework-initialization or integration flow has actually established it.

#### Scenario: Read v2 project identity
- **WHEN** a valid v2 manifest contains a spec workflow but no framework contract or agent list
- **THEN** validation, doctor, and update treat framework state as legacy with no declared agent integrations

#### Scenario: Rewrite v2 without fabricating agents
- **WHEN** approved update rewrites a valid v2 project without framework initialization
- **THEN** the v8 manifest records legacy framework state and no configured agents
- **AND** it does not claim Copilot, Claude Code, or Codex was installed or integrated

### Requirement: Only managed-core files carry durable update authority
The system SHALL use explicit logical declarations to distinguish managed core, project provenance, desired state, official framework output, and one-time seed content. Ordinary reconciliation SHALL operate only on managed-core identities and separately approved create-only component provisioning. Exact approved moves, retirements, and supported metadata/history or skill-transport migrations SHALL retain their declared bounded inventories without granting broader ownership. Application adoption or repair SHALL not convert project files into managed core. Authority SHALL NOT be selected by directory pattern, filename, category, current disk hash, or unknown legacy identity.

#### Scenario: Framework files are validated without hashes
- **WHEN** an official initializer creates framework-owned commands, skills, scripts, or templates
- **THEN** the manifest can identify that integration without creating managed-core entries for those paths

#### Scenario: Project files retain provenance without authority
- **WHEN** Liftoff generates source, dependencies, containers, environments, documentation, database files, or infrastructure
- **THEN** the manifest records project provenance
- **AND** update cannot use generation or later adoption hashes to restore or replace those files

#### Scenario: Update uses explicit durable lookup
- **WHEN** update calculates changes for any supported manifest
- **THEN** it looks up exact managed-core logical names in current lifecycle declarations
- **AND** legacy setup-alias deletion is restricted to exact eligible identities in the manifest migration bridge
- **AND** other removal is limited to exact approved managed moves or separately registered migration/retirement inventories, never path or category matching

#### Scenario: Unknown legacy artifact fails safe
- **WHEN** a legacy manifest contains a logical name absent from current declarations
- **THEN** ordinary durable entries remain project provenance rather than managed core
- **AND** unknown old setup-launcher names are rejected instead of acquiring guessed migration authority

### Requirement: Manifest v4 separates common integration identity from workload identity
The system SHALL preserve the v4-introduced separation of project name and discriminated generated workload under `project` from common workflow, canonical agents, applicable Spec Kit default, framework adapter, and tested framework contract in schema 8. Adopted profile/component identity SHALL occupy its declared project identity form without invented generation-only fields; integration identity SHALL still reflect actual established state. Observed host runtime, package-manager, Docker, infrastructure-tool, and agent versions SHALL NOT become deterministic manifest inputs.

#### Scenario: Record a standard project with OpenSpec and both agents
- **WHEN** a standard project is initialized with OpenSpec, GitHub Copilot, and Claude Code
- **THEN** the current v8 manifest retains separate standard workload and normalized agent identities
- **AND** it does not require a default-agent field

#### Scenario: Record a GenAI project with Spec Kit default agent
- **WHEN** a GenAI project is initialized with Spec Kit, both agents, and Claude Code as default
- **THEN** the v8 manifest records both agents, Claude Code as default, and the tested Spec Kit contract independently from workload identity

#### Scenario: Record Power Apps with OpenSpec and both agents
- **WHEN** a retired Power Apps request selects OpenSpec and both agents
- **THEN** workload rejection occurs before a new manifest or integrations are created

#### Scenario: Record Power Apps with Spec Kit default agent
- **WHEN** a retired Power Apps request selects Spec Kit and a default agent
- **THEN** workload rejection occurs before a new manifest or integrations are created

#### Scenario: Host versions do not affect v4 bytes
- **WHEN** identical plans are initialized with different compatible patch versions of Node.js or a coding agent
- **THEN** those observed versions do not change rendered manifest bytes or the retained v4 integration semantics

### Requirement: Generic is an explicit stable GenAI pattern identity
The system SHALL preserve `generic` as an append-only GenAI pattern identifier in desired state, supported historical manifests, current schema-8 GenAI identity, generated guidance, bootstrap specifications, and governance context. GenAI uncertainty SHALL NOT be represented by a missing pattern or substitution of another pattern. Adoption SHALL not assign `generic` to a component that is not an established GenAI workload.

#### Scenario: Generate a generic project manifest
- **WHEN** a developer initializes the generic GenAI pattern
- **THEN** configuration and manifest both record `pattern: generic`
- **AND** project artifacts retain their normal project-owned lifecycle and provenance semantics

#### Scenario: Read a generic project manifest
- **WHEN** validation, doctor, or update reads a supported historical or schema-8 GenAI manifest containing `generic`
- **THEN** it uses the same strict catalog validation as every specialized pattern

#### Scenario: Reject missing GenAI pattern identity
- **WHEN** a GenAI configuration or manifest omits its required pattern instead of selecting `generic`
- **THEN** the required-field validation error is reported

#### Scenario: Preserve append-only pattern identifiers
- **WHEN** the pattern catalog contains `generic`
- **THEN** all eight specialized pattern identifiers and meanings remain unchanged

### Requirement: Current activation identities are explicit and historical v1 state is diagnostic-only
The current executable identity SHALL declare manifest 8, policy 8, activation contract 4, graph schema 3, state/evidence-header/approval-envelope schemas 4, compatibility metadata 5, and credential-policy schema 2. The graph SHALL have an actually computed canonical hash and explicit phase-contract digests. The exact activation-package and CLI release identities SHALL be fixed and registered before current writers are enabled, not fabricated in plans or inferred from schema numbers. Governance command output 3, new public protocol 1, repair contract 1 with unchanged schema-2 records, and unchanged supersession and governance-assessment report/catalog schemas 1 SHALL remain separate axes. Historical v1/v2/v3 activation readers and digest algorithms, plus the exact pre-amendment policy-7/credential-policy-schema-1 candidate reader, SHALL remain isolated from current execution and require an exact registered transition and fresh proof rather than version retagging.

#### Scenario: Generate the current identity set
- **WHEN** current managed governance metadata is generated
- **THEN** manifest, policy, graph, phase digests, and compatibility metadata identify the exact registered target tuple
- **AND** command, repair, profile, and proof schema versions are not conflated

#### Scenario: Historical v1 activation remains readable but not executable
- **WHEN** a supported project contains known v1 records
- **THEN** their bytes remain historical and an exact declared migration or unsupported-source result is reported
- **AND** those records do not authorize current execution

#### Scenario: Managed-core maintenance does not silently rewrite historical state
- **WHEN** update or doctor encounters historical activation data
- **THEN** it stays within declared authority and does not retag or rewrite the records as current proof

#### Scenario: Historical v2 is upgraded
- **WHEN** an exact supported v2 source is approved for the target successor
- **THEN** source records and approvals are preserved and current proof is re-established through the declared migration contract
- **AND** existing cloud resources are not recreated merely to obtain new-version evidence

#### Scenario: Historical v3 publication needs revalidation
- **WHEN** a registered transition handles schema-3 publication affected by later Azure input binding
- **THEN** original plans, approvals, receipts, and the historical digest interpretation remain intact
- **AND** linked independently observed revalidation establishes only actual publication facts without rewriting old hashes, recommitting, or pushing solely to repair the mismatch

#### Scenario: A target identity has not been registered
- **WHEN** a writer would emit an unregistered tuple or placeholder graph digest
- **THEN** current generation or migration is blocked before writes
- **AND** historical compatibility is not inferred from lower version numbers

#### Scenario: The prior candidate shares other current schema numbers
- **WHEN** a manifest records policy 7 and credential-policy schema 1 alongside activation-contract number 4
- **THEN** the complete original tuple selects its explicit preservation reader and transition eligibility
- **AND** matching manifest or activation schema numbers do not grant policy-8 execution or schema-2 credential authority
