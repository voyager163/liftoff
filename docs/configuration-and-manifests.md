# Configuration and manifests

Generated projects have two Liftoff root files with different ownership.

## `liftoff.config.json`: developer-owned desired state

Liftoff writes configuration once during initialization and does not
machine-rewrite it afterward.

Supported edits are reconciled by `liftoff update`:

- API workloads can add or remove environments and enable applicable generated
  areas such as the frontend.
- Power Apps can change the optional Code Apps plugin preference.

Workload kind, API stack, GenAI pattern, spec workflow, selected agents, and a
user-supplied Power Apps starter source change are not ordinary updates.

A Power Apps configuration contains only applicable fields:

```json
{
  "projectName": "sales-hub",
  "projectType": "power-apps-code-app",
  "specWorkflow": "openspec",
  "agents": ["github-copilot"],
  "codeAppsPlugin": false
}
```

API, cloud, region, frontend, and environment fields are rejected for this
workload rather than silently ignored.

## `liftoff.manifest.json`: CLI-owned compatibility record

New projects use manifest schema v4. Its common project identity includes the
name, spec workflow, selected agents, and applicable Spec Kit default. A
discriminated `project.workload` object contains only fields valid for one
workload:

- `genai`: API stack, pattern, cloud, region, frontend, and environments.
- `standard`: API stack, cloud, region, frontend, and environments.
- `power-apps-code-app`: immutable starter repository, template path, commit,
  and Code Apps plugin preference.

The manifest also records:

- Generating Liftoff version.
- Official framework adapter, state, and tested contract version when known.
- Durable artifact logical names.
- OS-neutral path-part arrays.
- `sha256:` content hashes.

Power Apps source identity uses explicit repository, path, and 40-character
commit fields. It is not inferred from mutable URLs or generated file paths.

Treat the manifest as CLI-owned. Restore it from version control or regenerate
with the matching Liftoff version when validation reports malformed identity,
paths, or hashes.

## Compatibility

Readers support schemas v2, v3, and v4:

- V2 normalizes the legacy flat API identity and records framework state as
  uncertain without inventing agents.
- V3 normalizes flat GenAI or API identity plus framework and agent metadata.
- V4 represents the discriminated workload model, including Power Apps.

`liftoff update --check`, including `--check --json`, leaves an old manifest
byte-for-byte unchanged. A successful plain update writes v4 only after the
file transaction succeeds. Skipped conflicts retain their recorded hashes.

## Artifact ownership

Durable Liftoff artifacts carry logical names and hashes. That lets validate,
doctor, and update distinguish:

- Current template bytes.
- An untouched file with a template upgrade.
- A developer edit that conflicts with a template change.
- A named artifact moved by the template.
- Missing, new, and orphaned artifacts.

Framework-owned OpenSpec and Spec Kit files are validated separately and are
not claimed in durable hashes. One-time seed files are also excluded so they
can follow their own lifecycle.

## Contract conventions

- Writers use `artifactVersion` 4; readers support v2, v3, and v4.
- Artifact logical names and catalog identifiers are append-only.
- Rendering is deterministic and does not depend on timestamps, host versions,
  or network state.
- `.liftoff/` is reserved for future CLI-managed state.
- Machine-readable paths are path-part arrays, never platform-joined strings.
- Exit codes are 0 for success or clean, 1 for failure, and 2 for detected
  drift in check mode.
- JSON outputs carry a numeric top-level `schemaVersion`.

See [safety and consent](safety-and-consent.md) for reconciliation and rollback
behavior.
