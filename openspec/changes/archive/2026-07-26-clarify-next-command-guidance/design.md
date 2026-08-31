## Context

`TerminalRenderer.completion()` currently renders a success status, an optional `Completion` definition list, and then an optional command through the generic `$`-prefixed command primitive. Initialization, migration, and update all use this argument for a suggested next action, but the command has no heading explaining that it is guidance. The unlabeled shell marker is familiar to some developers but was observed to look like output or an already executed command.

The fix belongs in the shared terminal renderer so every completion caller receives the same semantics across rich, compact, plain, color, no-color, snapshot, redirected, and future completion surfaces.

## Goals / Non-Goals

**Goals:**

- Explicitly identify completion-time command suggestions as the next recommended command.
- Preserve the exact copyable command and conventional `$` marker.
- Apply the label uniformly through one shared renderer path.
- Preserve layout width, color, stream, JSON, command, and exit behavior.
- Cover direct rendering plus initialization, migration, and update completion snapshots.

**Non-Goals:**

- Execute the recommendation, prompt for permission, or alter shell state.
- Change which command each workflow recommends.
- Relabel ordinary commands, remediation commands, migration-plan bullets, or external child-process output.
- Add a new dependency, command option, persisted schema, or generated-project artifact.

## Decisions

### 1. Add a semantic recommended-command renderer

Add a `TerminalRenderer` primitive that renders a semantic heading titled `Next recommended command` immediately before the existing command output. `completion()` will call this primitive only when its optional recommendation is present.

Rich and compact layouts receive the existing styled heading and underline treatment; plain layout receives its deterministic heading fallback. Every layout then emits the unchanged `$`-prefixed command as one copyable line. JSON mode continues returning no decorative completion output.

**Alternative considered:** Put the command inside a generic panel. Panels normalize and wrap content, which can collapse intentional whitespace inside quoted arguments and split a shell command into non-copyable lines. A semantic heading keeps the purpose clear without rewriting the command.

### 2. Preserve command bytes and shell notation

The recommendation primitive will pass the original string unchanged to the existing command renderer. Quoting, repeated whitespace, Windows paths, shell operators such as `&&`, and command-specific arguments therefore remain copyable and behaviorally identical. The `$` marker remains presentation only and is not part of the command value.

The heading and its decoration remain width-safe. A recommendation longer than the terminal width deliberately remains one unwrapped command line because preserving executable text takes precedence over decorative width; this matches the existing command primitive.

**Alternative considered:** Remove `$` or rewrite the command as prose. That would reduce copyability and introduce command-specific transformations.

### 3. Keep completion callers declarative

Initialization, migration, and update continue supplying only the recommendation string to `PresentationSession.completion()`. They do not add their own headings. This prevents inconsistent wording and ensures future completion callers inherit the clarified guidance.

The internal parameter can be named `recommendedCommand` rather than `nextCommand` to encode its semantics without changing positional callers or public CLI behavior.

### 4. Validate the shared primitive and complete workflows

Add direct terminal tests at full, compact, and plain widths, including color/no-color visible-text checks, exact long-command and repeated-whitespace preservation, heading-width safety, JSON suppression, and omission when no recommendation exists. Refresh lifecycle snapshots for initialization and migration and maintenance snapshots for update. Add a CLI-reference sentence explaining that completion recommendations are suggestions and are not executed automatically.

## Risks / Trade-offs

- **Additional vertical output** -> Use one concise named section and render it only when a recommendation exists.
- **Long recommendations exceed narrow terminal width** -> Keep the semantic heading width-safe but preserve the recommendation as one exact copyable line, matching existing command behavior.
- **Callers add duplicate labels later** -> Keep the heading exclusively inside the shared completion primitive and test all current completion call sites.
- **Developers mistake the recommendation for execution despite the label** -> Use the explicit wording `Next recommended command` and document that Liftoff does not execute it.

## Migration Plan

1. Add and unit-test the semantic recommendation renderer.
2. Route completion suggestions through it and update lifecycle and maintenance snapshots.
3. Update terminal documentation and run the existing cross-platform package checks.

Rollback is a renderer-only revert; there is no data or project migration.

## Open Questions

None. The selected wording is `Next recommended command`, and the existing `$` marker and exact command string remain.
