## Why

Policy v4 permits a minimum Azure runner-network bootstrap but does not require
the plan to inventory resource-provider namespaces when AzureRM automatic
registration is disabled. A reviewed bootstrap therefore failed after creating
only an empty resource group because `GitHub.Network` was registered while the
required `Microsoft.Network` namespace was omitted.

## What Changes

- Require Phase 0 to derive the minimal Azure resource-provider namespace set
  from every planned resource type and inspect live registration state.
- When provider auto-registration is disabled or insufficient, require explicit
  registration of each missing namespace before dependent resources are
  planned or applied.
- Require registration permission, terminal `Registered` readback, and explicit
  dependency ordering; unresolved, registering, failed, or unauthorized states
  block billable resource creation.
- Require subscription features to match intentional resource capabilities; an
  unrelated feature error triggers resource/API correction, not automatic
  feature registration.
- Require `Microsoft.Network` and `GitHub.Network` for the hosted-runner
  networking bootstrap while prohibiting unrelated speculative registrations.
- Require network plans to validate service-tag direction and action, including
  the deny-only `AzurePlatformDNS` semantics.
- Treat successful subscription registrations as shared capabilities that are
  retained during repository teardown rather than automatically unregistered.
- Advance the canonical governance policy version and update validation,
  documentation, tests, hashes, and snapshots without changing Liftoff's
  local-only execution boundary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-repository-governance-profile`: Define provider inventory,
  conditional explicit registration, readiness evidence, dependency ordering,
  and teardown ownership for Azure governance infrastructure.
- `liftoff-user-documentation`: Explain auto-registration modes, the minimal
  namespace contract, failure handling, and retained subscription capability.

## Impact

The canonical `single-maintainer-gitflow` policy, policy version and validator,
generated governance metadata, managed-core hashes and snapshots,
repository-governance documentation, manifest expectations, and focused tests
are affected. General generated Azure templates may continue using AzureRM's
normal automatic registration; the new rule governs plans that disable or
cannot rely on it.
