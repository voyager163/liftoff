## Purpose

Define one canonical host-assisted workflow library and safe selected-host delivery so developers can use Liftoff before and after initialization without duplicate business logic or implicit execution authority.

## Requirements

### Requirement: One canonical library covers the complete lifecycle
Liftoff SHALL package one canonical skill library with shared instructions, references, examples, and an explicit catalog for setup, assess, init, adopt, update, repair, migrate, governance-assess, governance, Azure, and CLI-upgrade assistance. Copilot, Claude Code, and Codex projections SHALL derive their workflow semantics from that library rather than maintain independent business logic or imperative implementations. Host-specific material SHALL be limited to the qualified discovery, metadata, invocation, and tool-transport differences.

#### Scenario: The same workflow is delivered to three hosts
- **WHEN** equivalent selected scopes are rendered for Copilot, Claude Code, and Codex
- **THEN** all projections describe the same lifecycle, required evidence, approval boundaries, and supported commands
- **AND** host metadata differences do not change what Liftoff is authorized to execute

#### Scenario: A canonical repair instruction changes
- **WHEN** the shared workflow is revised
- **THEN** every affected host projection derives the same semantic revision
- **AND** a host-specific copy cannot retain a separate stale repair implementation

#### Scenario: A developer uses no skill
- **WHEN** a supported deterministic CLI command is invoked directly
- **THEN** it remains usable without a skill, model selection, or agent host
- **AND** the library is assistance rather than a prerequisite for CLI correctness

### Requirement: Skills negotiate capabilities instead of assuming version support
Before recommending execution, a skill SHALL inspect the installed public capability contract and required schema/profile identities, keeping the schema-1 shared envelope independent from each command's result/report schema. It SHALL accept the declared unchanged repair contract 1/report 2 rather than require that report to become schema 1; governance setup/execution SHALL use its explicit output schema 3. Managed content hashes and declared capability, protocol, profile, and host compatibility requirements SHALL identify delivered skill content; no independent per-skill SemVer SHALL be added to activation manifests. Negotiation SHALL distinguish executable, plan-only, unsupported, prerequisite-blocked, and unqualified operations and SHALL NOT infer compatibility from the CLI SemVer alone.

#### Scenario: A skill runs against an older CLI
- **WHEN** the installed CLI lacks the required public capability or schema
- **THEN** the skill reports the exact mismatch and supported read-only or installation guidance
- **AND** it does not invent flags, invoke an unsupported mutator, or request manual manifest edits

#### Scenario: Only the instruction bytes change
- **WHEN** a managed skill revision changes wording without changing an activation contract
- **THEN** its content hash changes through the reviewed delivery/update operation
- **AND** activation proof, graph identity, and historical approvals are not retagged

#### Scenario: A planner is available but execution is not
- **WHEN** capability negotiation reports a plan-only or unqualified required operation
- **THEN** the skill identifies that limitation explicitly
- **AND** it cannot claim the full release or requested journey complete merely because instructions exist

### Requirement: Skills leave model reasoning and authority with their proper owners
Agent hosts SHALL provide model reasoning and tools; skills SHALL collect intent, propose bounded changes, and explain deterministic CLI observations. Skills SHALL NOT embed an LLM client, choose a model, certify their own approval or conformance, or duplicate Liftoff's mutation engine in scripts. Operations requiring separate plan approval SHALL retain genuine action-specific default-No user decisions or exact authorized machine input, never autopilot, piped answers, generic intent, or model-generated Yes. Skills SHALL preserve registered command-specific authorization: an explicitly requested routine owner-preserving CLI upgrade SHALL not acquire an extra Liftoff confirmation or fingerprint requirement, and that request SHALL not authorize installation migration, elevation, or project work. Host tool permissions and CLI admission SHALL remain required even when instructions describe safe behavior.

#### Scenario: The user asks to modernize a project
- **WHEN** a host interprets a broad modernization request
- **THEN** the skill begins with supported read-only inspection and a concrete proposal
- **AND** it obtains each required approval rather than treating the initial request as authorization for files, code, network, Git, or cloud actions

#### Scenario: An agent tries to approve its own plan
- **WHEN** a proposed workflow supplies model-written approval text or a fabricated successful receipt
- **THEN** the CLI rejects it under the normal admission contract
- **AND** the skill explains the missing user authority or independent proof

#### Scenario: A host has broader tool access
- **WHEN** the host can execute tools outside Liftoff
- **THEN** the skill does not claim that its metadata creates an OS or network sandbox
- **AND** Liftoff's guarantees remain limited to the operations admitted by its CLI

### Requirement: User-scope skills are available before project creation
The CLI SHALL provide catalog and compatibility inspection plus reviewed user-scope delivery through `liftoff skills` without requiring a project, manifest, activation state, or generated launcher. User-scope records SHALL identify the selected hosts, canonical library identity, exact projected files and hashes, and resolved ownership boundary independently from project activation. A user-scope installation SHALL NOT create or rewrite files in the current repository, global framework configuration, or project manifests.

#### Scenario: Install assessment assistance before initialization
- **WHEN** a developer with no Liftoff project reviews and approves a supported user-scope skill delivery
- **THEN** the selected host can discover the installed assessment workflow
- **AND** no project scaffold, manifest, framework initialization, or activation state is created

#### Scenario: Manage personal skills from a repository
- **WHEN** a user-scope operation is invoked with an unrelated repository as its current directory
- **THEN** its plan and records remain bound to the explicit personal discovery root
- **AND** the repository does not become an installation target

#### Scenario: Personal paths use native Windows conventions
- **WHEN** personal discovery roots resolve to Windows drive or UNC paths, or macOS or Linux home paths with spaces
- **THEN** installed identities use native confined resolution and literal argument handling
- **AND** unsafe links, junctions, ambiguous aliases, or case/normalization collisions block delivery before writes

### Requirement: Selected-host delivery accounts for overlapping discovery roots
Delivery SHALL use a tested host compatibility matrix and an explicit collision-aware projection plan. Copilot and Codex SHALL be able to share one qualified personal `.agents/skills` projection; Claude Code SHALL use its qualified native personal projection. The plan SHALL resolve actual overlapping roots, discovery precedence, invocation collisions, and existing ownership before approval. It SHALL NOT blindly create three copies, assume symlink support, silently alter host settings, or promise host isolation that shared discovery cannot provide.

#### Scenario: Copilot and Codex share a personal root
- **WHEN** both selected hosts discover the same compatible personal skill files
- **THEN** delivery plans one owned physical projection with both consumers declared
- **AND** it does not create duplicate competing workflows merely because two hosts were selected

#### Scenario: An unselected host also discovers the shared root
- **WHEN** a selected-host projection would also be discoverable by another installed host
- **THEN** the plan discloses that shared visibility before approval
- **AND** it does not claim to have installed a separate unselected-host integration or change that host's settings

#### Scenario: A project copy shadows a personal skill
- **WHEN** the same invocation resolves to overlapping personal and project projections with differing content or incompatible schemas
- **THEN** inspection identifies the exact conflicting roots and effective discovery
- **AND** delivery or execution remains blocked where unambiguous compatible selection cannot be established

#### Scenario: The host transport is unsupported
- **WHEN** a selected host or filesystem cannot support the registered discovery and transport contract
- **THEN** the operation reports the unsupported combination without writes
- **AND** it does not fall back to symlinks, another host's directory, or blanket configuration changes

### Requirement: Skill files have exact managed ownership and reviewed lifecycle
Each managed projection SHALL have an immutable logical identity, exact scope and destination, canonical content identity, and managed hash. Install, update, migration, modification, and removal SHALL operate only on explicit registered entries under reviewed approval and current preconditions, never prefixes, globs, parent-directory ownership, or filename resemblance. Unrelated user skills, OpenSpec and Spec Kit output, custom commands, and unknown files SHALL remain outside that authority. A hash match alone SHALL not establish ownership without an approved identity-bound adoption.

#### Scenario: A delivery destination already contains user content
- **WHEN** a requested skill path has different unowned or framework-owned bytes
- **THEN** delivery reports the exact collision and preserves the file
- **AND** force or selection of the host does not acquire ownership

#### Scenario: Existing bytes exactly match
- **WHEN** a supported reviewed projection plan finds identical bytes at a safe unrecorded destination
- **THEN** it can record only that exact approved artifact identity without rewriting the file
- **AND** neighboring content remains unowned

#### Scenario: A managed skill is customized
- **WHEN** current bytes differ from the recorded managed hash
- **THEN** update reports a managed conflict and requires the supported exact reviewed resolution
- **AND** ordinary delivery does not silently overwrite the customization

#### Scenario: Remove a managed projection
- **WHEN** an approved removal inventory names a safely identified managed skill
- **THEN** only the registered eligible file entries and attributable empty created directories can be removed
- **AND** shared-root consumers, unrelated skills, changed files, and unlisted directories remain protected on Windows, macOS, and Linux

### Requirement: Existing invocation identities persist until reviewed migration
Existing setup, governance-assessment, and repair logical identities, invocation forms, and registered project paths SHALL remain valid until an explicit compatible migration handles them. Copilot and Claude SHALL retain their existing `/liftoff-setup`, `/liftoff-governance-assess`, and `/liftoff-repair` entry points; Codex SHALL retain its registered native skills and `$liftoff-setup`, `$liftoff-governance-assess`, and `$liftoff-repair` forms. A new canonical library SHALL NOT silently retire `.github/prompts`, `.claude/commands`, or `.agents/skills` entries or revive already retired aliases.

#### Scenario: Install a newer native CLI
- **WHEN** the executable changes but the developer has not approved a project integration migration
- **THEN** existing project integrations and their recorded hashes remain unchanged
- **AND** capability negotiation reports any incompatibility instead of rewriting those files during installation

#### Scenario: Migrate a project transport
- **WHEN** a supported reviewed plan changes an integration's registered delivery surface
- **THEN** it names the exact old and new identities, files, consumers, compatibility requirements, and conflict behavior
- **AND** only approved attributable entries change while historical provenance remains truthful

#### Scenario: Repair is added beside existing framework skills
- **WHEN** a selected-agent project receives its registered additive repair integration
- **THEN** existing setup and assessment identities retain their meanings
- **AND** no broad `.agents`, `.github`, or `.claude` migration is inferred

### Requirement: Workflow guidance preserves complete command and outcome context
Skills SHALL use the CLI's real `nextActions` and preserve `executable`, separate `args`, `cwd`, `scope`, `project`, configuration reference/digest, required authority, and compatibility identity. They SHALL distinguish whole-project `assess` from `governance assess`, in-place `adopt` from fresh-target `migrate`, managed `update` from application repair, and CLI upgrade from project evolution. Setup and governance guidance SHALL distinguish local, repository-only, activation, and lifecycle completion and SHALL continue only through requested approved scopes. An unscoped governance setup/execution call SHALL retain the existing activation default; a skill SHALL not silently select repository-only scope to obtain a narrower success result.

#### Scenario: Repository enforcement is the requested stopping point
- **WHEN** current repository-only checks, controls, and readback are complete
- **THEN** the skill reports repository completion while retaining pending or blocked Azure/production work
- **AND** it does not manufacture full-activation or production evidence

#### Scenario: A later scope is declined
- **WHEN** the developer completes local work and declines publication or cloud authority
- **THEN** the skill reports completed local effects and the unperformed later work
- **AND** it does not repeat completed mutations or declare a deployed governed system

#### Scenario: A Windows continuation changes directory
- **WHEN** a returned action targets a project with spaces or shell metacharacters and carries a relative-origin inputs binding
- **THEN** the host invokes the exact executable, arguments, working directory, and resolved configuration binding
- **AND** translating the action for Windows, macOS, or Linux cannot drop inputs, switch project, or expand scope

#### Scenario: JSON reports incomplete verification
- **WHEN** the CLI returns consistent but incomplete selected-scope verification
- **THEN** the skill explains the missing proof and registered continuation
- **AND** it does not treat `ok`, exit status, or generated-file presence as proof of a broader completed journey
