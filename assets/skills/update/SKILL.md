---
name: liftoff-update
description: "Reconcile managed-core template artifacts with safe drift detection and guarded transactions."
---

# Liftoff Managed Update Workflow

## Capability Negotiation

```bash
liftoff capabilities --json
```

Require `project-update`, Project Evolution, public envelope schema 1 and
UNCHANGED update report schema 3. A newer installed executable is not project
update authority. Missing implementation, prerequisites or qualification must
not trigger direct edits or guessed flags.

## Review Exact Managed Effects

```bash
liftoff update --project ./my-app --check --json
```

Check preserves project bytes and explicitly saves an external preview receipt;
that receipt is not approval. Review normal and eligible forced variants, exact
managed-core changes, source/destination identities, current bytes/modes,
registered retirements, manifest/provenance effects, and any separately declared
local activation migration/revalidation.

Project-owned source, dependencies, configuration, infrastructure, framework and
seed content do not become replaceable merely because templates changed. Only
explicit separately authorized provisioning/migration effects may extend the
ordinary core inventory. Preserve original provenance and intentionally absent
application files. Unowned collisions remain unowned even under force.

## Genuine Operation-Specific Approval

```bash
liftoff update --project ./my-app
```

The matching immutable plan is displayed before a genuine input/stderr TTY
Yes/No decision, default No. No manual hash entry. Autopilot, generic Yes, piped
answers, model prose and broad modernization intent are not consent.

Machine execution uses the exact returned normal or eligible forced plan through
`--approve-plan`; force selects its separately reviewed eligible variant and is
not a bypass. Do not combine check with approval/force or reuse another command's
fingerprint. Changed inputs after review require a new plan under the cooperating
lock. Pending transactions/private workspaces block conflicting writers.

## Verify and Recover the Actual Scope

Retain schema-3 outcome fields and context-bound `nextActions`. Distinguish
committed metadata/files from incomplete revalidation, external publication or
provider readiness. A nonzero or partial result cannot become success because
some files exist. Preserve newer bytes and supported historical serializers;
never rewrite old receipts, remove unowned parents, or blindly restore backups.

Current native setup/assessment/repair paths and logical identities remain valid.
Same-path content maintenance is not an invented transport move. Only explicit
registered migrations/retirements can change attributable entries, under their
own exact plan and actual readback. CLI upgrade, skill installation, application
repair, and activation remain distinct operations.
