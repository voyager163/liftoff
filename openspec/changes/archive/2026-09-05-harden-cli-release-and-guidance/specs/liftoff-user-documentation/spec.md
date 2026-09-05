## ADDED Requirements

### Requirement: Generated infrastructure guidance is environment-correct and authority-aware
Generated root and infrastructure guidance SHALL reference environments that
were actually selected. For governed projects it SHALL distinguish reference
commands from authorized phase execution and SHALL not present direct
infrastructure mutations as an ungated next step. It SHALL identify unavailable
production activation capabilities as blockers rather than claiming that a
command-only setup flow already implements them.

#### Scenario: Governed project documentation is read
- **WHEN** generated guidance describes infrastructure plan or apply operations
- **THEN** it requires the relevant separately approved governance phase before execution
- **AND** does not bypass the setup authority boundary

#### Scenario: Ungoverned project documentation is read
- **WHEN** a project explicitly disables governance
- **THEN** reference infrastructure recipes remain available without fabricated governance activation
- **AND** they use an environment the project actually contains

#### Scenario: A production-only project is generated
- **WHEN** `prod` is the first or only selected environment
- **THEN** generated examples do not reference a nonexistent development variable file

#### Scenario: Maintainer reads audit follow-up guidance
- **WHEN** the developer guide describes the patch's architectural review
- **THEN** it distinguishes implemented functionality from known deferred activation and generated-application work
- **AND** recommends incremental domain/adapter/generator separation rather than claiming the entire CLI was rewritten
