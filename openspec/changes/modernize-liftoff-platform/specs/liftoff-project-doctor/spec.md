## MODIFIED Requirements

### Requirement: Doctor reports version freshness and managed-core drift
Doctor SHALL report running executable/installation owner and bounded authoritative release/channel availability independently of project discovery. npm retains canonical target and scoped-mirror parity; native installs use verified release and owning-channel metadata. Project checks SHALL report managed-core drift through the shared layout/plugin-aware expectation and identify separate identity migration/revalidation. Doctor SHALL not write receipts, update packages, compare application bytes with fresh templates as overwrite debt or imply CLI upgrade changes projects. Unavailable freshness remains unknown without erasing local diagnostics.

#### Scenario: Freshness check runs outside a project
- **WHEN** doctor runs with usable release metadata
- **THEN** it identifies running version/owner and available upstream/channel versions

#### Scenario: Authoritative registry is newer than the running CLI
- **WHEN** a newer validated release is available
- **THEN** doctor recommends the supported owner-aware check/apply or explicit manual handoff
- **AND** npm-only remedies are not given for cask/WinGet ownership

#### Scenario: Configured managed mirror is stale
- **WHEN** npm delivery lacks the canonical target
- **THEN** doctor reports mirror synchronization without changing configuration

#### Scenario: Drift warning line
- **WHEN** four managed differences exist
- **THEN** one count-based warning identifies update check without creating its receipt

#### Scenario: Production files differ from templates
- **WHEN** only project-owned template bytes differ
- **THEN** no managed-core drift is fabricated

#### Scenario: Offline doctor preserves local version diagnostics
- **WHEN** release metadata is unavailable
- **THEN** local checks and running identity remain visible and freshness is unobserved, not falsely current

### Requirement: Doctor uses canonical freshness and bounded subprocess observations
Doctor SHALL use the same verified owner-specific release authority as upgrade and SHALL not let undocumented registry environment overrides substitute another authority. npm target and delivery checks remain separate. External diagnostic probes SHALL be finite, honor injected test dependencies, and report actual timeout or unavailable observations without installation or project writes.

#### Scenario: An environment override names another registry
- **WHEN** LIFTOFF_REGISTRY points elsewhere
- **THEN** it cannot replace the lane's verified release authority

#### Scenario: An external probe hangs
- **WHEN** its deadline expires
- **THEN** doctor reports the timeout rather than a passing observation

#### Scenario: A test injects a release lookup
- **WHEN** an explicit test dependency is supplied
- **THEN** it is used without contacting a real registry

## ADDED Requirements

### Requirement: Doctor respects Manual and explicit plugin layout selections
Doctor SHALL use current validated workflow/profile/plugin/layout bindings shared with assessment/update/repair. Manual's absent framework and empty agent list SHALL be valid intentional states, not legacy failures. The embedded CLI runtime SHALL not substitute for required external project tools. Existing-deployment state migration SHALL be reported as deferred planning, not an executable remedy.

#### Scenario: Manual CLI-only project is inspected
- **WHEN** applicable local project tools are ready
- **THEN** absent OpenSpec, Spec Kit and agents do not fail readiness or cause installs

#### Scenario: Compatible noncanonical root is inspected on Windows
- **WHEN** a project binding selects a component path with spaces on Windows, macOS or Linux
- **THEN** checks use that exact native path and reject unsafe aliases rather than assuming a fresh template location
