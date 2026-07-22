## Context

The root `README.md` is shipped with the public `@msn-control/liftoff` package and is the first durable documentation developers see before running the generator. The current README covers installation, compatibility contracts, contributor commands, and release mechanics, but the CLI has grown since that document was written: it now has manifest v2, `update`, `migrate`, project-aware `doctor`, Azure Functions workers for worker-backed patterns, and a clearer generated project layout.

This change is documentation-only. The implementation should update the package README to reflect existing behavior without changing CLI command semantics, generated files, manifest format, package metadata, or tests beyond any documentation validation that proves the README remains aligned.

## Goals / Non-Goals

**Goals:**

- Make the README useful as a first-use guide for installing, previewing, creating, validating, diagnosing, running, updating, and migrating Liftoff projects.
- Show the generated project structure at a practical level, including conditional folders for frontend, Azure Functions workers, and migration staging.
- Explain the ownership model for `liftoff.config.json` and `liftoff.manifest.json` in language that helps developers make safe changes after generation.
- Preserve the existing contract and release sections while giving them enough surrounding context to make sense to CLI users.

**Non-Goals:**

- No changes to CLI behavior, command flags, exit codes, manifest schema, generated templates, package metadata, or release automation.
- No expansion of generated project README templates; this change targets the Liftoff package README only.
- No new documentation site or cross-repo documentation restructuring.

## Decisions

### Put user workflow before internal contract details

The README should lead with installation and quick start, then explain project structure and command lifecycle, then keep contract conventions, development, and release details. This gives new users the practical path first while preserving contributor and compatibility details.

Alternative considered: append only a short project-structure section after contract conventions. That keeps churn smaller but leaves the README front-loaded with internal guarantees before users understand what Liftoff creates.

### Document logical project paths, not platform-specific path behavior

The structure section should display logical folder names with slash-separated README paths such as `backend/apis` and `infrastructure/opentofu/azure`, matching existing documentation style. It should avoid claiming that the CLI hardcodes those separators; cross-platform path handling remains an implementation contract covered by existing specs and tests.

Alternative considered: omit path examples to avoid cross-platform nuance. That would make the structure section too vague for the user's stated need.

### Describe `update` as a safe reconciliation lifecycle

The README should explain that `liftoff update` is check mode by default, returns exit code 2 when drift exists, and only writes with `--apply`. It should also mention that conflicts are skipped unless forced and orphans are never auto-deleted, because those rules are central to the new CLI version's safety model.

Alternative considered: simply list `update` in the command table. That would not help users understand the manifest/config workflow or why update is safe to run in CI.

### Keep examples command-shaped and copyable

Use short command blocks for common flows: preview/create, validate/doctor, local dev helpers, update check/apply, migrate. Avoid long prose-only descriptions of command behavior.

Alternative considered: a large narrative walkthrough. That would be friendlier in isolation but harder to scan in a CLI README.

## Risks / Trade-offs

- README drift from command implementation -> Mitigate by deriving command descriptions from the existing command surface and validating with the Liftoff package check when implementation is complete.
- Over-documenting generated internals -> Mitigate by documenting stable top-level structure and ownership boundaries rather than every generated file.
- Confusing package README with generated project README -> Mitigate by explicitly saying this is the Liftoff CLI package README and linking generated project behavior to what `liftoff create` writes.

## Migration Plan

No runtime migration is required. Implement the README update, run the Liftoff workspace check, and leave existing generated projects unchanged.