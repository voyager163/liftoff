## Purpose

Define the `liftoff migrate` command that adopts existing non-Liftoff projects through a fresh scaffold, a staged legacy copy, and an emitted migration plan, without ever writing to the source project.

## Requirements

### Requirement: Migrate adopts existing projects through a fresh scaffold
The system SHALL provide a `liftoff migrate <path>` command that scans an existing non-Liftoff project, captures project decisions through the standard init prompts, generates a fresh Liftoff scaffold in a new directory beside the source project using the staged official-framework generation pipeline, and SHALL NOT write to the source project in any way.

#### Scenario: Migrate produces a compliant scaffold
- **WHEN** a developer runs `liftoff migrate ../legacy-app` and completes the prompts
- **THEN** a new Liftoff project is generated in a fresh directory with a v3 manifest and complete official framework integration
- **AND** `liftoff validate` passes on it

#### Scenario: Source project is untouched
- **WHEN** a full migrate run completes or fails
- **THEN** the source project's file tree is byte-for-byte identical to its state before the run

#### Scenario: Target directory must be new or empty
- **WHEN** the chosen project name resolves to an existing non-empty directory
- **THEN** migrate fails before target writes even when `--force` is present

### Requirement: The legacy scan is deterministic and feeds prompts and plan
The system SHALL scan the source project read-only for Python, Node.js, and Go dependency files; framework indicators; GenAI and retrieval indicators; environment files; Docker assets; CI workflows; tests; database migrations; frontend indicators; and spec-workflow directories. The scan SHALL run before prompting, its inventory SHALL drive both prompt pre-fill and migration task seeding, and every top-level entry not matched by an explicit detection rule SHALL surface as a placement-decision task.

#### Scenario: Scan detects common Python assets
- **WHEN** the source project contains `requirements.txt`, `.env`, a `Dockerfile`, and a `tests/` directory
- **THEN** the inventory records each finding with its source path

#### Scenario: Scan detects Node.js API evidence
- **WHEN** the source project contains `package.json` with Fastify and TypeScript dependencies
- **THEN** the inventory records strong evidence for the approved standard Node.js API stack

#### Scenario: Scan detects Go API evidence
- **WHEN** the source project contains `go.mod` and Go source using Huma or Chi
- **THEN** the inventory records strong evidence for the approved standard Go API stack

#### Scenario: Nothing is silently dropped
- **WHEN** the source project contains a top-level directory no explicit detection rule recognizes
- **THEN** the emitted plan includes a task to decide that directory's placement

#### Scenario: Scan paths are cross-platform
- **WHEN** migration scans a project on Windows, macOS, or Linux
- **THEN** evidence source paths and staged destinations are resolved with platform-correct path handling while emitted logical paths remain portable

### Requirement: Prompt pre-fill is evidence-based with visible provenance
The system SHALL pre-fill project type, API stack, GenAI pattern, and common init decisions only from strong scan evidence, SHALL display the evidence alongside each pre-filled default, and SHALL leave a decision unresolved when evidence is weak or conflicting. The developer SHALL be able to override every pre-filled value, and non-interactive runs with `--yes` SHALL follow the same project-question semantics as `init` without implying overwrite or installation consent.

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

#### Scenario: Weak evidence leaves type-specific decisions blank
- **WHEN** the scan finds no strong project-type or API-stack indicator
- **THEN** the project-type question is presented without a pre-filled default derived from the scan

#### Scenario: Conflicting evidence requires developer choice
- **WHEN** the scan finds strong evidence for more than one API stack or both standard and GenAI application behavior
- **THEN** the CLI reports the conflicting evidence and requires the developer to choose before generation

### Requirement: Migration output reflects the target project type and API stack
The system SHALL generate the fresh target scaffold and migration plan using the resolved project type and API stack, and SHALL map detected source material to destinations valid for that stack.

#### Scenario: Migrate a standard Go project
- **WHEN** a developer confirms a standard Go/Huma migration plan
- **THEN** the fresh scaffold uses the Go backend layout and database tooling
- **AND** migration tasks map source handlers, configuration, tests, and migrations to Go-specific target locations without introducing GenAI tasks

#### Scenario: Migrate a GenAI project
- **WHEN** a developer confirms a GenAI migration plan
- **THEN** the emitted proposal identifies the GenAI pattern and Python/FastAPI/PydanticAI stack

### Requirement: Legacy source is staged inside the scaffold
The system SHALL copy the source project into `migration/legacy/` within the generated scaffold, excluding version-control, dependency, cache, and build directories; the generated `.gitignore` SHALL cover `migration/legacy/`; and the emitted plan SHALL end with a task that removes the staging directory.

#### Scenario: Staging copy is filtered
- **WHEN** the source project contains `.git/`, `node_modules/`, and application source
- **THEN** `migration/legacy/` contains the application source but not the excluded directories

#### Scenario: Staging directory is ignored by git
- **WHEN** the scaffold is generated
- **THEN** `migration/legacy/` is matched by the generated `.gitignore`

### Requirement: The migration plan is emitted as an executable change
The system SHALL emit the migration plan into the scaffold as an OpenSpec change named `migrate-to-liftoff` containing a proposal and a task list seeded from the scan inventory, with each task mapping staged legacy material to its Liftoff destination, ordered dependencies first and staging cleanup last; the proposal SHALL state the completion gate (all tasks done, `liftoff validate` and `liftoff doctor` green, scaffold tests passing, change archived). When the selected spec workflow is not OpenSpec, the system SHALL emit the same plan as a `MIGRATION.md` checklist instead.

#### Scenario: Emitted change reflects the scan
- **WHEN** the scan detected Python dependencies, env files, and tests
- **THEN** `openspec/changes/migrate-to-liftoff/tasks.md` contains tasks for porting dependencies, mapping environment variables, and relocating tests, referencing paths under `migration/legacy/`

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
The system SHALL apply the same plan-derived workstation readiness, selected-agent configuration, staged official framework initialization, and optional project dependency phase to a migration target as to a new initialized project. The migration source SHALL remain read-only throughout these phases.

#### Scenario: Missing migration target prerequisite
- **WHEN** a resolved migration plan requires a missing blocking runtime or framework CLI
- **THEN** Liftoff obtains the same separate installation consent used by `init`
- **AND** it writes neither the source nor target before blocking requirements are ready

#### Scenario: Configure both agents in a migration target
- **WHEN** a migration plan selects Copilot and Claude Code
- **THEN** the fresh target's official framework setup contains both selected integrations
- **AND** the source project receives no framework files

#### Scenario: Dependency installation affects only the target
- **WHEN** `--install-dependencies` is authorized for a completed migration scaffold
- **THEN** Liftoff runs the selected stack's dependency commands with working directories under the new target
- **AND** it never runs a dependency command from the source path

#### Scenario: Machine installation does not weaken source safety
- **WHEN** migration installs a selected machine tool outside either project
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
