## Why

Liftoff 0.12.1 detects legacy OpenTofu layouts but does not expose the project repair coordinator promised by its specifications. Developers cannot get past local baseline verification, and the previously archived task checklist incorrectly implied that this public capability was complete.

## What Changes

- Add executable `liftoff repair` with project-bound checks, exact-plan approval, bounded discovery, isolated validation, history-preserving file transactions, and recovery.
- Reorganize supported existing Azure OpenTofu roots into `modules/application` and the project's selected `environments/<id>` roots. Preserve existing resource definitions, variable/output semantics, compatible provider constraints, locks, and environment values rather than regenerate an application.
- Inspect actual source files and recognize safe partial moves. Reject ambiguous customizations with specific reasons instead of overwriting them or fabricating manifest provenance.
- Require authoritative undeployed eligibility before local transformation. Ordinary checks make no cloud calls; explicitly requested, time-bounded Azure metadata checks use an exact subscription and existing authentication. Missing state files alone never establish safety.
- Keep deployed/unknown state plan-only in this public local-repair lane. Describe the required protected stateful migration rather than dispatching an unbound internal state service or recommending manual state commands.
- Connect update, local verification, and native setup guidance to the real repair command. Explain `seed-verified` as local baseline verification, not a change developers must manually complete.
- Register repaired current provenance only at commit, preserve original provenance separately, and keep approval for repair distinct from managed-core update or activation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-project-repair`: Concrete supported public local infrastructure repair recipe, command, eligibility, transaction, recovery, and truthful result contract.
- `liftoff-project-update`: Project-targeted repair handoff when local baseline revalidation encounters legacy infrastructure.
- `liftoff-cli-workflow`: Registered repair command and native setup orchestration through preview, approval, repair, and resumed local verification.

## Impact

CLI definitions/dispatch/help, project repair application and semantic HCL adapter, shared reviewed transaction and external receipt primitives, active infrastructure inventory, update/governance diagnostics, native integration templates, documentation, and installed command tests. A packaged semantic HCL parser may be required.

This change does not authorize changes to downstream workspaces, real cloud resources, credentials, Git publication, or live state. It does not claim arbitrary application modernization, agent installation, or newly qualified stateful execution. Existing internal stateful services remain intact; unsupported public lanes are explicit limitations, not completed features.
