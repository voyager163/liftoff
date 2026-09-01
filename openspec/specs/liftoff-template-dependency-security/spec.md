## Purpose

Define security controls for npm dependency templates packaged into generated Liftoff projects, including minimal remediation, reviewed exceptions, deterministic validation, and isolated live auditing.

## Requirements

### Requirement: Every packaged npm template is explicitly audited
The system SHALL maintain an explicit inventory of every npm lockfile packaged for generated projects and SHALL provide a read-only audit command that checks each inventory entry against canonical npm advisory data. Inventory paths SHALL be represented as portable path parts and resolved with platform-native path handling rather than discovered through recursive pattern matching.

#### Scenario: Audit all current packaged templates
- **WHEN** the template dependency audit runs
- **THEN** it checks the standard Node.js backend lockfile, standard frontend lockfile, and current commit-addressed Power Apps starter lockfile
- **AND** it reports the stable logical name and repository-relative path for each audited template

#### Scenario: Run the audit on a supported operating system
- **WHEN** a maintainer runs the audit on Windows, macOS, or Linux
- **THEN** the same logical inventory entries are resolved with platform-correct filesystem paths
- **AND** no path depends on a hardcoded operating-system separator

#### Scenario: Encounter an untracked packaged lockfile
- **WHEN** package inspection finds an npm lockfile intended for generated output that is absent from the explicit audit inventory
- **THEN** verification fails and identifies the untracked packaged path

### Requirement: Fixable template advisories use compatible patched dependencies
The system SHALL update a packaged template dependency when a compatible patched release exists and SHALL select the smallest supported upgrade line that resolves the advisory without unrelated major-version migration. The package manifest and deterministic lockfile MUST remain coherent.

#### Scenario: Remediate the Node.js backend SQL injection advisory
- **WHEN** the Node.js backend template is refreshed for the Drizzle ORM identifier-escaping advisory
- **THEN** its manifest requires a patched Drizzle ORM release
- **AND** its lockfile resolves that patched release without changing the approved Fastify, TypeScript, PostgreSQL, or Drizzle stack

#### Scenario: Remediate the standard frontend development-server advisories
- **WHEN** the standard frontend template is refreshed for its Vite and esbuild advisories
- **THEN** its manifest selects the compatible patched Vite 6 line
- **AND** its lockfile contains patched Vite and esbuild releases without requiring a Vite 8 or Vue plugin major upgrade

#### Scenario: No compatible patch exists
- **WHEN** an advisory has no compatible verified patch
- **THEN** the system does not apply an automatic major upgrade, downgrade, or transitive override
- **AND** the finding remains blocking unless it has a valid reviewed exception

### Requirement: Unresolved advisories require exact time-bounded exceptions
The system SHALL permit an unresolved template advisory only when checked-in structured policy contains an exact exception for the advisory identifier, package, manifest path parts, and complete reviewed dependency-chain set. Every exception MUST record a constrained disposition, technical rationale, mitigation, owner, review date, expiry date, and upstream reference when applicable.

#### Scenario: Accept a non-reachable advisory
- **WHEN** live audit output contains a finding whose vulnerable API is demonstrably not invoked by the generated template
- **THEN** the audit accepts it only when an unexpired exact exception records the non-reachability evidence and mitigation
- **AND** every reported dependency chain matches the exception's reviewed chain set
- **AND** the report identifies the finding as reviewed rather than fixed

#### Scenario: Reject an unreviewed advisory
- **WHEN** live audit output contains a finding with no exact policy entry
- **THEN** the audit exits unsuccessfully
- **AND** it reports the manifest, advisory identifier, package, severity, and affected dependency path

#### Scenario: Reject an expired or overlong exception
- **WHEN** an exception has expired or exceeds the allowed review window for the finding severity
- **THEN** the audit exits unsuccessfully and identifies the owner and required review date

#### Scenario: Reject a stale exception
- **WHEN** policy contains an exception that no longer corresponds to a current finding or an inventoried manifest
- **THEN** the audit exits unsuccessfully and requires the stale entry to be removed or re-established through a new review

#### Scenario: Distinguish the same advisory across templates
- **WHEN** one advisory affects more than one packaged lockfile
- **THEN** each affected manifest requires its own exact remediation or exception
- **AND** an exception for one template does not authorize the finding in another

### Requirement: Upstream-derived templates preserve verified provenance
The system SHALL NOT alter a hash-verified upstream starter, inject a dependency override, or relabel upstream bytes solely to silence a finding that is covered by a valid non-reachability exception. Exceptions for an upstream-derived template SHALL bind to its commit-addressed manifest and SHALL be re-evaluated whenever that upstream snapshot changes.

#### Scenario: Review a Power Apps advisory in unused code
- **WHEN** a Power Apps dependency advisory affects an API not used by the generated SPA or its supported tooling flow
- **THEN** Liftoff preserves the recorded Microsoft starter files and catalog hashes
- **AND** policy records the complete dependency-chain set, evidence, upstream owner, and bounded review date

#### Scenario: Refresh the official Power Apps starter
- **WHEN** maintainers select a newer verified Microsoft starter commit
- **THEN** the template audit treats its new lockfile path and dependency graph as a new review boundary
- **AND** exceptions tied to the previous commit do not carry forward automatically

#### Scenario: Discover reachable vulnerable behavior
- **WHEN** review determines that an affected upstream API is reachable through generated or documented behavior
- **THEN** a non-reachability exception is rejected
- **AND** the template remains blocked until a verified patch or concrete mitigation is provided

### Requirement: Live advisory retrieval is isolated and actionable
The system SHALL run live template advisory retrieval in a dedicated weekly and manually dispatchable workflow using canonical npm. The audit SHALL accept npm's documented finding exit code, distinguish retrieval or parse failures, avoid dependency installation and metadata mutation, and emit an actionable result for every finding.

#### Scenario: Scheduled audit finds only valid exceptions
- **WHEN** the weekly workflow detects no fixable findings and every unresolved finding has a valid exception
- **THEN** it succeeds with counts for clean, fixed, and reviewed template findings

#### Scenario: Scheduled audit finds a new advisory
- **WHEN** canonical npm reports an advisory not represented by a valid exception
- **THEN** the workflow fails and reports the affected template and dependency chain
- **AND** it does not rewrite the package manifest or lockfile

#### Scenario: Canonical advisory retrieval fails
- **WHEN** npm returns an infrastructure exit code, malformed JSON, or an unavailable registry response
- **THEN** the workflow fails as an audit infrastructure error
- **AND** it does not report the templates as secure or silently reuse stale output

### Requirement: Pull-request checks remain deterministic
The system SHALL test inventory validation, audit-result normalization, exception matching, review-window enforcement, and report formatting in ordinary CI using committed fixtures rather than mutable live advisory responses.

#### Scenario: Run ordinary pull-request CI
- **WHEN** a pull request does not invoke the dedicated live audit workflow
- **THEN** security policy tests use committed audit fixtures and a controlled review date
- **AND** results do not change because an external advisory database changed during the run

#### Scenario: Normalize npm audit findings
- **WHEN** fixture output represents direct, transitive, duplicate, or chained vulnerability nodes
- **THEN** the policy engine resolves leaf advisory identifiers and affected manifests deterministically
- **AND** duplicate dependency nodes do not produce ambiguous exception matches

### Requirement: Security refreshes preserve generated-project behavior
The system SHALL validate each dependency refresh through deterministic scaffold generation and the affected template's lockfile-preserving install, build, lint, or test commands. Logical output and audit inventory behavior SHALL remain consistent across Windows, macOS, and Linux.

#### Scenario: Validate the standard Node.js backend refresh
- **WHEN** the backend dependency template is updated
- **THEN** a generated Node.js standard backend completes `npm ci`, TypeScript build, and its generated tests
- **AND** its lockfile installs with both the oldest supported npm 10 baseline and the release npm 11 line
- **AND** its database schema and migration contract remain unchanged

#### Scenario: Validate the standard frontend refresh
- **WHEN** the frontend dependency template is updated
- **THEN** a generated frontend completes `npm ci` and a Vite production build
- **AND** its lockfile installs with both the oldest supported npm 10 baseline and the release npm 11 line
- **AND** its Vue application and static deployment boundary remain unchanged

#### Scenario: Validate unchanged Power Apps provenance
- **WHEN** Power Apps advisories are handled through reviewed exceptions
- **THEN** catalog hash validation still proves the packaged starter bytes
- **AND** the generated starter completes its supported install, lint, and build verification

### Requirement: Reviewed baseline refreshes may cross npm major versions
The system SHALL distinguish a focused advisory remediation from a reviewed supported-stack baseline refresh. A focused remediation SHALL continue selecting the smallest compatible patched release, while a baseline refresh MAY upgrade packaged npm templates across stable major versions only after source compatibility changes, deterministic lock regeneration, security audit, and representative install, build, lint, and test verification are complete.

#### Scenario: Fix one advisory between baseline releases
- **WHEN** a supported current-major patch resolves a newly disclosed advisory
- **THEN** the packaged template uses the smallest verified compatible patch
- **AND** unrelated dependency majors remain unchanged

#### Scenario: Promote a new frontend baseline
- **WHEN** a reviewed baseline refresh moves Vite, its framework plugin, or Tailwind to a newer stable major
- **THEN** the generated frontend source and configuration are migrated together with its manifest and lockfile
- **AND** production build verification passes before the baseline is accepted

#### Scenario: Major candidate remains vulnerable
- **WHEN** a candidate major graph contains an unresolved finding without a valid exact exception
- **THEN** baseline promotion remains blocked

### Requirement: Packaged npm freshness inventory is explicit
The system SHALL maintain explicit named inventory entries for the Liftoff package, telemetry service, standard Node.js backend, standard frontend, and current immutable Power Apps starter package graphs. Freshness and security checks SHALL resolve these paths with platform-native path handling and SHALL fail when a packaged npm graph is absent from the appropriate inventory.

#### Scenario: Check every npm dependency surface
- **WHEN** baseline verification runs
- **THEN** it reports the current and candidate identity for every explicit npm inventory entry
- **AND** no recursive filesystem pattern determines which package graphs are in scope

#### Scenario: Add a packaged npm lock on Windows
- **WHEN** a new generated npm lockfile is introduced
- **THEN** CI fails until its path-part entry and applicable verification are added
- **AND** the inventory resolves equivalently on Windows, macOS, and Linux

### Requirement: Baseline npm verification preserves metadata
Every packaged npm graph SHALL install through its committed lockfile using the baseline and oldest-supported npm compatibility lanes applicable to that graph. Verification SHALL fail if installation, build, lint, or test changes package metadata.

#### Scenario: Verify a refreshed packaged graph
- **WHEN** a package manifest or lockfile changes during baseline refresh
- **THEN** the corresponding generated project completes all documented checks
- **AND** a before-and-after byte comparison confirms that package metadata was not rewritten

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
