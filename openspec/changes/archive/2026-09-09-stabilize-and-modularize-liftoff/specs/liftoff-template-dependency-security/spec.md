## MODIFIED Requirements

### Requirement: Every packaged npm template is explicitly audited
The system SHALL maintain an explicit inventory of every npm lockfile packaged for generated projects and SHALL provide a read-only audit command that checks each inventory entry against canonical npm advisory data. Inventory paths SHALL be represented as portable path parts and resolved with platform-native path handling rather than discovered through recursive pattern matching.

#### Scenario: Audit all current packaged templates
- **WHEN** the template dependency audit runs
- **THEN** it checks the standard Node.js backend lockfile and the standard frontend lockfile
- **AND** it reports the stable logical name and repository-relative path for each audited template

#### Scenario: Run the audit on a supported operating system
- **WHEN** a maintainer runs the audit on Windows, macOS, or Linux
- **THEN** the same logical inventory entries are resolved with platform-correct filesystem paths
- **AND** no path depends on a hardcoded operating-system separator

#### Scenario: Encounter an untracked packaged lockfile
- **WHEN** package inspection finds an npm lockfile intended for generated output that is absent from the explicit audit inventory
- **THEN** verification fails and identifies the untracked packaged path

### Requirement: Security refreshes preserve generated-project behavior
The system SHALL validate each dependency refresh through deterministic scaffold generation and the affected template's lockfile-preserving install, build, lint, or test commands. Logical output and audit inventory behavior SHALL remain consistent across Windows, macOS, and Linux.

#### Scenario: Validate the standard Node.js backend refresh
- **WHEN** the backend dependency template is updated
- **THEN** a generated Node.js standard backend completes `npm ci`, TypeScript build, and its generated tests
- **AND** its lockfile installs with both the oldest supported npm 10 baseline and the release-owned npm 12 line
- **AND** its database schema and migration contract remain unchanged

#### Scenario: Validate the standard frontend refresh
- **WHEN** the frontend dependency template is updated
- **THEN** a generated frontend completes `npm ci` and a Vite production build
- **AND** its lockfile installs with both the oldest supported npm 10 baseline and the release-owned npm 12 line
- **AND** its Vue application and static deployment boundary remain unchanged

#### Scenario: Validate unchanged Power Apps provenance
- **WHEN** a retained Power Apps artifact exists only as a retired negative fixture
- **THEN** template-security verification does not treat it as a supported generated npm template
- **AND** it preserves that retired fixture outside active scaffold install, lint, build, or provenance checks

### Requirement: Packaged npm freshness inventory is explicit
The system SHALL maintain explicit named inventory entries for the Liftoff package, telemetry service, standard Node.js backend, and standard frontend package graphs. Freshness and security checks SHALL resolve these paths with platform-native path handling and SHALL fail when a packaged npm graph is absent from the appropriate inventory.

#### Scenario: Check every npm dependency surface
- **WHEN** baseline verification runs
- **THEN** it reports the current and candidate identity for every explicit npm inventory entry
- **AND** no recursive filesystem pattern determines which package graphs are in scope

#### Scenario: Add a packaged npm lock on Windows
- **WHEN** a new generated npm lockfile is introduced
- **THEN** CI fails until its path-part entry and applicable verification are added
- **AND** the inventory resolves equivalently on Windows, macOS, and Linux

### Requirement: Dependency automation preserves integration and ownership boundaries
The system SHALL configure automated dependency proposals so routine version updates target the repository's default integration branch, preserve release-owned supported-stack metadata, respect the selected runtime major, and never treat retired or historical Power Apps artifacts as active package graphs. Backlog reconciliation SHALL replace overlapping proposals with one reviewable baseline change before superseded pull requests are closed.

#### Scenario: Dependabot targets the default integration branch
- **WHEN** `develop` is the repository's default integration branch
- **THEN** new Dependabot version and security pull requests target `develop`
- **AND** the repository does not add a redundant branch override that can diverge from the default-branch security flow

#### Scenario: Group routine version updates by package graph
- **WHEN** multiple minor or patch version updates are available for one explicitly configured npm package graph
- **THEN** Dependabot groups them into one version-update pull request for that graph
- **AND** major updates remain separately reviewable

#### Scenario: Runtime type major exceeds the selected LTS
- **WHEN** the supported runtime is Node 24 LTS and Dependabot discovers an `@types/node` semantic-major update for Node 26
- **THEN** version-update automation suppresses that major proposal for each Node 24 package graph
- **AND** security update detection and other dependency majors remain enabled

#### Scenario: Upstream starter dependency changes
- **WHEN** a dependency update would touch a retired Power Apps starter artifact or other Power Apps historical bytes
- **THEN** dependency automation does not maintain it as an active package directory
- **AND** any review of that retired artifact proceeds through explicit historical maintenance rather than ordinary dependency proposals

#### Scenario: Retired Power Apps files are not automated package directories
- **WHEN** a retained Power Apps manifest, lockfile, or historical asset exists only for unsupported-workload detection or diagnostics
- **THEN** dependency automation does not manage it as an active package directory
- **AND** any review of that retired artifact proceeds through explicit historical maintenance rather than ordinary dependency proposals

#### Scenario: Overlapping baseline proposals are admissible
- **WHEN** multiple open dependency pull requests modify supported-stack-managed manifests or locks and their candidates remain compatible
- **THEN** maintainers regenerate the affected package graphs and supported-stack identities together in one replacement change targeting `develop`
- **AND** the replacement records every superseded pull request and validates all affected graphs

#### Scenario: Proposed candidate fails compatibility
- **WHEN** an individual dependency candidate fails the selected runtime, oldest-supported toolchain, build, test, security, or generated-project checks
- **THEN** the replacement change excludes that candidate and records the incompatibility
- **AND** the failed Dependabot pull request is not merged independently

#### Scenario: Close a superseded Dependabot pull request
- **WHEN** the replacement branch, candidate metadata, and required validation evidence are available
- **THEN** each superseded, incompatible, or provenance-violating pull request receives an explanatory closure
- **AND** exact associated remote branch refs are verified and removed when Dependabot does not clean them up

#### Scenario: Resolve configured package directories across platforms
- **WHEN** dependency configuration or verification maps the root, telemetry service, standard Node backend, and standard frontend graphs on Windows, macOS, or Linux
- **THEN** each graph is selected from an explicit named directory entry
- **AND** internal filesystem access uses platform-correct path handling rather than recursive pattern discovery

## REMOVED Requirements

### Requirement: Upstream-derived templates preserve verified provenance
**Reason**: No supported npm template now depends on a packaged immutable upstream starter snapshot. The Power Apps commit-addressed starter is retired together with the workload.

**Migration**: Remove Power Apps lockfiles and provenance checks from active audit, freshness, and automation scopes. Any retained Power Apps bytes stay explicit retired fixtures outside supported template generation and ordinary dependency maintenance.
