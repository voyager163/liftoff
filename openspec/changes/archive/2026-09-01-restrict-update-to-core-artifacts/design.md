## Context

See `proposal.md` for motivation. The current renderer emits one flat artifact collection whose `category` describes a domain such as backend, frontend, or infrastructure. The manifest gives nearly every non-framework, non-seed artifact the same durable hash ownership, and update re-renders that full collection. As a result, an untouched production file is a safe upgrade, a deliberately deleted production file is a safe restore, and `--force` can replace any conflicted production file.

The existing safeguards remain valuable but answer a narrower question: whether bytes changed since Liftoff last wrote them. They cannot decide whether Liftoff should still have authority over the file. Tenko-v2 demonstrates the distinction: a deliberate OpenTofu redesign removed the original flat roots, and update restored those paths because the manifest still owned them.

The change crosses template declaration, manifest compatibility, initialization, update reconciliation, validation, doctor, terminal and JSON contracts, tests, and documentation. It must remain deterministic, offline-capable, transactional, path-confined, and equivalent on Windows, macOS, and Linux.

## Goals / Non-Goals

**Goals:**

- Make post-generation write authority explicit and auditable for every artifact.
- Make production project files unreachable from update mutations, including `--force`.
- Preserve complete new-project generation and safe, explicit provisioning of a newly selected frontend or environment.
- Upgrade supported legacy manifests without reading current production bytes into managed state or recreating intentionally removed files.
- Keep current managed-core conflict, move, orphan, preflight, transaction, and recovery protections.
- Make human and machine output accurately describe the narrower authority.

**Non-Goals:**

- Three-way merging or automatic modernization of production application files.
- An in-place project-template migration command in this change.
- Changing the existing `liftoff migrate` contract for adopting a non-Liftoff source into a fresh target.
- Inferring ownership from paths, categories, filenames, file contents, or Git history.
- Managing official OpenSpec or Spec Kit output, one-time seed content, or developer desired state.
- Installing dependencies or changing remote, cloud, or repository settings during update.

## Decisions

### 1. Add lifecycle metadata orthogonal to artifact category

Generated artifacts gain a required lifecycle:

```text
managed-core  Liftoff control-plane file; update may reconcile it
project       starter or workload file; project owns it after creation
desired-state developer input read by Liftoff but never machine-rewritten
framework     official framework-owned output
seed          write-once gifted content
```

The manifest remains a transaction record rather than a normal reconciled artifact.

`category` remains the stable domain label used for inventory and presentation. It does not grant authority. Every template declaration must provide lifecycle explicitly; there is no permissive default. The add-artifact helpers and type system reject an omitted lifecycle, and tests assert that every representative workload has a complete classification.

Current managed core consists only of the exact repository-governance policy, context, guide, and selected-agent launcher logical names. `liftoff.config.json` is desired state. Existing application, dependency, lock, Docker, Compose, environment, documentation, database, frontend, backend, Power Apps starter, and OpenTofu artifacts are project-owned. Future managed-core files must be introduced through an explicit logical declaration and contract test; a `.liftoff/` path or a `configuration` category is not sufficient.

Alternative considered: derive core ownership from categories or reserved directories. Rejected because categories describe domains, production configuration appears across several categories, and exact files under `.github`, `.claude`, or `.liftoff` can have different owners.

Alternative considered: default every new artifact to managed core. Rejected because an omitted annotation would silently recreate the current unsafe behavior. Missing lifecycle metadata must fail generation and tests.

### 2. Use manifest schema v6 with physically separate authority and provenance collections

Schema v6 replaces the flat durable artifact list with discriminated collections:

```json
{
  "artifactVersion": 6,
  "liftoffVersion": "0.x.y",
  "managedArtifacts": [
    {
      "logicalName": "repository-governance-policy",
      "category": "governance",
      "pathParts": [".liftoff", "governance", "policy.md"],
      "contentHash": "sha256:..."
    }
  ],
  "projectArtifacts": [
    {
      "logicalName": "go-backend-api",
      "category": "backend",
      "pathParts": ["backend", "internal", "api", "api.go"],
      "generatedBy": "0.7.0",
      "generationHash": "sha256:...",
      "provisioningGroup": "base"
    }
  ]
}
```

Separate collections make it difficult for a future update path to mistake provenance for authority. Managed entries retain the current `contentHash` invariant: the hash is what Liftoff last wrote or adopted and is usable for reconciliation. Project entries use `generationHash`, which records original template provenance only. Update never refreshes it from production bytes.

`generatedBy` is per project artifact because configuration expansion can add a frontend or environment with a later CLI than the original base scaffold. `liftoffVersion` continues to identify the CLI that last wrote the manifest and core state; it no longer implies that project files match that release.

Desired state remains represented by the fixed configuration contract rather than a managed hash entry. Framework identity remains in `framework`, selected agents remain in `project`, governance identity remains in `governance`, and seed content remains absent from durable state.

Alternative considered: retain one `artifacts` array and add a lifecycle field. Rejected because every reconciliation caller would have to remember to filter a mixed-authority collection. Separate collections make the safe API shape the default.

Alternative considered: remove project entries entirely. Rejected because immutable Power Apps source provenance, generated logical-name inventory, configuration re-enablement, migration diagnostics, and per-component generation version remain useful without granting write authority.

### 3. Normalize legacy manifests with a fail-safe lifecycle mapping

Readers accept schemas v2 through v6; writers emit only v6. During v2-v5 normalization:

1. Preserve workload, framework, agent, governance, path, logical-name, and recorded-hash facts.
2. Map an artifact to managed core only when its exact logical declaration is currently known as managed core.
3. Convert every other recorded artifact to project provenance, using the legacy manifest's `liftoffVersion` as `generatedBy` and its `contentHash` as `generationHash`.
4. Default unknown logical names to project provenance.
5. Preserve project provenance even when the path is absent or current bytes differ.

Normalization does not need to read project file bytes. Check mode reports `ownershipMigrationPending` without writing. Plain update writes v6 after core reconciliation and any authorized provisioning succeeds, even when no core file changed. The transaction does not contain a project-file mutation merely because lifecycle changed.

Known managed-core declarations come from explicit template metadata rather than the current render alone. This preserves orphan behavior when a core feature such as governance is disabled by configuration.

An older CLI rejects v6 as unsupported before artifact access. This is an intentional downgrade barrier: it is safer than letting an older broad-ownership engine reinterpret released production artifacts.

Alternative considered: infer legacy ownership from category. Rejected because it would classify backend configuration and infrastructure as core despite being production assets.

Alternative considered: keep legacy entries managed until the user opts out individually. Rejected because the unsafe authority would survive indefinitely and still allow accidental restoration or force replacement.

### 4. Partition reconciliation before classification or filesystem access

The renderer continues producing the complete current plan because initialization, planning, provenance, and configuration expansion need it. Before update classification, artifacts are partitioned by lifecycle:

```text
full render
   |
   +-- managed-core ----------> reconcile -> preflight -> optional mutations
   |
   +-- newly authorized group -> create-only preflight -> optional creation
   |
   +-- existing project ------> provenance only; no drift classification
   |
   +-- desired/framework/seed -> existing specialized behavior
```

Only managed-core entries enter the existing unchanged/new/missing/upgrade/conflict/moved/orphan state machine. Therefore default apply, `--force`, move cleanup, orphan handling, update snapshots, and transaction preconditions cannot receive a project-owned path.

The update preflight and transaction APIs accept scoped mutation plans rather than the full render. A defensive assertion rejects any write or delete mutation whose logical artifact is not managed core or an authorized create-only provisioning entry. This keeps the safety boundary intact if a future caller bypasses the normal partition helper.

`--force` is consulted only while resolving managed-core conflicts. It is never passed to component provisioning and cannot expand the eligible artifact set.

Alternative considered: classify all artifacts and filter only immediately before writes. Rejected because check output, doctor counts, force guidance, manifest refresh, and future call sites could still treat production drift as actionable.

### 5. Preserve configuration expansion through explicit create-only provisioning groups

The existing desired-state contract supports enabling a frontend and adding environments. Those operations remain possible, but they are not release-driven template upgrades.

Project artifact declarations carry an explicit `provisioningGroup`:

```text
base
frontend
environment:<catalog-id>
power-apps-starter
```

No group is inferred from a path or category. Update compares the normalized recorded workload selection with the desired plan:

- `frontend: false -> true` authorizes the `frontend` group only when that group has never been provisioned.
- a newly listed environment authorizes only its matching environment group.
- a previously provisioned group that is disabled and re-enabled remains project-owned and is not regenerated.
- template additions within an already selected group are not provisioning candidates.

All destinations in an authorized group are preflighted before any write. Missing destinations are created; byte-identical destinations may be adopted as generation provenance without rewriting; any differing destination blocks the entire group. `--force` cannot bypass the collision. On success, project provenance records the current CLI and generated hashes, then the manifest records the new workload selection.

Removing a frontend or environment updates desired workload identity but does not delete, orphan-report, or stop preserving its project provenance. Re-enabling therefore cannot restore missing files or overwrite evolved ones.

Power Apps plugin preference changes update only manifest intent and applicable managed-core governance context. They do not rewrite the project-owned README or starter.

Alternative considered: remove configuration-driven expansion entirely. Rejected because absent-destination provisioning is explicit developer intent and can remain safe without retaining authority over the resulting files.

Alternative considered: treat every new logical name in the current render as a new component file. Rejected because a Liftoff release adding a starter file would then bypass the ownership boundary.

### 6. Narrow validation and doctor without weakening independent diagnostics

Validation performs content existence and hash checks only for `managedArtifacts`. It validates project provenance schema, uniqueness, path safety, logical-name stability, generation hashes, and source identity without requiring project paths to exist or match generation bytes. Framework markers retain their separate validation.

Doctor uses the managed-core reconciliation result and authorized provisioning plan for its drift count. Project template evolution does not appear as an update warning. Runtime and workload diagnostics remain independent: doctor may still report a missing `.env`, invalid Compose configuration, dependency inconsistency, or workload-specific failure based on the current project, but the remedy must not imply that core update owns the file.

Alternative considered: keep whole-template drift as an informational doctor signal. Rejected because it recreates noisy output and encourages users to reach for force even though update cannot safely act on the differences.

### 7. Version update machine output to make the scope explicit

Update JSON advances to schema version 2 because existing consumers may assume that check entries cover the whole generated scaffold. Both modes include:

- `scope: "managed-core"`;
- `ownershipMigrationPending`;
- managed-core summary and entries;
- a separate provisioning section for configuration-authorized groups;
- written and skipped core paths in apply mode.

Human output names "Liftoff core" rather than generic "template changes." Ownership-only migration explicitly says that no production file will be written. Check output never recommends `--force` for project template differences or provisioning collisions.

Alternative considered: preserve output schema version 1 and only change prose. Rejected because the semantic narrowing can affect CI policy and requires an explicit machine-contract boundary.

### 8. Keep project-template adoption outside this change

Installing a newer CLI can expose newer generation templates, but update does not compare or apply them to an existing project's project artifacts. Dependency, runtime, container, database, application, Power Apps starter, and infrastructure adoption requires a normal reviewed project change.

This change does not extend the existing `liftoff migrate` command, which continues to adopt a non-Liftoff source into a fresh target. Documentation states that Liftoff does not automate in-place project-template migration in this release rather than pointing users to an unsupported command. A future migration capability can consume v6 project provenance without weakening update.

## Risks / Trade-offs

- **[Existing projects no longer receive automatic dependency and image updates]** -> Treat those as production migrations, publish baseline differences and security guidance, and keep future explicit migration work separate from core maintenance.
- **[A lifecycle annotation is assigned incorrectly]** -> Require lifecycle at every artifact declaration, review exact logical names, snapshot all workload classifications, and default unknown legacy names to project ownership.
- **[Manifest v6 increases schema and fixture complexity]** -> Use discriminated collections, centralized validation helpers, and convert existing fixtures through shared builders rather than hand-maintained variants.
- **[Older CLIs cannot update a v6 project]** -> Fail before artifact access with upgrade guidance; do not provide a compatibility mode that restores broad authority.
- **[Configuration expansion partially writes a component]** -> Preflight the complete explicit group and include its writes and manifest update in one existing project transaction.
- **[Removing a configured component leaves files and provenance]** -> Document this as intentional project ownership; deletion remains a developer decision.
- **[Doctor no longer reports newer starter templates]** -> Keep update diagnostics honest and use release notes or a future migration-inspection command for project-template evolution.
- **[Project provenance paths become stale after developer moves]** -> Treat them as historical generation facts, validate path safety but not disk presence, and never use them as mutation targets.

## Migration Plan

1. Add lifecycle and provisioning metadata to generated artifact declarations, classify every representative workload, and introduce exhaustive contract snapshots.
2. Add schema-v6 types, parsing, validation, builders, and v2-v5 normalization into separate managed and project collections.
3. Update initialization and planning to write the complete scaffold while producing v6 authority and provenance records.
4. Partition update before reconciliation, add ownership-only migration and guarded create-only provisioning, and confine every mutation and force path to eligible entries.
5. Narrow validation and doctor, advance update JSON to schema version 2, and update terminal presentation.
6. Add regression fixtures for evolved production source and intentionally removed OpenTofu roots, plus force, provisioning, failure, retry, legacy, Power Apps, and Windows path matrices.
7. Update packaged and generated documentation, migration guidance, snapshots, and release notes.
8. Publish as a breaking pre-1.0 release and direct existing projects to run `liftoff update --check` before the ownership-only manifest transition.

Before release, rollback is a normal source revert. After a project has a v6 manifest, an older CLI intentionally refuses it; a release rollback must preserve v6 parsing and the core-only boundary or ship a forward fix. Restoring a v5 manifest from version control re-enables old broad ownership and is not presented as a routine rollback.
