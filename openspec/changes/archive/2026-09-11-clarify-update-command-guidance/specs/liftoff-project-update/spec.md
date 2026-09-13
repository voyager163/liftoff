## ADDED Requirements

### Requirement: Human update follow-ups use the invocation's project context

Whenever update emits a human follow-up command, it SHALL omit `--project` if ordinary project discovery from the invocation directory resolves to the same canonical project as the selected update target. Otherwise, it SHALL retain an explicit, shell-safe absolute target. This policy SHALL apply consistently to preview follow-ups, normal and forced apply suggestions, approval reminders, and update retry or recovery instructions. Human guidance using an implicit target SHALL identify the resolved project separately. Shortening a suggested command MUST NOT change discovery rules, the selected target, plan eligibility, or update authority.

#### Scenario: Preview from the project root suggests a plain update
- **WHEN** a developer runs `liftoff update --check` at the root of a supported project and an apply follow-up is available
- **THEN** the human follow-up is `liftoff update`, without a redundant `--project` argument
- **AND** the report identifies the resolved project separately from the command

#### Scenario: Preview from a project subdirectory retains implicit discovery
- **WHEN** a developer runs update check from a subdirectory whose nearest valid project boundary is the selected target
- **THEN** an emitted apply follow-up omits `--project`
- **AND** running that follow-up from the unchanged directory resolves to the same project

#### Scenario: A redundant explicit input does not force redundant human guidance
- **WHEN** a developer explicitly selects the same project that ordinary discovery from the invocation directory would select
- **THEN** emitted human update follow-ups omit the redundant target argument
- **AND** the explicitly selected project remains the operation's authoritative target

#### Scenario: A different target remains explicit
- **WHEN** update selects a project outside the invocation directory's discovered project, through either a positional path or `--project`
- **THEN** all emitted human update follow-ups retain the selected project's absolute target
- **AND** copying a suggested command does not redirect the operation to the caller's project

#### Scenario: An inner project cannot stand in for an explicitly selected outer project
- **WHEN** the invocation directory is inside a nested project and update explicitly selects its containing outer project
- **THEN** follow-up commands retain the outer project's explicit path
- **AND** sharing a directory ancestor does not authorize omission of that path

#### Scenario: Unknown invocation context keeps guidance explicit
- **WHEN** an explicit update target is valid but equivalent implicit targeting cannot be established from the invocation directory
- **THEN** follow-up guidance remains explicitly targeted
- **AND** optional command shortening does not change the primary operation's outcome or hide an actual selected-project discovery error

#### Scenario: Force and approval reminders follow the same targeting rule
- **WHEN** an eligible forced plan or an approval reminder is shown from a directory that resolves to the selected project
- **THEN** the corresponding human update command omits `--project` while retaining any required mode or approval arguments
- **AND** the existing force eligibility and exact-plan approval requirements remain unchanged

#### Scenario: Native path identities and quoting remain safe
- **WHEN** invocation and target paths use supported native path forms on Windows, macOS, or Linux, including Windows drive or UNC paths and names containing spaces or shell metacharacters
- **THEN** command shortening depends on the resolved project boundary rather than textual prefix similarity
- **AND** equivalent path spellings are treated as equal only when the filesystem's canonical identity establishes equality
- **AND** any retained target is formatted as a literal argument for the platform's supported shell
- **AND** an unsafe manifest or path alias is not made acceptable by the guidance policy

### Requirement: Post-update validation guidance preserves its execution directory

After a successful update, the system SHALL omit the directory-change wrapper from human validation guidance when the invocation directory is already the canonical project root. From any other directory, including a project subdirectory, it SHALL retain the shell-safe change to that root before validation. Both forms SHALL preserve the existing order and success-dependent execution of `liftoff validate` followed by `liftoff doctor`. Generating these instructions SHALL NOT execute them or change the caller's directory.

#### Scenario: Completion at the project root avoids a redundant directory change
- **WHEN** a successful update emits completion guidance while invoked at the selected project root
- **THEN** the validation sequence contains no `cd` or `Set-Location` wrapper
- **AND** it runs doctor only after validate succeeds

#### Scenario: Completion outside the project root keeps the directory change
- **WHEN** completion guidance is emitted from another directory, including a subdirectory of the selected project
- **THEN** the sequence first changes to the selected project root
- **AND** a failed directory change prevents both validation commands from running

#### Scenario: Completion uses native shell semantics
- **WHEN** validation guidance targets a path containing spaces, apostrophes, or other shell metacharacters on Windows, macOS, or Linux
- **THEN** retained directory arguments preserve the literal path
- **AND** POSIX shells and PowerShell retain their respective conditional-execution behavior with or without a directory-change wrapper

### Requirement: Preview recovery guidance identifies the actual failure

The system SHALL distinguish a missing saved preview from stale, invalid, unsupported, busy, and storage-failure conditions. A missing-preview diagnostic SHALL identify the selected project, explain that no usable saved preview was found and no new project update was performed, and direct the developer to run update check before approving apply. It MUST NOT imply that a project path argument or storage repair is required solely because the preview is missing. Recovery commands in human output SHALL follow the invocation-context targeting policy. Diagnostics SHALL preserve the actual failure details and MUST NOT delete receipts, bypass approval, or perform recovery actions merely to simplify the message.

#### Scenario: Plain update has no saved preview
- **WHEN** apply has actionable work but no saved preview is available for the selected project
- **THEN** the diagnostic explains the missing saved preview and identifies the selected project
- **AND** it instructs the developer to run `liftoff update --check`, review the result, then run update and approve the matching plan
- **AND** it reports no new project update and does not claim a storage fault or missing project argument
- **AND** the command exits 1 with the existing `preview-missing` reason code

#### Scenario: A prior check does not imply a receipt is still available
- **WHEN** a previous check's receipt has been consumed or is absent from the current user-local store and a new actionable apply is attempted
- **THEN** the diagnostic reports the absence of a saved preview without asserting that the developer never ran check
- **AND** it requests a fresh preview rather than suggesting that repeating the project path will repair the problem

#### Scenario: A stale preview keeps its distinct explanation
- **WHEN** a saved preview does not match the current effective plan
- **THEN** the diagnostic retains the mismatch explanation and `preview-mismatch` reason code
- **AND** it directs the developer to a fresh check and approval of the current plan without treating the mismatch as a storage fault

#### Scenario: A storage failure retains the real operation and repair details
- **WHEN** preview storage fails because of permissions, an unsafe location, or a failed filesystem operation
- **THEN** the diagnostic retains the actual failure and affected path information
- **AND** it gives storage-specific repair guidance before retrying check
- **AND** it does not replace the failure with a generic missing-preview explanation

#### Scenario: Invalid, unsupported, and busy previews remain distinguishable
- **WHEN** a preview is invalid, uses an unsupported schema, or is blocked by concurrent access
- **THEN** the diagnostic retains its existing specific reason code and relevant fault details
- **AND** its remedy addresses that condition rather than describing every preview failure as missing or damaged storage

#### Scenario: Check and apply are shown as separate steps
- **WHEN** guidance explains the preview-then-apply workflow
- **THEN** it presents separate commands rather than joining check and apply with a success-only shell chain
- **AND** exit code 2 from an actionable check remains a reviewable update result rather than a failed preview

### Requirement: Guidance changes preserve durable update identities and machine contracts

Context-sensitive wording SHALL be presentation-only. Equivalent invocations against the same canonical project and inputs SHALL retain identical receipt keys, effective-plan fingerprints, and approval requirements. Update JSON SHALL retain schema version 3, its field structure, canonical `projectRoot`, status and reason codes, and existing exit semantics. JSON remedies and callers without trusted invocation context SHALL retain explicitly targeted commands so their guidance remains self-contained outside the originating shell. The content of diagnostic prose SHALL explain the actual preview failure without changing machine-readable failure identity.

#### Scenario: Implicit and explicit invocations share the same reviewed plan
- **WHEN** check and apply target the same unchanged project but one invocation omits the path and the other supplies it
- **THEN** the same matching preview and exact effective-plan approval apply
- **AND** differences in displayed commands do not invalidate or authorize the plan

#### Scenario: A JSON missing-preview failure stays actionable outside the original shell
- **WHEN** update emits a JSON result for a missing preview
- **THEN** it retains schema version 3, canonical `projectRoot`, and `preview-missing`
- **AND** its remedy contains an explicitly targeted check command without claiming an unobserved storage failure

#### Scenario: Safety gates are not relaxed by shorter commands
- **WHEN** a follow-up command omits a redundant path
- **THEN** missing or mismatched previews, absent or mismatched approval, ownership boundaries, and transaction-recovery requirements continue to block or constrain updates exactly as before
- **AND** neither printing nor running an unapproved follow-up silently approves an update
