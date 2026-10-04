# Existing repositories

Liftoff chooses its target from the current directory and Git worktree
discovery before it stages any output.

## Exact Git root: initialize in place

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
2. Verifies or separately configures the required global OpenSpec profile.
3. Runs the official OpenSpec or Spec Kit initializer in staging.
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
liftoff validate
liftoff governance status --json
liftoff update --check
liftoff update
```

For project-file layout repair, use `liftoff repair --check` for inspection or
`liftoff repair` in a genuine terminal to review an eligible exact plan and
answer Yes/No (default No), without copying a fingerprint. Unknown/deployed
infrastructure remains protected. For broader application paths, the selected
native `/liftoff-repair` integration (Codex: `$liftoff-repair`) inventories the
real project and stages a reviewed patch outside it. Verification/project-code,
declared network and file-transaction permissions are separate; see
[repair modes](cli-reference.md#repair-modes) and
[application repair](application-repair.md). This is not a fresh scaffold over
the application, and `liftoff migrate` remains a separate adoption workflow.

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

Liftoff's own repair integrations instead use exact managed-core update
identities. A supported older manifest can acquire the selected-agent repair
files through the reviewed update above, including when governance is disabled.
Unowned custom integrations and neighboring skills are not overwritten by force.

Supported historical projects preview a manifest-v8 managed-core successor.
After a matching check and explicit approval, update adopts safe policy,
context, guide, phase graph, compatibility metadata, credential-policy schema
and selected-agent setup integrations. An omitted governance setting retains
the single-maintainer default only when the historical profile is unspecified;
recorded opt-out remains disabled. Configuration is never rewritten to
materialize a default. A required unowned conflict blocks the complete successor
rather than claiming a partially installed v8 contract; force cannot take
ownership of that destination. Resolve the conflict and run a fresh check.
Profile changes are a separate operation. No update mode runs an agent or
activates GitHub settings.

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

A project generated with `pattern: generic` follows the same ownership rule.
When its specialization becomes clear, migrate the project-owned routes,
orchestration, data, and infrastructure through a reviewed project change.
Changing the configuration to RAG, chatbot, or another pattern and running
`liftoff update` is intentionally rejected.

## Existing non-Liftoff application

Use migration when you want a fresh governed scaffold and a filtered source
copy:

```bash
liftoff migrate ../legacy-app --region eastus --agents copilot,claude --yes
```

Migration requires a new or empty sibling target, runs the same readiness and
framework pipeline, including separate global OpenSpec profile authorization,
and leaves the source byte-for-byte unchanged. `--force` does not permit a
non-empty migration target.

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
the completed change; a Spec Kit migration checklist is finalized locally
without an invented archive command.

Power Apps creation, maintenance, and migration are retired. Existing Power Apps
manifests are rejected without modifying or converting their application files.
