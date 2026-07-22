# Proposal: add-manifest-v2

## Why

The upcoming `update`, `migrate`, and richer `doctor` commands all need to reason about what Liftoff previously wrote into a project: which CLI version generated it and whether the user has modified each generated file. Today's manifest records neither, so drift detection and safe overwrites are impossible — and every project generated before this change ships without the data those commands need, making the cost of delay compound with each release.

Liftoff is pre-adoption, which grants a one-time luxury: declare manifest v2 the first supported contract instead of carrying v1 compatibility machinery forever.

## What Changes

- `liftoff.manifest.json` gains `liftoffVersion` (the exact CLI semver that wrote it) and a per-artifact `contentHash` in `sha256:<hex>` prefixed format; `artifactVersion` bumps from 1 to 2. **BREAKING**: v1 manifests are declared unsupported (pre-contract; no known external projects exist).
- Manifest compatibility policy is established: readers accept every supported schema version, writers always write the latest. Manifest v2 is the first supported contract.
- A contract test locks the persistent surface: the sorted `logicalName` list is snapshotted (renames fail CI), rendering the same plan twice must be byte-identical (determinism), and a frozen v2 manifest fixture guards schema shape.
- Cross-command conventions are declared once: exit codes (0 = clean, 1 = failure, 2 = drift), the `.liftoff/` directory name is reserved in generated projects for future machine state, and future `--json` outputs must carry a `schemaVersion` field.
- The CLI package version bumps to 0.2.0 on release to mark where compatibility guarantees begin.

## Capabilities

### New Capabilities

- `liftoff-manifest-contract`: The persistent contract between the Liftoff CLI and generated projects — manifest schema v2, compatibility policy (read all supported, write latest), contract stability rules (`logicalName` and catalog IDs are append-only, rendering is deterministic, machine files store OS-neutral path parts), and reserved namespaces.

### Modified Capabilities

- `liftoff-project-scaffold`: The generated manifest artifact requirement changes — generated projects now carry a v2 manifest with `liftoffVersion` and per-artifact content hashes.

## Impact

- `src/types.ts`: `LiftoffManifest` interface gains `liftoffVersion` and per-artifact `contentHash`; `artifactVersion` becomes 2.
- `src/templates.ts`: `buildManifest` computes hashes of rendered content and embeds the CLI version.
- `src/file-system.ts`: `validateGeneratedProject` continues presence checks against v2 manifests (no behavior change required, verified by tests).
- `tests/`: new contract test (logicalName snapshot, double-render determinism, v2 manifest fixture).
- `package.json`: version 0.2.0 at release; CLI version threaded to the manifest builder from package metadata.
- No user-facing command behavior changes; `create`, `plan`, and `validate` flows are unchanged apart from manifest content.
