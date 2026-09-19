## MODIFIED Requirements

### Requirement: Migrate adopts existing projects through a fresh scaffold
The system SHALL retain `liftoff migrate <path>` as a source-read-only workflow that scans an existing non-Liftoff project, captures decisions through the standard initialization contract, generates a fresh scaffold in a new or empty sibling target, stages the permitted legacy material and emits reviewed migration work. The new target SHALL use current manifest artifact 8, its explicit profile/generation identity and the complete selected official framework integration. The command SHALL NOT write to the source or become an alias for in-place adoption or CLI installation migration.

#### Scenario: Migrate produces a compliant scaffold
- **WHEN** the developer selects a supported target and completes the required planning and prerequisite permissions
- **THEN** the fresh target contains a valid manifest-8 scaffold and complete selected framework integration
- **AND** scaffold validation is distinguished from completion of the pending application-porting work

#### Scenario: Source project is untouched
- **WHEN** migration generation completes or fails
- **THEN** the original source tree remains byte-for-byte unchanged

#### Scenario: Target directory must be new or empty
- **WHEN** the chosen target is non-empty
- **THEN** migration fails before target writes even when force is supplied

## ADDED Requirements

### Requirement: Fresh-target planning does not invent semantic conversion support
A developer's supported target selection SHALL determine the fresh scaffold and placement plan without certifying that legacy application behavior has been converted. Source findings and unresolved mappings SHALL remain visible. Executable application adoption or porting SHALL require a registered supported profile/recipe, exact reviewed effects and actual validation; unsupported source-stack conversion SHALL remain diagnostic or explicitly unresolved planning work.

#### Scenario: The target differs from the detected source
- **WHEN** the developer explicitly chooses a supported target stack different from the source evidence
- **THEN** migration can describe the selected fresh scaffold and source-preserving placement work
- **AND** it does not claim that application behavior has already been converted or that unregistered porting is executable

#### Scenario: A source framework is unsupported
- **WHEN** source assessment finds an unregistered framework or uncertain semantic mapping
- **THEN** those facts remain explicit blockers for executable application conversion
- **AND** generated target files or checked planning tasks cannot substitute for a supported transformation and proof

### Requirement: Project and installation migration retain distinct targets
Fresh-target project migration, reviewed in-place adoption and installation-owner migration SHALL retain separate commands, target identities, plans and permissions. None SHALL infer the other's mutation authority. Native path handling SHALL preserve these boundaries on Windows, macOS and Linux.

#### Scenario: A historical npm user replaces only the CLI
- **WHEN** installation migration is selected
- **THEN** no project scaffold, legacy-source copy, application mapping or manifest rewrite occurs
- **AND** `liftoff migrate` is not offered as the npm-to-native handover command

#### Scenario: The user wants to keep the existing project location
- **WHEN** an existing supported application requests in-place adoption
- **THEN** the CLI identifies the reviewed adopt workflow
- **AND** it does not weaken fresh-target migrate's non-empty-target refusal

#### Scenario: Source and target paths contain spaces
- **WHEN** fresh-target migration operates on Windows, macOS or Linux paths containing spaces or platform-specific separators
- **THEN** it binds and resolves the exact distinct source and destination using native path semantics
- **AND** path aliases, escapes and target overlap cannot authorize source mutation
