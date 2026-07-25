## Context

Liftoff already has a `TerminalRenderer` with full, compact, plain, color, snapshot, and JSON-aware modes, plus primitives for banners, headings, panels, tables, statuses, and commands. Adoption is incomplete: general and command help are assembled as plain strings, interactive prompts write directly to global process streams, and most plan, discovery, validation, update, doctor, helper, error, and migration output uses command-local `write()` calls. The branded `init` banner is also emitted only after all project questions and plan confirmation.

The result is functionally correct but visually fragmented. A developer may move from raw readline questions, to an unbordered plan, to a branded readiness table, to direct completion text within one command. The approved direction is a cohesive terminal interface with a large Liftoff wordmark, Unicode box-drawing sections, clear hierarchy, aligned content, and restrained semantic color.

The interface must remain deterministic and cross-platform. Liftoff runs on macOS, Linux, Windows Terminal, CI, narrow terminals, redirected streams, and test capture streams. JSON, exit codes, one-line version output, child-process argument safety, and existing command behavior are compatibility contracts.

## Goals / Non-Goals

**Goals:**

- Establish one presentation path for every human-readable Liftoff command and interactive workflow.
- Show the branded identity at the beginning of onboarding commands, before the first prompt.
- Match the approved rich visual direction on capable wide terminals with a fixed large wordmark, Unicode panels, alignment, spacing, and semantic color.
- Preserve legible compact and plain modes without clipped borders or ANSI leakage.
- Keep parser metadata as the source of truth for help while allowing rich rendering.
- Make interactive output injectable and snapshot-testable instead of binding presentation to global process streams.
- Preserve JSON, `--version`, redirected output, exit codes, and raw external-command streaming.

**Non-Goals:**

- Building a full-screen TUI, cursor-addressed interface, animation system, or terminal dashboard.
- Changing project questions, defaults, command flags, command sequencing, consent boundaries, filesystem behavior, or generated artifacts.
- Decorating JSON, changing the one-line version contract, or wrapping third-party installer output.
- Adding a runtime FIGlet or terminal-component dependency when fixed assets and the existing lightweight color dependency are sufficient.
- Guaranteeing rich glyph rendering in legacy terminals that cannot display modern UTF-8 output.

## Decisions

### D1: Use a single semantic presentation session

`runCommand` will construct one presentation session for the command's stdout and stderr streams. Command handlers and interactive helpers will express intent through semantic operations such as brand header, section, panel, definition list, table, choice list, status, command, remedy, error, and completion rather than assembling borders, padding, markers, or colors themselves.

`TerminalRenderer` remains the deterministic formatting engine. A thin session/presenter layer owns stream selection and provides the semantic write API so command handlers do not repeatedly instantiate renderers or bypass layout decisions.

The only deliberate bypasses are documented machine contracts:

- JSON values are serialized directly with no decorative prefix or suffix.
- `liftoff --version` remains exactly one line.
- External installer and dependency-process output continues streaming unchanged after a Liftoff-owned stage heading.

This is preferred over introducing a complete intermediate document AST because Liftoff output is sequential and interactive. Semantic methods provide consistency without buffering long-running output or complicating prompts.

### D2: Check in a fixed rich identity and visual token set

The rich layout will use a checked-in static Liftoff wordmark and fixed Unicode border tokens. It will not generate art at runtime. This keeps package output deterministic across Node.js versions and platforms and avoids a new dependency.

The renderer will centralize:

- rich and compact wordmarks;
- Unicode panel corners, lines, and junctions;
- indentation and section spacing;
- semantic colors for brand, information, success, warning, error, pending work, commands, and dim metadata;
- visible-width padding that ignores ANSI sequences;
- wrapping that operates on content width rather than terminal width.

Individual commands will not own glyphs or ANSI sequences. Tests will snapshot the fixed assets and visible widths.

### D3: Preserve the existing responsive layout model

The current capability-based selection remains the basis:

| Context | Presentation |
|---|---|
| TTY, at least 96 columns | Rich wordmark, Unicode bordered sections, aligned tables, semantic color when supported |
| TTY, 64-95 columns | Compact identity, unbordered or minimally separated sections, wrapped values |
| Non-TTY or fewer than 64 columns | Deterministic plain text without decorative borders |
| `NO_COLOR` or unsupported color | The selected layout and hierarchy remain, but no ANSI color is emitted |
| JSON mode | Renderer decoration is bypassed completely |
| Snapshot mode | Explicit deterministic rich, compact, or plain output independent of host capabilities |

The thresholds remain centralized constants rather than command-level decisions. Wide Windows Terminal receives the same rich layout as wide macOS and Linux terminals. Redirected Windows output uses the same plain contract as other platforms.

### D4: Begin onboarding with the brand, then move through named stages

`init` and `migrate` will emit their rich or fallback identity immediately after argument validation and before discovery, questions, or long-running work. Their lifecycle becomes:

```text
brand
  -> context/target discovery
  -> project choices
  -> plan review
  -> workstation readiness
  -> framework and scaffold work
  -> dependency decision
  -> completion and next command
```

`plan` uses the same opening identity but ends after plan, artifact, and workstation-requirement sections. Maintenance and reference commands use a compact command identity rather than repeating the largest wordmark for every short operation. All still share the same panels, tables, statuses, errors, and spacing.

### D5: Render help from structured parser metadata

Command definitions in `args.ts` remain authoritative for names, usage, groups, flags, metavariables, negation, descriptions, and defaults. Help formatting will return or expose structured help data to the presentation layer instead of final plain strings.

General help on a rich terminal uses the large identity plus bordered usage, global-option, and command-group sections. Command help uses the same visual language and a command-specific identity with grouped option panels, but it does not include unrelated commands. Plain help preserves a stable, copyable text form derived from the same data.

This avoids a separate visual-help catalog drifting from parser behavior.

### D6: Make interactive prompts presentation-aware and injectable

Interactive functions will accept their input/output and presentation dependencies rather than importing global `stdin` and `stdout` for display. Readline remains responsible for reading answers; the Liftoff presenter renders prompt headings, choice lists, defaults, disabled states, validation errors, plans, consent commands, and cancellation/completion states.

Prompts remain line-oriented and keyboard-compatible. The change does not introduce cursor movement, raw terminal mode, hidden input, or a new prompt library. This keeps tests deterministic and behavior portable while still presenting a coherent wizard.

### D7: Migrate every human-readable command family

The migration covers:

- global and command-specific help;
- `init`, `plan`, and `migrate`;
- `validate`, `update`, and `doctor`;
- `patterns`, `providers`, and `regions`;
- `dev` and `infra`;
- parser and validation failures;
- file-conflict, machine-tool, and dependency confirmations;
- completion, deferred work, remedies, and next steps.

No command is considered migrated while it still assembles its own visual borders, status markers, aligned columns, or prompt lists. Domain strings and machine serialization may remain near their command logic; presentation punctuation and layout belong to the renderer.

### D8: Keep automation and stream ownership explicit

TTY richness is a presentation enhancement, not a new data contract. When output is redirected, Liftoff emits plain, deterministic, ANSI-free text in the same semantic order. JSON commands continue to emit only their documented JSON object. Error output remains on stderr, success and informational output remain on stdout, and exit codes are unchanged.

External command output is not rewrapped because doing so could corrupt progress output, diagnostics, or command semantics. Liftoff emits a stage/status line before streaming and resumes its own visual output after the child exits.

### D9: Validate a presentation matrix rather than one host terminal

Tests will use injectable capture streams with explicit TTY, width, color, platform, JSON, and snapshot properties. Golden snapshots will cover representative complete screens rather than only isolated primitives:

- general help;
- command help;
- interactive `init` opening and plan confirmation;
- plan;
- readiness and consent;
- update drift;
- doctor;
- success and failure completion.

Assertions will also cover ANSI absence, visible-width alignment, no wrapped borders, one-line version output, JSON purity, stdout/stderr ownership, and Windows path text rendered without separator assumptions.

## Risks / Trade-offs

- [Large Unicode art consumes vertical space] -> Use it for entry, help, and onboarding screens; use compact command identity for short maintenance and reference commands.
- [Legacy terminals may render Unicode glyphs poorly] -> Restrict rich borders to capable wide TTY mode and retain compact/plain fallbacks with identical information.
- [Snapshot tests can become noisy] -> Snapshot a representative screen matrix and assert semantics directly for the remaining commands.
- [Refactoring output can accidentally change command behavior] -> Keep domain orchestration unchanged, migrate one command family at a time, and run existing command and contract tests alongside new presentation tests.
- [ANSI styling can break width calculations] -> Centralize visible-width and wrapping logic and test colored and uncolored output at boundary widths.
- [Prompt refactoring can make tests or cancellation hang] -> Keep readline line-oriented, inject streams, and add deterministic answer fixtures for every interactive branch.
- [External process output does not visually match Liftoff panels] -> Clearly label the stage but stream child bytes unchanged to preserve correctness.
- [A visually rich stderr could obscure focused errors] -> Use compact error/remedy blocks without the large wordmark and preserve the original actionable message.

## Migration Plan

1. Expand renderer tokens, layout primitives, presentation-session construction, and snapshot helpers without changing command call sites.
2. Move general and command help to structured metadata rendered through the session.
3. Inject presentation dependencies into interactive prompts and move onboarding banners before the first prompt.
4. Migrate plan, readiness, consent, completion, and migration stages.
5. Migrate maintenance, doctor, discovery, helper, and error output while preserving JSON and exit codes.
6. Add complete-screen snapshots and cross-platform/plain-output assertions, then remove obsolete command-local visual formatting.
7. Update documentation screenshots or examples to the new `init` wording and rich visual system.

Rollback is code-only: restore the previous renderer and command formatting in a follow-up patch. No project data, manifests, generated artifacts, or migration step is affected.

## Open Questions

None. The visual scope, responsive fallbacks, machine-output exceptions, and no-full-screen-TUI boundary are defined for implementation.
