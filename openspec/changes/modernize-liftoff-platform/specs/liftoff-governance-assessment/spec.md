## MODIFIED Requirements

### Requirement: Assessment pins an explicit installed target
Governance assessment SHALL identify the installed CLI, selected profile/policy/content digest, target manifest, activation/graph/compatibility and report/catalog identities. Supported projects SHALL use their recorded selected profile and current installed target without registry latest or implicit profile migration. Ordinary Git repositories default to the explicitly displayed installed single-maintainer baseline unless an explicit supported target-profile selection is supplied. Observed contributors/branches SHALL not choose a different policy.

#### Scenario: Registry latest differs from the installed CLI
- **WHEN** assessment runs behind latest
- **THEN** the installed policy remains authoritative without a registry lookup

#### Scenario: CLI versions match but configuration differs
- **WHEN** recorded SemVer matches but controls or managed bytes differ
- **THEN** findings report the actual differences

#### Scenario: Ordinary Git repository has no Liftoff metadata
- **WHEN** no project profile is recorded
- **THEN** the report displays its explicit baseline without inventing a manifest or activation history

### Requirement: Control coverage is explicit and release-owned
The installed release SHALL provide validated profile-bound inventories of stable controls, applicability, expected values, proof layers and supported evaluators. Identity, GitFlow/ref families, effective protections, required checks, security, environments, runner access, Azure foundation, evidence and remaining policy families SHALL remain visible. Team review expectations SHALL differ from single-maintainer zero-review rules. New evaluators SHALL expand real coverage rather than remove unsupported controls to make alignment pass.

#### Scenario: A required evaluator is unavailable
- **WHEN** an applicable control lacks a supported observer
- **THEN** it remains not-observed and visible in coverage

#### Scenario: Catalog and policy do not match
- **WHEN** the profile/digest or enabled inventory is invalid
- **THEN** assessment errors rather than reporting vacuous alignment

#### Scenario: Single-maintainer policy is assessed
- **WHEN** its review controls are evaluated
- **THEN** expected values retain zero required human reviewers

#### Scenario: Release and hotfix bindings are only partially knowable
- **WHEN** some applicable ref families cannot be observed
- **THEN** proven findings remain and unresolved family coverage stays not-observed

#### Scenario: Team policy is assessed
- **WHEN** team GitFlow is selected
- **THEN** one current independent human PR approval and the actual automated checks are evaluated without reusing single-maintainer expectations

## ADDED Requirements

### Requirement: Manual and whole-project assessment preserve governance authority
Manual workflow SHALL not make enabled governance inapplicable or remove required proof. Whole-project assessment SHALL compose the same profile/layout-aware governance findings without changing the narrower governance-assess semantics, telemetry exclusion or no-write guarantees. Existing deployment/state limitations SHALL remain visible and shall not become executable recommendations.

#### Scenario: Manual project has local completion only
- **WHEN** framework-free local checks passed but live governance is unobserved
- **THEN** governance remains partial rather than aligned

#### Scenario: Customized paths are bound on Windows
- **WHEN** governance context uses supported active bindings on Windows, macOS or Linux
- **THEN** assessment agrees with update/repair about expected managed bytes and uses native confined paths
