# Configuration and manifests

Generated projects have two Liftoff root files with different ownership.

## `liftoff.config.json`: developer-owned desired state

Liftoff writes configuration once during initialization and does not
machine-rewrite it afterward.

Supported edits are reconciled by `liftoff update`:

- API workloads can select a previously absent environment or frontend. Update
  provisions that component once only when its destinations are absent or
  byte-identical; a differing destination blocks the complete component and
  cannot be forced.
- Removing or re-enabling a previously provisioned component never deletes,
  restores, or overwrites its project-owned files.
- Power Apps can change the optional Code Apps plugin preference; only manifest
  intent and applicable managed-core context change.

Workload kind, API stack, GenAI pattern, spec workflow, selected agents, and a
user-supplied Power Apps starter source change are not ordinary updates.

An undecided GenAI project records an explicit generic identity rather than
omitting the pattern:

```json
{
  "projectName": "general-assistant",
  "projectType": "genai",
  "apiStack": "python-fastapi",
  "pattern": "generic",
  "cloud": "azure",
  "region": "eastus",
  "includeFrontend": false,
  "environments": ["dev"],
  "specWorkflow": "openspec",
  "agents": ["github-copilot"],
  "governanceProfile": "single-maintainer-gitflow"
}
```

Changing `generic` to a specialized pattern later is a reviewed project
migration because application files are project-owned; it is not an update.

A Power Apps configuration contains only applicable fields:

```json
{
  "projectName": "sales-hub",
  "projectType": "power-apps-code-app",
  "specWorkflow": "openspec",
  "agents": ["github-copilot"],
  "governanceProfile": "single-maintainer-gitflow",
  "codeAppsPlugin": false
}
```

API, cloud, region, frontend, and environment fields are rejected for this
workload rather than silently ignored.

## `liftoff.manifest.json`: CLI-owned compatibility record

New projects use manifest schema v6. Its common project identity includes the
name, spec workflow, selected agents, and applicable Spec Kit default. A
discriminated `project.workload` object contains only fields valid for one
workload:

- `genai`: API stack, pattern, cloud, region, frontend, and environments.
- `standard`: API stack, cloud, region, frontend, and environments.
- `power-apps-code-app`: immutable starter repository, template path, commit,
  and Code Apps plugin preference.

The manifest also records:

- Last manifest-writing Liftoff version.
- Official framework adapter, state, and tested contract version when known.
- `managedArtifacts`: exact Liftoff core logical names, paths, and
  reconciliation `contentHash` values.
- `projectArtifacts`: starter provenance with the original path, generating
  Liftoff version, `generationHash`, and provisioning group. These hashes never
  authorize update writes.
- OS-neutral path-part arrays.
- Repository governance profile, policy version, and local
  `handoff-generated`, `handoff-partial`, or disabled state.

Power Apps source identity uses explicit repository, path, and 40-character
commit fields. It is not inferred from mutable URLs or generated file paths.

Treat the manifest as CLI-owned. Restore it from version control or regenerate
with the matching Liftoff version when validation reports malformed identity,
paths, or hashes.

## Compatibility

Readers support schemas v2, v3, v4, v5, and v6:

- V2 normalizes the legacy flat API identity and records framework state as
  uncertain without inventing agents.
- V3 normalizes flat GenAI or API identity plus framework and agent metadata.
- V4 represents the discriminated workload model, including Power Apps.
- V5 adds repository-governance handoff identity without claiming live
  enforcement.
- V6 separates managed-core update authority from project generation
  provenance.

Enabled governance manifests retain their recorded positive-integer policy
version. Readers accept historical policy versions up to the CLI's current
version so `liftoff update --check` can report managed-core drift and plain
update can migrate it. Malformed or future policy versions remain invalid.

`liftoff update --check`, including `--check --json`, leaves an old manifest
byte-for-byte unchanged. A successful plain update writes v6 only after the
transaction succeeds. V2-v5 backend, frontend, database, dependency, container,
environment, documentation, Power Apps, and infrastructure entries become
project provenance without reading or changing current production bytes.
Intentionally deleted files remain absent. Only exact current core logical
names retain write authority.

## Artifact ownership

Every generated artifact has an explicit lifecycle independent from its
category or filename:

| Lifecycle | Owner after initialization | Update behavior |
| --- | --- | --- |
| `managed-core` | Liftoff | Safe reconciliation; reviewed core conflicts may use `--force` |
| `project` | Developer/project | Provenance only; never compared, restored, moved, or overwritten |
| `desired-state` | Developer | Read as input and never machine-rewritten |
| `framework` | Official framework | Validated through framework markers and maintained by that framework |
| `seed` | Developer/project | Written once and never reconciled |

The manifest is a CLI-owned transaction record rather than an ordinary
template artifact. Current managed core is limited to the exact repository
governance policy, context, guide, and selected-agent launchers. A name such as
`config.go`, a `configuration` category, or a path under `.github` does not
grant update authority.

## Contract conventions

- Writers use `artifactVersion` 6; readers support v2, v3, v4, v5, and v6.
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
