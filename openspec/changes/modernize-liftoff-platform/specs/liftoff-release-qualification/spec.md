## Purpose

Define the evidence and coordinated publication gate that prove each Liftoff release meets its coverage, native-platform, compatibility, recovery, and delivered-capability promises.

## ADDED Requirements

### Requirement: CLI and telemetry coverage independently exceed every threshold
Release qualification SHALL require lines, branches, functions, and statements strictly greater than 80 percent for the CLI package and the telemetry service separately. Each decision SHALL use actual covered and total counts, with acceptance requiring `covered * 100 > total * 80`, not a rounded displayed percentage or a greater-than-or-equal threshold. A missing, invalid, or zero-denominator required metric SHALL block qualification rather than count as a pass.

#### Scenario: A metric is exactly eighty percent
- **WHEN** either package covers 80 of 100 branches while its other metrics pass
- **THEN** that package and the coordinated release fail qualification
- **AND** the report names the package, branch numerator, denominator, and strict threshold

#### Scenario: Display rounding hides the true ratio
- **WHEN** a valid covered/total ratio is strictly greater than 80 percent but rounds to `80.00` for display
- **THEN** the decision uses the exact counts and accepts that metric
- **AND** display formatting does not change the threshold

#### Scenario: One package masks another
- **WHEN** the CLI has high coverage but any telemetry metric is at or below 80 percent
- **THEN** qualification fails regardless of the combined average
- **AND** CLI and telemetry results remain separate for all four metrics

#### Scenario: No usable measurement exists
- **WHEN** a required package report is absent, malformed, missing a metric, or has a zero denominator
- **THEN** qualification reports missing coverage evidence
- **AND** it does not infer 100 percent from an empty report

### Requirement: Coverage includes unimported production code without scope manipulation
Each package's coverage scope SHALL include all of its production TypeScript and JavaScript, including unimported modules, and SHALL use coverage tooling compatible with and pinned to that package's selected Vitest version. The release SHALL publish an explicit source inventory and the covered/total measurements. Excluding, relocating, reclassifying, or omitting production code solely to increase the percentage SHALL NOT satisfy qualification. Changes to legitimate measurement scope SHALL be reviewed and disclosed without silently narrowing the whole-package claim.

#### Scenario: A production module is never imported
- **WHEN** a production TypeScript or JavaScript module receives no test import
- **THEN** it remains in its package's denominator with its actual uncovered counts
- **AND** a test-import-only report is rejected as incomplete

#### Scenario: A weakly tested production path is excluded
- **WHEN** a coverage change removes production execution paths from the inventory to clear the gate
- **THEN** qualification rejects that evidence
- **AND** moving the same behavior into an unmeasured directory does not resolve the failure

#### Scenario: Coverage tooling is incompatible
- **WHEN** a selected coverage provider cannot produce valid counts for its package's pinned test-runner version
- **THEN** qualification fails with the tooling mismatch
- **AND** a skipped coverage run is not accepted as behavioral test success

### Requirement: Native helpers have separately disclosed qualification
Qualification SHALL explicitly inventory production native helper code and distinguish its appropriate instrumentation and execution evidence from V8 coverage of TypeScript/JavaScript. Helper code SHALL NOT silently disappear from a whole-package assurance claim or be described as V8-covered. Required helper behavior SHALL have native-platform evidence, including failure, cancellation, process settlement, and recovery; unmeasured helper scope SHALL be disclosed and SHALL block a claim of complete required qualification.

#### Scenario: Windows controller is outside V8 coverage
- **WHEN** the release includes a Windows process-controller helper not measured by V8
- **THEN** reports identify its separate source scope, instrumentation or applicable qualification method, and native results
- **AND** the CLI's four percentages are not represented as measuring that helper

#### Scenario: Helper is mocked on another operating system
- **WHEN** portable regression tests replace Windows process behavior with a fixture
- **THEN** the result is labeled fixture-based evidence
- **AND** it cannot satisfy the required native Windows controller qualification

#### Scenario: A helper has no qualification evidence
- **WHEN** a required production helper is shipped without its declared measurement and behavioral evidence
- **THEN** the coordinated release remains blocked even if all TypeScript/JavaScript percentages pass

### Requirement: Every supported native target proves installed runtime closure
The coordinated release SHALL qualify macOS, Windows, and Linux on x64 and arm64 at their declared host floors, including the selected Linux glibc baseline. Each final signed artifact SHALL be installed and invoked outside its build checkout without ambient Node/npm, with read-only installation resources and cwd-independent lookup. Qualification SHALL cover native launchers, resources, documented host constraints, and selected-project subprocess execution separately from private runtime startup.

#### Scenario: Exercise the installed public surface
- **WHEN** a final artifact is installed in an isolated target environment
- **THEN** version, help, init help, side-effect-free plan, upgrade help, capability discovery, and representative template, policy, and skill operations use the public `liftoff` entrypoint
- **AND** `create` is rejected with init migration guidance without creating a project

#### Scenario: Qualify relocated paths
- **WHEN** the installation and project locations contain spaces on Windows, macOS, or Linux
- **THEN** native executables, shims, resources, literal argument arrays, and displayed continuations resolve the intended locations
- **AND** case collisions, path escapes, and missing inventory entries fail admission rather than resolving an unintended file

#### Scenario: A platform is missing
- **WHEN** Linux qualification passes but a required Windows or macOS target fails or has not run
- **THEN** stable publication remains blocked
- **AND** no architecture is relabeled supported using another platform's result

#### Scenario: Private runtime passes but project tools do not
- **WHEN** installed Liftoff runs but the selected external Node, npm, Python, Go, or specification tool is unavailable
- **THEN** project readiness remains blocked with its actual requirement
- **AND** the runtime-closure result does not stand in for project-execution qualification

### Requirement: Windows qualification resolves the observed execution failures
Qualification SHALL reproduce and investigate the v0.12.3 Windows verification/controller timeouts, npm identity rejection, and uncertain workspace-settlement symptoms under the actual supported controller, protocol, and host conditions. The resulting release SHALL have evidence for the corrected behavior and bounded failure paths. Increasing timeouts, excluding failing scenarios, weakening execution policy, or treating uncertain settlement as success SHALL NOT constitute resolution.

#### Scenario: Reproduce baseline Windows symptoms
- **WHEN** the qualification work evaluates failures observed for commit `70d10881b46d873118d825735696f39b6d35ebe0`
- **THEN** it records the relevant host and executable conditions, observed failure, established cause, and corresponding regression evidence
- **AND** an observation alone is not labeled a proven root cause

#### Scenario: Process settlement remains uncertain
- **WHEN** a verifier or controller cannot establish that the supervised process tree has settled
- **THEN** the operation remains failed or blocked and preserves the uncertain workspace and recovery evidence
- **AND** a longer wait without verified settlement cannot turn the result into success

#### Scenario: Enterprise policy blocks a helper
- **WHEN** a declared supported Windows host reports a PowerShell/.NET, Restricted-policy, AppLocker, or WDAC admission problem
- **THEN** qualification records the exact supported-host limitation and remedy
- **AND** it does not use an execution-policy bypass as the supported solution

### Requirement: Qualification exercises owner-aware handover and compatibility recovery
Release evidence SHALL cover actual installation-owner decisions, manager-source lag, enterprise policy, direct staged replacement, npm-to-native launcher conflicts, Windows locks, partial failures, stale approvals, and owner-specific recovery in isolated installations. It SHALL also cover supported historical manifest, activation, update, and repair readers and the exact registered new transitions without rewriting historical identities. Tests SHALL NOT mutate the runner's real installation, user projects, or unrelated package-manager configuration.

#### Scenario: Qualify the legacy handover
- **WHEN** migration fixtures contain npm-owned Liftoff beneath Homebrew Node, a conflicting Windows npm shim, or a Linux direct-launcher conflict
- **THEN** evidence proves actual-owner classification, unlinked verification, explicit approval, correct retirement/install ordering, and final PATH verification
- **AND** Node, npm, project dependencies, and unrelated launchers remain preserved

#### Scenario: Qualification requires manager availability
- **WHEN** an upstream artifact exists but the approved Homebrew or WinGet source does not deliver that exact version
- **THEN** the check identifies upstream availability and manager readiness separately
- **AND** no cross-channel replacement is accepted as equivalent evidence

#### Scenario: Historical data is replayed
- **WHEN** qualification reads supported v2-v7 manifests, historical activation v1/v2/v3 records, or registered update and repair recovery records
- **THEN** original identities, receipt meanings, and bytes remain preserved
- **AND** migration to current contracts requires the exact supported transition and new proof rather than a SemVer guess or hash retag

#### Scenario: Approval becomes stale
- **WHEN** candidate bytes, source files, configuration bindings, owner records, or intended effects change after approval
- **THEN** the affected operation rejects the stale plan before new effects
- **AND** qualification verifies truthful reporting of any earlier separately approved effects

### Requirement: Every promised capability has real outcome evidence
The release SHALL trace every capability in the coordinated scope to its admitted inputs, executable behavior, independently verified outcomes, failure/recovery behavior, and applicable platform/profile evidence. Generated files, capability names, static success payloads, model assertions, or injected-only producers SHALL NOT establish production implementation. Required production executors SHALL receive separately authorized disposable GitHub/Azure qualification for their exact provider, host, and recipe combinations, with explicit resource, spending, and time bounds.

#### Scenario: A required executor is not implemented
- **WHEN** a required workflow, credential, provider, private-state, runner, artifact, deployment, qualification, ruleset, or readback producer is unavailable
- **THEN** the coordinated release remains incomplete
- **AND** removing a blocker label or declaring the producer externally supplied does not satisfy the agreed scope

#### Scenario: Live qualification access is missing
- **WHEN** signing identities, approved runners, credentials, or disposable qualification resources have not been authorized
- **THEN** qualification records the missing external prerequisite and blocks publication
- **AND** it neither provisions resources implicitly nor substitutes mocked provider success

#### Scenario: Credential permission policy changes
- **WHEN** source acceptance evaluates policy 8 and credential-policy schema 2
- **THEN** it proves exact App/PAT grant admission, broader-read disclosure, operation confinement, fresh approval, stale/extra/missing-grant rejection and byte-preserving handling of original policies and approvals
- **AND** a fixture pass does not qualify real credential use, resolve PAT identity/lifetime or conditional-create gaps, or authorize provider effects

#### Scenario: Repository-only enforcement passes
- **WHEN** actual positive and controlled-negative source checks and exact ruleset readback qualify the selected repository-only scope
- **THEN** that evidence proves repository enforcement only
- **AND** it cannot satisfy full activation, production rehearsal, or staging qualification

#### Scenario: Template corrections are qualified
- **WHEN** the release claims the Azure baseline and API-documentation routing fixes
- **THEN** generated-output evidence verifies the required TLS/private-blob settings and actual Scalar/schema behavior for all affected supported profiles
- **AND** HTTP 200 alone or regenerated starter files do not prove existing-project remediation

### Requirement: Release version and product identity agree across all delivery surfaces
Before publication, root package and lockfile metadata, the release Git tag where applicable, native build information, signed release manifest, packaged metadata, installed version output, and owner-channel records SHALL identify the same canonical Liftoff product and semantic version from the reviewed release commit. Consistent use of a noncanonical identity SHALL still fail. Historical npm verification exceptions SHALL NOT exempt a native artifact from exact installed-version verification.

#### Scenario: All version-bearing surfaces agree
- **WHEN** the candidate's source metadata, tag, final artifact, manifest, installed CLI, and channel records all identify the approved release
- **THEN** release identity verification passes for those exact artifacts

#### Scenario: One delivery surface differs
- **WHEN** a lockfile version, Git tag, packaged version, or installed output disagrees with the approved release
- **THEN** publication fails with the expected and observed identities
- **AND** an internally consistent but different package name also fails

#### Scenario: A native artifact requests a historical exception
- **WHEN** native qualification attempts to use the immutable npm `0.3.3` version-command exception
- **THEN** qualification rejects the exception
- **AND** the native artifact still must print its exact `Liftoff <version>` identity

### Requirement: Stable publication is one immutable coordinated gate
All required build, test, coverage, compatibility, documentation, native-artifact, channel, production-capability and telemetry-dashboard evidence SHALL bind the same immutable release source commit and the exact final artifact or dashboard-definition identities they qualify. The stable channel and coordinated completion announcement SHALL advance only after every required check, channel and independently approved operator-dashboard qualification is ready. Artifact staging and manager submission SHALL be permitted before that gate only as explicitly incomplete preparation; publication lag SHALL remain explicit and SHALL NOT authorize a partial stable release, unsigned replacement, npm bridge, or unqualified rebuild.

#### Scenario: Reuse evidence from another commit
- **WHEN** one required check passed for an earlier commit or a different artifact checksum
- **THEN** the coordinated gate rejects that evidence for the candidate
- **AND** the changed identity requires fresh applicable qualification

#### Scenario: Signing or rebuilding changes bytes
- **WHEN** a release candidate changes after installed-artifact qualification
- **THEN** the final manifest and affected installed-artifact evidence must be regenerated for those final bytes
- **AND** a source-only match does not excuse the artifact mismatch

#### Scenario: Package-manager submission is pending
- **WHEN** signed artifacts have been staged but a required tap or WinGet catalog identity is not available and verified
- **THEN** the release reports the channel as pending or blocked
- **AND** stable publication and the coordinated announcement remain gated

#### Scenario: All required evidence agrees
- **WHEN** the full capability and platform matrix, both coverage reports, documentation inventory, required delivery channels and telemetry dashboard verify the same release and definition identities
- **THEN** the stable channel can advance as one coordinated release
- **AND** no required executor or recovery path is silently deferred to a later release

### Requirement: Current ruleset response compatibility is qualified end to end
Qualification SHALL cover #82's three supported pull-request fields together and individually, older omission, nonempty reviewer and enabled dismissal restrictions, effective zero-review behavior, malformed values and genuinely unknown enforcement. Normalization, assessment, planning and actual supported readback SHALL agree without discarding meaningful data or mutating neutral defaults solely for compatibility.

#### Scenario: Default fields are returned during repository qualification
- **WHEN** GitHub returns disabled/empty restrictions and a true extra-approval flag under a zero-review rule
- **THEN** the supported observation and effective policy comparison succeed
- **AND** no unnecessary control write or unsupported-response result is accepted as the resolution

#### Scenario: Nonempty or invalid data is exercised
- **WHEN** qualification tests meaningful reviewer constraints, enabled actor restrictions, malformed shapes and unknown fields
- **THEN** meaningful supported values are preserved and invalid/unknown enforcement remains blocked
- **AND** removing strict validation or ignoring arbitrary fields cannot pass qualification

### Requirement: Grafana dashboard qualification proves data meaning access and lifecycle
The coordinated release SHALL qualify the committed dashboard in the selected Azure Monitor Grafana host using the existing telemetry schema and configured data source. It SHALL compare rendered aggregates with equivalent bounded KQL, test time/command/version filters, empty and denied/query-failure states, current-user access boundaries, readable native layout and idempotent operator provisioning. Structural JSON validity alone SHALL NOT establish a working dashboard.

#### Scenario: Rendered values are checked against query results
- **WHEN** authorized qualification opens the committed dashboard with a known time range and filters
- **THEN** event, command, version, outcome and latest-event values agree with equivalent data queries
- **AND** nonzero exits and recorded events are not mislabeled as crashes or unique users

#### Scenario: Empty and denied cases are qualified
- **WHEN** a successful empty query and an unauthorized or failed query are exercised
- **THEN** the dashboard presents different truthful states
- **AND** access/query errors never pass as zero usage or healthy operation

#### Scenario: Operator provisioning is qualified
- **WHEN** the approved dashboard definition is deployed and reconciled again
- **THEN** actual resource/readback and repeat no-op behavior match source
- **AND** ingestion, retention, workspace data and unrelated resources remain intact

#### Scenario: The selected host cannot render the required model
- **WHEN** the Azure Monitor dashboard API, region or supported data-source behavior cannot satisfy the required contract
- **THEN** dashboard qualification remains blocked
- **AND** the release does not silently create Managed Grafana, add tracking fields or declare an unrendered JSON file complete
