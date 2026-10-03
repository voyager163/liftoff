## MODIFIED Requirements

### Requirement: Repository governance is a selectable project profile
The append-only catalog SHALL include single-maintainer-gitflow, team-gitflow and none. Interactive selection SHALL explain their distinct review rules and retain single-maintainer as default; absent noninteractive/configuration values retain that default. Existing recorded selections SHALL not change based on contributor count, workflow choice or CLI upgrade.

#### Scenario: Accept the interactive default
- **WHEN** a user accepts the unchanged default
- **THEN** the plan selects single-maintainer and labels generated artifacts as a local handoff

#### Scenario: Opt out interactively
- **WHEN** none is selected
- **THEN** governance-specific policy/setup/assessment handoff is omitted

#### Scenario: Select noninteractively
- **WHEN** a valid explicit profile is supplied
- **THEN** it is resolved without another selection prompt

#### Scenario: Reject an unknown profile
- **WHEN** the value is not in the catalog
- **THEN** parsing/planning rejects it before effects

### Requirement: The profile carries settled platform and infrastructure defaults
Profiles SHALL retain applicable approved storage/state redundancy, identity/OIDC, small-workload scaling, production safeguards, secret-reference and Active-LTS defaults without repeatedly asking settled questions. They SHALL not provision unused services and SHALL disclose material cost/limits before adoption. Differences involving pre-existing deployed resources SHALL produce an approval-ready reconciliation plan but SHALL remain publicly planning-only in this release; matching a name SHALL not authorize import, replacement or a parallel stack.

#### Scenario: Generated workload uses an applicable platform default
- **WHEN** no approved project-specific exception applies
- **THEN** its selected profile's settled defaults are used

#### Scenario: Proposed managed service has no consumer
- **WHEN** no application path consumes a service
- **THEN** it is omitted rather than provisioned speculatively

#### Scenario: Proposed service has material limits or cost
- **WHEN** an applicable managed service is planned
- **THEN** its cost/limits are disclosed before scope approval

#### Scenario: Live infrastructure differs from IaC
- **WHEN** existing deployed ownership or state requires reconciliation
- **THEN** the plan describes required preservation/import work as deferred public execution
- **AND** no duplicate stack, force replacement or fabricated external ownership is used

### Requirement: Automated GitFlow completion respects protected branches and token recursion
Release/hotfix completion and back-merges SHALL use PRs and actual successful required checks. Single-maintainer retains zero human review; team requires its independent human PR approval. GITHUB_TOKEN-suppressed events SHALL be handled through explicit exact-commit validation/deployment dispatch, never direct protected pushes or synthetic success. Creation of tags/releases SHALL remain within the verified production release operation.

#### Scenario: Automation opens a protected-branch back-merge
- **WHEN** a release/hotfix needs a back-merge
- **THEN** automation opens the PR, starts exact-head checks and waits for all selected-profile gates before merge

#### Scenario: Token-generated merge does not emit a follow-on workflow
- **WHEN** the normal event would be suppressed
- **THEN** required follow-on work is explicitly invoked and absence/failure blocks completion

#### Scenario: Production deployment creates a release tag
- **WHEN** qualified production deployment succeeds
- **THEN** the same approved operation creates its tag/release/evidence without depending on another tag-triggered run

### Requirement: Updated policy content preserves the Liftoff activation envelope
Canonical policy SHALL retain valid frontmatter, an explicit current profile-specific version/digest, and the handoff-versus-enforcement protocol. Normative changes SHALL advance the affected policy identity. Preserve publication prerequisites, scoped discovery, exact approval, user-owned baseline, selected workflow or native Manual plan, and ruleset-last sequencing. Mandatory controls SHALL not be removed or weakened to obtain a passing result.

#### Scenario: Liftoff renders the revised policy
- **WHEN** either profile is selected
- **THEN** its actual current packaged identity and invariant set appear in the handoff without a live-enforcement claim

#### Scenario: Updated prompt omits Liftoff metadata
- **WHEN** policy input lacks the required envelope
- **THEN** validation rejects missing identity/approval safeguards rather than accepting the prose as authority

#### Scenario: Unsupported control coverage remains explicit
- **WHEN** a required control cannot be observed or executed
- **THEN** it stays visible as unsupported or blocked instead of becoming optional

### Requirement: Governance implementation starts only in the selected spec workflow
After scoped discovery and explicit approval, governance SHALL use the project's selected OpenSpec/Spec Kit source-of-truth contract or, for Manual, a native reviewed operational plan and evidence. Manual SHALL not require an agent or mandatory proposal/design/tasks/constitution artifacts. Generated handoff SHALL not pre-create or take ownership of unrelated active framework work, and a changed source/identity SHALL require reconciliation.

#### Scenario: Approve an OpenSpec project
- **WHEN** scoped Phase 0 is approved
- **THEN** the selected framework captures applicable governance work and the Liftoff handoff remains its input

#### Scenario: Archive the governance change
- **WHEN** its owner archives or removes completed framework work
- **THEN** ordinary validate/doctor/update do not recreate it

#### Scenario: Approve a Manual project without agents
- **WHEN** its complete operational plan receives the required approval
- **THEN** actual CLI governance operations can proceed without invoking a framework or fabricating a change archive

### Requirement: The supported profile is implemented and independently verified
The production path SHALL implement all applicable advertised controls for approved new-environment activation through real identities, artifacts, workflows, qualification and enforcement. Required contexts SHALL have actual green and controlled-red proof on applicable ref families; rulesets apply last and receive independent readback. Single-maintainer zero-reviewer restrictions and team independent-PR-review requirements SHALL remain distinct. Pre-existing deployment/state adoption remains planning-only and SHALL not be hidden behind a full-journey completion claim.

#### Scenario: A workflow file exists but has not run
- **WHEN** required proof consists only of source configuration
- **THEN** enforcement remains incomplete

#### Scenario: A required check is skipped or synthetic
- **WHEN** proof is skipped, cancelled, neutral, stale or a fabricated success
- **THEN** it cannot satisfy qualification

#### Scenario: Idempotent enforcement is requested
- **WHEN** approved source already matches current live rules
- **THEN** the operation preserves them and records real readback without destructive replacement

## ADDED Requirements

### Requirement: Team GitFlow requires one independent human PR approval
Team GitFlow SHALL require one independent human approving review plus its automated fail-closed checks for applicable protected PRs, including release/hotfix back-merges. Self/bot-only approvals and approvals invalidated by relevant changes SHALL not satisfy the gate. Existing stronger controls and CODEOWNERS SHALL not be silently weakened or removed. No mandatory deployment reviewer or fabricated team identity SHALL be introduced merely by selecting this profile.

#### Scenario: Author tries to approve their own PR
- **WHEN** no valid independent human approval exists
- **THEN** the team merge gate remains unsatisfied even if automated checks pass

#### Scenario: Reviewed PR changes
- **WHEN** relevant changes invalidate its required approval
- **THEN** merge remains blocked pending current independent review

#### Scenario: Existing repository requires two approvals
- **WHEN** adoption compares it with the one-approval default
- **THEN** any proposed weakening is explicitly surfaced for separate review rather than applied automatically

#### Scenario: Single-maintainer project is upgraded
- **WHEN** it retains the single-maintainer selection
- **THEN** its zero-human-review meaning remains unchanged

### Requirement: Profile identity is bound across portable governance artifacts
Assessment, plans, graph interpretation, approvals and evidence SHALL bind the exact selected profile/version/digest. Switching profiles SHALL require reviewed reconciliation and fresh applicable proof, not reuse approval from another profile. Logical names and path parts SHALL be explicit and portable across Windows, macOS and Linux.

#### Scenario: Team approval is reused for another profile
- **WHEN** identity or planned controls no longer match
- **THEN** execution rejects reuse and requests a current plan

#### Scenario: Governance artifacts are resolved on Windows
- **WHEN** the project path contains spaces or unsafe aliases
- **THEN** native confinement and exact artifact lookup preserve the same profile binding without following junction escapes
