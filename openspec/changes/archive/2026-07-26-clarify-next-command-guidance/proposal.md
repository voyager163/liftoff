## Why

Completion output currently prints a `$`-prefixed command without identifying its purpose, so developers can mistake a suggested next step for output that Liftoff already executed. Completion guidance should state explicitly that the command is recommended and remains under developer control.

## What Changes

- Label completion-time command suggestions as `Next recommended command` before rendering the copyable command.
- Apply the label consistently to initialization, migration, and update completion through the shared terminal renderer.
- Preserve the exact suggested command, shell-style command marker, stream ownership, command behavior, and exit code.
- Keep the label clear in rich, compact, plain, color, and no-color layouts without rendering an empty section when no suggestion exists.
- Update CLI documentation and presentation snapshots for the clarified guidance.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `liftoff-cli-workflow`: Require completion-time commands to be explicitly presented as recommended next actions rather than unlabeled output.

## Impact

The change affects the shared completion primitive in `src/terminal.ts`, all command surfaces that pass a completion suggestion, terminal documentation, and lifecycle and maintenance presentation snapshots. It adds no dependency, parser, command, manifest, generated-project, or machine-output change.
