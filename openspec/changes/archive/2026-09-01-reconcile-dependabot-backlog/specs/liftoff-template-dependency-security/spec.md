## ADDED Requirements

### Requirement: Dependency automation preserves integration and ownership boundaries
The system SHALL configure automated dependency proposals so routine version updates target the repository's default integration branch, preserve release-owned supported-stack metadata, respect the selected runtime major, and never rewrite a commit-addressed upstream starter as if it were a Liftoff-owned package graph. Backlog reconciliation SHALL replace overlapping proposals with one reviewable baseline change before superseded pull requests are closed.

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
- **WHEN** a dependency update would modify the commit-addressed Power Apps starter manifest or lockfile
- **THEN** Dependabot does not maintain that upstream snapshot as an ordinary package directory
- **AND** the change proceeds only through selection and verification of a newer immutable upstream commit

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
