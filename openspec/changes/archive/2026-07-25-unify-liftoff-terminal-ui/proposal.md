## Why

Liftoff 0.4 introduced responsive terminal primitives, but most human-readable commands and every interactive prompt still bypass them, so the shipped CLI does not deliver the cohesive, polished interface developers expect from the approved visual direction. Liftoff needs one terminal design system that presents its brand, hierarchy, prompts, progress, results, and remedies consistently without weakening script-safe output.

## What Changes

- Apply a unified Liftoff visual system to every human-readable command surface, including general help, command help, `init`, `plan`, `migrate`, `validate`, `update`, `doctor`, discovery commands, helper commands, confirmations, conflicts, failures, and completion output.
- Start interactive onboarding commands with the branded Liftoff identity before the first prompt instead of introducing the banner after project decisions are complete.
- Render wide capable terminals with the approved large wordmark, Unicode box-drawing sections, aligned labels, deliberate spacing, and restrained semantic color.
- Provide responsive compact and plain presentations for narrow terminals, redirected output, unsupported color, deterministic snapshots, and accessibility-oriented environments.
- Route prompts, plans, tables, lists, statuses, commands, remedies, warnings, and errors through shared semantic presentation primitives instead of command-specific string assembly.
- Preserve machine contracts: JSON remains decoration-free, `--version` remains exactly one line, redirected output remains deterministic and ANSI-free, and command exit codes and business behavior do not change.
- Add representative golden/snapshot coverage across wide, compact, plain, no-color, Windows-compatible, and JSON contexts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-cli-workflow`: Expand the responsive terminal-renderer contract into a unified CLI-wide human interface with branded onboarding, Unicode panels on capable terminals, shared prompt and result primitives, and strict machine-output fallbacks.

## Impact

- Affects `src/terminal.ts`, `src/commands.ts`, `src/interactive.ts`, help formatting in `src/args.ts`, and human-readable plan/doctor/update/reference output.
- Expands terminal and command snapshot tests while preserving existing parser, JSON, filesystem, release, and generated-project contracts.
- May reorganize presentation APIs and dependency injection for interactive streams, but does not change project artifacts, manifests, command flags, external process behavior, or npm package identity.
- Must remain reliable on macOS, Linux, Windows Terminal, CI, redirected streams, and terminals that cannot safely display the rich layout.
