## ADDED Requirements

### Requirement: Documentation explains repository-governance selection and activation
The system SHALL provide packaged and generated documentation for the governance profile choice, enabled default, opt-out, local artifact set, manifest state, post-push agent launcher, read-only Phase 0, explicit approval boundary, selected-framework change creation, and live enforcement sequence. It SHALL state prominently that generated policy is not active GitHub governance.

#### Scenario: New user follows interactive onboarding
- **WHEN** a developer reads getting-started or workload guidance
- **THEN** the guide includes the repository-governance question after applicable architecture choices
- **AND** explains that accepting it generates a local handoff only

#### Scenario: User activates after push
- **WHEN** a developer reads the generated governance guide
- **THEN** it identifies the selected-agent command or prompt, Git repository and remote prerequisites, Phase 0 report, and required plan approval
- **AND** distinguishes conversational plan approval from prohibited human merge or deployment approvals

#### Scenario: User opts out
- **WHEN** documentation describes `--governance none` or the configuration equivalent
- **THEN** it explains that Liftoff omits the handoff and does not alter live repository settings

### Requirement: Documentation describes existing-project adoption
Update, configuration, manifest, safety, and troubleshooting guidance SHALL
explain that configurations without a governance field default to the enabled
profile, `liftoff update --check` previews the new durable artifacts, plain
update applies collision-free artifacts, unrecorded conflicts remain preserved
and produce `handoff-partial` without Liftoff ownership, resolving all such
conflicts promotes the manifest to `handoff-generated`, opt-out creates orphans
rather than deletion, and no update mode activates remote governance.

#### Scenario: Existing user previews adoption
- **WHEN** a user reads upgrade guidance for a pre-v5 project
- **THEN** it directs the user to run `liftoff update --check`
- **AND** explains the expected schema-v5 and governance artifact drift

#### Scenario: Existing governance file conflicts
- **WHEN** troubleshooting describes a collision at a generated policy or launcher path
- **THEN** it tells the user to review the exact file before considering `--force`
- **AND** explains the partial local handoff state and that the preserved file has no Liftoff manifest entry
- **AND** does not recommend deleting, bypassing, or remotely applying anything to make update pass

### Requirement: The complete single-maintainer policy remains discoverable
The packaged governance documentation SHALL expose the complete policy covering GitFlow, zero-approval repository rules, security stages and designated tools, fail-closed checks, immutable release evidence, build-once promotion, deployment and rollback, monitoring and health, DORA metrics, ruleset sequencing, negative tests, documentation, and workload adaptation. It SHALL identify fixed assumptions and every capability that Phase 0 must verify.

#### Scenario: Developer audits generated policy
- **WHEN** a developer opens the canonical generated policy
- **THEN** the full standard is readable without requiring network access or an agent
- **AND** links or launchers do not replace its normative content

#### Scenario: Policy capability is unavailable
- **WHEN** documentation describes a missing license, runner, monitoring route, or platform mechanism
- **THEN** it requires an explicit Phase 0 gap or inapplicability report
- **AND** prohibits a silent substitute or success-shaped placeholder
