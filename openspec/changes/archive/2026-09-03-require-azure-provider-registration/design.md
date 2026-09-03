## Context

See `proposal.md` for motivation. Liftoff's general Azure template leaves
AzureRM automatic registration enabled, but downstream governance roots may
disable it to avoid broad subscription mutation. Policy v4 requires
`GitHub.Network` behavior but does not require the approved plan to inventory
all provider namespaces. A runner bootstrap therefore registered
`GitHub.Network` while omitting `Microsoft.Network`, and failed after creating
only an empty resource group.

## Goals / Non-Goals

**Goals:**

- Prevent resource creation from starting before every required Azure namespace
  is ready.
- Keep explicit registration minimal and derived from the approved plan.
- Support both AzureRM-managed automatic registration and deliberate
  no-auto-registration configurations.
- Preserve registration safely during repository teardown.

**Non-Goals:**

- Disable automatic registration in Liftoff's general generated Azure template.
- Register every Azure namespace preemptively.
- Treat provider registration as a repository-exclusive resource.
- Hide registration permission or latency failures behind retries or partial
  success.

## Decisions

### Derive namespaces from approved resource types

Phase 0 maps each planned Azure resource type to its namespace prefix and
deduplicates the result. The inventory includes bootstrap, state, networking,
identity, monitoring, and applicable application resources. A hosted-runner
network always includes `Microsoft.Network` and `GitHub.Network`; state or other
resources add their own namespaces.

A static list containing only the two namespaces was rejected because later
resources could repeat the same failure. Registering a broad default list was
rejected because it creates unnecessary subscription-level mutation.

### Make registration mode explicit

The plan records the AzureRM registration mode and relevant subscription
permission:

- When automatic registration is enabled and sufficient, AzureRM may manage
  registration and explicit resources are not duplicated.
- When `resource_provider_registrations = "none"` or equivalent is selected,
  every missing planned namespace is represented by explicit registration.

The selected mode is part of the reviewed plan rather than inferred after a
failed apply.

### Separate provider readiness from billable provisioning

Provider inventory and registration form a `provider-ready` transition before
`bootstrap-local`, remote state, runner networking, or application resources.
Already registered namespaces are no-ops. Missing namespaces are registered,
then polled or read back until terminal `Registered`.

```text
approved namespace inventory
          |
          v
registration mode + permission
          |
          v
all required namespaces Registered
          |
          v
provider-ready
          |
          v
dependent resource planning/apply
```

Absent permission, `NotRegistered`, `Registering`, `Unregistering`, or failure
keeps dependent work blocked. A resource group created before failure is
reported as partial evidence, never as readiness.

Relying on implicit dependency discovery was rejected because OpenTofu can
attempt resource creation before an omitted provider is registered.

### Order each resource after its namespace

When explicit registrations are used, each planned resource has a direct or
transitive dependency on the registration for its namespace. Registration
readback is included in saved-plan evidence so a retry cannot silently use a
different prerequisite state.

For the runner bootstrap, all VNet, subnet, private DNS, private endpoint,
firewall, public IP, NAT, NSG, route, and peering resources depend on
`Microsoft.Network`; `GitHub.Network/networkSettings` also depends on
`GitHub.Network`.

### Retain subscription registrations during teardown

A provider registration is a subscription capability and may be used by
resources outside the repository. Explicit registration declarations therefore
prevent automatic destruction or are removed from repository ownership without
issuing unregister operations. Teardown deletes only repository-owned resources.

Automatically unregistering after the last known repository resource was
rejected because the repository cannot prove there are no external consumers.

### Register subscription features only for intentional capabilities

`SubscriptionNotRegisteredForFeature` is not automatic permission to register
the named feature. The plan compares the feature with the intended resource
properties. If the design does not use that capability, the resource shape,
provider behavior, or API version is corrected and a new no-apply plan is
reviewed.

Ordinary Firewall and NAT Standard public IPs do not require BYOIP. If they
request `Microsoft.Network/AllowBringYourOwnPublicIpAddress` without a custom IP
prefix, creation-time properties that accidentally trigger BYOIP are removed.
If the pinned AzureRM provider still requests it, a reviewed supported AzAPI
Public IP shape without BYOIP or IP tags is used. Registering the BYOIP feature
was rejected because the intended design does not bring custom address space.

### Validate service-tag semantics before apply

Each service-tag rule is checked against its supported direction, target, and
action. `AzurePlatformDNS` is a special outbound tag for denying the default
Azure DNS service; Azure does not accept it in an Allow rule. The plan omits an
allow rule when platform DNS remains enabled. When custom resolvers replace
platform DNS, explicit TCP and UDP port 53 rules target the resolver addresses.

Assuming every outbound service tag supports Allow was rejected because Azure's
special platform tags intentionally expose deny-only controls.

### Advance the managed policy contract

The canonical policy version advances from 4 to 5. Validation requires namespace
inventory, conditional explicit registration, both runner-network namespaces,
terminal readback, dependency ordering, intentional subscription features,
valid service-tag semantics, and retained subscription capability. Unsafe
wording that allows provisioning while registration is pending, registers BYOIP
for ordinary public IPs, allows `AzurePlatformDNS`, or unregisters providers
during teardown is rejected.

## Risks / Trade-offs

- **[Registration can take time]** -> Represent pending state explicitly and
  wait for terminal readback before planning dependent resources.
- **[The operator lacks register permission]** -> Fail before billable resource
  creation and report the exact namespace and subscription scope.
- **[Namespace derivation misses a resource]** -> Derive from every approved
  resource type and test the hosted-runner resource family explicitly.
- **[Registration outlives repository resources]** -> Treat it as a retained
  subscription capability and record that ownership boundary.
- **[AzureRM behavior changes]** -> Record the selected registration mode in the
  plan rather than assuming provider defaults.
- **[A provider/API shape requests an unrelated feature]** -> Correct the shape
  and regenerate the plan instead of broadening subscription capabilities.
- **[A special service tag rejects a generic rule]** -> Validate documented
  direction and action semantics before apply.

## Migration Plan

1. Advance the canonical policy and validation contract to version 5.
2. Update generated metadata, hashes, documentation, tests, and snapshots.
3. Validate the OpenSpec change and complete package checks.
4. Existing policy-v4 projects review managed-core drift and regenerate any
   runner-network plan before retrying a failed bootstrap.
5. Roll back by restoring policy version 4 and its validator, tests, hashes, and
   documentation together; no live provider registration is changed by Liftoff.
