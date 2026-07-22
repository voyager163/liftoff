# Design: add-manifest-v2

## Context

`liftoff.manifest.json` is written once by `create` and read by `validate`. It records the project options and an artifact list (`logicalName`, `category`, `pathParts`) but not the generating CLI version or content hashes. The planned `update` command needs both: the version to compare against the current CLI, and hashes to distinguish "user modified this file" (never overwrite) from "untouched since generation" (safe to overwrite).

The manifest lives in user projects and outlives any CLI release — it is a persistent contract, not an implementation detail. Liftoff is at 0.1.x with no known external projects, so the schema can change once, now, without a compatibility tail.

## Goals / Non-Goals

**Goals:**

- Record enough state at generation time that a future CLI can reconcile a project safely (version + per-artifact content hashes).
- Establish the compatibility policy and contract-stability rules before any real projects exist.
- Enforce the rules with CI (contract test), not etiquette.

**Non-Goals:**

- No `update`, `migrate`, or doctor changes — those are separate changes that consume this one.
- No v1-manifest reading support (v2 is declared the first supported contract).
- No `.liftoff/` directory creation — the name is reserved, nothing is written there yet.
- No three-way merge base cache, template extraction, or provider adapters (named future work with triggers; see the exploration record).

## Decisions

### D1: Manifest v2 shape

`artifactVersion: 2`; new top-level `liftoffVersion` (exact CLI semver from package metadata); each artifact entry gains `contentHash`. Rationale: the minimum fields update needs, nothing speculative.

### D2: Hash format is `sha256:<hex>` with algorithm prefix

A naked hex string would hardwire sha256 forever. The prefix costs one string concat now and makes algorithm rotation a non-event later. Hashing uses `node:crypto` on the exact bytes written to disk (after `ensureTrailingNewline`), so `hash(disk file) === manifest hash` is a well-defined comparison. Alternative considered: no prefix (rejected — retrofit agony), multihash (rejected — overkill).

### D3: v2 is the first supported contract

Readers reject `artifactVersion` other than 2 with a clear message ("regenerate this project or use a matching CLI"). Alternative considered: degraded read-only mode for v1 manifests (rejected — no known v1 projects exist; the code path would be born dead). Policy going forward: read every supported version, write only the latest. Update (future change) rewrites manifests to the latest schema on apply, so projects self-heal.

### D4: The CLI version reaches `buildManifest` from package metadata

Read `package.json` version at runtime (resolved relative to the compiled module) rather than embedding it at build time via codegen. Rationale: no build tooling changes, single source of truth, works in tests. Comparisons elsewhere must use semver-aware logic (the `next` prerelease channel exists in the release flow), but no comparison happens in this change.

### D5: Determinism is a tested invariant, not a convention

`buildArtifacts(plan)` must be a pure function of (plan, template code): no timestamps, randomness, host, or environment leakage. This is already true and load-bearing — hashes are only meaningful if re-rendering reproduces bytes. The contract test renders the same plan twice and asserts byte equality, so a contributor adding a `Generated on <date>` header fails CI instead of silently breaking clean-detection for every project.

### D6: Contract test locks the persistent surface

One test file asserts:

1. Sorted `logicalName` list for a representative plan matrix (frontend on/off, worker/non-worker pattern) matches a checked-in snapshot — renames or deletions fail with a message pointing at the append-only policy.
2. Double-render byte equality (D5).
3. A frozen v2 manifest fixture parses and matches the `LiftoffManifest` type shape — guards accidental schema drift.

`logicalName` is update's join key across versions; treating it as API is what keeps every future upgrade path sound. Catalog IDs (`rag`, `azure`, `dev`, `openspec`, …) fall under the same append-only rule.

### D7: Conventions declared here, implemented where first used

- Exit codes: 0 = success/clean, 1 = failure, 2 = drift found (consumed by the future update command).
- `.liftoff/` is reserved in generated projects for future machine state; nothing else may claim the name and no new liftoff files may be added at project root.
- Any future `--json` output carries a top-level `schemaVersion` number.
- Machine files store OS-neutral `pathParts` arrays, never joined path strings (already true; now a stated rule).

These live in this change because they are contract-surface decisions; commands that implement them arrive in later changes.

### D8: Version bump to 0.2.0 at release

The minor bump marks where compatibility guarantees begin. Release mechanics are unchanged (existing `Release Liftoff` workflow).

## Risks / Trade-offs

- [Hash comparisons are byte-exact; line-ending translation (e.g., git `autocrlf` on Windows) could make untouched files hash as "modified"] → Acceptable: false "modified" is the safe direction (update reports instead of overwriting). Note in the future update change; the generated `.gitignore`/docs already assume LF, and `pathParts` keep paths portable.
- [Reading package.json at runtime could fail in unusual install layouts] → Resolve relative to the module URL with a test covering the packed layout (the existing package smoke test exercises the npm-installed shape).
- [Snapshot tests can be blindly regenerated, defeating the gate] → The snapshot failure message states the append-only policy and that renames require a CLI-side alias map; review culture plus an explicit message is proportionate at this team size.
- [Declaring v1 unsupported strands any unknown early adopter] → Accepted consciously; the error message names the remedy (regenerate or use the matching older CLI).

## Migration Plan

Single release: implement, test, publish as 0.2.0. No data migration exists because no supported manifests predate this change. Rollback is an npm dist-tag rollback; projects generated by 0.2.0 remain valid v2 manifests.

## Open Questions

None — all forks were resolved during exploration (hash prefix, v2-first-contract, runtime version read, conventions placement).
