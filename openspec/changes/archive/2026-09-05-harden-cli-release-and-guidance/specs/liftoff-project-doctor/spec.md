## ADDED Requirements

### Requirement: Doctor uses canonical freshness and bounded subprocess observations
Doctor's default Liftoff freshness lookup SHALL use canonical npm independently
of undocumented registry environment overrides. Configured-registry delivery
checks SHALL remain separate. Default external diagnostic probes SHALL have a
finite time bound, preserve existing injected test interfaces, and report
timeouts explicitly without installing tools or changing project state.

#### Scenario: An environment override names another registry
- **WHEN** `LIFTOFF_REGISTRY` is set while default doctor freshness runs
- **THEN** canonical release identity still comes from canonical npm
- **AND** the override cannot make an older or substituted registry authoritative

#### Scenario: An external probe hangs
- **WHEN** a diagnostic command exceeds its time bound
- **THEN** doctor reports a timeout or unavailable observation and terminates the wait
- **AND** does not claim the probe passed

#### Scenario: A test injects a release lookup
- **WHEN** a deterministic diagnostic test supplies an explicit lookup dependency
- **THEN** doctor uses that injected dependency without contacting a real registry
