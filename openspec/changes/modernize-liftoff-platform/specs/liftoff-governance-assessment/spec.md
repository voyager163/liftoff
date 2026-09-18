## MODIFIED Requirements

### Requirement: Unsupported activation identities remain diagnosable without unsafe parsing
Assessment SHALL retain safe found-versus-target diagnosis for supported manifests with historical or unsupported activation identities. Known v1/v2/v3 records SHALL remain historical and SHALL NOT be migrated, deleted or accepted as current v4 proof by assessment. A declared supported successor lane SHALL be explained through the human-first update-check remedy. In a migrated project, assessment SHALL distinguish validated retained history from the active v4 successor and evaluate only independently interpretable current facts. Unknown formats, unsafe paths, malformed active records and broken links SHALL NOT trigger permissive fallback or relaxed mutation compatibility.

#### Scenario: Activation policy or graph is unsupported
- **WHEN** the recorded tuple cannot execute under the installed engine
- **THEN** assessment reports the difference and evaluates only independently interpretable facts
- **AND** evidence-dependent unknowns remain not-observed without an invented mapping

#### Scenario: Historical activation v1 is present
- **WHEN** supported v1 remains the historical active representation
- **THEN** assessment reports diagnostic-only execution status and actual migration eligibility
- **AND** it recommends the relevant update check without creating a receipt, approval or successor

#### Scenario: Historical activation v2 or v3 is present
- **WHEN** a supported v2 or v3 family remains the historical active representation
- **THEN** assessment reports its actual identity and declared migration eligibility without using it as current v4 execution proof
- **AND** no receipt, approval, successor or revalidation effect is created

#### Scenario: Manifest structure is unknown or malformed
- **WHEN** the manifest cannot be safely interpreted
- **THEN** assessment emits safe diagnostics without accessing artifact paths from that unsupported structure

#### Scenario: Path attempts to escape the project
- **WHEN** an artifact or history reference contains traversal, embedded separators, drive/UNC escapes or an unsafe link
- **THEN** assessment refuses access under the same Windows, macOS and Linux boundary rules

#### Scenario: Current proof coexists with preserved v1
- **WHEN** a valid migration link connects retained v1 history, directly or through a validated ancestor chain, to current v4 state
- **THEN** assessment reports history separately and uses only validated current proof for present scope/readiness
- **AND** historical presence alone does not invalidate that current proof

#### Scenario: Current proof coexists with preserved v3
- **WHEN** a valid migration link connects retained v3 history to current v4 state without a v1 ancestor
- **THEN** assessment validates the actual source relationship and current proof
- **AND** it does not invent earlier history or reject current evidence merely because v3 records remain

#### Scenario: Migration has incomplete revalidation
- **WHEN** migration committed but current proof is incomplete
- **THEN** assessment reports actual gaps without treating migration completion as alignment
- **AND** it does not run revalidation, refresh a preview or authorize another transition

## ADDED Requirements

### Requirement: Repository enforcement proof remains distinct from full activation alignment
Governance assessment SHALL identify current repository-only enforcement separately from full cloud/production activation and lifecycle obligations. It SHALL consume the same validated scope, identity and history relationships as governance status, verification and doctor. A valid repository main hold SHALL NOT be treated as production qualification, and whole-project assessment SHALL NOT expand this existing read-only operation's authority.

#### Scenario: Repository controls are verified before cloud work
- **WHEN** repository-only evidence and readback satisfy their applicable controls while Azure activation remains incomplete
- **THEN** assessment can report those repository controls as established
- **AND** it does not mark unrelated deployment or full activation aligned

#### Scenario: Production hold remains active
- **WHEN** a valid reviewed main hold protects the repository pending qualification
- **THEN** assessment identifies that protection and the outstanding production boundary
- **AND** it neither lifts the hold nor claims the absent qualification passed

#### Scenario: The user requests assessment only
- **WHEN** assessment finds a native installation, project, repair or activation migration opportunity
- **THEN** it reports the supported separately authorized action
- **AND** it does not install skills, run project code, generate a migration receipt or mutate provider state

### Requirement: Current pull-request rule parameters are normalized without losing constraints
Live ruleset normalization SHALL recognize and validate supported pull-request parameters `dismissal_restriction`, `require_extra_approval_for_unattributed_changes` and `required_reviewers`, including their documented nested actor, reviewer, approval-count and condition structures. Supported disabled/empty defaults SHALL normalize successfully and meaningful values SHALL remain available to assessment. Genuinely unknown, malformed, oversized or unsupported rule/parameter combinations SHALL still prevent a complete trusted observation.

#### Scenario: GitHub returns all three defaults
- **WHEN** a supported pull-request rule returns a disabled dismissal restriction with an empty actor list, an enabled extra-approval flag and an empty required-reviewer list
- **THEN** normalization succeeds and preserves those observed values
- **AND** the rule is not rejected solely because GitHub includes the supported defaults

#### Scenario: A new field appears independently
- **WHEN** each of the three supported additions is returned individually in an otherwise supported pull-request rule
- **THEN** each field is validated and normalized successfully

#### Scenario: An older response omits optional additions
- **WHEN** a supported older response omits these optional fields
- **THEN** normalization retains their absence under the applicable provider contract
- **AND** it does not invent meaningful restrictions or rewrite historical observations

#### Scenario: Required reviewers carry meaningful constraints
- **WHEN** the provider returns supported nonempty reviewer definitions and their approval or path conditions
- **THEN** those values are validated and preserved for effective-policy assessment
- **AND** the decoder does not replace the list with an empty default

#### Scenario: Review dismissal is restricted
- **WHEN** a supported enabled dismissal restriction names permitted actors
- **THEN** the enabled state and exact supported actor identities remain in the normalized observation

#### Scenario: A known field has an invalid shape
- **WHEN** a boolean, reviewer collection, approval count or nested actor/restriction field has an invalid type or shape
- **THEN** normalization reports an invalid or unsupported response
- **AND** adding support for default values does not bypass validation

#### Scenario: An enforcement field is genuinely unknown
- **WHEN** an outer or nested enforcement field or rule/parameter combination is outside the supported contract
- **THEN** the observation remains incomplete or blocked
- **AND** arbitrary fields are not silently discarded to obtain normalization success

### Requirement: Review assessment distinguishes effective approval from neutral defaults
Assessment SHALL evaluate the full applicable normalized review constraints rather than only the top-level approving-review count or field presence. The extra-approval flag SHALL NOT be reported as adding a required approval when that count is zero under GitHub's documented semantics. Nonempty reviewer and dismissal settings SHALL retain their actual meaning, including the distinction between visibility-only reviewer entries and required approvals. Observed configuration SHALL remain distinct from its policy comparison.

#### Scenario: Extra approval is enabled with zero required approvals
- **WHEN** the rule requires zero approving reviews and the extra-approval flag is true
- **THEN** that flag alone does not violate the zero-required-review policy
- **AND** no repository write is proposed merely to remove the neutral default

#### Scenario: A conditional reviewer still requires approval
- **WHEN** a supported reviewer condition imposes a positive approval requirement for applicable files
- **THEN** assessment reports that actual requirement even if the top-level count is zero
- **AND** it does not declare alignment by ignoring the nonempty rule

#### Scenario: A reviewer entry adds visibility only
- **WHEN** a supported reviewer entry requires zero approvals
- **THEN** assessment preserves the configured reviewer and identifies its actual visibility-only meaning
- **AND** collection presence alone is not misreported as mandatory human approval

#### Scenario: Observation representation changes incompatibly
- **WHEN** supporting a provider response changes persisted normalization or digest meaning incompatibly
- **THEN** the change uses an explicit version/compatibility treatment before current proof is accepted
- **AND** historical records are not edited or silently reinterpreted
