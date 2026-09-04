## Why

Fresh Liftoff projects currently rely on an underspecified agent prompt to
complete an incomplete bootstrap seed, invent an activation phase order,
configure credentials, and decide whether evidence is sufficient. Two projects
using the same policy and initial model consequently produced different active
changes, credential contracts, task ordering, and completion state.

## What Changes

- Add one generated `/liftoff-setup` skill as the primary post-`liftoff init`
  entry point, with `/liftoff-repository-governance` as a governance-only alias and
  no model-selection prompt or pinned model.
- Add a deterministic Liftoff governance activation engine with machine-readable
  phase definitions, dependencies, allowed mutations, evidence requirements,
  approval gates, blocked states, resumption, and verification.
- Track an independent activation-contract version, graph/state/evidence schema
  versions, exact phase-graph hash, policy version, and creating Liftoff release
  so long-running activation can be reconciled without coupling every change to
  one version number.
- Make generated OpenSpec bootstrap changes complete and strict-valid by
  including their declared capability specification and consistent baseline
  verification tasks.
- Require `/liftoff-setup` to complete, sync, and archive the generated
  bootstrap change before initial commit/push and governance Phase 0.
- Generate exactly one active governance change, resume an existing one, and
  refuse ambiguous or stale active-change state unless an explicit supersession
  record resolves it.
- Standardize runner-preflight credential enrollment: deterministic PAT display
  name, fixed repository secret, selected-repository scope, permissions,
  30-day lifetime, rotation metadata, allowed jobs, non-forwarding, masked
  input, and secret-leak detection. An existing approved GitHub App may be
  consumed, but Liftoff does not install one.
- Consolidate questions into explicit repository, credential, infrastructure
  cost/exception, enforcement, destructive-operation, and external-blocker
  gates. Deterministic retries inside an approved envelope do not ask again.
- Make task completion a projection of validated phase evidence rather than an
  independent source of truth, and reject contradictory, stale, missing, or
  activation-identity-incompatible evidence.
- Define compatibility and bump rules: normative governance changes advance the
  policy version, phase/gate semantics advance the activation contract, JSON
  shape changes advance their schema, and wrapper-only changes use managed
  content hashes.
- Update the root and generated READMEs with the exact
  `liftoff init` -> `/liftoff-setup` kickstart and normal development/release
  lifecycle.

## Capabilities

### New Capabilities

- `liftoff-governance-activation-engine`: Deterministic setup commands, phase
  graph, execution state, approval envelopes, evidence validation, credentials,
  resumption, and completion semantics.

### Modified Capabilities

- `liftoff-infrastructure-governance`: Generate a complete, strict-valid
  workload bootstrap change with an unambiguous local-only completion contract.
- `liftoff-project-scaffold`: Generate setup skills, managed phase definitions,
  complete seed artifacts, and kickstart documentation across supported
  platforms and agents.
- `liftoff-repository-governance-profile`: Replace model-inferred activation
  ordering and credential choices with the deterministic engine while
  preserving read-only Phase 0 and explicit approval boundaries.
- `liftoff-project-update`: Reconcile managed phase definitions and require
  active governance changes to acknowledge relevant activation-identity updates
  without rewriting user-owned execution evidence.
- `liftoff-cli-workflow`: Expose strict project-aware governance status, plan,
  apply-next, resume, and verify commands used by the generated skill.
- `liftoff-user-documentation`: Document the single-command kickstart,
  baseline-bootstrap boundary, question budget, credential enrollment, phase
  lifecycle, resumption, and ordinary development/release flow.

## Impact

This affects CLI parsing and commands, repository-governance rendering,
managed-core artifact identity, OpenSpec seed templates, generated Copilot and
Claude skills/commands, a new manifest schema version, manifest and update
reconciliation, phase/evidence schemas, credential guidance, completion output,
public and generated documentation, fixtures, snapshots, package contents, and
cross-platform tests. The change does not make `liftoff init` mutate GitHub or
Azure and does not let a model bypass explicit consent or phase evidence.
