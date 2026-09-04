## Why

The generated repository-governance setup surface currently exposes a retired `/liftoff-repository-governance` alias alongside `/liftoff-setup`, which leaves users and generated contracts with two visible ways to enter the same deterministic setup flow. Retiring the alias from current generation and documentation simplifies the public command contract while preserving a bounded migration path for older manifests.

## What Changes

- **BREAKING**: `/liftoff-repository-governance` is no longer a generated or visible setup command; users invoking it must use `/liftoff-setup`.
- Generate and document `/liftoff-setup` as the sole selected-agent setup integration for current projects, including Power Apps projects and generated update guidance.
- Ensure new/current manifests, compatibility metadata, snapshots, generated artifacts, and project provenance contain only current setup identities; retired setup-alias logical names cannot appear in current `managedArtifacts`, `projectArtifacts`, or compatibility inventories.
- Keep manifest v2 through v6 and early v7 readers as an upgrade bridge for exactly `repository-governance-copilot-launcher` at `.github/prompts/liftoff-repository-governance.prompt.md` and `repository-governance-claude-launcher` at `.claude/commands/liftoff-repository-governance.md`.
- Reject unknown old launcher names, retired aliases at the wrong category or path, and retired alias logical names in project provenance.
- Make plain `liftoff update` transactionally remove exact clean retired alias ownership, delete the alias file only when the recorded bytes are still present, retire already absent ownership without counting a deletion, and leave unrelated orphans untouched.
- Protect modified exact retired aliases during plain update by retaining ownership as migration debt, setting `handoff-partial`, and deleting only through `liftoff update --force`.
- Roll back retired alias deletion and manifest rewrites together on update failure, and expose retired alias removal/protection in human and JSON update reports.
- Correct directly touched current requirements and documentation from stale v6/launcher terminology to v7/setup terminology.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `liftoff-cli-workflow`: plan preview names selected-agent `/liftoff-setup` integrations rather than launchers.
- `liftoff-manifest-contract`: current v7 manifest and compatibility contracts exclude retired aliases while legacy readers bridge exactly two retired identities for upgrade.
- `liftoff-power-apps-code-apps`: Power Apps governance guidance generates and documents only applicable `/liftoff-setup` integrations.
- `liftoff-project-scaffold`: generated projects use manifest v7 and one deterministic setup entry point with no visible alias command.
- `liftoff-project-update`: reconciliation, apply, force, rollback, manifest rewrite, and JSON reporting handle exact retired aliases safely.
- `liftoff-repository-governance-profile`: profile selection and local handoff diagnostics refer to setup integrations without claiming live enforcement.
- `liftoff-user-documentation`: user-facing guidance presents `/liftoff-setup` as the only command and treats old aliases only as migration debt.

## Impact

- Affected code paths include governance artifact rendering, current managed-core logical-name catalogs, manifest loading/validation, compatibility metadata validation, reconciliation, update apply/force/reporting, and rollback transactions.
- Affected outputs include generated setup artifacts, `liftoff.manifest.json`, `.liftoff/governance/compatibility.json`, CLI plan/update/doctor presentations, snapshots, and user documentation.
- Existing projects with generated `/liftoff-repository-governance` files migrate through `liftoff update`; modified retired aliases require `liftoff update --force` after review.
