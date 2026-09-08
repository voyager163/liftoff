## MODIFIED Requirements

### Requirement: The root README is a product-oriented landing page
The system SHALL provide a concise public README leading with Liftoff's identity, plain-language value, meaningful release/quality badges, an accessible terminal visual, and the shortest supported interactive install path. It SHALL introduce GenAI and API workloads with OpenSpec, Spec Kit, GitHub Copilot, and Claude Code without embedding the complete operational reference or presenting Power Apps as supported.

#### Scenario: New developer scans the repository
- **WHEN** a developer opens the root README
- **THEN** the first screen explains Liftoff's supported workloads and integrations and gives installation followed by `liftoff init`

#### Scenario: Terminal visual has a text alternative
- **WHEN** the README includes a terminal image
- **THEN** meaningful alternative text and the surrounding quick start communicate the same essential flow

#### Scenario: Badges represent observable project facts
- **WHEN** badges appear
- **THEN** they link to observable npm, CI, license, or runtime facts rather than unsupported readiness claims

### Requirement: Detailed user guidance uses progressive Markdown documentation
The system SHALL maintain linked Markdown guides for getting started, supported workloads, workflows/agents, existing repositories, prerequisites, safety/consent, CLI reference, generated structure, configuration/manifests, assessment, deployment, and troubleshooting. Material moved out of the README SHALL remain discoverable. Supported-workload guidance SHALL cover API/GenAI; retirement guidance SHALL explain former Power Apps inputs separately.

#### Scenario: Developer needs a detailed contract
- **WHEN** a developer follows README links for safety, prerequisites, manifests, structure, or Azure
- **THEN** the linked documents contain the corresponding detailed guidance

#### Scenario: Developer chooses a workload
- **WHEN** workload documentation is opened
- **THEN** it distinguishes API/GenAI questions, output, prerequisites, and deferred actions without offering Power Apps creation or maintenance

#### Scenario: Contributor needs release internals
- **WHEN** a contributor needs build, test, packaging, or release procedures
- **THEN** the README links to CONTRIBUTING.md rather than duplicating release implementation in onboarding

### Requirement: Documentation identifies the tested supported-stack baseline
The system SHALL publish applicable runtime, package-manager, framework, frozen-dependency, immutable-source, and refresh contracts consistently across packaged and contributor guidance. Statements SHALL agree with the release-owned baseline and distinguish new-generation baselines from separately reviewed adoption into existing projects.

#### Scenario: Developer checks prerequisites
- **WHEN** prerequisites are read for a supported workload
- **THEN** only its applicable Node.js, npm, Python, Go, uv, OpenTofu, OpenSpec, and Spec Kit constraints are identified
- **AND** they agree with the release-owned baseline, including the CLI Node.js minimum

#### Scenario: Developer installs Python dependencies
- **WHEN** Python setup is documented
- **THEN** it uses the platform-appropriate frozen uv flow rather than regenerating locks or installing open-ended ranges

#### Scenario: Existing project reviews a major baseline
- **WHEN** release guidance describes changed generated-stack compatibility
- **THEN** runtime floors and application compatibility changes are identified as separate project migration work
- **AND** ordinary update or force is not offered to replace production dependencies, containers, or infrastructure

### Requirement: Contributor guidance documents reproducible baseline refresh
Contributor guidance SHALL identify canonical version sources, stable/LTS selection, temporary materialization, explicit remaining asset/audit inventories, immutable provenance where applicable, and complete promotion checks. The retired Power Apps starter refresh and compatibility inventory SHALL NOT remain an active maintenance procedure.

#### Scenario: Maintainer refreshes dependencies
- **WHEN** a maintainer follows the refresh process
- **THEN** neither user projects nor mutable upstream state become the source of truth
- **AND** the resulting reviewed change includes affected baseline records, manifests, locks, digests, checksums, cases, and documentation

### Requirement: Documentation explains repository-governance selection and activation
The system SHALL document governance selection, enabled default, opt-out, local artifacts, manifest state, post-init setup, read-only Phase 0, approval boundaries, selected-workflow handoff, and the target enforcement sequence. It SHALL distinguish those target capabilities from currently executable behavior and state that generated policy is not active governance.

#### Scenario: New user follows interactive onboarding
- **WHEN** getting-started or workload guidance is read
- **THEN** governance selection follows applicable architecture choices and accepting it is described as a local handoff only

#### Scenario: User activates after push
- **WHEN** the generated guide describes post-push governance
- **THEN** it identifies the selected-agent entry point, repository/remote prerequisites, Phase 0 facts, and required scope approval
- **AND** distinguishes activation authority from prohibited human merge/deployment reviewers
- **AND** states when the installed release lacks a necessary execution or approval-entry capability

#### Scenario: User opts out
- **WHEN** governance none is documented
- **THEN** the guide explains that local handoff generation is omitted without changing live repository settings

### Requirement: Documentation describes existing-project adoption
Guidance for supported API/GenAI projects SHALL explain enabled defaults for absent governance configuration, safe core adoption, unowned collision protection and partial handoff, orphan-preserving opt-out, and the absence of remote activation. It SHALL distinguish v2-v7 project manifest compatibility from executable activation-history compatibility. Retired Power Apps projects SHALL NOT be included in the supported adoption path.

#### Scenario: Existing user previews adoption
- **WHEN** a supported pre-v7 project reads upgrade guidance
- **THEN** it is directed to `liftoff update --check` and receives an explanation of manifest-v7 ownership migration and governance core drift
- **AND** existing activation history is not described as implicitly migrated or newly verified

#### Scenario: Existing governance file conflicts
- **WHEN** a generated policy or setup path collides with an unowned file
- **THEN** guidance requires review of that exact file, explains partial handoff and lack of ownership, and preserves the conflict
- **AND** does not recommend deletion, forced takeover, or remote action merely to make update pass

### Requirement: Documentation provides one post-init kickstart
The root README, getting-started guide, generated README, and governance guide SHALL retain initialization followed by `/liftoff-setup` as the primary supported-project journey. They SHALL explain the selected workflow's local baseline/finalization, later publication and Phase 0 boundaries, authority gates, explicit retry, and the distinction between model explanation and CLI authority. Unimplemented production or public enrollment/approval capabilities SHALL be identified as blockers, not presented as completed automation.

#### Scenario: Developer finishes initialization
- **WHEN** supported-project completion output or README is read
- **THEN** the next setup entry point is `/liftoff-setup` and its applicable local baseline checks are listed

#### Scenario: Developer asks about model selection
- **WHEN** setup guidance discusses model selection
- **THEN** it states that none is required and safety depends on deterministic phase/evidence contracts

#### Scenario: Developer inspects setup identity
- **WHEN** setup identities are documented
- **THEN** CLI, policy, activation contract, schema versions, and graph hash are distinguished without an independent setup-skill version
- **AND** the current activation-v2 family is distinguished from diagnostic-only v1 history

#### Scenario: Setup needs developer input
- **WHEN** authority questions are documented
- **THEN** they are limited to repository publication, credentials, billed infrastructure/exceptions, enforcement, destructive actions, and external blockers
- **AND** documentation does not suggest manually creating an approval envelope when no supported entry point exists

#### Scenario: Developer resumes setup
- **WHEN** a prior run stopped on a blocker
- **THEN** guidance explains read-only resume and explicit retry after repair through the selected setup flow
- **AND** unchanged verified work is not repeated and remote/destructive failures are not automatically retried

#### Scenario: Developer reads setup command guidance
- **WHEN** generated setup aliases are discussed
- **THEN** `/liftoff-setup` is the primary setup command and retired aliases appear only as reviewed removal debt

#### Scenario: Developer enters a credential
- **WHEN** the target policy requires PAT fallback
- **THEN** guidance describes deterministic scope and masked-entry requirements without exposing credentials in chat, arguments, logs, evidence, or screenshots
- **AND** a release without a supported enrollment entry point is described as blocked rather than inviting another input channel

#### Scenario: Spec Kit user completes the local baseline
- **WHEN** Spec Kit setup is documented
- **THEN** the guide distinguishes the project-owned bootstrap spec/plan/tasks bundle from official framework initialization markers and explains its finalized local receipt
- **AND** does not instruct the user to create an OpenSpec directory or run a nonexistent Spec Kit archival command
- **AND** explains that an older project without the bundle needs separately reviewed seed adoption rather than automatic creation by update or force

### Requirement: Documentation distinguishes assessment from update and activation
Public, generated, and contributor guidance SHALL describe read-only governance assessment for supported Liftoff projects and ordinary Git repositories, its local-only default and explicit live reads, installed policy target, four comparison layers, classifications, coverage, provenance, and exit codes. Assessment SHALL remain distinct from initialization, update, migration, activation, and permission to remediate.

#### Scenario: Developer wants to see differences
- **WHEN** assessment guidance is read
- **THEN** target, recorded baseline, declared configuration, and observed enforcement are distinguished together with expected/observed values, provenance, impact, and advice

#### Scenario: Developer does not want network access
- **WHEN** the default assessment example is followed
- **THEN** it is local-only with no cloud/GitHub credentials and explains unobserved live proof
- **AND** all assessment invocations, including help, are described as telemetry/disclosure-excluded

#### Scenario: Developer requests live assessment
- **WHEN** live mode is introduced
- **THEN** bounded existing-permission scope and the no-mutation boundary are stated
- **AND** denied or unavailable reads are not described as absence, alignment, or changed local files

#### Scenario: Assessment is partial or excepted
- **WHEN** coverage is incomplete or an exception is accepted
- **THEN** guidance explains exit 2 without claiming broken activation, permission to repair, or full alignment
- **AND** states that unsupported applicable controls prevent a fully aligned outcome even in live mode

#### Scenario: Upgrade is blocked by compatibility
- **WHEN** assessment identifies historical or unsupported activation mapping
- **THEN** guidance names the actual unavailable reconciliation capability without inventing a command or recommending edited receipts
- **AND** force is not presented as a compatibility bypass

#### Scenario: Developer installs a newer assessment integration
- **WHEN** a compatible initialized project needs the selected-agent integration
- **THEN** guidance uses normal guarded core update and states that installation/running the integration does not activate governance
- **AND** ordinary Git repositories can use the CLI directly without installing an integration

#### Scenario: Maintainer extends policy assessment coverage
- **WHEN** contributor guidance describes a new control or evaluator
- **THEN** it requires stable IDs, policy/catalog coherence, explicit proof/support limits, deterministic cases, no-write guarantees, and cross-platform path coverage
- **AND** does not introduce an independently maintained assessment-skill version

#### Scenario: Developer assesses Liftoff's source repository
- **WHEN** an ordinary Git repository has no Liftoff manifest
- **THEN** guidance uses the same read-only CLI and explains missing Liftoff-specific proof rather than requiring initialization
- **AND** makes the installed single-maintainer policy target explicit instead of inferring policy from current branches

#### Scenario: Manifest is retired or damaged
- **WHEN** a repository contains an explicit retired, malformed, or unsafe manifest
- **THEN** guidance explains its error boundary and does not recommend hiding that manifest to force generic fallback

### Requirement: Generated infrastructure guidance is environment-correct and authority-aware
Generated guidance SHALL use selected environments and their recorded infrastructure layout. New output SHALL describe independent environment roots/state; existing shared-state output SHALL have an explicit migration boundary. Governed projects SHALL distinguish reference commands from separately approved execution and identify unavailable production capabilities instead of bypassing them.

#### Scenario: Governed project documentation is read
- **WHEN** generated guidance describes plan/apply
- **THEN** it requires the relevant separately approved phase and does not bypass an unavailable executor

#### Scenario: Ungoverned project documentation is read
- **WHEN** governance is explicitly disabled
- **THEN** reference recipes use declared environments without fabricated activation

#### Scenario: A production-only project is generated
- **WHEN** prod is the first or only selected environment
- **THEN** examples use its independent root and production inputs without nonexistent development files

#### Scenario: Maintainer reads audit follow-up guidance
- **WHEN** contributor guidance describes this stabilization work
- **THEN** completed corrections and structural extraction are distinguished from deferred production activation and GenAI specializations
- **AND** it does not equate rendered artifacts or module moves with finished capabilities

#### Scenario: Existing infrastructure uses shared state
- **WHEN** an existing project reviews the new environment layout
- **THEN** guidance requires a separate reviewed infrastructure/state migration and preserves existing files/state under update and force
- **AND** it explains that new-environment provisioning is blocked until the recorded layout is compatible rather than creating unusable roots or rewriting shared project files

## ADDED Requirements

### Requirement: Retirement guidance preserves existing Power Apps projects
Public and packaged guidance SHALL identify complete Power Apps retirement as a breaking change, covering creation and existing-project support. It SHALL explain explicit unsupported-workload errors without offering conversion, application deletion, force bypass, or continued support in the new CLI.

#### Scenario: User opens an existing retired project
- **WHEN** a user encounters a Power Apps retirement error
- **THEN** guidance states that their application files are unchanged and that this release does not provide a Power Apps maintenance or migration lane

#### Scenario: Maintainer removes starter assets
- **WHEN** contributor guidance describes retirement
- **THEN** it requires coordinated explicit inventory removal and preservation of shared regression scenarios on supported workloads
- **AND** never directs users to uninstall unrelated machine-wide tools or plugins

### Requirement: Starter capability descriptions match delivered behavior
Public and generated guidance SHALL expose an accurate capability/maturity description for each retained GenAI pattern and distinguish invocation/runtime wiring from missing specialized behavior. It SHALL NOT call buffered completion incremental streaming or imply that retrieval, history, tools, coordination, workflow execution, or fine-tuning is present when absent.

#### Scenario: User compares named patterns
- **WHEN** a user reads the pattern/workload matrix
- **THEN** implemented operations and deferred boundaries are explicit rather than inferred from a full-scaffold label

#### Scenario: User follows configuration instructions
- **WHEN** supported native or Compose startup is documented
- **THEN** configuration sources, precedence, dependency preparation, and container-specific addressing agree with generated runtime behavior
- **AND** locally installed dependency trees are excluded from generated container build contexts

### Requirement: Contributor guidance makes module responsibilities discoverable
The contributor guide SHALL document the eight functional responsibility groups, their actual implementation locations, public interfaces, dependency direction, ownership rules, and the process for extending workloads or phases without duplicating policy/evidence authority.

#### Scenario: Contributor extends a supported workload
- **WHEN** a contributor follows the module map
- **THEN** the responsible planning, generation, configuration, prerequisite, and acceptance boundaries are identifiable without treating callback facades as independent implementations

#### Scenario: Contributor changes an activation contract
- **WHEN** phase, evidence, approval, or serialization semantics change
- **THEN** the guide identifies the required independent version/hash updates and historical-compatibility consequences

#### Scenario: Contributor works on Windows
- **WHEN** paths and acceptance recipes are documented for contributors
- **THEN** they use platform-correct path construction and explicit shell conventions for Windows, macOS, and Linux
- **AND** distinguish portable logical artifact paths from native filesystem paths
