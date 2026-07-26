## ADDED Requirements

### Requirement: Completion command guidance is explicitly labeled
The system SHALL present any command supplied by a successful completion flow under a named `Next recommended command` heading before rendering the existing copyable shell command. The label SHALL make clear that the command is guidance rather than output Liftoff already executed. Liftoff MUST NOT execute, confirm, rewrite, wrap, or otherwise act on the recommendation, and completion without a recommended command SHALL NOT render an empty recommendation section.

#### Scenario: Initialization recommends validation clearly
- **WHEN** project initialization completes with its validation recommendation
- **THEN** Liftoff renders `Next recommended command` before the exact `$`-prefixed validation command
- **AND** it returns control to the developer without running that command

#### Scenario: Migration recommends the validation gate clearly
- **WHEN** migration completes with `liftoff validate && liftoff doctor` as its recommendation
- **THEN** the command appears in the named recommendation section rather than as an unlabeled completion line

#### Scenario: Update recommends follow-up validation clearly
- **WHEN** an update completes with `liftoff validate && liftoff doctor` as its recommendation
- **THEN** the completion output identifies it as the next recommended command and does not imply it already ran

#### Scenario: Recommendation preserves exact command syntax
- **WHEN** a recommended command contains quoted paths, repeated whitespace, a Windows path, arguments, or shell operators such as `&&`
- **THEN** the displayed command content remains one line and is byte-for-byte identical to the supplied recommendation
- **AND** the `$` marker remains presentation rather than part of the command

#### Scenario: Recommendation is responsive and color-safe
- **WHEN** completion renders in rich, compact, plain, color, or no-color presentation
- **THEN** the recommendation heading and decoration remain within the selected terminal width and retain the same visible text
- **AND** a command longer than the terminal width remains an exact unwrapped line rather than being rewritten

#### Scenario: Completion has no recommendation
- **WHEN** a completion caller supplies no recommended command
- **THEN** Liftoff renders no empty `Next recommended command` section

#### Scenario: Machine output remains unaffected
- **WHEN** a machine-readable command path bypasses human completion presentation
- **THEN** no recommendation label or decorative command text contaminates its output
