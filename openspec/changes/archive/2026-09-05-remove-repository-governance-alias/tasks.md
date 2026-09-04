## 1. Generation and model

- [x] 1.1 Remove retired setup-alias logical names and paths from current managed-core catalogs and governance artifact rendering; verify generated logical-name snapshots contain `/liftoff-setup` identities only.
- [x] 1.2 Update generated setup text, project guidance, and Power Apps governance guidance so `/liftoff-setup` is the sole visible command; verify generated artifacts no longer contain `/liftoff-repository-governance`.

## 2. Reader bridge

- [x] 2.1 Add a retired identity catalog for exactly the Copilot and Claude old setup aliases; verify v2-v7 manifest readers accept only those exact logical-name/category/path tuples as migration debt.
- [x] 2.2 Reject retired aliases at the wrong identity, unknown old launcher names, and retired names in project provenance; verify manifest validation tests cover each failure mode.

## 3. Reconciliation and update

- [x] 3.1 Classify retired aliases as retired, retired-absent, or retired-conflict from manifest ownership, disk presence, and recorded hash; verify update check reports reasons without writing.
- [x] 3.2 Make plain update remove clean or absent retired ownership, delete only matching present alias files, and leave unrelated orphans untouched; verify JSON summary and manifest results.
- [x] 3.3 Protect modified retired aliases during plain update and delete only exact aliases with `update --force`; verify `handoff-partial`, skipped reports, and forced removal behavior.
- [x] 3.4 Include retired alias deletion in the update transaction; verify injected failure rolls both alias bytes and manifest bytes back.

## 4. Documentation and specs

- [x] 4.1 Update directly affected current docs and main specs from stale v6/launcher wording to v7/setup terminology; verify no current guidance presents the retired alias as callable.
- [x] 4.2 Create proposal, design, and delta specs for every modified capability; verify `openspec validate remove-repository-governance-alias --strict` succeeds.

## 5. Tests and snapshots

- [x] 5.1 Update contract, filesystem, governance, update, framework-adapter, doctor, and snapshot coverage for current-only setup identities; verify changed tests assert old names are absent from current manifests and metadata.
- [x] 5.2 Cover migration edge cases for clean, absent, modified, force-deleted, unrelated orphan, invalid identity, and rollback states; verify targeted update and manifest tests exercise each path.

## 6. Validation

- [x] 6.1 Run strict OpenSpec validation; verify the change validates with all modified requirement blocks present.
- [x] 6.2 Confirm apply status after artifact creation; verify `openspec status --change remove-repository-governance-alias --json` reports all artifacts done and apply instructions report state `all_done`.
