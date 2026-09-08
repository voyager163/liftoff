## MODIFIED Requirements

### Requirement: Migrate adopts existing projects through a fresh scaffold
The system SHALL provide a `liftoff migrate <path>` command that scans an existing non-Liftoff project, captures project decisions through the standard init prompts, generates a fresh Liftoff scaffold in a new directory beside the source project using the staged official-framework generation pipeline, and SHALL NOT write to the source project in any way.

#### Scenario: Migrate produces a compliant scaffold
- **WHEN** a developer runs `liftoff migrate ../legacy-app` and completes the prompts
- **THEN** a new Liftoff project is generated in a fresh directory with a schema-v7 manifest and complete official framework integration
- **AND** `liftoff validate` passes on it

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
