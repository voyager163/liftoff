## ADDED Requirements

### Requirement: Documentation explains Azure provider readiness
The governance documentation SHALL explain how Phase 0 derives the minimal
resource-provider namespace set, distinguishes AzureRM automatic registration
from explicit registration, proves terminal readiness, orders dependent
resources, validates intentional subscription features and service-tag
semantics, and retains successful provider registrations during teardown.

#### Scenario: Developer disables AzureRM auto-registration
- **WHEN** documentation shows or discusses `resource_provider_registrations = "none"`
- **THEN** it requires explicit registration and `Registered` readback for every namespace used by the approved plan
- **AND** identifies `Microsoft.Network` and `GitHub.Network` as required by the hosted-runner network

#### Scenario: Registration is incomplete
- **WHEN** documentation describes an absent, unauthorized, pending, or failed provider registration
- **THEN** it keeps dependent provisioning blocked and requires a revised no-apply plan before retry

#### Scenario: Infrastructure is torn down
- **WHEN** documentation describes repository resource removal
- **THEN** it preserves successful provider registrations as subscription capabilities
- **AND** does not recommend unregistering them automatically

#### Scenario: Azure reports an unrelated feature gate
- **WHEN** documentation discusses `SubscriptionNotRegisteredForFeature`
- **THEN** it requires proof that the approved resource intentionally uses the feature before registration
- **AND** directs unintended feature requests to resource, provider, or API correction

#### Scenario: Documentation configures Azure platform DNS
- **WHEN** documentation discusses the `AzurePlatformDNS` service tag
- **THEN** it identifies the tag as deny-only for disabling default platform DNS
- **AND** directs custom DNS allows to exact resolver addresses instead
