## Why

`liftoff update` currently retains write authority over the complete generated scaffold, even after that scaffold has become a production application. Hash conflict protection prevents some overwrites, but it still restores intentionally deleted files, silently replaces untouched files, and allows `--force` to replace production source, dependencies, schemas, and infrastructure.

## What Changes

- **BREAKING**: Split generated output into explicit Liftoff-managed core artifacts and project-owned scaffold artifacts; domain categories such as `backend`, `frontend`, and `configuration` no longer imply update authority.
- Restrict release-driven `liftoff update`, `--check`, and `--force` reconciliation to managed-core artifacts only.
- Treat application source, tests, database assets, dependency manifests and locks, containers, environment files, documentation, and infrastructure topology as project-owned immediately after generation.
- Never upgrade, restore, move, overwrite, or report ordinary template drift for an existing project-owned artifact, including when `--force` is supplied.
- Preserve developer-owned `liftoff.config.json` as desired state and permit explicitly requested configuration expansion to create new project-owned components only at absent destinations; it does not grant authority over existing project files.
- Evolve the manifest so ownership and generation provenance are distinct, and migrate existing manifests by releasing non-core artifacts without writing, restoring, moving, or deleting their project files.
- Limit validation and doctor drift reporting to the new ownership boundary while retaining separate structural and workload diagnostics.
- Update command help and documentation to state that project template evolution requires a separately authorized migration rather than ordinary update.

## Capabilities

### New Capabilities

- `liftoff-template-ownership`: Defines explicit artifact lifecycle classes, post-generation authority, configuration-driven creation, and the permanent production-file safety boundary.

### Modified Capabilities

- `liftoff-project-update`: Reconcile only managed-core artifacts and confine check, restore, move, conflict, and force behavior to that set.
- `liftoff-manifest-contract`: Record lifecycle and provenance separately, migrate legacy ownership safely, and prevent older CLIs from interpreting the new contract as broad write authority.
- `liftoff-project-scaffold`: Generate the complete starter while transferring non-core output to project ownership after the initial transaction.
- `liftoff-cli-workflow`: Present update and force as core-maintenance commands rather than whole-scaffold reconciliation.
- `liftoff-project-doctor`: Count and report only managed-core drift through the update engine.
- `liftoff-user-documentation`: Explain the core/project split, legacy-manifest transition, and explicit migration boundary for project template changes.

## Impact

This affects artifact types and rendering metadata, manifest parsing and writing, update reconciliation and transactions, validation and doctor diagnostics, configuration-driven component creation, JSON and terminal output, cross-platform fixtures, manifest compatibility tests, generated-project tests, and packaged documentation. Existing projects gain a one-way ownership migration: production files remain byte-for-byte untouched while future Liftoff releases retain authority only over explicit control-plane artifacts.
