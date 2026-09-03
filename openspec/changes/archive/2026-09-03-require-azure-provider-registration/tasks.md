## 1. Define provider readiness

- [x] 1.1 Advance the canonical governance policy to version 5 and add Phase 0 namespace inventory and registration-mode evidence; verify generated metadata agrees
- [x] 1.2 Require minimal explicit registration when auto-registration is disabled, including `Microsoft.Network` and `GitHub.Network` for runner networking; verify unrelated namespaces are prohibited
- [x] 1.3 Require permission and terminal `Registered` readback before dependent or billable resources; verify partial resource creation remains failed
- [x] 1.4 Define dependency ordering and preserve successful provider registrations during teardown; verify no repository destroy path unregisters subscription capabilities
- [x] 1.5 Require subscription-feature registration to match intentional capabilities and reject automatic BYOIP registration for ordinary Standard public IPs
- [x] 1.6 Require service-tag action and direction validation, including deny-only `AzurePlatformDNS` and explicit custom-resolver DNS rules

## 2. Enforce and document the contract

- [x] 2.1 Update validator required and forbidden fragments, policy hash, manifest expectations, and generated snapshots to version 5
- [x] 2.2 Add focused tests for automatic mode, explicit mode, minimal inventory, existing registration, pending/failure states, resource ordering, feature intent, service-tag semantics, and teardown retention
- [x] 2.3 Update repository-governance, prerequisite, safety, troubleshooting, and existing-project documentation; verify disabled auto-registration guidance names both runner namespaces
- [x] 2.4 Preserve historical policy-version migration through version 5; verify older manifests still preview managed-core drift

## 3. Validate the change

- [x] 3.1 Run strict OpenSpec validation and focused governance, manifest, update, documentation, catalog, planner, and contract tests
- [x] 3.2 Regenerate versioned presentation snapshots and verify cross-platform output
- [x] 3.3 Run `npm run check`, package smoke, release identity, and package inspection
