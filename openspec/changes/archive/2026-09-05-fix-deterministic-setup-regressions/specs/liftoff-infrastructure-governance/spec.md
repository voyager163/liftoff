## MODIFIED Requirements

### Requirement: Generated OpenSpec bootstrap changes are complete and strict-valid
Every generated OpenSpec bootstrap change SHALL include its metadata, proposal,
design, tasks, and the capability spec declared by its proposal. The generated
new-capability spec SHALL include a concrete `## Purpose` before its delta
requirements so archive never creates a placeholder main-spec purpose. The
generated tasks SHALL verify the local baseline and defer domain-specific
product behavior without contradicting the design non-goals.

#### Scenario: Generate an API project
- **WHEN** Liftoff creates `bootstrap-<project>`
- **THEN** the change includes `specs/<generated-capability>/spec.md`
- **AND** strict OpenSpec validation succeeds immediately after generation

#### Scenario: Developer reviews seed tasks
- **WHEN** the generated design excludes domain-specific product behavior
- **THEN** its tasks confirm placeholders are deferred to follow-up changes
- **AND** do not instruct the developer to replace them inside the bootstrap change

#### Scenario: Seed baseline is verified
- **WHEN** setup completes every applicable local baseline command
- **THEN** the seed can be synced and archived without deploying infrastructure or contacting GitHub

#### Scenario: Archive creates a strict-valid main spec
- **WHEN** setup archives a generated bootstrap change that introduces a capability
- **THEN** the synchronized main spec receives the generated concrete Purpose
- **AND** `openspec validate --all --strict` succeeds without a fallback `TBD` purpose
