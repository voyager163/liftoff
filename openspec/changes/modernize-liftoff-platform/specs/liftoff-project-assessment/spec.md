## Purpose

Provide evidence-backed whole-project assessment before or after Liftoff initialization, keeping observed standards gaps, unsupported scope, and later mutation authority distinct.

## ADDED Requirements

### Requirement: Whole-project assessment works before initialization
The CLI SHALL provide `liftoff assess` for an explicitly selected existing repository, project directory or supported Liftoff project without requiring a manifest, Git initialization, framework initialization, agent integration, activation state, model, or cloud credentials. Assessment SHALL be local and read-only: it SHALL NOT run project code, prepare dependencies, install tools or skills, initialize metadata, acquire write approval, create preview receipts, change Git, or make network calls. Live governance comparison SHALL remain a separately selected supported governance assessment operation.

#### Scenario: Assess an ordinary repository
- **WHEN** a developer selects a repository that has no Liftoff files
- **THEN** assessment reports available project facts and standards coverage
- **AND** it creates no manifest, configuration, framework files, skills, activation state, or approval

#### Scenario: Existing application has no VCS metadata
- **WHEN** an existing project directory is explicitly selected without a Git repository
- **THEN** assessment reports actual application facts and the absence of VCS metadata
- **AND** it does not initialize Git or a Liftoff project to perform the inspection

#### Scenario: Assess an initialized production project
- **WHEN** a supported project's business files have diverged from their generated templates
- **THEN** assessment examines actual bounded evidence without restoring starter bytes or rerunning setup
- **AND** its report does not expand ordinary update ownership

#### Scenario: A report suggests live comparison
- **WHEN** a finding needs repository or Azure proof that local assessment cannot establish
- **THEN** the report marks that proof unobserved and identifies the separate scoped read-only action
- **AND** it does not contact a provider merely because credentials are available

### Requirement: Assessment pins a versioned standards target
Assessment SHALL bind its target to an explicit release-owned standards profile with schema 1, stable profile identity, version or immutable revision, digest, supported component boundaries, and declared evaluation coverage. It SHALL identify the installed CLI and capability protocol independently from recorded project provenance. The executable profile inventory SHALL be limited to the existing supported FastAPI, Fastify, Go/Huma, Vue, and current GenAI profiles. Strong observations can propose a profile, but uncertainty or conflicting evidence SHALL remain visible until an explicit target is resolved. Assessment SHALL NOT resolve mutable latest templates or invent a framework conversion target.

#### Scenario: A supported Fastify project is observed
- **WHEN** dependency declarations and source evidence identify the supported Fastify profile
- **THEN** the report identifies the exact evidence and installed profile target
- **AND** a framework name in comments alone is not treated as that evidence

#### Scenario: A repository contains multiple components
- **WHEN** a supported backend and a Vue frontend are present at distinct component roots
- **THEN** the report identifies each observed component and its applicable selected profile
- **AND** conflicting roots or overlapping target claims remain unresolved rather than being collapsed into one starter

#### Scenario: An unsupported stack is present
- **WHEN** assessment observes Express, an unregistered framework, or an unsupported variant of a supported stack
- **THEN** it reports observed facts and the unsupported profile or evaluator boundary
- **AND** it offers no automatic conversion to Fastify, FastAPI, Go/Huma, Vue, or GenAI

#### Scenario: A newer release exists
- **WHEN** a newer upstream CLI or profile is available
- **THEN** the assessment remains bound to the selected installed target
- **AND** it neither downloads a replacement nor rewrites project identity

### Requirement: Project boundaries and inventory are explicit and portable
Assessment SHALL resolve an explicit target authoritatively and otherwise disclose the nearest applicable project or repository boundary. It SHALL support native Windows, macOS, and Linux paths, Git worktree files, nested projects, and paths with spaces without assuming project root equals repository root. Bounded inventory SHALL cover applicable source and reference locations, dependency declarations and locks, tests and build definitions, application configuration, documentation, containers, infrastructure declarations, workflows, framework and agent markers, managed core, and recorded provenance. Inventory SHALL distinguish observed files, exclusions, unreadable or unsupported scope, and limits; it SHALL NOT inspect credential, private-key, or state payloads.

#### Scenario: A nested component is explicitly selected
- **WHEN** assessment selects a supported component below a repository root
- **THEN** the report preserves both the selected project/component boundary and its repository context
- **AND** it does not silently inventory or propose ownership of sibling applications

#### Scenario: Windows paths have ambiguous identities
- **WHEN** a selected or inventoried path contains traversal, unsafe links or junctions, case or normalization collisions, or ambiguous drive or UNC resolution
- **THEN** assessment reports the unsafe or ambiguous identity before accessing the affected target
- **AND** the same confinement rule applies on macOS and Linux without textual-prefix shortcuts

#### Scenario: A malformed inner manifest is found
- **WHEN** the selected boundary contains a malformed, unreadable, linked, dangling, unknown-schema, or retired-workload manifest
- **THEN** assessment reports that boundary error without trusting paths from the invalid manifest
- **AND** it does not walk outward or pretend that the same boundary is an ordinary uninitialized repository

#### Scenario: A bounded scan cannot observe all files
- **WHEN** size, count, time, permissions, or supported-parser limits prevent complete inventory
- **THEN** the report identifies the affected scope and reason
- **AND** an unobserved file is not represented as absent or compliant

### Requirement: Findings preserve evidence and semantic uncertainty
Each finding SHALL identify a stable rule, target profile, applicable scope, expected behavior, observed facts, evidence references and digests, severity, classification, limitations, and advisory next action. Findings SHALL distinguish alignment, known differences, missing items established by complete observation, conflicts, permitted validated exceptions, inapplicability, and unobserved or unsupported evaluation. A filename, framework marker, generation hash, passing command receipt, model assertion, or HTTP status alone SHALL NOT prove business behavior or standards conformance.

#### Scenario: Custom code satisfies a supported rule
- **WHEN** observed custom implementation satisfies the rule's actual declared evidence requirements
- **THEN** assessment does not report a gap solely because the file differs from a starter
- **AND** generation hashes remain provenance rather than replacement permission

#### Scenario: Test declarations exist but tests were not executed
- **WHEN** inventory finds a test suite without fresh matching execution evidence
- **THEN** the report distinguishes the presence of tests from verified runtime behavior
- **AND** assessment does not execute the suite or claim that it passes

#### Scenario: API documentation returns a frontend page
- **WHEN** available evidence shows HTTP 200 but the expected schema response is HTML or lacks the required OpenAPI structure
- **THEN** the documentation contract is not reported as satisfied
- **AND** the finding identifies the missing JSON content-type and schema evidence

#### Scenario: An assumption is supplied by an agent
- **WHEN** a model proposes that a source mapping or custom behavior is safe without sufficient observations
- **THEN** the assumption remains explicitly unverified
- **AND** it cannot become a conformance result or executable adoption mapping

### Requirement: Assessment reports honest coverage and reproducible snapshots
The new assessment result SHALL use a versioned schema-1 command envelope and retain target, project and component identities, captured input digests, observation time, inventory, findings, diagnostics, applicability, coverage counts, and outcome. It SHALL remain distinct from the existing governance-assessment report contract. Equivalent captured inputs and clock SHALL produce deterministic ordering and findings. Changed inputs during collection SHALL invalidate dependent comparisons rather than combine incompatible snapshots. Known gaps SHALL remain visible alongside missing evidence.

#### Scenario: Enumeration order changes
- **WHEN** equivalent file observations arrive in another order
- **THEN** normalized findings, coverage, and result identity remain equivalent
- **AND** host-specific separators do not change logical evidence identity

#### Scenario: Source changes during collection
- **WHEN** a protected declaration or reference changes before its dependent comparisons finish
- **THEN** those comparisons are reported as unstable or unobserved
- **AND** no clean whole-project claim is emitted

#### Scenario: Selected scope is fully observed
- **WHEN** all applicable supported rules for the selected scope have complete matching evidence and no differences
- **THEN** assessment exits 0 for that assessed scope
- **AND** it does not claim completed adoption, activation, or behavior outside the profile's declared coverage

#### Scenario: Differences or coverage gaps remain
- **WHEN** a valid report contains differences, unsupported evaluation, or incomplete observations
- **THEN** assessment exits 2 with the known findings and exact limitations
- **AND** unsupported stacks are not represented as executable adoption candidates

#### Scenario: The report cannot be trusted
- **WHEN** required input identity, path safety, profile integrity, or catalog validation fails
- **THEN** assessment exits 1 with a bounded versioned diagnostic
- **AND** it does not emit an aligned fallback

### Requirement: Recommendations preserve operation and ownership boundaries
Assessment SHALL distinguish managed-core update, supported in-place adoption, explicit application or infrastructure repair, fresh-target migration, repository enforcement, Azure activation, and installation maintenance. Every available recommendation SHALL name a real installed capability and provide context-bound `executable`, `args`, `cwd`, `scope`, `project`, configuration binding, compatibility requirements, and required approval. Unsupported work SHALL remain a blocker rather than an invented command. Reports SHALL contain bounded sanitized facts and no raw source bodies, credential values, sensitive state, or secret-bearing command output.

#### Scenario: A supported uninitialized application needs integration
- **WHEN** assessment finds a supported stack with missing Liftoff metadata
- **THEN** it recommends an in-place adoption preview for the same project
- **AND** the report itself is neither an adoption receipt nor permission to initialize over the application

#### Scenario: Managed drift and application gaps coexist
- **WHEN** a project has outdated managed skills and a customized handler needing remediation
- **THEN** recommendations distinguish reviewed core update from the separate exact per-file evolution plan
- **AND** force-update is not offered as an application repair

#### Scenario: A continuation uses a relative configuration input
- **WHEN** assessment was invoked outside the selected project with a relative inputs reference
- **THEN** the next action preserves the resolved reference and digest despite its different working directory
- **AND** its Windows and POSIX display forms preserve the same literal target and scope

#### Scenario: A collector encounters sensitive output
- **WHEN** an observation or diagnostic contains credentials or prohibited payloads
- **THEN** those values are withheld before truncation, output, or retention
- **AND** any resulting evidence limitation remains explicit
