## MODIFIED Requirements

### Requirement: Public repository declares open-source participation terms
The Liftoff repository SHALL publish GPL-3.0-only licensing and contributor-facing conduct, contribution, support, governance, and vulnerability-reporting guidance. Public contributions and forks SHALL remain welcome. Contributions SHALL retain the existing inbound GPL-3.0-only terms without mandatory CLA, DCO sign-off, or signed-commit requirements. The guidance SHALL distinguish public support, private vulnerability reporting, and a separate owner-approved private conduct-reporting channel.

#### Scenario: User reviews reuse terms
- **WHEN** a user opens the repository or inspects the packed npm package
- **THEN** the GPL-3.0-only license text is available
- **AND** package metadata declares `GPL-3.0-only`

#### Scenario: Contributor prepares participation
- **WHEN** a contributor wants to report a bug, propose a change, or disclose a vulnerability
- **THEN** the repository provides public contribution and conduct guidance
- **AND** security guidance identifies a non-public reporting path for vulnerabilities
- **AND** public support and conduct reports have distinct documented routes

#### Scenario: Contributor submits original or AI-assisted work
- **WHEN** a contributor reads contribution rights and provenance guidance
- **THEN** the contributor is responsible for permission to contribute, applicable third-party notices, review, and honest validation reporting
- **AND** AI assistance does not waive those responsibilities or require disclosure of private prompts and transcripts
- **AND** no corporate CLA, DCO sign-off, or signed commit is required by the repository

#### Scenario: Private conduct contact has not been authorized
- **WHEN** the owner has not supplied and verified the separate private conduct contact
- **THEN** that setup step remains explicitly incomplete
- **AND** no placeholder address, unapproved personal contact, corporate endpoint, or vulnerability form is presented as the completed conduct route

## ADDED Requirements

### Requirement: Open-source participation has usable public entry points
The repository SHALL provide bug and feature issue forms, an accessible general-issue path, a pull-request template, and discoverable support and contribution guidance. These entry points SHALL request only information suitable for public disclosure and SHALL direct sensitive security and conduct matters to their private policies.

#### Scenario: New contributor reports a reproducible bug
- **WHEN** a contributor opens a bug report
- **THEN** the form requests the relevant Liftoff version, operating system, sanitized reproduction, and expected and actual behavior
- **AND** it warns against posting credentials, personal data, private source, or sensitive findings

#### Scenario: A request does not fit the provided forms
- **WHEN** a user needs public support or has an issue outside the bug and feature form structures
- **THEN** a general public issue remains available
- **AND** the support guidance does not require a nonexistent chat service or promise an unsupported response time

#### Scenario: Contributor opens a pull request
- **WHEN** a contributor prepares a normal change
- **THEN** the guidance directs the PR to `develop` and requests rationale, actual checks performed, limitations, contribution rights, and relevant documentation updates
- **AND** it explains the separately documented release-promotion and back-synchronization routes

### Requirement: Maintainer authority is explicit and does not imply independent review
The repository SHALL document its current single-maintainer decision, merge, release, conduct-enforcement, and recovery responsibilities and a deliberate process for adding or removing maintainers. Ownership metadata SHALL identify the real maintainer for default changes and sensitive workflow, release, and policy surfaces without claiming that ownership routing itself enforces approval.

#### Scenario: Contributor identifies the responsible maintainer
- **WHEN** a contributor reads governance or receives an ownership review request
- **THEN** the documented owner is an actual authorized maintainer
- **AND** governance explains how decisions and future maintainer changes are made

#### Scenario: Sole maintainer reviews their own contribution
- **WHEN** the only maintainer authors a PR or initiates a release
- **THEN** the documented process allows that maintainer to perform the required deliberate review or release confirmation
- **AND** it does not describe this as independent or two-person approval

#### Scenario: A conduct complaint concerns the sole maintainer
- **WHEN** a participant reads conduct escalation guidance
- **THEN** the limitations of a single-maintainer process and applicable platform-reporting options are clear
- **AND** an independent enforcement panel or mediation service is not invented

### Requirement: Long-lived branches require reviewed pull-request integration
Active repository rules SHALL require pull requests into both `develop` and `main`, resolved conversations, and the established required check set with strict up-to-date enforcement. Required approving reviews SHALL be zero while there is one maintainer, and neither code-owner approval nor approval by someone other than the latest pusher SHALL be mandatory. Force pushes and branch deletion SHALL be prohibited, with no standing bypass actors for these branch rules.

#### Scenario: Maintainer proposes a change to a long-lived branch
- **WHEN** a maintainer wants to update `develop` or `main`
- **THEN** the change must go through a PR and the applicable merge gates
- **AND** administrator status does not provide a configured standing bypass
- **AND** the maintainer is not blocked solely because no second reviewer exists

#### Scenario: Branch update fails a required condition
- **WHEN** a PR has unresolved conversations, a failed required check, or is not up to date with its target
- **THEN** normal merging is blocked
- **AND** automation does not suppress the condition or use an administrative merge bypass

#### Scenario: A client attempts a destructive branch operation
- **WHEN** an actor attempts to delete or force-push `develop` or `main`
- **THEN** the active branch rules reject the operation

### Requirement: Release promotion preserves the two-branch history
`develop` SHALL remain the default integration branch. Normal changes SHALL target `develop`, and release promotion into `main` SHALL originate from `develop` in the canonical repository. The process SHALL support ancestry-preserving merge commits for release promotion and back-synchronization, while normal feature PRs use squash merging. Automatic merging, rebase merging, and a conflicting linear-history requirement on the long-lived branches SHALL not be enabled by this setup.

#### Scenario: Maintainer promotes a reviewed integration revision
- **WHEN** a release PR targets `main` from canonical `develop`
- **THEN** the promotion can satisfy the branch rules and use an ancestry-preserving merge commit
- **AND** the documented process includes reviewed `main` to `develop` synchronization before a subsequent promotion when required by strict freshness

#### Scenario: An arbitrary branch attempts release promotion
- **WHEN** a PR targets `main` from a feature branch or from a fork branch named `develop`
- **THEN** the repository-policy gate rejects the promotion source
- **AND** the contributor is directed to the documented integration path

#### Scenario: Both long-lived branches have advanced
- **WHEN** `main` must be synchronized into an already advanced `develop`
- **THEN** the documented process prepares an up-to-date temporary sync branch from `develop` containing the merge of canonical `main`
- **AND** that branch is integrated through a checked PR into `develop` while preserving ancestry
- **AND** the process does not require an unprotected direct push or a circular update of both protected heads

#### Scenario: Legacy and replacement protections overlap
- **WHEN** new rulesets are activated alongside existing branch protection
- **THEN** their effective combined behavior is checked
- **AND** superseded rules are removed only after equivalent intended protection is active, with linear-history conflicts explicitly reconciled

### Requirement: Required checks are established from observed hosted identities
Required checks SHALL be bound to observed successful hosted contexts and their expected GitHub App producers before those contexts become mandatory. Setup SHALL preserve existing product qualification and existing required checks, add bounded repository-policy qualification, and distinguish incomplete gate activation from a fully configured repository. Future check replacement SHALL establish the replacement before retiring the prior required identity.

#### Scenario: A new repository-policy check is introduced
- **WHEN** the check exists locally but has not yet produced a successful hosted result
- **THEN** its name alone is insufficient evidence to activate it as a required check
- **AND** foundational branch controls and previously required checks remain effective

#### Scenario: A hosted context is made mandatory
- **WHEN** the maintainer activates a required check
- **THEN** the recorded evidence identifies its successful result, source revision, event, exact context, and GitHub App producer
- **AND** the required workflow runs for relevant PRs without path filters that leave the context pending

#### Scenario: Existing application qualification fails during setup
- **WHEN** an existing application check prevents activation of a planned required context and no narrowly scoped repair has been explicitly authorized
- **THEN** setup reports the blocked context without investigating or remediating application code
- **AND** it does not remove existing gates, disable tests, lower thresholds, or silently declare the planned gate unnecessary

#### Scenario: Owner authorizes the Windows CI compatibility repair
- **WHEN** the owner explicitly authorizes repairing the Windows CI blocker
- **THEN** diagnosis and changes remain limited to the failing Windows execution and test paths needed for qualification
- **AND** existing assertions, checks, and execution deadlines remain enforced without expanding into general application auditing or npm-account configuration

#### Scenario: A future rewrite changes a required check
- **WHEN** the project replaces a workflow or job identity
- **THEN** the successor is observed and the required-check mapping is explicitly updated before the old identity is retired
- **AND** scheduled dependency audits and freshness reports do not automatically become blocking PR checks

### Requirement: Contribution automation does not carry publication authority
Repository Actions defaults SHALL remain read-only with bot PR approvals disabled. External action dependencies SHALL be explicitly allowed and full-SHA pinned, and fork workflows from all outside contributors SHALL require maintainer approval. Contribution CI SHALL use unprivileged pull-request execution on GitHub-hosted runners without release secrets, OIDC publication grants, or cloud credentials. Privileged execution of untrusted PR code or artifacts SHALL not be introduced.

#### Scenario: Returning outside contributor opens another PR
- **WHEN** a contributor without collaborator access submits a fork PR after an earlier contribution was merged
- **THEN** the fork workflow still requires the configured maintainer approval
- **AND** approval to run checks does not grant secrets, publishing access, or deployment authority

#### Scenario: Workflow requests an unapproved external action
- **WHEN** a workflow references an external action outside the approved inventory or without a full commit SHA
- **THEN** the repository action policy or bounded repository-policy check rejects it
- **AND** an action allowlist is not represented as restricting arbitrary shell commands or providing a sandbox

#### Scenario: Contributor changes automation controls
- **WHEN** a PR changes workflow triggers, permissions, publication configuration, or checks
- **THEN** deliberate maintainer review is required by the documented process
- **AND** a successful GitHub Actions status is not represented as independent review of that workflow
- **AND** the PR is not automatically merged

#### Scenario: Existing reporting controls are retained
- **WHEN** the repository setup is applied
- **THEN** private vulnerability reporting, enabled secret scanning and push protection, and existing Dependabot updates remain enabled
- **AND** their existing findings are not audited or triaged as part of this setup

### Requirement: Repository setup is scoped and verified independently of application hardening
Setup SHALL distinguish local preparation, authorized hosted mutations, observed effective enforcement, owner-managed account steps, and unexercised publication behavior. It SHALL modify only explicitly identified files and settings, preserve unrelated work, and require explicit authority for Git-state mutations, hosted mutations, app installations, and publication. The setup SHALL not initiate application-code, history, vulnerability, dependency-license, or generated-project governance audits.

#### Scenario: Local setup files have been prepared
- **WHEN** community documents, workflow changes, and policy checks exist locally
- **THEN** setup reports those files as prepared rather than claiming GitHub or npm configuration is active
- **AND** it does not commit, push, switch branches, mutate remote settings, or publish without the corresponding authority

#### Scenario: Hosted settings are applied
- **WHEN** an approved repository settings change is executed
- **THEN** setup reads back the effective target repository settings and relevant branch, environment, or tag controls
- **AND** missing permissions, unsupported capabilities, or owner-only steps remain explicit blockers rather than success-shaped fallbacks

#### Scenario: An unrelated configuration file is present
- **WHEN** setup updates its named artifacts
- **THEN** replacement or deletion is selected by explicit inventory lookup
- **AND** unrelated OpenSpec skills, prompts, application files, and other user-owned content are preserved rather than claimed by directory patterns

#### Scenario: Setup checks run on supported workstations
- **WHEN** repository/documentation checks run on Windows paths containing spaces, macOS, or case-sensitive Linux filesystems
- **THEN** named local artifacts resolve using platform-correct filesystem paths
- **AND** URL separators and local path separators are treated distinctly
