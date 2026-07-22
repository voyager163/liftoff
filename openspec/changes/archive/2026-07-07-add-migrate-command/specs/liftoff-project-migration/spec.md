# liftoff-project-migration

## ADDED Requirements

### Requirement: Migrate adopts existing projects through a fresh scaffold
The system SHALL provide a `liftoff migrate <path>` command that scans an existing non-Liftoff project, captures project decisions through the standard creation prompts, generates a fresh Liftoff scaffold in a new directory beside the source project using the standard generation pipeline, and SHALL NOT write to the source project in any way.

#### Scenario: Migrate produces a compliant scaffold
- **WHEN** a developer runs `liftoff migrate ../legacy-app` and completes the prompts
- **THEN** a new Liftoff project is generated in a fresh directory with a v2 manifest, and `liftoff validate` passes on it

#### Scenario: Source project is untouched
- **WHEN** a full migrate run completes
- **THEN** the source project's file tree is byte-for-byte identical to its state before the run

#### Scenario: Target directory must be new or empty
- **WHEN** the chosen project name resolves to an existing non-empty directory
- **THEN** migrate fails with the same safety error as `create`

### Requirement: The legacy scan is deterministic and feeds prompts and plan
The system SHALL scan the source project read-only for dependency files, framework indicators, environment files, Docker assets, CI workflows, tests, database migrations, frontend indicators, and spec-workflow directories; the scan SHALL run before prompting and its inventory SHALL drive both prompt pre-fill and migration task seeding. Every top-level entry not matched by a detection rule SHALL surface as an explicit placement-decision task.

#### Scenario: Scan detects common assets
- **WHEN** the source project contains `requirements.txt`, `.env`, a `Dockerfile`, and a `tests/` directory
- **THEN** the inventory records each finding with its source path

#### Scenario: Nothing is silently dropped
- **WHEN** the source project contains a top-level directory no detection rule recognizes
- **THEN** the emitted plan includes a task to decide that directory's placement

### Requirement: Prompt pre-fill is evidence-based with visible provenance
The system SHALL pre-fill creation prompts only from strong scan evidence, SHALL display the evidence alongside each pre-filled default, and SHALL leave prompts blank when evidence is weak. The developer SHALL be able to override every pre-filled value, and non-interactive runs with `--yes` SHALL follow the same semantics as `create`.

#### Scenario: Strong evidence pre-fills with provenance
- **WHEN** the source project contains a `frontend/` directory with a React dependency
- **THEN** the frontend prompt defaults to yes and shows what was detected and where

#### Scenario: Weak evidence leaves the prompt blank
- **WHEN** the scan finds no strong indicator for the GenAI pattern
- **THEN** the pattern prompt is presented without a pre-filled default

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
