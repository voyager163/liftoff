## Purpose

Let developers compare their project's recorded and declared governance with
observable enforcement and the installed Liftoff policy, without changing the
project, granting upgrade authority, or presenting unknown controls as aligned.

## ADDED Requirements

### Requirement: Assessment pins an explicit installed target
Assessment SHALL identify the installed CLI version, selected target profile,
policy version and content digest, activation contract, phase-graph hash, and
assessment-catalog schema and digest. It SHALL compare that target with the
project's recorded identity without resolving registry latest or replacing the
installed CLI.

#### Scenario: Registry latest differs from the installed CLI
- **WHEN** assessment runs with an installed release older than registry latest
- **THEN** the target remains the installed release and its packaged policy
- **AND** the report does not fetch or substitute latest as the comparison target

#### Scenario: CLI versions match but configuration differs
- **WHEN** project metadata and the CLI report the same SemVer but managed bytes or governance settings differ
- **THEN** assessment reports the actual differences rather than inferring alignment from version equality

### Requirement: Local assessment requires no activation or live credentials
Assessment SHALL operate on a safely resolved Liftoff project before commit,
push, activation, or credential enrollment. Without an explicit live request it
SHALL perform no network requests, registry lookup, tool installation, project
script execution, or cloud/GitHub discovery. Missing execution state SHALL be
reported as not started, not fabricated as completed.

#### Scenario: Assess a freshly generated project
- **WHEN** a project has a manifest and active bootstrap seed but no Git remote or activation state
- **THEN** local facts are compared and unobservable enforcement is identified
- **AND** no prerequisite is created and no phase advances

#### Scenario: Assess a partially activated project offline
- **WHEN** seed validation is complete but setup has not reached live governance
- **THEN** assessment preserves the existing state and evidence
- **AND** reports applicable gaps and unavailable live proof without rerunning baseline commands

#### Scenario: Governance is disabled
- **WHEN** the project explicitly selects governance profile `none`
- **THEN** assessment reports `not-applicable`, not aligned governance
- **AND** it does not enable the profile or perform live collection

### Requirement: Assessment separates target, declared configuration, and enforcement
Each control result SHALL retain the expected target, recorded baseline,
declared project configuration, and required observed enforcement as separate
layers. Findings SHALL include stable control identity, policy reference,
scope, severity, reasons, evidence provenance, and advisory remediation.
Reading project-owned files SHALL NOT grant update authority over those files.

#### Scenario: Workflow exists without proven enforcement
- **WHEN** a workflow file exists but no current evidence proves its required check is enforced
- **THEN** file presence is reported as a local fact
- **AND** the enforcement layer remains `not-observed` rather than aligned

#### Scenario: Live ruleset differs from declared JSON
- **WHEN** complete live readback contradicts the project's declared ruleset
- **THEN** the finding includes the declared, observed, and expected values
- **AND** identifies the conflicting layer without rewriting either configuration

#### Scenario: Project customization still satisfies policy
- **WHEN** a custom configuration is observably equivalent to the target control
- **THEN** assessment does not label it conflicting merely because starter bytes differ
- **AND** no project-owned overwrite is recommended through ordinary update

### Requirement: Control coverage is explicit and release-owned
The installed release SHALL provide a validated, policy-bound inventory of
stable control IDs, applicability, expected values, proof requirements, and
supported evaluation coverage. The inventory SHALL cover identity, GitFlow,
rulesets, checks, security pipeline, environments, private-runner applicability,
Azure foundation, and governance evidence, with other normative policy families
explicitly represented even when evaluation is unsupported.

#### Scenario: A required evaluator is unavailable
- **WHEN** a policy control has no supported evaluator or required proof source
- **THEN** its result remains visible as `not-observed` with the coverage gap named
- **AND** it is not omitted from the alignment summary

#### Scenario: Catalog and policy do not match
- **WHEN** the packaged catalog does not match the target policy digest or has invalid or empty enabled coverage
- **THEN** assessment reports an error rather than a vacuous aligned result

#### Scenario: Single-maintainer policy is assessed
- **WHEN** review and environment settings are evaluated
- **THEN** the expected values follow Liftoff's zero-required-reviewer policy
- **AND** assessment does not recommend peer review or organization-wide governance as generic best practice

### Requirement: Findings distinguish uncertainty from differences
Assessment SHALL classify control results as `aligned`, `outdated`, `missing`,
`conflicting`, `approved-exception`, `inapplicable`, or `not-observed`.
Alignment SHALL require every proof layer declared by the control to be
available and valid. Known differences and unknown layers SHALL both remain
visible when they coexist.

#### Scenario: Absence is proven
- **WHEN** a complete authoritative observation proves an applicable required setting is absent
- **THEN** the result is `missing` and identifies the evidence establishing absence

#### Scenario: Access or collection is incomplete
- **WHEN** access is denied, pagination is incomplete, a request times out, or a 404 cannot be distinguished from hidden access
- **THEN** the affected proof is `not-observed`
- **AND** it is not classified as missing or aligned

#### Scenario: Applicability is unknown
- **WHEN** available facts cannot determine whether a control applies
- **THEN** assessment reports `not-observed` and the missing applicability fact
- **AND** does not use `inapplicable` as a fallback

#### Scenario: Workload excludes a component
- **WHEN** validated workload facts establish that no corresponding backend, container, infrastructure, or private DAST boundary applies
- **THEN** the corresponding controls are explicitly `inapplicable`
- **AND** no missing resource or provisioning recommendation is invented

### Requirement: Approved exceptions require exact validated scope
Assessment SHALL distinguish a valid approved exception from both alignment and
an unverified exception claim. An accepted exception SHALL identify an exact
catalog-permitted control, compatible target identity, phase, baseline,
repository/environment scope, and unexpired approval. Assessment SHALL NOT
approve, extend, create, or repair exceptions.

#### Scenario: Exact approved exception exists
- **WHEN** a validated approval envelope names an exception-permitted control ID and covers the observed difference's target and scope
- **THEN** the result is `approved-exception` with its approval reference and expiry
- **AND** the report does not describe it as an exact target match

#### Scenario: Exception is expired or only prose
- **WHEN** an exception is expired, ambiguously described, incompatible, or bound to another scope
- **THEN** it does not suppress the underlying finding or missing proof
- **AND** the report identifies why the claim was not accepted

### Requirement: Unsupported activation identities remain diagnosable without unsafe parsing
For supported manifest structures with unsupported activation identities,
assessment SHALL report found-versus-target identity and unavailable migration
or evidence interpretation without modifying data. Unknown state formats SHALL
remain opaque. Assessment SHALL retain strict path/schema safeguards and SHALL
NOT relax the loaders or compatibility requirements of mutating commands.

#### Scenario: Activation policy or graph is unsupported
- **WHEN** the recorded activation tuple cannot be used by the installed engine
- **THEN** assessment reports the identity difference and assesses only independently interpretable facts
- **AND** unsupported state/evidence-dependent comparisons are `not-observed`
- **AND** no mapping is invented or applied

#### Scenario: Manifest structure is unknown or malformed
- **WHEN** the manifest schema cannot be safely interpreted or its JSON is invalid
- **THEN** assessment emits an error with safe target and diagnostic information
- **AND** does not access artifact paths supplied by the unsupported document

#### Scenario: Path attempts to escape the project
- **WHEN** a supplied artifact path contains traversal, embedded separators, drive-qualified or UNC parts, or a symlink escape
- **THEN** assessment refuses unsafe access before reading the destination
- **AND** the same safeguard applies on Windows, macOS, and Linux

### Requirement: Live observation is explicit and scoped
Live assessment SHALL use only allowlisted read operations with existing
authentication and verified repository/environment/resource bindings. It SHALL
make no writes to GitHub or Azure, and SHALL NOT discover unrelated tenant,
subscription, repository, or organization resources to guess missing scope.

#### Scenario: Live observation is not requested
- **WHEN** assessment runs without `--live`
- **THEN** no GitHub, Azure, registry, or other network call occurs
- **AND** live-only proof is marked as not collected

#### Scenario: Live repository observation is authorized
- **WHEN** the developer requests live assessment and repository identity is resolvable with existing permissions
- **THEN** only scoped metadata for the declared control families is collected
- **AND** collection records source identity and observation time

#### Scenario: Azure resource bindings are unavailable
- **WHEN** live assessment lacks a validated subscription/environment/resource binding
- **THEN** the affected Azure controls are `not-observed`
- **AND** the account's default subscription or similarly named resources are not substituted

#### Scenario: Private runner inspection needs organization metadata
- **WHEN** an applicable repository assignment references known hosted-runner, group, or network IDs
- **THEN** reads are limited to metadata needed to establish that assignment
- **AND** no unrelated organization governance is enumerated, proposed, or changed

### Requirement: Evidence is source-bound and cannot manufacture completion
Assessment SHALL use validated evidence scope, identity, digest, commit,
freshness, and required readback rules. Recorded successful execution SHALL NOT
be treated as fresh live enforcement unless the control's proof requirements
are met. Assessment reports SHALL NOT be written as phase evidence or advance
activation state.

#### Scenario: Historical success is stale
- **WHEN** a previously successful record no longer matches the target identity, input digest, commit, scope, or freshness rules
- **THEN** the historical record remains visible but cannot establish alignment
- **AND** the required current proof is `not-observed`

#### Scenario: All observed controls align
- **WHEN** assessment finds no differences in its supported observations
- **THEN** it still makes no change to activation state, task checkboxes, approvals, or evidence
- **AND** incomplete catalog coverage remains visible

### Requirement: Reports are deterministic snapshots with honest coverage
For identical captured inputs and clock, normalized findings and ordering SHALL
be identical regardless of filesystem or API enumeration order. Reports SHALL
identify scope, target and project identities, capture time, input digests,
coverage counts, and collection diagnostics. Partial coverage SHALL prevent an
unqualified aligned outcome.

#### Scenario: File or API ordering changes
- **WHEN** equivalent observations arrive in a different order
- **THEN** their normalized comparisons and result digest remain identical

#### Scenario: Inputs change during collection
- **WHEN** relevant worktree content or observed refs change during the assessment
- **THEN** affected comparisons are identified as not reliably observed
- **AND** the report does not combine incompatible snapshots into alignment

#### Scenario: Local results match but live proof was not collected
- **WHEN** local assessment finds matching declarations but applicable controls require live evidence
- **THEN** the overall report is partial and names the unobserved controls
- **AND** does not claim full-policy alignment

### Requirement: Diagnostics and recommendations preserve authority boundaries
Reports SHALL retain only bounded, sanitized, relevant observations. Secrets,
credential values, webhook URLs, state payloads, and raw sensitive responses
SHALL NOT appear in output or persisted artifacts. Recommendations SHALL state
ownership and approval needs but SHALL NOT execute remediation, create issues,
write a report into the worktree, or invoke an unavailable migration command.

#### Scenario: Collector output contains sensitive data
- **WHEN** an observation or failure includes credential-shaped or otherwise prohibited payloads
- **THEN** the data is redacted or withheld before output, truncation, or retention
- **AND** the affected finding states any resulting observation limitation

#### Scenario: Managed and project-owned drift coexist
- **WHEN** managed integration drift and user-owned workflow or infrastructure differences are found
- **THEN** recommendations distinguish guarded managed update from separately reviewed project/remote changes
- **AND** do not suggest force-update can overwrite project-owned files or bypass compatibility

#### Scenario: Developer only requests assessment
- **WHEN** a report identifies actionable differences
- **THEN** no update, upgrade, activation, migration, resource provisioning, issue creation, or Git mutation occurs
- **AND** any subsequent execution requires a separate supported plan and authorization
