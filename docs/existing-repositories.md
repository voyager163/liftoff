# Existing repositories

Liftoff chooses its target from the current directory and Git worktree
discovery before it stages any output.

## Choose the supported journey

| Current repository | Goal | Start with | Write-capable follow-up |
| --- | --- | --- | --- |
| Existing Liftoff project | Observe current conformance | `liftoff assess --project . --json` | `liftoff update --check` for managed core; `liftoff repair --check` for separately scoped repair |
| Existing non-Liftoff application | Keep the same root and application paths | `liftoff assess --project . --json`, then `liftoff adopt --project . --check` | Exact adoption verification and publication only after their separate reviews and consents |
| Existing non-Liftoff application | Create a fresh sibling scaffold and filtered source copy | `liftoff assess --project . --json`, then `liftoff migrate . <selection>` | Complete the unchecked migration work in the new sibling |
| Empty or intentionally new Git root | Generate a new project at that root | `liftoff plan`, then `liftoff init` | Explicit initialization permissions |

Assessment is read-only and does not turn findings into approval. Adoption,
migration, update, and repair have different authority and recovery records.
Do not substitute `init --force`, a copied starter, hand-edited manifest, or a
deleted journal for the selected journey.

## Empty or new Git root: initialize in place

When the current directory is exactly the root reported by
`git rev-parse --show-toplevel`, `liftoff init` uses that directory as the
target:

```bash
cd existing-repository
liftoff init
```

With no project name, Liftoff derives project identity from the repository
directory. Supplying a name changes the generated project identity but still
does not create a child folder:

```bash
liftoff init customer-portal
```

Use this only when the root is intentionally becoming a new Liftoff project.
If it already contains an application that must be preserved, use assessment
plus in-place adoption or sibling migration instead.

## Other locations: create a named child

In a non-Git directory, or in a directory below but not equal to a Git root, a
project name produces a child:

```text
workspace/
`-- customer-portal/
    |-- liftoff.config.json
    `-- liftoff.manifest.json
```

This distinction prevents an invocation deep inside an existing repository
from unexpectedly treating that subdirectory as the repository root.

## Non-empty targets

Liftoff never blindly replaces a target tree. It:

1. Renders Liftoff-owned files in temporary staging.
2. For OpenSpec only, verifies or separately configures its required global profile.
3. Runs the official initializer for OpenSpec or Spec Kit; Manual skips all framework work.
4. Rejects unexpected roots, nested Git metadata, and unsafe paths.
5. Compares every destination before writing.
6. Lists different regular files as one replacement set.
7. Requires explicit overwrite permission before replacing that set.
8. Applies the authorized merge transactionally and rolls back handled
   failures.

Unrelated existing files are preserved. Structural collisions, symlinks,
case or NFC-normalization aliases in destination paths, unsafe ancestors, and an
existing `liftoff.manifest.json` are blockers that `--force` cannot bypass.
Existing destination ancestors must be listable; an inspection failure stops
initialization instead of permitting an unchecked merge.

See [safety and consent](safety-and-consent.md) for the complete permission
model.

## Existing Liftoff project

If the target already contains `liftoff.manifest.json`, do not run init again.
Use:

```bash
liftoff assess --project . --json
liftoff validate
liftoff governance status --json
liftoff update --check
liftoff update
```

For project-file layout repair, use `liftoff repair --check` for inspection.
Bare current-v8 repair also performs read-only application inventory, with
explicit active bindings instead of assumed canonical paths. Use an external
`--application-patch` in a genuine terminal to review its eligible exact plan
and answer Yes/No (default No), without copying a fingerprint. Historical
infrastructure recipes retain their separate bare-repair flow. Unknown/deployed
infrastructure remains protected. For broader application paths, the selected
native `/liftoff-repair` integration (Codex: `$liftoff-repair`) inventories the
real project and stages a reviewed patch outside it. Verification/project-code,
declared network and file-transaction permissions are separate; see
[repair modes](cli-reference.md#repair-modes) and
[application repair](application-repair.md). This is not a fresh scaffold over
the application, and `liftoff migrate` remains a separate adoption workflow.
When an approved current-v8 patch moves an actively bound artifact, application
files commit first and the manifest remains unchanged. Review and approve the
separate binding fingerprint reported by repair. A failure reports the exact
committed effects and preserves them; rerunning the original application
fingerprint reconstructs only pending manifest binding work and cannot repeat
the move or claim new generation/activation history.

To add or repair coding-agent integrations without changing the workflow, start
with an exact additive preview:

```bash
liftoff repair . --agents codex --check --json
liftoff repair . --agents codex
```

Existing agents are never removed. Manual installs only requested
Liftoff-native integrations. OpenSpec and Spec Kit use pinned official
integration operations in isolated staging and preserve framework history,
active work and unrelated files. A Spec Kit default remains unchanged unless
the request explicitly includes, for example, `--default-agent codex`.
Missing integration output for an already recorded requested agent is repaired
as real file work; metadata alone is not installation proof. Tool installation
and OpenSpec global-profile configuration require their separate permissions,
and an agent-only repair does not claim that application or infrastructure work
is complete.

### CLI-only and agent-assisted repair

Both paths use the same deterministic inventory, external staging, verification
receipt, exact file plan, transaction, and recovery contracts:

- **CLI-only:** run `liftoff repair --inspect-layout --json`, author the strict
  patch document and replacement files outside the project, and submit
  `--application-patch` in a genuine terminal. Ambiguous semantic rewrites stay
  blocked until the developer supplies an exact reviewed mapping.
- **Agent-assisted:** invoke the installed `/liftoff-repair` integration
  (`$liftoff-repair` in Codex) to explain inventory and help author the same
  external patch. The agent cannot mint verification, network, file-write, or
  active-binding approval and cannot edit the project first.

In either path, project-code execution, dependency preparation, declared
network, file publication, and active-binding publication are distinct
permissions. A successful check does not imply file approval, deployment, or
whole-project conformance.

Always run `--check` before a write-capable update. Check leaves project bytes
unchanged and discloses a user-local preview receipt outside the repository.
Plain update requires a matching preview and explicit approval of the exact
plan before applying safe managed-core changes; core conflicts and orphans stay
protected. `--force` requires separate approval of its previewed variant and
can replace only listed, owned core conflicts. Project-owned production
files are not compared with new templates or overwritten by update. For CI
core-maintenance gates, use `liftoff update --check --json`.
See [preview receipt storage](cli-reference.md#preview-receipt-storage) for
platform-specific locations and checkout portability.

OpenSpec skills and commands remain framework-owned. To give an existing
project all 12 workflows as both skills and commands, run:

```bash
openspec config profile
openspec update
```

Select both delivery modes and every workflow in the profile picker. Plain
`liftoff update` does not regenerate OpenSpec integrations. To change the
hosted Copilot agent later, update `githubCopilot.cloudAgent` through OpenSpec
and run `openspec update`.

Liftoff's own repair integrations use exact managed identities. A supported
older manifest first acquires its current manifest through the reviewed update
above. A current v8 project then uses additive `liftoff repair --agents` to add
or restore the requested native and framework integrations, including when
governance is disabled. Unowned custom integrations and neighboring skills are
not overwritten by repair or force.

Supported historical projects preview a manifest-v8 managed-core successor.
After a matching check and explicit approval, update adopts safe policy,
context, guide, phase graph, compatibility metadata, credential-policy schema
and selected-agent setup integrations. An omitted governance setting retains
the single-maintainer default only when the historical profile is unspecified;
recorded opt-out remains disabled. Configuration is never rewritten to
materialize a default. A required unowned conflict blocks the complete successor
rather than claiming a partially installed v8 contract; force cannot take
ownership of that destination. Resolve the conflict and run a fresh check.
For a current v8 project, an explicit `governanceProfile` change is represented
by a separately labeled local policy plan under `liftoff update --check`.
Exact approval updates only reviewed managed policy/integration identity and the
manifest. It preserves stronger controls, CODEOWNERS, workflow, application/Git
history, and old proof; selecting `none` leaves source-only governance files as
unmanaged orphans only after the separately approved governance workflow has
removed active `governance/activation-state.json`. It does not activate or
deactivate GitHub settings. Workflow changes use `liftoff workflow set`;
ordinary update and force cannot execute either lane.

Review the exact profile/workflow contract and actual operation descriptors in
the preview, including history preservation. Supported activation-v1/v2/v3
sources retain original state, receipts, plans, approvals and source metadata
in in-project history before a linked current successor is created. Sources
without activation preserve their original manifest separately without
inventing activation state. Historical records stay non-executable; updating
core files never makes old proof or approval current.
Publication returns committed-incomplete when local revalidation remains
outstanding. Use the separately reviewed
[modern local interfaces](cli-reference.md#modern-successor-revalidation);
postcommit failures preserve the successor rather than downgrading it.
Unsupported source formats and application/infrastructure migrations remain
separate blockers.

The manifest-v8 successor retains legacy non-core artifacts as project
provenance without writing, restoring, moving, or deleting their paths.
Intentionally removed infrastructure stays absent and production source stays
byte-for-byte unchanged.

Supported update readers accept manifest v2-v8 and write v8 only after all
preflights pass. Future versions, unsupported policy/contract/schema tuples,
unknown graph hashes, unversioned activation state, or prose-only task history
block with explicit upgrade, import-mapping, or reconciliation remedies. Liftoff
never fabricates evidence from old checkboxes. A diagnostic is not a command to
hand-write mappings, retag receipts, or manufacture missing history.

The new infrastructure layout uses shared application modules and independent
environment roots. Its eight [retired flat-root identities](azure-deployment.md#explicit-flat-root-identity-retirement)
remain readable as historical provenance, not aliases for new paths. Existing
files, state, and generation hashes remain untouched. Adding an environment
requires recorded independent-root provenance and safe existing module files;
legacy or unknown layouts need separately reviewed migration. Core context
updates cannot claim that this migration happened.

Major supported-stack releases apply to new scaffolds. Existing projects adopt
runtime, lock, Docker, provider, framework, and application changes through a
normal reviewed project change. Ordinary update and force cannot perform that
migration, and the existing `liftoff migrate` command remains a fresh-target
workflow for non-Liftoff sources.

For a generated Liftoff project that needs application-stack migration:

1. Preserve version-control history and run `liftoff assess --project . --json`.
2. Use `liftoff update --check` only for compatible Liftoff-owned metadata and
   integrations; it does not port project-owned application or infrastructure.
3. Inventory the active application bindings with
   `liftoff repair --inspect-layout --json`.
4. Implement the runtime/framework/source migration as a normal reviewed
   project change, or use the application-repair lane only when its exact
   registered recipe fits.
5. Run the real project checks. If files moved, complete the separately
   reviewed active-binding publication without rewriting generation history.
6. Re-run update, validation, assessment, and governed status/resume checks.

Changing only `liftoff.config.json`, rerunning init, or copying current starter
files does not migrate a generated application.

A project generated with `pattern: generic` follows the same ownership rule.
When its specialization becomes clear, migrate the project-owned routes,
orchestration, data, and infrastructure through a reviewed project change.
Changing the configuration to RAG, chatbot, or another pattern and running
`liftoff update` is intentionally rejected.

## Existing non-Liftoff application

Use the read-only in-place adoption preview when the application should remain
at its existing root:

```bash
liftoff assess --project ../legacy-app --json
liftoff adopt --project ../legacy-app --check
liftoff adopt ../legacy-app --type standard --api node --spec manual --agents none --governance none --json
```

The schema-1 preview observes one exact Git boundary or explicitly selected
non-Git root. When supported application binding evidence exists, it saves only
expiring review metadata outside the repository.
It does not run project scripts, install dependencies, access credentials or
network, write a manifest, move application files, change Git history, infer
deployment absence, or approve later work. Static planning retains observed
application bindings at their current paths, omits unobserved starter bindings,
and leaves protected infrastructure uninspected and planning-only. Its mapping
draft lists bounded source, build/test, Docker/Compose, CI, documentation and
import references for explicit review. A missing supported application-component
binding, destination conflict, unresolved custom mapping/reference, or
unsupported conversion remains an explicit blocker rather than triggering
starter replacement.

The registered `--approve-plan` and fingerprint-selected `--recover` surfaces
accept only a complete expiring publication plan produced after explicit
compatibility mapping, exact verification permission and a successful unchanged
receipt. File approval writes only the displayed absent managed-core/manifest
targets through the dedicated root-bound adoption transaction, with the final
manifest last. Recovery selects the same plan plus the observed transaction
digest, restores only attributable unchanged writes and preserves concurrent
edits. A missing manifest never authorizes a second adoption while the
authenticated journal remains. Existing Liftoff manifests route to
`update --check` and `repair --check` rather than re-adoption, except that
fingerprint-selected recovery may settle an already authenticated adoption
transaction.

The complete in-place journey is:

1. Assess the selected root without executing project code or contacting live
   providers unless the separate live mode is explicitly requested.
2. Preview adoption and review preserved bindings, exclusions, unresolved
   mappings, destinations, and deployment/state uncertainty.
3. Complete an explicit compatibility mapping. Semantic ambiguity is developer
   work; a skill may assist only by authoring review material outside the
   project.
4. Grant preparation, project-code, and declared-network permissions
   separately, then run the exact isolated verification plan.
5. Review and approve only the matching publication fingerprint. The
   transaction writes the listed absent managed-core files and manifest, with
   the manifest last; it does not rewrite application files.
6. If publication is interrupted, run only the reported
   `liftoff adopt --recover --approve-plan <fingerprint>` action. Do not start a
   second adoption because the manifest is absent.
7. Run `liftoff validate`, `liftoff doctor`, a fresh assessment, and applicable
   governance status/resume checks. Deployment and existing-state work remain
   separate planning-only scope.

Use migration when you want a fresh governed scaffold and a filtered source
copy:

```bash
liftoff migrate ../legacy-app --region eastus --agents copilot,claude --yes
```

Migration requires a new or empty sibling target, runs the same readiness and
conditional framework pipeline, including separate global OpenSpec profile authorization,
and leaves the source byte-for-byte unchanged. `--force` does not permit a
non-empty migration target.

Current generation also supports a framework-free migration:

```bash
liftoff migrate ../legacy-app --spec manual --agents none --governance none --yes
```

It writes a fresh v8 sibling, a filtered `migration/legacy/` copy, and an
unchecked `MIGRATION.md`. No source adoption or semantic equivalence is claimed.
Manual does not initialize a framework or change global profiles; existing
source files and modes remain unchanged. The original project is not an in-place
conversion target.

The scan reads dependency declarations rather than comments or example text.
Python setup/test configuration and non-workflow `.github` files remain
explicit inventory items; dynamic or malformed declarations produce review
diagnostics rather than invented stack defaults. Source configuration code is
never executed to discover dependencies.

Explicit workload, API-stack, and frontend choices control the target mapping.
For example, Go source selected for a Node target receives porting instructions,
not Go-only destination paths; a declined frontend remains a placement decision.

Complete the mapped work and run the backend tests, `liftoff validate`, and
`liftoff doctor` before deleting `migration/legacy/`. OpenSpec archival follows
the completed change; a Manual or Spec Kit migration checklist is finalized locally
without an invented archive command.

## Partial failure, recovery, and follow-up

| Operation | Preserved on partial failure | Supported recovery or continuation |
| --- | --- | --- |
| Adoption publication | Existing application bytes/modes/paths and any concurrent edits | Reuse the exact reported adoption fingerprint with `adopt --recover`; never infer authority from a missing manifest |
| Application repair | Verified effects that actually committed, plus immutable repair history | Use the reported repair recovery action; if a move committed, reuse the original application fingerprint to reconstruct only pending binding publication |
| Active-binding publication | Committed application move and original generation/adoption provenance | Approve or recover the separate binding fingerprint; do not replay the file move |
| Managed-core update | Original manifest/history and any committed successor state | Use fingerprint-selected `update --recover`; postcommit incompleteness resumes forward and never downgrades the active successor |
| Historical infrastructure repair | Source files, state/backend metadata, and concurrent destinations | Use `repair --recover` only for the authenticated local transaction. Existing or unknown deployment/state remains planning-only |

Recovery is attributable rollback or forward completion, not whole-directory
restore. Do not delete `.liftoff` journals, external preview records, state
files, or user-local receipts to make a command start over. After recovery,
re-run the operation's read-only check, then `liftoff validate`,
`liftoff doctor`, `liftoff assess --project <path> --json`, and applicable
governance status/resume checks before claiming completion.

Power Apps creation, maintenance, and migration are retired. Existing Power Apps
manifests are rejected without modifying or converting their application files.
