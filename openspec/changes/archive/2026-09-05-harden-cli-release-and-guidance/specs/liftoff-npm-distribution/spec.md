## ADDED Requirements

### Requirement: Release identity is canonical before publication
Release identity validation SHALL require the canonical Liftoff package name
and a valid npm semantic version in addition to agreement between package,
lockfile, installed package, and release tag metadata. A consistently renamed
package SHALL fail before publication.

#### Scenario: All metadata uses the wrong package name
- **WHEN** package and lock metadata agree on a noncanonical name
- **THEN** release identity validation fails rather than accepting internal consistency

#### Scenario: Version is not valid SemVer
- **WHEN** release metadata contains an invalid or noncanonical semantic version
- **THEN** the release gate fails before publication

### Requirement: Historical version-command compatibility cannot exempt modern releases
The published-package verifier SHALL allow its legacy version-command exception
only for the historical immutable `0.3.3` release. Other release targets SHALL
not bypass installed `--version` verification through that option.

#### Scenario: Modern target requests a legacy exception
- **WHEN** a release other than `0.3.3` requests legacy version-command compatibility
- **THEN** verification rejects the request before installing the target

#### Scenario: Historical target needs compatibility
- **WHEN** explicit verification targets the supported historical `0.3.3` release
- **THEN** only the documented version-command exception is permitted
- **AND** package identity and the other verification requirements remain enforced
