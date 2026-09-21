## Purpose

Define real, fail-closed security validation for Liftoff's source repository, generated projects and artifacts, including Actions trust boundaries, secret-scan coverage and safe disposition, findings, exceptions and qualification evidence.

## ADDED Requirements

### Requirement: Actions use explicit dependencies and minimum authority
Repository Actions SHALL retain read-only default tokens and disabled bot PR approvals, allow only selected approved actions, and use immutable full-SHA external action/reusable-workflow references with validation of applicable nested dependencies. Elevated permissions SHALL be limited to jobs that demonstrably need them; checkout credentials SHALL NOT persist without an explicit need. Unavailable platform pinning controls or unavoidable transitive limitations SHALL be reported rather than represented as enforced.

#### Scenario: Ordinary validation requests publication authority
- **WHEN** a validation job requests content-write, publishing, cloud or OIDC permissions without an approved need
- **THEN** deterministic policy validation fails with the job and excessive permission identified

#### Scenario: A workflow uses an unapproved or mutable action
- **WHEN** an action dependency is outside the selected allowlist or uses a mutable reference
- **THEN** policy validation fails before the workflow is accepted
- **AND** a pinned outer reference alone does not excuse an unreviewed mutable nested dependency

### Requirement: Fork and Dependabot execution remain unprivileged
Untrusted PR validation SHALL use ephemeral hosted runners without repository secrets, publication credentials, cloud authority, publisher environments or OIDC issuance. It SHALL preserve the existing fork execution approval boundary and SHALL NOT execute untrusted checkouts or downloaded artifacts in privileged `pull_request_target` or `workflow_run` contexts. Security report upload limitations SHALL NOT trigger a privileged fallback that executes candidate content.

#### Scenario: Fork contributor runs generated-code checks
- **WHEN** an approved fork PR executes candidate code or builds generated images
- **THEN** execution remains on an ephemeral unprivileged runner with no publishing or cloud rights
- **AND** the existing first-time-contributor execution approval policy is not silently widened or tightened

#### Scenario: Dependabot PR requires analysis
- **WHEN** Dependabot opens a PR affecting a supported surface
- **THEN** applicable analysis and finding gates run without secrets or bot approvals
- **AND** a token/report-upload limitation is handled explicitly without skipping required analysis or granting publisher authority

#### Scenario: Privileged workflow receives a PR artifact
- **WHEN** a report or artifact originates from an untrusted PR
- **THEN** it is not executed or accepted as a qualified release input by a privileged consumer

### Requirement: Execution and artifact trust are bounded
Security jobs and subprocesses SHALL have finite timeouts and event-appropriate concurrency. Trust domains SHALL have separate caches and artifact acceptance policies. Required evidence SHALL bind repository, event, head/base or tested merge revision, workflow revision, run/attempt, tool/configuration and inventory identities, timestamps and digests. Missing, expired, malformed, oversized, mismatched or untrusted evidence SHALL fail validation rather than be executed or assumed clean.

#### Scenario: New commit supersedes an active PR run
- **WHEN** concurrency cancels the obsolete run
- **THEN** cancelled results do not satisfy the new revision's required checks

#### Scenario: Protected publication encounters a PR-writable cache
- **WHEN** an artifact or cache was produced in an untrusted domain
- **THEN** it is not restored as privileged executable build or publication input

#### Scenario: Required scanner times out or loses its report
- **WHEN** a scanner exceeds its bound or its expected report is absent or unreadable
- **THEN** the gate fails as an infrastructure/evidence error with actionable diagnostics
- **AND** no empty report or stale result replaces it

### Requirement: Security coverage is an explicit cross-platform inventory
Validation SHALL maintain named source, dependency, generated-case, IaC and artifact inventories, reusing existing supported-stack and generator identities. It SHALL account for all four current npm graphs, Python standard/GenAI locks and applicable extras, Go dependencies, committed/generated OpenTofu, telemetry and generated images, and packed release contents. Expected versus actual coverage SHALL be checked. Local paths SHALL use portable path parts and platform-native handling on Windows, macOS and Linux; generated files and cleanup targets SHALL be modified or deleted only through explicit registered lookup, not filesystem pattern discovery.

#### Scenario: A supported generated surface lacks inventory coverage
- **WHEN** generation or package inspection produces an applicable graph, code language, IaC unit or image not represented by the inventory
- **THEN** validation fails and identifies the missing coverage
- **AND** an empty selection cannot satisfy the gate

#### Scenario: Resolve and clean generated outputs on Windows
- **WHEN** generation, report normalization and cleanup run in a Windows path containing spaces
- **THEN** they select the same logical entries as macOS and Linux using platform-correct paths
- **AND** cleanup affects only registered temporary paths/images without following traversal, symlink or case-alias escapes

#### Scenario: Retired fixture or native artifact is encountered
- **WHEN** a Power Apps negative fixture or a not-yet-supported native bundle is considered for coverage
- **THEN** its inapplicable or deferred status is explicit
- **AND** it does not silently enter a supported generated graph or pretend container scan

### Requirement: Source analysis success and source findings are independently gated
The repository SHALL use advanced CodeQL with explicit supported languages/categories and appropriate extended security queries for actual source. It SHALL require successful analysis for every applicable category and independently block policy-level findings through source-result evaluation and available native code-scanning merge protection. It SHALL NOT treat successful analysis/upload as absence of findings or rely exclusively on PR-diff annotation coverage. A distinct qualified maintenance-admission decision SHALL NOT alter the source-finding verdict or bypass native hosted rules.

#### Scenario: Analysis completes with a high-severity finding
- **WHEN** CodeQL completes successfully but reports an unexcepted high/critical security finding
- **THEN** the finding gate blocks even though the analysis job or upload succeeded

#### Scenario: Required language extraction is missing
- **WHEN** an applicable language/category is unsupported, omitted, empty unexpectedly or fails extraction
- **THEN** analysis qualification fails with the missing coverage identified
- **AND** the matrix is not silently reduced

#### Scenario: Finding falls outside a PR diff
- **WHEN** a required current-source finding is not eligible for native diff-based merge protection
- **THEN** explicit source-result evaluation still applies the blocking policy

#### Scenario: Validate Dependabot and fork merge protection
- **WHEN** advanced analysis is qualified for Dependabot and fork PRs
- **THEN** positive and deliberate negative evidence proves applicable analysis and finding gates on those paths
- **AND** documentation records that default-setup Dependabot PRs and merge-queue groups are excluded from native merge protection and does not claim merge-queue coverage

### Requirement: Secret assessments establish complete declared scope
Secrets validation SHALL inventory current committed source and the published repository refs whose reachable Git history is in scope, binding each to exact revisions and observation time. Initial and recurring full-scope assessments SHALL establish detector/configuration identity where available, scope and completion rather than infer success from enabled settings or an empty alert list. Incoming PR assessment SHALL cover the candidate tree and introduced commits, including content removed before the final revision. Native protection SHALL be preserved; a pinned isolated detector SHALL be used only for an explicitly approved demonstrated coverage or unprivileged enforcement gap. Unsupported surfaces and history outside the declared repository scope SHALL remain explicit limitations, not scanned claims. Missing refs/objects, shallow required history, unapproved exclusions, failed scans and incomplete reports SHALL block the affected qualification.

#### Scenario: Current tree is clean but history was not assessed
- **WHEN** a current-source scan finishes without findings but declared historical refs lack completion evidence
- **THEN** current-source and historical coverage are reported separately
- **AND** secrets-protection acceptance remains blocked for the missing history assessment

#### Scenario: Credential fixture is added and removed within one PR
- **WHEN** a safe detector-supported nonfunctional fixture appears in an introduced commit but not in the final PR tree
- **THEN** introduced-history assessment detects it and exercises the required blocking result
- **AND** a clean head-tree scan alone cannot make the candidate pass

#### Scenario: Required history is shallow or incomplete
- **WHEN** expected ref identities or required reachable objects cannot be reconciled with the scan workspace
- **THEN** history qualification fails with the missing nonsecret scope identified
- **AND** an empty or partial scan does not become a clean verdict

#### Scenario: Resolve scan locations on supported operating systems
- **WHEN** source/history assessment or finding normalization handles repository paths on Windows, macOS or Linux
- **THEN** platform-native resolution preserves the same logical tracked locations, including Windows paths containing spaces
- **AND** it does not scan unrelated worktrees or developer-home files or follow paths outside the declared workspace

### Requirement: Secret assessment evidence cannot disclose credentials
Secrets assessment SHALL expose only bounded sanitized metadata, such as nonsecret finding identifiers, locations, detector/rule/ref identities, completion, counts and disposition. Locally authorized scanners SHALL redact matches before stdout, stderr, reports, failure diagnostics or artifacts are persisted or surfaced. Raw secret-bearing hosted alert responses SHALL NOT be retrieved for acceptance; unavailable safe metadata SHALL require supported sanitized evidence or qualified approved local coverage, not an invented clean result. Assessment SHALL NOT send discovered credentials to external validation services or add an external content-upload service.

#### Scenario: Detector or error output would expose a match
- **WHEN** a deterministic test causes a scanner or failure path to emit a nonfunctional sentinel as an unredacted match
- **THEN** the reporting boundary fails qualification without retaining or displaying that sentinel as finding content
- **AND** public logs, comments and retained reports contain only sanitized diagnostics

#### Scenario: Hosted API cannot provide safe sufficient evidence
- **WHEN** available metadata does not establish scan scope/completion without retrieving secret values
- **THEN** that coverage remains unqualified until supported sanitized evidence or the approved isolated assessment establishes it
- **AND** raw alert payloads, unsupported provider guarantees and an empty alert count are not substituted

#### Scenario: Scanner encounters a potential real credential
- **WHEN** an explicitly authorized local assessment detects a potential credential in the declared repository content
- **THEN** only its sanitized finding identity and remediation status enter evidence
- **AND** assessment does not test the credential against its issuer, rotate it or upload its value elsewhere

### Requirement: Secret detections require safe disposition and owner-authorized remediation
Each secret detection SHALL have a sanitized owner-bound disposition distinguishing unresolved detection, confirmed exposure awaiting remediation, exact reviewed false positive/nonfunctional fixture, or remediated exposure with evidence. Untriaged detections and confirmed unremediated exposures SHALL block secrets-protection acceptance, actual finding qualification, normal intake and publication regardless of generic vulnerability severity. A qualified policy-only proposal for an exact existing-base false positive/nonfunctional fixture SHALL remain unadopted and SHALL NOT resolve the detection before merge; confirmed unremediated exposures SHALL never qualify for that maintenance admission. Confirmed exposures SHALL require separately authorized credential-owner revocation/rotation evidence and removal from current source where present. Source deletion, history rewriting or alert closure alone SHALL NOT establish credential invalidation. Historical remediated occurrences SHALL be recorded precisely without requiring history rewriting. False-positive/fixture dispositions SHALL be exact and justified under trusted base policy; candidate-authored suppression SHALL NOT authorize itself.

#### Scenario: Finding has no disposition or is labelled low severity
- **WHEN** a potential secret is untriaged or a confirmed exposure lacks remediation evidence
- **THEN** the applicable secrets gate blocks independently of a high/critical vulnerability threshold
- **AND** an ordinary time-bounded dependency exception does not make it pass

#### Scenario: Exposed credential is deleted from current source
- **WHEN** current source no longer contains the credential but owner-authorized invalidation evidence is missing
- **THEN** exposure remains unresolved
- **AND** deleting the file, branch or alert does not qualify remediation

#### Scenario: Historical exposure has been remediated
- **WHEN** exact owner-authorized revocation/rotation evidence is recorded and the exposure is removed from current source where present
- **THEN** its historical occurrence may be represented by a precise sanitized remediation record
- **AND** acceptance does not require destructive history rewriting or claim that external copies were removed

#### Scenario: Candidate suppresses its own detector hit
- **WHEN** a PR changes detector configuration, exclusions or disposition records to hide its own finding
- **THEN** trusted base-policy evaluation rejects self-authorized suppression and reports the proposed policy change
- **AND** a legitimate exact false-positive or nonfunctional-fixture proposal still requires validated maintainer policy adoption without a second reviewer

### Requirement: Generated-output gates analyze executable materialized projects
Validation SHALL materialize representative supported Node.js, Python standard/GenAI, Go and frontend outputs with real generator inputs, locks, optional features and IaC in secret-free temporary workspaces. It SHALL analyze actual generated language files and assess their findings through an explicit required generated-output gate independent of PR-diff locations. Coverage SHALL map security-relevant generator branches to named representatives and preserve committed/generated dependency metadata.

#### Scenario: Vulnerability appears only in a generated Python file
- **WHEN** a TypeScript generator change materializes Python with a blocking security finding
- **THEN** actual Python analysis causes the generated-output gate to fail
- **AND** source TypeScript analysis or absent GitHub diff annotations do not turn it green

#### Scenario: Representative excludes a distinct supported branch
- **WHEN** worker/functions, non-worker, generic, frontend or stack-specific output has materially distinct security inputs
- **THEN** the inventory maps that branch to a qualified representative or adds a named case
- **AND** generation failure or a missing report remains blocking

#### Scenario: Generated-project preparation changes a lockfile
- **WHEN** preparation rewrites an inventoried manifest or lock
- **THEN** qualification fails with the changed logical path
- **AND** no updated metadata is silently accepted as the release-owned baseline

#### Scenario: Generated validation runs without deployment
- **WHEN** security jobs materialize and assess projects
- **THEN** they do not invoke cloud setup, governance activation, production telemetry administration or deployed-service probing

### Requirement: IaC and images receive real distinct assessments
Validation SHALL execute Checkov against applicable committed and generated IaC/build configuration and Trivy against actual locally built telemetry and representative generated image digests. Image evidence SHALL identify platform, OS and installed application package coverage. IaC formatting/validation, container startup, template strings and mocked scanner invocations SHALL NOT substitute for security scanning. Trivy configuration scanning and redundant image engines SHALL NOT duplicate the assigned IaC/image gates without a concrete approved gap.

#### Scenario: Committed or generated OpenTofu violates policy
- **WHEN** real Checkov execution reports a defined blocking rule violation
- **THEN** the applicable security gate fails without provisioning infrastructure

#### Scenario: Built image contains a blocking installed component
- **WHEN** Trivy reports an unexcepted high/critical vulnerability in an actual telemetry or generated image
- **THEN** the digest-bound image gate fails even if container startup succeeded

#### Scenario: Image report describes different bytes or platform
- **WHEN** the reported digest/platform differs from the selected built artifact or an expected image is missing
- **THEN** qualification fails
- **AND** coverage of one platform is not reported as coverage of unbuilt architectures

### Requirement: Dependency coverage distinguishes diffs current graphs and updates
Security validation SHALL combine supported native Dependency Review for PR differences with explicit complete-current-graph auditing and separately configured update proposals. Existing canonical npm audit SHALL remain authoritative for its four named graphs. Non-npm graph validation SHALL prove full Python lock/extra and resolved Go dependency coverage rather than rely on graph recognition, best-effort manifest parsing or reachability-only analysis. Unsupported review/update features SHALL remain visible without exempting the graph from scanning.

#### Scenario: GitHub recognizes a graph without an enforced audit
- **WHEN** a graph appears in dependency metadata or an SBOM
- **THEN** its security state remains unqualified until real complete-graph assessment and finding evaluation succeed

#### Scenario: Advisory affects an unchanged dependency
- **WHEN** a high/critical advisory exists in the current graph but not in the PR dependency diff
- **THEN** complete-graph validation blocks unless an exact valid exception applies

#### Scenario: Go or Python extraction is incomplete
- **WHEN** scanner-extracted components omit selected transitive modules, locked packages or applicable extras
- **THEN** validation fails or materializes exact supported scanner inputs before claiming coverage
- **AND** an apparently clean partial report does not pass

#### Scenario: Dependency automation proposes a new baseline
- **WHEN** Dependabot proposes supported npm, Python, Go or Actions updates
- **THEN** proposals retain default-integration-branch targeting, supported-stack ownership and runtime compatibility constraints
- **AND** update automation does not silently rewrite release-owned metadata or count as a security gate

### Requirement: Blocking policy is precise and errors fail closed
Actual finding gates SHALL block high/critical vulnerabilities and explicitly defined policy violations while preserving stricter existing npm policy. They SHALL distinguish security severity, non-security diagnostics and tool-specific rule severity. Lower-severity findings SHALL remain visible with owner-bound triage. Secret detections SHALL follow their independent disposition/remediation requirement rather than be waived by a vulnerability severity threshold. Normal admission and publication SHALL consume those actual verdicts; the separate qualified maintenance path SHALL not relabel them as passing. Unknown schemas/severities, missing analysis, scanner outages, skipped/cancelled required jobs and unreadable reports SHALL fail as explicit incomplete/error states and SHALL block maintenance admission too.

#### Scenario: Lower severity finding is present
- **WHEN** a new gate finds a lower-severity issue outside the existing stricter npm contract
- **THEN** it records the finding and triage owner without representing it as fixed

#### Scenario: Existing npm policy rejects a moderate advisory
- **WHEN** canonical npm reports a moderate advisory without an exact valid exception
- **THEN** the existing npm gate still blocks rather than being weakened to the new high/critical minimum

#### Scenario: Tool has no comparable vulnerability severity
- **WHEN** an IaC or control-plane rule uses a policy classification instead
- **THEN** an explicit reviewed blocking rule mapping determines its result
- **AND** unknown or malformed security classification requires triage rather than silent omission

### Requirement: Exceptions are exact owner-bound and expiring
An unresolved blocking vulnerability or policy-rule finding SHALL be permitted only by an approved exact exception binding tool/advisory or rule identity, affected graph/case/artifact, package/version and reviewed chains or applicable location/digest, rationale, mitigation, owner, review date and expiry. High/critical windows SHALL NOT exceed 30 days and lower-severity windows SHALL NOT exceed 90 days. Exceptions SHALL NOT auto-renew, ignore unfixed findings broadly, suppress tool errors, cover unrelated graphs or remain valid after their finding/scope becomes stale. These exception windows SHALL NOT authorize untriaged secret detections or confirmed unremediated exposures; exact secret-disposition/remediation records SHALL remain distinct.

#### Scenario: Same advisory affects another graph
- **WHEN** a reviewed npm template exception matches an advisory identifier also found in the root, telemetry, Python or image graph
- **THEN** the original exception does not authorize the different finding

#### Scenario: Exception expires or its dependency chains change
- **WHEN** expiry, maximum-window or exact-scope validation fails
- **THEN** the finding blocks with its owner and re-review requirement reported

#### Scenario: Candidate adds a broad suppression
- **WHEN** a PR adds a wildcard ignore, automatic renewal or blanket ignore-unfixed setting
- **THEN** policy validation rejects it
- **AND** an outage or missing report cannot be excepted as a vulnerability finding

### Requirement: Policy-only maintenance admission has an exact non-executable boundary
A trusted-base validator SHALL derive maintenance eligibility from current base/head identities and the complete change set, not candidate labels or asserted modes. Eligible changes SHALL affect only exact base-registered exception/disposition data paths and SHALL preserve source, dependency manifests/locks, workflows, detectors/rules/query packs, evaluators, inventories, thresholds, permissions and publishers. Unknown paths, file-type/mode changes, symlinks, renames or unapproved configuration changes SHALL not qualify. New or expanded entries SHALL match findings actually observed on the trusted base and satisfy exact scope, evidence and validity rules; unused future grants and stale-entry relaxation SHALL be rejected. Exact withdrawals/cleanup SHALL not add permission or erase incident evidence. Complete compatible analysis SHALL establish no new raw findings or unassessed surfaces using stable exact source/graph, detector/rule and location/component identities independently of per-run/ref provenance. Actual commit/run identities SHALL remain separately bound and fresh. Confirmed unremediated exposures SHALL block admission. Required analysis, integrity and functional checks SHALL remain mandatory.

#### Scenario: Existing base finding has an exact policy-data proposal
- **WHEN** the complete compatible observations show the same base findings and only valid registered exception/disposition data changes
- **THEN** a distinct maintenance-admission result can qualify the proposal for ordinary maintainer merge
- **AND** the actual finding reports remain unchanged and identify the proposal as unadopted

#### Scenario: Maintenance PR also changes executable inputs
- **WHEN** a PR changes source, a lockfile, workflow, detector rule, evaluator or other non-allowlisted input
- **THEN** it is not admitted through maintenance eligibility
- **AND** it must satisfy normal admission without candidate-added finding permissions

#### Scenario: Candidate proposes an exception for future code
- **WHEN** a new exception/disposition does not match an observed trusted-base finding or belongs to another graph/case
- **THEN** maintenance admission rejects the unused or transplanted grant
- **AND** later code is not pre-authorized to introduce the finding

#### Scenario: Existing exception is renewed after expiry
- **WHEN** an existing-base finding has complete observations and a new exact renewal proposal satisfies current evidence and maximum-window rules
- **THEN** proposal eligibility is evaluated separately from the still-blocking expired-policy finding result
- **AND** renewal becomes authoritative only after maintainer merge, never by automatically advancing a date

#### Scenario: New finding or incomplete evidence appears
- **WHEN** comparison finds a new raw finding, incomplete snapshot, unknown severity, missing coverage or failed producer
- **THEN** maintenance admission blocks rather than treating the uncertainty as unchanged clean content
- **AND** a matching failure or empty result on both sides does not prove eligibility

#### Scenario: Path alias attempts to enter the maintenance allowlist
- **WHEN** eligibility is evaluated using Windows, macOS or Linux paths with case/separator aliases or changed file types
- **THEN** exact registered logical paths resolve consistently without broadening the permitted change set
- **AND** an unregistered or escaping path is rejected rather than matched by a broad pattern

#### Scenario: Policy-only edit changes the commit identity
- **WHEN** base and head SHAs differ solely because of eligible policy-data edits
- **THEN** unchanged findings are compared through exact stable protected inputs rather than treating the new run/commit identity alone as a new finding
- **AND** the actual base/head/run provenance remains verified without accepting stale results or ignoring other content changes

### Requirement: Policy adoption authority remains distinct from proposal evidence
Active exception/disposition authority SHALL derive from independently loaded adopted trusted-base policy and verified source context. Candidate owner, approval or evidence-reference fields SHALL be traceability data rather than authority. The maintainer's ordinary merge SHALL adopt a qualified policy-only proposal without a separate pre-merge approval step or blind auto-merge. Admission evidence SHALL bind repository, current base/head, complete change set, proposed policy digest, trusted validator/policy identity and compatible analysis evidence; drift SHALL invalidate it. Subsequent normal/release evaluation SHALL reload adopted policy and reassess the exact candidate. A normal code fix SHALL be allowed to withdraw an exact now-inapplicable waiver only with complete resolution evidence and an effective permission set no broader than the trusted base; remaining stale entries and new/expanded candidate grants SHALL still fail. Maintenance admission SHALL NOT be a clean scan, incident remediation, publication authority or release qualification.

#### Scenario: Candidate claims approval in its own metadata
- **WHEN** unmerged data contains an owner name, approval flag or purported evidence reference
- **THEN** that claim alone cannot create an active policy grant or clear a finding
- **AND** trusted source context is required independently of those fields

#### Scenario: Proposal is adopted by normal merge
- **WHEN** the maintainer merges a qualified policy-only PR
- **THEN** a later assessment reads the actually adopted base policy and evaluates its current exact scope and validity
- **AND** it does not reuse the pre-merge admission result as a finding verdict

#### Scenario: Base or head changes after qualification
- **WHEN** the PR revision, base, proposal bytes or required evidence changes
- **THEN** the previous admission decision is stale and must be recomputed

#### Scenario: Code fix retires an obsolete waiver
- **WHEN** complete normal assessment proves the finding resolved and a candidate removes only its exact now-inapplicable permission
- **THEN** normal evaluation can use the constrained trusted-base permission set without a new grant
- **AND** it preserves stale-entry rejection for entries not validly retired and retains incident/remediation history

#### Scenario: Proposal is represented as release evidence
- **WHEN** a consumer tries to use maintenance eligibility as proof of secure or publication-ready artifacts
- **THEN** the evidence type is rejected and actual adopted-policy qualification remains required

### Requirement: Security recurrence preserves deterministic ordinary tests
Security validation SHALL run dedicated PR checks, weekly full scans of applicable protected refs and full release-time assessment. Ordinary tests SHALL continue using committed fixtures and controlled dates. Scheduled failures SHALL produce actionable owner-visible records and prevent subsequent publication without fresh passing release qualification. Release security evidence SHALL be generated for the exact release attempt, no older than 24 hours and still within exception validity at publication.

#### Scenario: Advisory database changes after merge
- **WHEN** a scheduled full scan discovers a new blocking finding
- **THEN** the finding is reported for remediation and later release qualification must resolve or exactly except it
- **AND** ordinary deterministic test outcomes and Git history are not rewritten

#### Scenario: Release evidence ages before publication
- **WHEN** evidence exceeds 24 hours, belongs to another attempt or an applicable exception expires
- **THEN** publication remains blocked until fresh exact-artifact assessment succeeds

#### Scenario: Ordinary tests run offline against fixtures
- **WHEN** inventory, parser, exception and report tests run without live security retrieval
- **THEN** controlled inputs determine their outcomes independently of current advisory databases

### Requirement: Required gates prove coverage and real failure
Every proposed required security context SHALL require successful complete applicable producer execution and SHALL have exact-revision positive and safe negative qualification evidence before hosted enforcement. Required admission SHALL distinguish normal finding-policy success from explicitly qualified policy-only maintenance, while retaining actual finding outcomes and all mandatory analysis/integrity/functional checks. Required-check composition SHALL NOT recreate the maintenance adoption cycle by also demanding an unconditional clean finding result for that path, or solve it by synthetic green, neutral/skipped checks, broad error suppression or a hosted bypass. Evidence SHALL include observed context/App, event, refs/revisions, workflow/policy/tool identities, run/attempt and result. Negative cases SHALL remain unmerged and secret-free; synthetic success statuses SHALL NOT establish qualification.

#### Scenario: One producer is skipped or its report is empty
- **WHEN** an aggregate sees missing, skipped, cancelled or unexpectedly empty applicable output
- **THEN** the aggregate fails rather than treating absence as clean

#### Scenario: Prove a new required context
- **WHEN** a context is proposed for protection
- **THEN** an actual passing case and deliberate safe finding/error case demonstrate that exact context becoming green and red
- **AND** workflow removal, policy weakening, missing-language and report-tampering cases are covered where applicable

#### Scenario: Prove a secrets intake context
- **WHEN** a secrets check is proposed as a required context for fork and same-repository PRs
- **THEN** real safe positive and detector-supported negative cases prove its behavior on the applicable exact candidate/event paths
- **AND** introduced-history omissions, skipped scans, exclusion tampering, unsafe report output and missing remediation evidence cannot produce a passing context

#### Scenario: Prove maintenance admission without hiding findings
- **WHEN** an exact safe policy-only proposal is exercised under the required-check composition
- **THEN** its distinct admission decision and still-blocking pre-adoption finding results are both visible
- **AND** mixed edits, stale inputs, new findings, confirmed exposures and failed mandatory execution/integrity/functional checks prevent admission
