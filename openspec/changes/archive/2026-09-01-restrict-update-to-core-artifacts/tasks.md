## 1. Artifact lifecycle model

- [x] 1.1 Add required `managed-core`, `project`, `desired-state`, `framework`, and `seed` lifecycle types to generated artifact declarations, plus explicit project provisioning-group metadata, and verify TypeScript rejects an artifact declaration without lifecycle.
- [x] 1.2 Update every GenAI, standard API, frontend, Power Apps, governance, framework, and seed artifact declaration with an explicit lifecycle and provisioning group, and verify representative artifact inventories classify every logical name exactly once.
- [x] 1.3 Add contract snapshots that prove only the exact repository-governance policy, context, guide, and selected-agent launchers are currently managed core, while configuration and all workload files receive the intended non-core lifecycle.
- [x] 1.4 Extend deterministic and cross-platform template tests to prove identical logical names, lifecycle values, provisioning groups, and portable path parts on Windows, macOS, and Linux.

## 2. Manifest schema v6

- [x] 2.1 Add schema-v6 manifest types with separate managed-artifact and project-provenance collections, including per-project-artifact generating version and generation hash, and verify malformed or mixed-authority entries are rejected.
- [x] 2.2 Update manifest builders and fresh-project fixtures to write only schema v6, preserve workload, framework, agent, governance, and starter identity, and verify managed hashes and project generation hashes match the bytes initially generated.
- [x] 2.3 Implement v2-v5 normalization that maps only exact known core logical names to managed authority, converts every other and unknown entry to project provenance, and verify modified or absent production paths are never read into managed state.
- [x] 2.4 Extend path, uniqueness, hash, and project-boundary validation across both v6 collections using platform path APIs, and verify traversal, embedded separators, absolute paths, drive paths, UNC paths, duplicates, and symlink escapes fail before artifact access.
- [x] 2.5 Update compatibility tests so v2-v5 remain readable, writers emit v6, newer manifests fail with actionable guidance, and an older v5-only fixture reader cannot interpret v6 as broad authority.

## 3. Initialization and planning

- [x] 3.1 Update generated-artifact partitioning so initialization still stages and transactionally writes the complete resolved scaffold while the manifest records only core authority and project provenance; verify every supported workload initializes with its expected files.
- [x] 3.2 Preserve `liftoff.config.json` as developer-owned desired state outside managed hashes and verify validation accepts supported config edits without rewriting the file.
- [x] 3.3 Update plan and initialization presentation to distinguish managed core, project starter output, framework output, seed content, and desired state, and verify JSON and human plans remain deterministic and side-effect free.

## 4. Core-only update reconciliation

- [x] 4.1 Partition the current render before reconciliation so only managed-core artifacts enter unchanged, new, missing, upgrade, conflict, moved, and orphan classification, and verify changed, untouched, relocated, and deleted project artifacts produce no update entries.
- [x] 4.2 Implement ownership-only v2-v5 manifest migration that preserves project bytes and absences, carries recorded hashes into provenance, and writes v6 only after the core transaction succeeds; verify check mode remains byte-for-byte read-only.
- [x] 4.3 Add defensive mutation-plan guards that reject any write, replacement, move cleanup, or delete outside managed core or an authorized create-only provisioning group, and verify bypass attempts fail before the first filesystem mutation.
- [x] 4.4 Constrain `--force` to managed-core conflicts and verify it cannot overwrite production source, dependencies, schemas, containers, environment files, documentation, infrastructure, unknown legacy artifacts, or provisioning collisions.
- [x] 4.5 Preserve managed-core move, orphan, preflight, snapshot, race, rollback, retry, and transaction behavior under the scoped input set, and verify the existing failure-recovery tests remain green.

## 5. Configuration-authorized provisioning

- [x] 5.1 Detect frontend and environment selection additions by comparing normalized recorded workload intent with desired configuration, select only their explicit provisioning groups, and verify release-added files inside an already selected group are not candidates.
- [x] 5.2 Implement atomic create-only group preflight that writes absent destinations, adopts byte-identical destinations without rewriting, and blocks the entire group on any differing destination regardless of `--force`; verify no partial component is left behind after collision or failure.
- [x] 5.3 Record successfully provisioned files as project provenance with the current generating version and hash, advance workload intent only after success, and verify subsequent updates never restore or upgrade those files.
- [x] 5.4 Preserve files and provenance when a frontend or environment is disabled or re-enabled, and verify neither transition deletes, restores, orphan-reports, or overwrites the project-owned component.
- [x] 5.5 Restrict Power Apps plugin preference reconciliation to manifest intent and applicable managed-core governance context, and verify project-owned starter files and generated README bytes remain unchanged.

## 6. Validation, doctor, and output contracts

- [x] 6.1 Update `liftoff validate` to hash-check managed core while structurally validating project provenance without requiring project files to exist or retain generated bytes, and verify framework-marker validation remains unchanged.
- [x] 6.2 Update doctor to count only managed-core and authorized-provisioning drift while retaining independent runtime and workload diagnostics, and verify project template differences do not produce an update warning.
- [x] 6.3 Advance update JSON to schema version 2 with explicit managed-core scope, ownership-migration state, and separate provisioning results, and verify check/apply stdout remains byte-pure with existing exit-code semantics.
- [x] 6.4 Update human help, drift, warning, skipped-conflict, and completion presentation to name the core authority boundary and never recommend force for project files or provisioning collisions; verify terminal snapshot tests cover interactive and redirected output.

## 7. Production-safety regression coverage

- [x] 7.1 Add a Tenko-style regression fixture with evolved backend and frontend production code plus intentionally removed flat OpenTofu roots, and verify check, update, and forced update leave every production byte and absence unchanged.
- [x] 7.2 Add managed-core regression cases for safe upgrade, missing restore, conflict skip, forced conflict replacement, clean move, occupied move, orphan preservation, and governance adoption, and verify only exact core paths enter transactions.
- [x] 7.3 Add legacy-manifest matrices covering v2-v5, modified files, deleted files, unknown logical names, disabled governance, partial governance adoption, and project paths already matching newer templates, and verify all normalize without acquiring project authority.
- [x] 7.4 Add Power Apps and supported-stack regressions proving a newer packaged starter, dependency graph, lockfile, container, or provider baseline does not become ordinary update drift for an existing project.
- [x] 7.5 Confirm the path-sensitive update, manifest, initialization, validation, doctor, and transaction suites remain in the existing Windows, macOS, and Linux CI matrix, with platform-correct path assertions in the shared tests.

## 8. Documentation and release verification

- [x] 8.1 Update README, CLI reference, safety, configuration/manifest, project-structure, workload, supported-stack, existing-project, and troubleshooting guidance with the core/project ownership split, configuration provisioning limits, schema-v6 transition, and force boundary; verify packaged documentation links and command examples pass.
- [x] 8.2 Update generated project guidance so new projects explain that starter files are production-owned and that ordinary update cannot modernize them, and verify representative generated READMEs contain the ownership and migration language.
- [x] 8.3 Document that in-place project-template modernization requires a separately reviewed project change and is not provided by the existing non-Liftoff `migrate` command, and verify no guidance falsely directs users to update or force for application adoption.
- [x] 8.4 Run the targeted tests, full test suite, TypeScript build, supported-stack checks, package smoke test, and strict OpenSpec validation, and verify the repository is ready for the breaking pre-1.0 release.
