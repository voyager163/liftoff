## ADDED Requirements

### Requirement: Source hardening preserves public participation and existing ownership
Repository hardening SHALL preserve the public personal repository `voyager163/liftoff`, its forks, issues, contribution access, GPL-3.0-only terms, existing branches and history, and current supported npm release authority. It SHALL NOT reinitialize history, transfer ownership, require organization capabilities, or activate generated-project or Azure production governance as a side effect.

#### Scenario: Apply source-repository hardening
- **WHEN** an authorized maintainer applies the source-repository controls
- **THEN** the canonical repository remains publicly readable and forkable with issues and contribution paths available
- **AND** existing history, licensing and supported npm publication remain intact

#### Scenario: Generated governance policy contains additional controls
- **WHEN** packaged governance policy describes organization runners, deployments, or a generated project's bypass identity
- **THEN** those declarations are not treated as source-repository authorization or evidence of enforcement
- **AND** source hardening does not provision cloud resources, probe deployed services or administer telemetry production

### Requirement: Protected source branches support one maintainer without bypass
The repository SHALL require pull requests into `develop` and `main`, zero required approving reviews, resolved conversations, and successful current-head required checks from their observed producing Apps. Ordinary branch rules SHALL have no bypass actors or administrator exemption and SHALL prohibit force pushes and deletion. They SHALL preserve existing strict checks and `main` linear history, SHALL NOT require CODEOWNERS review, last-push approval, contributor commit signing, environment reviewers or a second person, and SHALL NOT use blanket update restrictions that prevent valid PR merges.

#### Scenario: Sole maintainer merges a qualified pull request
- **WHEN** a current pull request has passed all applicable checks and has no unresolved conversations
- **THEN** the sole maintainer can merge it without another person's approval
- **AND** compatible squash or rebase merging preserves the existing linear-history requirement

#### Scenario: Administrator attempts a direct or destructive update
- **WHEN** an administrator attempts a direct non-PR update, force push or deletion of either protected branch
- **THEN** the applicable protection rejects it without an ordinary admin bypass
- **AND** a valid PR merge is not blocked merely because the bypass list is empty

#### Scenario: Required result belongs to another producer or revision
- **WHEN** a check name is reported by the wrong App or for a superseded PR revision
- **THEN** it does not satisfy the required current-revision check

### Requirement: Security control-plane changes remain maintainer-owned
The repository SHALL identify changes to its workflows, check producers/evaluators, scanner inventories/configuration, exception policy, hosted desired state and publishers as security control-plane changes. Evaluation SHALL compare the candidate with trusted base-policy identity, report membership and content changes, and SHALL NOT automatically accept candidate policy as authority to weaken its own checks. Qualified policy-only maintenance SHALL use a distinct admission decision for exact registered data addressing existing trusted-base findings, without changing actual finding verdicts. The sole maintainer's ordinary merge SHALL be policy adoption, without blind auto-merge, a separate pre-merge authorization step or an additional reviewer gate. Active authority SHALL derive from independently loaded adopted base policy, not candidate owner/approval fields. App-bound status checks SHALL NOT be represented as proof that workflow content is unchanged.

#### Scenario: Candidate weakens its own security policy
- **WHEN** a PR deletes a scanner, lowers a blocking threshold, broadens an exception or substitutes an evaluator
- **THEN** the change is explicitly reported against the trusted base policy for maintainer disposition
- **AND** candidate-authored suppression alone does not produce an authoritative clean security result
- **AND** executable/configuration changes or invalid broadening do not qualify for the policy-only maintenance route

#### Scenario: Same App emits a familiar status name
- **WHEN** an edited workflow emits an existing required check name through GitHub Actions
- **THEN** the source-policy report still identifies the workflow change
- **AND** documentation does not claim that the App binding authenticates the workflow revision

#### Scenario: Dependency bot changes a publisher or exception file
- **WHEN** a bot proposal modifies a registered control-plane surface
- **THEN** it follows the same maintainer-controlled merge path and policy checks
- **AND** neither the bot nor a generated fix grants itself approval

#### Scenario: Sole maintainer adopts an exact policy-only proposal
- **WHEN** a data-only proposal for existing base findings passes the trusted maintenance-admission contract and all other applicable required checks
- **THEN** the maintainer can adopt it through ordinary merge without a separate approval interaction
- **AND** its unresolved pre-adoption finding results remain visible rather than being relabelled clean

#### Scenario: Code-changing PR introduces a new finding
- **WHEN** a PR changes source or other protected executable/configuration inputs and introduces a blocking finding
- **THEN** it follows normal admission and remains blocked without applicable adopted policy or an actual fix
- **AND** an unused future exception or a maintenance label cannot pre-authorize it

### Requirement: Hosted capability and enforcement states are independently observable
The repository SHALL report control availability, configuration, execution, result and enforcement separately using dated evidence. It SHALL preserve enabled secret scanning, push protection, private vulnerability reporting, dependency graph and Dependabot protections. Required unavailable controls SHALL remain visible blockers, while optional unavailable or inapplicable controls SHALL remain explicit limitations. It SHALL NOT assume paid, preview, organization-only, generic-secret, validity-check or AI capabilities are available to this public personal repository.

#### Scenario: Workflow exists but has never executed
- **WHEN** source files configure a new security workflow without qualifying run evidence
- **THEN** the control is reported as configured but not proven executed, passed or enforced

#### Scenario: Repository lacks a licensed or ownership-gated feature
- **WHEN** capability discovery cannot establish access to a proposed feature
- **THEN** the report states the limitation and its effect on readiness
- **AND** no paid upgrade, organization control or duplicate scanner is silently substituted

#### Scenario: Maintainer checks secret protection
- **WHEN** acceptance verifies existing secret-scanning and reporting configuration
- **THEN** it uses sanitized setting/readback evidence without retrieving or disclosing secret values
- **AND** enabled settings alone do not establish completed scan coverage, resolved findings or effective push/merge rejection
- **AND** Copilot Autofix, when available, remains a tested suggestion rather than a release or merge approval

### Requirement: Secrets intake protection is independently qualified
Secrets-protection readiness SHALL require evidence of declared current-source/history assessment, sanitized finding disposition, native push-protection behavior, receiving-branch merge protection, and effective secret-protection bypass permissions. Push rejection, detection, merge denial and remediation SHALL be reported separately. Hosted behavioral qualification SHALL use separately authorized disposable refs and permitted nonfunctional fixtures without live credentials, publication effects or silent access changes. Missing or inconclusive evidence SHALL leave the affected protection unqualified. The repository SHALL NOT claim that push protection prevents local commits, covers every secret type, or automatically enforces the same policy on external forks.

#### Scenario: Supported nonfunctional fixture is pushed
- **WHEN** an authorized safe test submits a provider-supported nonfunctional fixture expected to trigger native push protection
- **THEN** evidence records whether that exact push was rejected, its actor/ref/policy identity and the sanitized detector response
- **AND** a local scanner result alone does not count as native push-rejection evidence

#### Scenario: Provider does not recognize a safe fixture
- **WHEN** the provider does not detect the permitted nonfunctional fixture or safe behavioral testing is unavailable
- **THEN** native rejection remains unqualified rather than being reported as passed
- **AND** no live credential is minted, submitted or validated to manufacture proof

#### Scenario: Fork pull request contains a supported secret detection
- **WHEN** a fork PR introduces a detector-supported finding into the receiving protected branch
- **THEN** the qualified unprivileged intake gate prevents merge until safe disposition or remediation is established
- **AND** a successful push to the contributor's fork does not satisfy or disprove the receiving repository's independent merge policy

#### Scenario: Native controls cannot enforce a contributor path
- **WHEN** native capability or token limitations leave a demonstrated intake-enforcement gap
- **THEN** the explicitly approved isolated detector must be qualified for that gap without privileged PR execution
- **AND** until equivalent evidence exists, the affected merge-protection claim remains blocked rather than silently skipped

#### Scenario: An actor can bypass secret push protection
- **WHEN** effective permissions or an authorized safe test show that an actor can bypass a native secret block
- **THEN** the report identifies the actual permission and its limitations separately from branch-rule bypasses
- **AND** independent receiving-branch enforcement must still be proven, with an uncovered bypass route remaining a readiness blocker

#### Scenario: Contributor creates a local commit
- **WHEN** a contributor commits content in a local clone before pushing
- **THEN** guidance distinguishes that local action from repository push and merge enforcement
- **AND** it does not promise universal prevention of commits or detection of arbitrary secrets

### Requirement: Hosted controls activate only after qualified and separately authorized rollout
Hosted changes SHALL follow read-only inventory, implementation through approved PRs, real positive and deliberate safe negative check qualification on exact unmerged refs, and separate explicit authorization for global repository settings application. Application SHALL bind observed check contexts and App identities, recheck drift, preserve existing protections during migration, and verify readback and authorized behavioral evidence. Local artifacts and an apply-ready OpenSpec change SHALL NOT authorize hosted mutations.

#### Scenario: A proposed required context lacks qualification
- **WHEN** its exact producer has not demonstrated both success and controlled failure on applicable event/ref paths
- **THEN** activation of that context remains blocked
- **AND** a renamed, skipped or synthetic status is not substituted

#### Scenario: Replace existing main protection
- **WHEN** an authorized migration introduces equivalent-or-stronger repository rules
- **THEN** existing protections remain until replacement behavior and settings are verified
- **AND** an existing failing Windows check is not removed or exempted to force migration success

#### Scenario: Desired state or live state changes before application
- **WHEN** the approved payload, target refs or live control state differs from the reviewed snapshot
- **THEN** application stops for refreshed review rather than overwriting the drift

#### Scenario: Repeat application or recover from failure
- **WHEN** application is repeated against matching state or encounters a failed readback
- **THEN** matching state is left intact and a failed readback stops further changes with recovery evidence
- **AND** any recovery edit requires narrow explicit authorization rather than blanket weakening, automatic rollback or permanent administrator bypass

### Requirement: Source hardening guidance describes actual boundaries
README, contributor, security, conduct, developer and release guidance SHALL consistently document their applicable PR-only single-maintainer path, existing fork execution approval boundary, required checks, live-security versus deterministic-test behavior, exception ownership, release qualification, recovery, reporting routes and remaining capability gaps. They SHALL distinguish repository hardening from full product governance and future native modernization. Secrets guidance SHALL identify declared scan scope, supported and unsupported patterns/surfaces, bypass limitations, safe reporting, credential-owner remediation, and the different boundaries of local commits, pushes and PR merges.

#### Scenario: External contributor follows the documented path
- **WHEN** a fork contributor submits a change
- **THEN** the guidance explains secret-free CI and the existing fork execution approval policy
- **AND** it does not require paid tooling, signed contributor commits or a second maintainer as baseline participation conditions

#### Scenario: Maintainer reviews readiness
- **WHEN** only local workflows and planning artifacts exist
- **THEN** documentation reports pending qualification and hosted activation rather than completed repository security or production readiness

### Requirement: Public README provides bounded first-use and community entry
The root README SHALL introduce Liftoff's purpose, actual release/support scope, applicable prerequisites, supported npm installation and first interactive use before maintainer-only operations. It SHALL distinguish terminal commands from coding-agent invocations, retain accessible visual guidance and provide discoverable workload, detailed documentation, privacy, support, contribution, conduct, security, release-note and GPL-license links. It SHALL remain below 135 normalized content lines using one documented/tested counting rule that treats LF and CRLF equally and ignores only the terminal newline. Detailed repair, migration and recovery material SHALL remain reachable through maintained links rather than be deleted to meet that budget.

#### Scenario: New user follows the first-use path
- **WHEN** a reader opens the README without contributor or maintainer context
- **THEN** the supported install and interactive initialization path precede release/repair internals and identify how to recognize success or obtain help
- **AND** coding-agent skill invocations are not presented as shell commands or a nonexistent CLI setup command

#### Scenario: README detail moves to a guide
- **WHEN** a lengthy repair, migration or compatibility explanation is removed from the landing page
- **THEN** its canonical linked guide retains the safety and compatibility contract
- **AND** prior navigation remains usable through preserved anchors or explicit replacement links

#### Scenario: README uses Windows line endings
- **WHEN** the same README content is evaluated with LF or CRLF line endings
- **THEN** both satisfy or fail the same fewer-than-135-line rule
- **AND** documentation and checks do not use conflicting length limits

### Requirement: Contribution paths are public reproducible and proportionate
Contributor guidance SHALL describe supported contribution types, a fork/feature-branch path from `develop`, locked setup, local invocation, scope-appropriate prerequisites/checks and a PR targeting `develop`. Main-branch changes SHALL follow the release process. Substantial feature or public-contract changes SHALL receive prior discussion and applicable OpenSpec work, while routine corrections SHALL have a lightweight path without an unrelated issue/proposal requirement. Advanced maintainer operations SHALL remain available through canonical links. Canonical public registries SHALL be the ordinary public setup; alternate registries SHALL depend on explicit organizational policy, not device ownership alone.

#### Scenario: Contributor prepares a focused fix
- **WHEN** a contributor follows the documented fork/setup/test/PR path
- **THEN** it uses actual supported Liftoff commands and targets `develop`
- **AND** maintainer publication credentials, private Mission Control files and an independent reviewer are not prerequisites

#### Scenario: Contributor proposes a documentation correction
- **WHEN** a correction does not change a public behavior contract
- **THEN** guidance requests proportionate checks and permits justified not-applicable checklist entries
- **AND** it does not require every workload toolchain, a prior feature issue or an unnecessary OpenSpec change

#### Scenario: Contributor uses a managed device
- **WHEN** no explicit organizational registry restriction applies
- **THEN** public contributor instructions do not require an employer-specific proxy or a global workstation override
- **AND** any applicable approved-registry guidance remains a clearly separate optional policy-dependent path

### Requirement: Community templates provide safe consistent intake
The repository SHALL provide GitHub-discoverable local bug/feature forms, issue-chooser routing and a PR checklist consistent with its public support/reporting guidance. Usage questions SHALL have a usable route through existing guidance and GitHub Issues without requiring a new forum or chat service. Bug intake SHALL request version/environment, a sanitized minimal reproduction and expected/actual behavior without requiring a development build. Feature intake SHALL describe the problem and desired outcome. PR intake SHALL request purpose, applicable issue/spec, proportionate verification and documentation/compatibility impact without adding an approval gate. Templates SHALL warn against public credentials, private source/data, environment files and unredacted diagnostics, and SHALL NOT request broad environment dumps or assume nonexistent labels/destinations.

#### Scenario: User reports a bug in the released CLI
- **WHEN** a user opens the bug form
- **THEN** the form accepts a released-version reproduction and safe relevant environment details
- **AND** it does not require building `develop` or uploading credentials, private projects or full configuration dumps

#### Scenario: Contributor opens a small pull request
- **WHEN** a contribution has no applicable issue or specification change
- **THEN** the checklist permits a justified not-applicable answer while retaining relevant verification and documentation expectations
- **AND** the template does not impose peer, code-owner or environment approval

#### Scenario: User selects a reporting route
- **WHEN** a reader follows README, CONTRIBUTING or issue-chooser links
- **THEN** the same usable destinations distinguish questions, public bugs/features, private vulnerabilities and private conduct concerns
- **AND** unsupported Discussions, unapproved services and nonexistent labels are not presented as configured facilities

### Requirement: Conduct reporting uses an approved separate private destination
Sensitive conduct reporting SHALL use a private contact distinct from the vulnerability advisory form and public issue templates. The owner SHALL supply and explicitly approve publication of that contact and confirm that the route is usable and monitored before revised conduct routing is published. Missing approval SHALL block that policy update and its acceptance rather than produce a placeholder or invented contact. Guidance SHALL describe practical single-maintainer handling without corporate contacts, fictitious independent responders, guaranteed confidentiality or response SLAs. Route validation SHALL NOT send real reports or provision a contact channel without separate authorization.

#### Scenario: Conduct contact has not been approved
- **WHEN** implementation lacks the owner's usable private destination and publication consent
- **THEN** the conduct-policy update remains explicitly blocked
- **AND** no copied address, placeholder, vulnerability-form substitution or completed-community claim is published

#### Scenario: User needs to report sensitive misconduct
- **WHEN** the approved conduct guidance is published
- **THEN** it offers the distinct private route and accurately describes its handling limits
- **AND** security guidance continues to direct vulnerability reports through its separate private process

#### Scenario: Documentation validation checks the contact
- **WHEN** route consistency and approval evidence are checked
- **THEN** no actual conduct/security report, email or new account is created merely to qualify the documentation

### Requirement: Public support licensing and privacy claims remain accurate
Public guidance SHALL preserve GPL-3.0-only terms, relevant notices and existing contribution licensing without adding a corporate CLA, mandatory DCO/sign-off, relicensing, reviewer quorum or support guarantee. Contributors SHALL remain responsible for understanding, explaining and validating submissions and respecting rights/confidentiality, including AI-assisted work, without a mandatory tool-specific disclosure regime. README guidance SHALL surface the documented telemetry default and opt-outs before first eligible use without changing runtime behavior. Support/maturity statements, badges and release links SHALL reflect actual published capabilities and observed facts, distinguishing planned work and development branches from released features and security support.

#### Scenario: Contributor uses an AI assistant
- **WHEN** a contributor submits AI-assisted work
- **THEN** the same explanation, verification, confidentiality and existing licensing responsibilities apply
- **AND** this change does not impose an additional agreement, special approval quorum or tool-specific disclosure gate

#### Scenario: User considers telemetry before first use
- **WHEN** the README presents the first telemetry-eligible invocation
- **THEN** the documented default, opt-out information and authoritative privacy link are already discoverable
- **AND** the documentation refresh does not silently alter telemetry behavior

#### Scenario: README describes support or quality
- **WHEN** public status, support scope, badges or release notes are presented
- **THEN** they identify actual supported/published facts and the existing release-note source without implying corporate affiliation or a service guarantee
- **AND** a planning artifact, public workflow file or benchmark comparison is not presented as implemented protection or certification
