## ADDED Requirements

### Requirement: Azure resource providers are ready before dependent provisioning
The canonical profile SHALL derive the minimal Azure resource-provider
namespace set from the approved resource plan and inspect the configured
AzureRM registration mode. When automatic registration is disabled or cannot
cover the plan, every missing namespace MUST be registered explicitly and read
back as `Registered` before any dependent or billable resource is created.

#### Scenario: Automatic registration is available
- **WHEN** the approved AzureRM configuration enables automatic registration with sufficient subscription permission for every planned namespace
- **THEN** the plan records that mode and does not add duplicate explicit registration resources

#### Scenario: Automatic registration is disabled
- **WHEN** the approved AzureRM configuration disables automatic resource-provider registration
- **THEN** the plan declares explicit registration for every missing namespace required by its resource types
- **AND** it does not register unrelated providers speculatively

#### Scenario: Hosted-runner network is planned
- **WHEN** the approved plan includes Azure VNet-injected GitHub-hosted runner networking
- **THEN** the required namespace inventory includes at least `Microsoft.Network` and `GitHub.Network`
- **AND** it includes any additional namespace used by the approved state, identity, monitoring, or application resources

#### Scenario: Provider registration is already complete
- **WHEN** live subscription readback reports a required namespace as `Registered`
- **THEN** registration is a no-op and dependent resources may reference the verified capability

#### Scenario: Provider registration is not ready
- **WHEN** a required namespace is absent, unauthorized, registering, unregistering, or failed
- **THEN** dependent and billable resource creation remains blocked
- **AND** the state is reported without treating an empty resource group or partial apply as readiness

#### Scenario: Explicit registration completes
- **WHEN** an explicitly managed provider registration reaches terminal `Registered` state
- **THEN** every resource using that namespace is ordered after the registration evidence

#### Scenario: Repository infrastructure is removed
- **WHEN** the approved repository teardown deletes its network or application resources
- **THEN** successful provider registrations remain registered as subscription capabilities
- **AND** teardown does not unregister a namespace that may be shared by other resources

### Requirement: Azure subscription features and service tags match intended capabilities
The canonical profile SHALL treat subscription features and network service
tags as explicit platform contracts. A feature MUST be registered only when the
approved resource design intentionally uses it. Every service-tag rule MUST use
an action and direction supported by that tag.

#### Scenario: Unrelated feature registration is requested
- **WHEN** an ordinary resource returns `SubscriptionNotRegisteredForFeature` for a capability the approved design does not use
- **THEN** the plan remains blocked and corrects the resource properties, provider behavior, or API shape
- **AND** it does not register the unrelated feature as a retry shortcut

#### Scenario: Ordinary Standard public IP requires BYOIP
- **WHEN** a Firewall or NAT Standard public IP unexpectedly requests `Microsoft.Network/AllowBringYourOwnPublicIpAddress` without a custom IP prefix
- **THEN** the plan removes accidental BYOIP-triggering properties or uses a supported API shape that does not request BYOIP
- **AND** the feature remains unregistered

#### Scenario: Azure platform DNS is used
- **WHEN** an NSG plan references the `AzurePlatformDNS` service tag
- **THEN** it uses the tag only for an intentional Deny that disables default platform DNS
- **AND** it does not create an Allow rule for that tag

#### Scenario: Custom DNS is required
- **WHEN** the approved topology replaces Azure platform DNS with custom resolvers
- **THEN** NSG rules allow TCP and UDP port 53 to the exact resolver addresses
- **AND** DNS reachability is verified before dependent provisioning
