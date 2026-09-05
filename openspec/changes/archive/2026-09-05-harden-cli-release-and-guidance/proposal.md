## Why

The whole-CLI audit found bounded correctness gaps in release identity checks,
project helper commands, doctor probes, and user-facing preservation claims.
The user approved fixing these in the patch while keeping larger activation,
GenAI, deployment, and registry-delivery redesigns as separate follow-up work.

## What Changes

- Reject noncanonical package names and invalid versions before release work,
  and limit the historical version-command exception to release `0.3.3`.
- Make project-scoped infrastructure recipes use the generated module directory
  and an environment actually selected by the project.
- Keep doctor freshness anchored to canonical npm and bound external probes.
- Limit dependency-failure preservation claims to the metadata actually
  protected by the dependency transaction.
- Make generated infrastructure guidance honor governance approval boundaries
  and selected environments without changing generated infrastructure behavior.
- Make generated OpenSpec migration plans strict-valid, and prevent managed
  update from silently changing project identity/location or disabling an
  existing activation state.
- Document the broader audit's implementation gaps and incremental architecture
  plan rather than advertising them as repaired by this patch.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-npm-distribution`: Canonical release identity and narrowly scoped
  historical verification compatibility.
- `liftoff-cli-workflow`: Project-aware infrastructure recipes and truthful
  dependency-failure messages.
- `liftoff-project-doctor`: Canonical freshness and bounded external probes.
- `liftoff-user-documentation`: Environment-correct, approval-aware generated
  guidance and explicit deferred capability limits.
- `liftoff-project-migration`: Complete, strict-valid OpenSpec migration
  artifacts that do not block subsequent bootstrap validation.
- `liftoff-project-update`: Fail-closed project identity and active-governance
  profile changes outside ordinary managed maintenance.

## Impact

Changes are limited to release verification, helper/diagnostic orchestration,
generated documentation, and regression coverage. There is no provider
provisioning, global installation, policy/state schema migration, or broad
architecture refactor. The assessment and bootstrap fixes remain separate
changes included in the same authorized patch release.
