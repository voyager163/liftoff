## Purpose

Define the `liftoff migrate` command that adopts existing non-Liftoff projects through a fresh scaffold, a staged legacy copy, and an emitted migration plan, without ever writing to the source project.

## Requirements

### Requirement: Migrate adopts existing projects through a fresh scaffold
The system SHALL provide a `liftoff migrate <path>` command that scans an existing non-Liftoff project, captures project decisions through the standard init prompts, generates a fresh Liftoff scaffold in a new directory beside the source project using the staged official-framework generation pipeline, and SHALL NOT write to the source project in any way.

The fresh target SHALL use current manifest artifact 8 and its explicit profile/generation identity. This source-read-only command SHALL NOT become an alias for in-place adoption or CLI installation migration.

#### Scenario: Migrate produces a compliant scaffold
- **WHEN** a developer runs `liftoff migrate ../legacy-app`, selects a supported target, and completes the prompts and required planning/prerequisite permissions
- **THEN** a new Liftoff project is generated in a fresh directory with a manifest-8 scaffold and complete official framework integration
- **AND** `liftoff validate` passes on it
- **AND** scaffold validation is distinguished from completion of the pending application-porting work

#### Scenario: Source project is untouched
- **WHEN** a full migrate run completes or fails
- **THEN** the source project's file tree is byte-for-byte identical to its state before the run

#### Scenario: Target directory must be new or empty
- **WHEN** the chosen project name resolves to an existing non-empty directory
- **THEN** migrate fails before target writes even when `--force` is present

### Requirement: The legacy scan is deterministic and feeds prompts and plan
The system SHALL scan the source project read-only for Python, Node.js, and Go dependency files and declarations; framework indicators; GenAI and retrieval indicators; environment files; Docker assets; CI workflows; non-workflow `.github` content; tests and test configuration; database migrations; frontend indicators; and spec-workflow directories. The scan SHALL include `setup.py`, `setup.cfg`, and `pytest.ini` in its explicit inventory when present, SHALL distinguish dependency declarations from comments or example text, SHALL run before prompting, and its inventory SHALL drive both prompt pre-fill and migration task seeding. Every top-level entry or explicit inventory item not matched by a reviewed placement rule SHALL surface as a placement-decision task.

#### Scenario: Scan detects common Python assets
- **WHEN** the source project contains `requirements.txt`, `setup.py`, `setup.cfg`, `pytest.ini`, `.env`, a `Dockerfile`, and a `tests/` directory
- **THEN** the inventory records each finding with its source path

#### Scenario: Scan detects Node.js API evidence
- **WHEN** the source project contains `package.json` with Fastify and TypeScript dependencies
- **THEN** the inventory records strong evidence for the approved standard Node.js API stack

#### Scenario: Scan detects Go API evidence
- **WHEN** the source project contains `go.mod` and Go source using Huma or Chi
- **THEN** the inventory records strong evidence for the approved standard Go API stack

#### Scenario: Dependency comments are not treated as declarations
- **WHEN** the source project contains a comment or markdown snippet mentioning `fastify`, `pydantic-ai`, or another dependency name without a matching dependency declaration file entry
- **THEN** the inventory does not record that comment as stack or pattern evidence

#### Scenario: Non-workflow GitHub content receives an explicit placement decision
- **WHEN** the source project contains `.github/CODEOWNERS`, `.github/dependabot.yml`, or another non-workflow file under `.github/`
- **THEN** the inventory records the exact source path
- **AND** the emitted migration plan includes a placement-decision task unless a reviewed rule maps it directly

#### Scenario: Nothing is silently dropped
- **WHEN** the source project contains a top-level directory no explicit detection rule recognizes
- **THEN** the emitted plan includes a task to decide that directory's placement

#### Scenario: Scan paths are cross-platform
- **WHEN** migration scans a project on Windows, macOS, or Linux
- **THEN** evidence source paths and staged destinations are resolved with platform-correct path handling while emitted logical paths remain portable

### Requirement: Prompt pre-fill is evidence-based with visible provenance
The system SHALL pre-fill project type, API stack, GenAI pattern, frontend selection, and common init decisions only from strong scan evidence, SHALL display the evidence alongside each pre-filled default, and SHALL leave a decision unresolved when evidence is weak or conflicting. The developer SHALL be able to override every pre-filled value, and explicit CLI target selections SHALL remain authoritative over scan evidence. Non-interactive runs with `--yes` SHALL follow the same project-question semantics as `init` without implying overwrite or installation consent.

#### Scenario: Strong standard Node.js evidence pre-fills with provenance
- **WHEN** the scan finds Fastify and TypeScript dependencies without GenAI dependencies
- **THEN** the standard project type and Node.js/Fastify API stack are pre-filled
- **AND** the CLI displays the dependency file that supplied the evidence

#### Scenario: Strong GenAI evidence pre-fills with provenance
- **WHEN** the scan finds PydanticAI and retrieval dependencies
- **THEN** GenAI project type, Python/FastAPI API stack, and RAG pattern may be pre-filled
- **AND** the CLI displays the evidence for each decision

#### Scenario: Frontend evidence pre-fills with provenance
- **WHEN** the source project contains a `frontend/` directory with a React dependency
- **THEN** the frontend prompt defaults to yes and shows what was detected and where

#### Scenario: Explicit target override wins over scan evidence
- **WHEN** the scan finds strong Node.js evidence but the developer explicitly selects Go/Huma or disables the frontend
- **THEN** the final migration plan uses the developer's selected stack and frontend choice
- **AND** the scan evidence remains visible as provenance rather than authority

#### Scenario: Weak evidence leaves type-specific decisions blank
- **WHEN** the scan finds no strong project-type or API-stack indicator
- **THEN** the project-type question is presented without a pre-filled default derived from the scan

#### Scenario: Conflicting evidence requires developer choice
- **WHEN** the scan finds strong evidence for more than one API stack or both standard and GenAI application behavior
- **THEN** the CLI reports the conflicting evidence and requires the developer to choose before generation

### Requirement: Migration output reflects the target project type and API stack
The system SHALL generate the fresh target scaffold and migration plan using the resolved project type, API stack, and frontend selection, and SHALL map detected source material to destinations valid for that target. Explicit target overrides SHALL change the destination mapping even when the source scan indicates a different supported stack.

#### Scenario: Migrate a standard Go project
- **WHEN** a developer confirms a standard Go/Huma migration plan
- **THEN** the fresh scaffold uses the Go backend layout and database tooling
- **AND** migration tasks map source handlers, configuration, tests, and migrations to Go-specific target locations without introducing GenAI tasks

#### Scenario: Migrate a GenAI project
- **WHEN** a developer confirms a GenAI migration plan
- **THEN** the emitted proposal identifies the GenAI pattern and Python/FastAPI/PydanticAI stack

#### Scenario: Override the target API stack
- **WHEN** the legacy scan finds Node.js evidence but the developer explicitly selects the supported Python/FastAPI API stack
- **THEN** the scaffold and migration tasks target Python/FastAPI destinations
- **AND** the plan does not emit Node.js-only destination paths as authoritative outputs

#### Scenario: Override frontend selection
- **WHEN** the legacy scan finds React frontend evidence but the developer explicitly declines a generated frontend
- **THEN** the scaffold omits frontend generation
- **AND** the migration plan records the detected frontend material as placement decisions rather than writing unsupported frontend destinations

### Requirement: Legacy source is staged inside the scaffold
The system SHALL copy the source project into `migration/legacy/` within the generated scaffold, excluding version-control, dependency, cache, and build directories; the generated `.gitignore` SHALL cover `migration/legacy/`; and the emitted plan SHALL order verification before the final task that removes the staging directory.

#### Scenario: Staging copy is filtered
- **WHEN** the source project contains `.git/`, `node_modules/`, and application source
- **THEN** `migration/legacy/` contains the application source but not the excluded directories

#### Scenario: Staging directory is ignored by git
- **WHEN** the scaffold is generated
- **THEN** `migration/legacy/` is matched by the generated `.gitignore`

#### Scenario: Verification precedes staging cleanup
- **WHEN** the emitted migration plan is generated for a staged legacy source
- **THEN** validation and doctor completion tasks appear before the task that removes `migration/legacy/`
- **AND** staging deletion is not the final verification gate

### Requirement: The migration plan is emitted as an executable change
The system SHALL emit the migration plan into the scaffold as an OpenSpec change named `migrate-to-liftoff` containing a proposal and a task list seeded from the scan inventory, with each task mapping staged legacy material to its Liftoff destination, exact logical artifact, or explicit placement decision. Dependency and prerequisite tasks SHALL appear before dependent porting work, verification SHALL precede staging cleanup, and the proposal SHALL state the completion gate (all tasks done, `liftoff validate` and `liftoff doctor` green, scaffold tests passing, change archived). When the selected spec workflow is not OpenSpec, the system SHALL emit the same plan as a `MIGRATION.md` checklist instead.

An executable change describes reviewed implementation work, not automatic semantic-conversion authority. Unsupported source mappings SHALL remain explicit blockers until a registered transformation and actual validation establish their outcomes; checked tasks alone SHALL NOT certify conversion.

#### Scenario: Emitted change reflects the scan
- **WHEN** the scan detected Python dependencies, env files, and tests
- **THEN** `openspec/changes/migrate-to-liftoff/tasks.md` contains tasks for porting dependencies, mapping environment variables, and relocating tests, referencing paths under `migration/legacy/`

#### Scenario: Emitted change inventories exact GitHub and setup paths
- **WHEN** the scan detects `.github/CODEOWNERS`, `setup.py`, and `pytest.ini`
- **THEN** the emitted tasks reference those exact inventoried paths
- **AND** the plan identifies whether each item maps to a reviewed destination or requires a placement decision

#### Scenario: Non-OpenSpec workflow gets a checklist
- **WHEN** the developer selects the spec-kit workflow
- **THEN** the plan is written as `MIGRATION.md` in the scaffold root with the same seeded tasks

#### Scenario: Migration is resumable
- **WHEN** a migration is interrupted with some tasks complete
- **THEN** the remaining work is exactly the unchecked tasks in the emitted change, with no migrate re-run required

### Requirement: Migrate prints the completion path
The system SHALL end a successful run by printing next steps: the optional git-history preservation recipe (copying the legacy `.git` into the scaffold and committing the migration on top), how to execute the emitted plan, and the verification gate (`liftoff validate` and `liftoff doctor`).

#### Scenario: Next steps after generation
- **WHEN** migrate completes successfully
- **THEN** the output includes the optional history-preservation instruction, the emitted plan location, and the validate/doctor gate

### Requirement: Migration targets use the complete workstation and framework pipeline
The system SHALL apply the same plan-derived workstation readiness, global OpenSpec profile compatibility and consent, selected-agent configuration, cloud-agent choice, staged official framework initialization, and optional project dependency phase to a migration target as to a new initialized project. The migration source SHALL remain read-only throughout these phases.

#### Scenario: Missing migration target prerequisite
- **WHEN** a resolved migration plan requires a missing blocking runtime, framework CLI, or compatible OpenSpec global profile
- **THEN** Liftoff obtains the same separate authorization used by `init`
- **AND** it writes neither the source nor target before blocking requirements are ready

#### Scenario: Configure both agents in a migration target
- **WHEN** a migration plan selects OpenSpec with Copilot and Claude Code
- **THEN** the fresh target's official framework setup contains skills and commands for all 12 required workflows for both integrations
- **AND** the source project receives no framework files

#### Scenario: Configure the cloud agent only in the migration target
- **WHEN** an OpenSpec migration plan selects GitHub Copilot and enables the cloud coding agent
- **THEN** the two cloud-agent files and matching OpenSpec config value are written only under the fresh target
- **AND** the source project remains unchanged

#### Scenario: Dependency installation affects only the target
- **WHEN** `--install-dependencies` is authorized for a completed migration scaffold
- **THEN** Liftoff runs the selected stack's dependency commands with working directories under the new target
- **AND** it never runs a dependency command from the source path

#### Scenario: Machine installation does not weaken source safety
- **WHEN** migration installs a selected machine tool or configures the authorized global OpenSpec profile outside either project
- **THEN** the source project tree remains byte-for-byte unchanged
- **AND** the machine change is reported separately from source and target writes

### Requirement: Migration keeps a fresh-target-only safety rule
The system SHALL require the migration target to be new or empty even though `init` can merge into an existing non-Liftoff directory. `--force` SHALL NOT authorize migration into a non-empty target.

#### Scenario: Non-empty migration target is rejected
- **WHEN** the chosen migration project name resolves to an existing non-empty directory
- **THEN** migration exits before framework initialization or target writes with guidance to choose a fresh target

#### Scenario: Force does not merge a migration target
- **WHEN** a developer supplies `--force` and the migration target is non-empty
- **THEN** migration still rejects the target and leaves it unchanged

### Requirement: Generated OpenSpec migration work is planning-complete and strict-valid
When migration uses OpenSpec, the generated adoption change SHALL include
schema metadata, a coherent proposal, design, tasks, and proposal-declared
delta specifications. New capability deltas SHALL contain a concrete Purpose.
The staged change SHALL pass strict validation before the target merge.
Generated requirements SHALL describe controlled source adoption and behavior
preservation without inventing domain-specific implementation or marking
adoption tasks complete.

#### Scenario: Migrate with the default OpenSpec workflow
- **WHEN** Liftoff adopts an existing source tree into a fresh generated target
- **THEN** the migration change has all required planning artifacts and passes `openspec validate <change> --strict`
- **AND** the source tree is unchanged

#### Scenario: Bootstrap archive validates all changes
- **WHEN** the generated bootstrap is archived and the complete OpenSpec set is validated
- **THEN** the pending migration change does not fail because metadata, declared deltas, or design are absent
- **AND** its adoption tasks remain pending for their actual implementation

#### Scenario: Validate on supported operating systems
- **WHEN** migration runs from source and target paths containing spaces on Windows, macOS, or Linux
- **THEN** strict validation receives the correct staged project directory
- **AND** artifacts use the same stable logical names and portable path parts

### Requirement: Fresh-target planning does not invent semantic conversion support
A developer's supported target selection SHALL determine the fresh scaffold and placement plan without certifying that legacy application behavior has been converted. Source findings and unresolved mappings SHALL remain visible. Executable application adoption or porting SHALL require a registered supported profile/recipe, exact reviewed effects and actual validation; unsupported source-stack conversion SHALL remain diagnostic or explicitly unresolved planning work.

#### Scenario: The target differs from the detected source
- **WHEN** the developer explicitly chooses a supported target stack different from the source evidence
- **THEN** migration can describe the selected fresh scaffold and source-preserving placement work
- **AND** it does not claim that application behavior has already been converted or that unregistered porting is executable

#### Scenario: A source framework is unsupported
- **WHEN** source assessment finds an unregistered framework or uncertain semantic mapping
- **THEN** those facts remain explicit blockers for executable application conversion
- **AND** generated target files or checked planning tasks cannot substitute for a supported transformation and proof

### Requirement: Project and installation migration retain distinct targets
Fresh-target project migration, reviewed in-place adoption and installation-owner migration SHALL retain separate commands, target identities, plans and permissions. None SHALL infer the other's mutation authority. Native path handling SHALL preserve these boundaries on Windows, macOS and Linux.

#### Scenario: A historical npm user replaces only the CLI
- **WHEN** installation migration is selected
- **THEN** no project scaffold, legacy-source copy, application mapping or manifest rewrite occurs
- **AND** `liftoff migrate` is not offered as the npm-to-native handover command

#### Scenario: The user wants to keep the existing project location
- **WHEN** an existing supported application requests in-place adoption
- **THEN** the CLI identifies the reviewed adopt workflow
- **AND** it does not weaken fresh-target migrate's non-empty-target refusal

#### Scenario: Source and target paths contain spaces
- **WHEN** fresh-target migration operates on Windows, macOS or Linux paths containing spaces or platform-specific separators
- **THEN** it binds and resolves the exact distinct source and destination using native path semantics
- **AND** path aliases, escapes and target overlap cannot authorize source mutation
