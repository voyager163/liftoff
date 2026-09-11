## Why

When a developer runs `liftoff update --check` inside a generated project, Liftoff discovers that project but prints a next step containing a redundant absolute `--project` argument, then repeats a directory change after applying. Together with missing-preview guidance that suggests repairing storage, this makes the required preview step look like a project-discovery failure.

## What Changes

- Make human update next steps context-aware: omit `--project` when implicit discovery from the invocation directory selects the same project, and retain an explicit, safely quoted target otherwise.
- Apply the same targeting policy to preview, normal and forced apply suggestions, approval reminders, retry guidance, and recovery guidance. Keep the resolved target visible separately from the suggested command.
- Omit the directory-change wrapper from post-update validation guidance when already at the resolved project root; preserve it when validation must run from another directory.
- Explain a missing preview as a missing prerequisite: run `liftoff update --check`, review the proposed changes, then run `liftoff update` and approve the matching plan. Reserve storage-repair guidance for an actual storage failure.
- Preserve public command syntax, exit codes, schema-3 JSON structure and reason codes, project-bound receipt identity, exact-plan approval, and transaction safeguards.
- Update related documentation and regression coverage for current-directory, nested-project, explicit-target, and platform-specific path cases.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-project-update`: Define context-aware project-bound follow-up commands, execution-directory-aware completion guidance, and reason-specific preview recovery without changing update authority or project discovery.

## Impact

- Presentation and orchestration: `src/application/update/command-guidance.ts`, `output.ts`, and `use-case.ts`, together with update error producers that currently embed fully formatted commands.
- Preview diagnostics: `src/application/update/preview.ts` and `src/adapters/filesystem/update-previews.ts`; receipt contents, storage locations, fingerprints, and approval semantics remain unchanged.
- Existing update guidance, integration, preview, and recovery tests; related update sections in the CLI reference and troubleshooting documentation.
- No new dependencies, project-file migrations, changes to generated application artifacts, automatic updates, or changes to doctor runtime, package-manager, coding-agent, environment-file, or governance-seed policies.
