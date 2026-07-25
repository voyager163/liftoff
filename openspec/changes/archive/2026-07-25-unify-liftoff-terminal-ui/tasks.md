## 1. Build the shared presentation foundation

- [x] 1.1 Replace the current ASCII-only rich identity with checked-in rich and compact Liftoff wordmarks that match the approved visual direction and remain deterministic in the packed CLI.
- [x] 1.2 Centralize Unicode border glyphs, spacing, indentation, layout thresholds, and semantic brand/info/success/warning/error/pending/command color tokens in `src/terminal.ts`.
- [x] 1.3 Make visible-width padding and wrapping handle ANSI-styled Unicode content without crossing the selected terminal width.
- [x] 1.4 Add semantic renderer primitives for command identity, section, definition list, bullet list, choice list, prompt context, remedy, compact error, cancellation, and completion.
- [x] 1.5 Add a presentation-session abstraction that owns stdout and stderr renderers and exposes explicit raw child-output streaming without changing stream ownership.
- [x] 1.6 Keep rich, compact, plain, no-color, JSON, and deterministic snapshot layout selection centralized and independent of individual commands.
- [x] 1.7 Add focused renderer tests for fixed wordmarks, Unicode panels, multiline wrapping, visible alignment, semantic colors, and every layout threshold.

## 2. Render help from parser metadata

- [x] 2.1 Refactor general and command help formatting into structured models derived from the existing command and flag definitions, retaining one parser-owned source of truth.
- [x] 2.2 Render general help with the rich Liftoff identity plus usage, global options, and grouped command sections on capable terminals.
- [x] 2.3 Render command-specific help with a branded command identity, usage, subcommands when applicable, and grouped option sections without unrelated command groups.
- [x] 2.4 Preserve deterministic plain general and command help when output is redirected or the terminal is too narrow for decorative sections.
- [x] 2.5 Route unknown-command and help-usage failures through the compact stderr error/remedy presentation without adding a large banner or stack trace.
- [x] 2.6 Add complete-screen snapshots for general help and representative `init`, `doctor`, `regions`, and helper command help in rich, compact, and plain modes.

## 3. Unify interactive prompt presentation

- [x] 3.1 Refactor interactive helpers to accept injected input, output, and presentation dependencies instead of writing presentation through global process streams.
- [x] 3.2 Emit the responsive `init` identity immediately after command acceptance and before Git discovery or the first project question.
- [x] 3.3 Emit the responsive `migrate` identity before legacy scan provenance and migration questions.
- [x] 3.4 Render project type, pattern, API stack, provider, spec workflow, and default-agent questions through shared prompt and choice-list primitives while preserving defaults and disabled choices.
- [x] 3.5 Render region resolution, multi-agent selection, frontend, and environment questions through the same prompt system while preserving accepted aliases and validation loops.
- [x] 3.6 Render resolved GenAI and standard plans as aligned named sections before plan confirmation.
- [x] 3.7 Render file-replacement consent with the complete conflict set and keep `--force` and `--yes` semantics unchanged.
- [x] 3.8 Render each machine-tool consent with its purpose, constraint, observed state, and exact allowlisted command or manual remedy before its independent prompt.
- [x] 3.9 Render project-dependency consent with each working directory and exact command without merging it with machine-tool authorization.
- [x] 3.10 Render validation feedback and cancellation through shared warning/error/cancellation statuses while preserving cancellation exit behavior.
- [x] 3.11 Add scripted interactive tests for every prompt branch, default, invalid answer, multi-select path, consent decision, and cancellation without hanging on readline.

## 4. Complete onboarding and planning screens

- [x] 4.1 Render standalone `plan` decisions, artifacts, and workstation requirements through shared definition-list, list, and table sections.
- [x] 4.2 Render workstation readiness, installation results, post-install remedies, deferred advisories, and resumable commands through shared status, table, panel, and command primitives.
- [x] 4.3 Organize `init` discovery, readiness, framework staging, merge, dependency decision, and completion into named visual stages without changing their execution order.
- [x] 4.4 Organize migration scan defaults and provenance, readiness, fresh-target staging, dependencies, completion, and rollback guidance into named visual stages.
- [x] 4.5 Label external installer, framework, and dependency stages while forwarding child stdout and stderr without wrapping, borders, or byte rewriting.
- [x] 4.6 Render successful onboarding with target path, configured integrations, deferred work, and next validation command through shared completion primitives.
- [x] 4.7 Add rich, compact, and plain complete-screen snapshots for plan, init readiness, consent, success, handled failure, migration provenance, and migration completion.

## 5. Migrate maintenance and diagnostic commands

- [x] 5.1 Render `validate` success and manifest failures through shared status and compact error/remedy primitives.
- [x] 5.2 Render `update` identity, drift table, safe-change hint, apply results, skipped conflicts, orphans, and completion summary through shared primitives.
- [x] 5.3 Render human-readable `doctor` layers, checks, remedies, and summary through shared sections and statuses while leaving the documented JSON schema byte-pure.
- [x] 5.4 Route plan-validation, readiness, merge, migration, update, and expected filesystem failures through the shared stderr presentation while preserving focused messages and exit codes.
- [x] 5.5 Add representative update and doctor snapshots plus direct assertions for severity, remedies, stdout/stderr ownership, and JSON bypass behavior.

## 6. Migrate reference and helper commands

- [x] 6.1 Render `patterns` and `providers` through shared headings and aligned list/table primitives while preserving every catalog value and availability state.
- [x] 6.2 Render region listing, search matches, ambiguity, and unsupported-provider guidance through shared table, warning, and error primitives.
- [x] 6.3 Render `dev` and `infra` helper output through shared command sections while preserving the exact shell commands.
- [x] 6.4 Audit human-readable writes in `src/commands.ts` and `src/interactive.ts`; retain direct writes only for documented JSON, one-line version, and raw child-process payloads.
- [x] 6.5 Add command tests proving every reference and helper surface uses the same hierarchy in rich mode and remains copyable in plain mode.

## 7. Preserve automation and cross-platform behavior

- [x] 7.1 Assert redirected stdout and stderr are deterministic, ANSI-free, and free of decorative box borders while retaining all semantic labels, values, and remedies.
- [x] 7.2 Assert `NO_COLOR` disables ANSI without removing understandable section hierarchy, statuses, defaults, or warnings.
- [x] 7.3 Test widths immediately below and above the plain, compact, and rich thresholds so no border clips or wraps.
- [x] 7.4 Assert every `--json` surface emits only its documented JSON value and `liftoff --version` remains exactly one line.
- [x] 7.5 Add Windows-focused tests for the rich Unicode layout, visible alignment, backslash paths, command names, and plain redirected fallback using platform-safe path expectations.
- [x] 7.6 Verify errors remain on stderr, informational and success output remain on stdout, and raw external streams retain their original destination.
- [x] 7.7 Run existing parser, consent, filesystem, migration, update, doctor, package-smoke, and exit-code tests to prove the presentation refactor changes no domain behavior.

## 8. Document and validate the unified UI

- [x] 8.1 Update README and contributor-facing CLI examples or screenshots to show the `init`-based rich interface, responsive fallbacks, `NO_COLOR`, plain redirected output, and JSON exceptions.
- [x] 8.2 Run the focused terminal, command, interactive, doctor, update, and documentation tests and review intentional snapshot changes.
- [x] 8.3 Run `npm run check`, `npm run smoke:package`, and release-identity verification against the packed CLI.
- [x] 8.4 Run strict OpenSpec validation for `unify-liftoff-terminal-ui` and resolve every artifact or delta-spec error.
