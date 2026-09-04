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
- Supported API deployment environments are exactly `dev`, `staging`, and
  `prod`. The retired `test` identifier is rejected in configuration and
  manifests; replace it with `staging` before validation or update.
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

New projects use manifest artifact version 7. Its common project identity includes the
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
- Repository governance profile, policy version 6, activation-contract version
  1, graph/state/evidence/approval/supersession/credential schema versions, the
  exact phase-graph hash, and local `handoff-generated`, `handoff-partial`, or
  disabled state.

Power Apps source identity uses explicit repository, path, and 40-character
commit fields. It is not inferred from mutable URLs or generated file paths.

Treat the manifest as CLI-owned. Restore it from version control or regenerate
with the matching Liftoff version when validation reports malformed identity,
paths, or hashes.

## Compatibility

Readers support artifact versions v2, v3, v4, v5, v6, and v7:

- V2 normalizes the legacy flat API identity and records framework state as
  uncertain without inventing agents.
- V3 normalizes flat GenAI or API identity plus framework and agent metadata.
- V4 represents the discriminated workload model, including Power Apps.
- V5 adds repository-governance handoff identity without claiming live
  enforcement.
- V6 separates managed-core update authority from project generation
  provenance.
- V7 adds deterministic setup identity: manifest artifact version 7, policy
  version 6, activation-contract version 1, schema-v1 activation artifacts, and
  the canonical phase-graph hash. Governance-disabled v7 manifests use the
  disabled variant and do not fabricate activation identity.

Enabled governance manifests retain their recorded positive-integer policy
version only when the complete compatibility tuple is supported. Readers accept
historical v2-v6 manifests so `liftoff update --check` can report managed-core
drift and plain update can migrate them to v7. Malformed or future manifest,
policy, contract, schema, or graph identities remain invalid or blocked without
rewrite.

`liftoff update --check`, including `--check --json`, leaves an old manifest
byte-for-byte unchanged. A successful plain update writes v7 only after the
transaction succeeds. V2-v6 backend, frontend, database, dependency, container,
environment, documentation, Power Apps, and infrastructure entries become
project provenance without reading or changing current production bytes.
Intentionally deleted files remain absent. Only exact current core logical names
retain write authority.

The compatibility map is explicit; Liftoff does not use numeric less-than
comparisons to infer safety. Supported v7 identity resumes when policy 6,
activation contract 1, schema versions 1, and a recognized graph hash match.
Future identities, individually known versions in unsupported combinations,
unversioned ad hoc governance state, and unknown graph hashes block with an
upgrade, import-mapping, or reconciliation remedy. No reader converts prose,
filenames, or checked tasks into evidence.

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
governance policy, context, guide, phase graph, compatibility metadata,
credential-policy schema, and selected-agent `/liftoff-setup` integrations.
Forced update may remove exact retired generated setup-alias entries from older
manifests after review. A name such as `config.go`, a `configuration` category,
or a path under `.github` does not grant update authority.

User-owned governance artifacts are deliberately excluded from managed-core
hashes: `governance/activation-state.json`, approvals, evidence, credential
policies, supersession records, active OpenSpec changes, and bootstrap
retention/disposal records. Update may report reconciliation-required status for
those files, but it does not advance, reset, or delete a phase.

## Contract conventions

- Writers use `artifactVersion` 7; readers support v2, v3, v4, v5, v6, and v7.
- Artifact logical names and catalog identifiers are append-only.
- Rendering is deterministic and does not depend on timestamps, host versions,
  or network state.
- `.liftoff/governance/` contains managed setup definitions; `governance/`
  contains user-owned activation state.
- Machine-readable paths are path-part arrays, never platform-joined strings.
- Exit codes are 0 for success or clean, 1 for failure, and 2 for detected
  drift in check mode.
- JSON outputs carry a numeric top-level `schemaVersion`.

See [safety and consent](safety-and-consent.md) for reconciliation and rollback
behavior.
