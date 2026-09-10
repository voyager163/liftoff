## Purpose

Let developers compare their project's recorded and declared governance with
observable enforcement and the installed Liftoff policy, without changing the
project, granting upgrade authority, or presenting unknown controls as aligned.

## Requirements

### Requirement: Assessment pins an explicit installed target
Assessment SHALL identify the installed CLI version, selected displayed target
profile, target manifest artifact version, policy version and content
digest, activation-contract version, phase-graph hash when applicable,
assessment-catalog schema and digest, and the activation-state,
evidence-header, approval-envelope, and compatibility-metadata schema versions
required to interpret recorded governance data. For a supported Liftoff
project, it SHALL compare that target with the project's recorded identity
without resolving registry latest or replacing the installed CLI. For an
ordinary Git repository with no supported Liftoff manifest, it SHALL display
the installed `single-maintainer-gitflow` target as the explicit comparison
baseline and SHALL NOT infer a different target from observed branches,
workflows, or provider configuration.

#### Scenario: Registry latest differs from the installed CLI
- **WHEN** assessment runs with an installed release older than registry latest
- **THEN** the target remains the installed release and its packaged policy
- **AND** the report does not fetch or substitute latest as the comparison target

#### Scenario: CLI versions match but configuration differs
- **WHEN** project metadata and the CLI report the same SemVer but managed bytes or governance settings differ
- **THEN** assessment reports the actual differences rather than inferring alignment from version equality

#### Scenario: Ordinary Git repository has no Liftoff metadata
- **WHEN** assessment runs at a Git root that has no supported Liftoff manifest or activation data
- **THEN** the report names the installed `single-maintainer-gitflow` target and its packaged policy as the comparison baseline
- **AND** it does not synthesize project identity, activation history, or a custom target from observed branch names

### Requirement: Local assessment requires no activation or live credentials
Assessment SHALL operate on a safely resolved supported Liftoff project or
ordinary Git repository before commit, push, activation, or credential
enrollment. An explicit path MUST be authoritative; otherwise assessment SHALL
resolve the nearest applicable supported-project or Git boundary, including
worktree `.git` files and nested invocation paths. A Liftoff manifest, or a
required Liftoff governance artifact in a supported Liftoff project, that is
malformed, unreadable, a symlink or junction,
dangling, or a retired Power Apps workload SHALL be treated as an error
boundary rather than ignored in favor of an outer repository or ordinary-Git
fallback. Without an explicit live request it SHALL perform no network
requests, registry lookup, tool installation, project script execution,
slash-launcher installation, initialization, or state writes. Missing
execution state in a supported Liftoff project SHALL be reported as not
started, not fabricated as completed. An ordinary Git repository's absent
Liftoff metadata SHALL remain unavailable or not observed; unrelated files
named governance SHALL NOT establish a Liftoff boundary.

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

#### Scenario: Assess an ordinary Git repository
- **WHEN** assessment runs inside a Git repository that has no supported Liftoff project boundary
- **THEN** it resolves that Git root and performs a local-only comparison against the installed target
- **AND** it does not initialize Liftoff files, generated prompts, or activation state

#### Scenario: Retired or malformed manifest blocks ordinary-Git fallback
- **WHEN** assessment encounters a retired `power-apps-code-app` manifest or a malformed manifest at the resolved boundary
- **THEN** it reports that boundary as unsupported or invalid
- **AND** it does not walk past that boundary to assess an outer repository as a different project

### Requirement: Assessment separates target, declared configuration, and enforcement
Each control result SHALL retain the expected target, recorded baseline,
declared project configuration, and required observed enforcement as separate
layers. Findings SHALL include stable control identity, policy reference,
scope, severity, reasons, evidence provenance, observation availability,
freshness, collection stability, and advisory remediation. Reading
project-owned files SHALL NOT grant update authority over those files, and loss
of one observation source SHALL NOT erase independently established facts from
another source unless a relevant input actually changed.

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

#### Scenario: Unrelated live access fails after a local violation is proven
- **WHEN** assessment has already proven a local configuration difference and a later GitHub or Azure read for another control is denied or times out
- **THEN** the proven local finding remains visible with its original provenance
- **AND** only the dependent live proof is marked `not-observed`

### Requirement: Control coverage is explicit and release-owned
The installed release SHALL provide a validated, policy-bound inventory of
stable control IDs, applicability, expected values, proof requirements, and
supported evaluation coverage. The inventory SHALL cover identity, GitFlow,
repository rulesets, inherited and effective rules, classic branch protection,
required-check bindings for `develop`, `main`, and release or hotfix ref
families, security pipeline, environments, private-runner applicability and
restrictions, Azure foundation, governance evidence, and resource-role
expectations, with other normative policy families explicitly represented even
when evaluation is unsupported.

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

#### Scenario: Release and hotfix bindings are only partially knowable
- **WHEN** assessment can prove bindings for `main` and `develop` but cannot establish every applicable `release/*` or `hotfix/*` protected ref
- **THEN** the report keeps the proven bindings and marks the unresolved ref family coverage as `not-observed`
- **AND** it does not collapse the entire control family into aligned or missing

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
Assessment SHALL retain safe found-versus-target diagnosis for supported manifests with unsupported activation identities. Original known v1 records SHALL remain diagnostic-only and SHALL not be migrated, deleted, or accepted as current proof by assessment. A declared supported successor lane SHALL be explained through the human-first update-check remedy. In an already migrated project, assessment SHALL distinguish the validated retained snapshot from the active v2 successor and evaluate only independently interpretable current facts. Unknown formats, unsafe paths, malformed active records, and broken declared migration links SHALL not trigger permissive fallback or relaxed mutation compatibility.

#### Scenario: Activation policy or graph is unsupported
- **WHEN** the recorded tuple cannot execute under the installed engine
- **THEN** assessment reports the difference and assesses only independently interpretable facts
- **AND** evidence-dependent unknowns remain not-observed without an invented mapping

#### Scenario: Historical activation v1 is present
- **WHEN** known v1 is still the active historical representation
- **THEN** assessment reports diagnostic-only status and actual migration eligibility
- **AND** it recommends `liftoff update --check` only when relevant without creating a receipt, approval, or successor

#### Scenario: Manifest structure is unknown or malformed
- **WHEN** the manifest cannot be safely interpreted
- **THEN** assessment emits safe diagnostics without accessing artifact paths from the unsupported structure

#### Scenario: Path attempts to escape the project
- **WHEN** an artifact or migration-history reference contains traversal, embedded separators, drive/UNC parts, or an unsafe link
- **THEN** assessment refuses access under the same Windows, macOS, and Linux boundary rules

#### Scenario: Current proof coexists with preserved v1
- **WHEN** a valid migration link connects retained v1 history to current v2 state
- **THEN** assessment reports history separately and uses only validated current proof for present readiness and scope
- **AND** historical presence alone does not make current evidence unsupported

#### Scenario: Migration has incomplete revalidation
- **WHEN** the local migration committed but current proof is incomplete
- **THEN** assessment reports the actual coverage gaps without treating migration completion as alignment
- **AND** it does not run revalidation, refresh a preview, or authorize a later transition

### Requirement: Live observation is explicit and scoped
Live assessment SHALL use only allowlisted read operations with existing
authentication and verified repository, environment, and resource bindings. It
SHALL evaluate repository rulesets, inherited and effective rules, and classic
branch protections as the effective enforcement set; compare required-check
bindings for `develop`, `main`, and the release and hotfix ref families;
resolve required jobs and their transitive `needs` dependencies without
executing workflows; and preserve incomplete coverage when exact refs, dynamic
workflow semantics, or effective-rule scope cannot be established. Runner
alignment SHALL require the full policy-relevant binding, labels, capacity,
status, and repository or group restrictions, and Azure observations SHALL
require authoritative environment or storage-role evidence while diagnosing
conflicting bindings before deduplication. It SHALL make no writes to GitHub or
Azure, and SHALL NOT discover unrelated tenant, subscription, repository, or
organization resources to guess missing scope or infer resource roles.

#### Scenario: Live observation is not requested
- **WHEN** assessment runs without `--live`
- **THEN** no GitHub, Azure, registry, or other network call occurs
- **AND** live-only proof is marked as not collected

#### Scenario: Live repository observation is authorized
- **WHEN** the developer requests live assessment and repository identity is resolvable with existing permissions
- **THEN** only scoped metadata for the declared control families is collected
- **AND** collection records source identity and observation time

#### Scenario: Azure resource bindings are unavailable
- **WHEN** live assessment lacks a validated subscription, environment, or resource binding
- **THEN** the affected Azure controls are `not-observed`
- **AND** the account's default subscription or similarly named resources are not substituted

#### Scenario: Private runner inspection needs organization metadata
- **WHEN** an applicable repository assignment references known hosted-runner, group, or network IDs
- **THEN** reads are limited to metadata needed to establish that assignment
- **AND** no unrelated organization governance is enumerated, proposed, or changed

#### Scenario: Effective enforcement differs from repository-owned source files
- **WHEN** inherited rules or classic branch protection add or remove an applicable restriction beyond the repository's declared files
- **THEN** assessment reports the effective enforcement separately from the declared configuration
- **AND** it does not assume repository-owned files are the complete live policy

#### Scenario: Required workflow uses transitive dependencies
- **WHEN** a required check is produced by a workflow whose visible job depends on other jobs through `needs`
- **THEN** assessment resolves the transitive dependencies it can determine without execution
- **AND** unknown reusable-workflow, matrix, dynamic-name, or condition semantics remain `not-observed` rather than aligned

### Requirement: Evidence is source-bound and cannot manufacture completion
Assessment SHALL use validated evidence scope, identity, body digest, baseline
digest, current-input snapshot digest, commit, freshness, and required readback
rules. Recorded successful execution SHALL NOT be treated as fresh live
enforcement unless the control's proof requirements are met against current
inputs and compatible identities. Assessment reports SHALL NOT be written as
phase evidence or advance activation state.

#### Scenario: Historical success is stale
- **WHEN** a previously successful record no longer matches the target identity, input digest, commit, scope, or freshness rules
- **THEN** the historical record remains visible but cannot establish alignment
- **AND** the required current proof is `not-observed`

#### Scenario: Stored evidence body no longer matches current inputs
- **WHEN** a recorded evidence body does not match its referenced body digest, or its baseline/input digest fails comparison with the recomputed current normalized inputs
- **THEN** the recorded evidence remains visible as historical context
- **AND** it cannot establish alignment or current completion

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
