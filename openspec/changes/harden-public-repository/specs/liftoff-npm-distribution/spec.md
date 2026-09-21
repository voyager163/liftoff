## ADDED Requirements

### Requirement: Publication consumes exact qualified package bytes
The release process SHALL extend the existing npm release coordinator and preserve all current npm identity, install, dist-tag, trusted-publication and canonical verification contracts. It SHALL build and pack from an explicitly selected protected `main` commit, qualify the exact tarball and packaged contents, and publish those same digest-bound bytes without an implicit repack. Functional checks, actual current security verdicts under adopted policy, inventory completeness and exception validity SHALL pass before publication. Applicable secrets assessment SHALL have complete declared coverage and sanitized disposition/remediation evidence; untriaged detections or confirmed unremediated exposures SHALL NOT be waived by vulnerability exception windows. Policy-maintenance admission SHALL NOT be publication evidence; a new release assessment after adoption SHALL satisfy the full qualification contract.

#### Scenario: Publish a qualified npm release
- **WHEN** a release has a consistent package/lock/tag/installed version and complete qualification for its selected protected source
- **THEN** npm receives the exact tarball inspected, installed and assessed by that release attempt
- **AND** canonical post-publication verification checks its integrity as well as version, dist-tag and installed behavior

#### Scenario: Artifact changes after qualification
- **WHEN** the tarball digest, source, inventory, policy or expected asset set differs from qualified evidence
- **THEN** publication fails before uploading the replacement bytes

#### Scenario: Release source has unresolved secret exposure
- **WHEN** required secrets coverage is incomplete or the selected release scope has an untriaged detection or confirmed unremediated exposure
- **THEN** publication remains blocked even if provenance, package tests and dependency exceptions are valid
- **AND** the result identifies only sanitized finding/scope metadata without exposing credential values or triggering credential rotation

#### Scenario: Manual run selects an arbitrary ref
- **WHEN** manual input or a tag push names an unqualified or non-approved source revision
- **THEN** it cannot authorize publication
- **AND** a secret-free dry-run remains distinct from real publication

#### Scenario: Maintenance admission is supplied as qualification
- **WHEN** a release receives a passing policy-maintenance admission result instead of actual current adopted-policy finding verdicts
- **THEN** publication is blocked
- **AND** the release must freshly assess its exact source and artifacts after any policy adoption

### Requirement: Distributed documentation preserves community navigation
The qualified npm artifact SHALL contain README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, existing developer/user guides and every declared local document or asset needed by their public navigation. Documentation qualification SHALL verify explicit expected files, relative targets and declared section anchors in the actual extracted tarball as well as the source checkout, using platform-native resolution on Windows, macOS and Linux. Missing files, broken navigation or mismatched reporting destinations SHALL fail acceptance even when checkout-only checks pass. Moving maintainer, repair or migration material SHALL preserve its safety/compatibility content and reachable canonical destination; a larger package allowlist alone SHALL NOT establish successful navigation.

#### Scenario: README links a community file omitted from the package
- **WHEN** the extracted candidate tarball lacks a locally linked CONTRIBUTING, SECURITY or CODE_OF_CONDUCT document
- **THEN** package documentation qualification fails before publication
- **AND** the file's presence in the checkout is not substituted for its absence from the artifact

#### Scenario: A guide or section is moved
- **WHEN** documentation is reorganized for shorter onboarding
- **THEN** declared links and section navigation resolve to the preserved authoritative guidance in the checkout and tarball
- **AND** removing a safety assertion from a test does not qualify loss of the underlying contract

#### Scenario: Read packaged documentation on Windows
- **WHEN** package navigation is verified in an extracted path containing spaces on Windows, macOS or Linux
- **THEN** platform-correct paths resolve the same logical documents/assets and declared anchors
- **AND** checks do not succeed by reading missing package content from the source checkout

### Requirement: Publisher authority is scoped and proven
Publication SHALL be isolated from unprivileged validation and SHALL use a verified publisher environment/ref policy with no required reviewers. OIDC, content-write and attestation permissions SHALL exist only in narrowly necessary jobs, and short-lived trusted npm publication SHALL remain the authentication path. The actual actor's tag authority and credential/ref reachability SHALL be proven before activation; a shared Actions App name alone SHALL NOT establish a workflow-specific identity. Infeasible scoping SHALL block activation rather than cause a broad PAT grant, silent App enrollment or administrator bypass.

#### Scenario: Fork or nonpublisher job requests publication
- **WHEN** a PR, arbitrary ref or nonpublisher workflow tries to enter the publisher boundary
- **THEN** it lacks the required credentials/environment/ref authority and cannot publish or create release tags

#### Scenario: Shared identity cannot be scoped
- **WHEN** qualification cannot prove that other jobs/events/refs lack equivalent creator authority
- **THEN** tag-control activation remains blocked with the limitation reported
- **AND** any dedicated repository-only identity enrollment requires separate explicit owner authorization

#### Scenario: Sole maintainer releases from the approved path
- **WHEN** the qualified protected source enters the verified publisher path
- **THEN** publication needs no second-person or environment approval
- **AND** trusted-publisher and environment readback match the intended repository, workflow and ref boundary

### Requirement: Release tag creation is distinct from mutation authority
Future `v*` tag creation SHALL be restricted to the verified scoped publisher through a creation-specific rule. Independent update and deletion restrictions SHALL have no bypass, including for the creator, and SHALL prevent tag movement/deletion. Tag creation and downstream publication SHALL be explicitly coordinated for the same source/version and SHALL NOT rely on a `GITHUB_TOKEN` tag push automatically triggering another workflow.

#### Scenario: Publisher creates a qualified release tag
- **WHEN** the verified publisher creates the selected version tag at the exact qualified source
- **THEN** the creation-specific exception permits only that creation
- **AND** subsequent required work is explicitly invoked or coordinated with exact revision identity

#### Scenario: Publisher or administrator tries to move or delete a tag
- **WHEN** an actor covered by the creation exception attempts a protected tag update or deletion
- **THEN** the independent no-bypass mutation restriction denies the operation

#### Scenario: Untrusted actor creates a version tag
- **WHEN** another actor attempts matching tag creation
- **THEN** creation is rejected
- **AND** no publication path accepts the unauthorized tag as qualification

### Requirement: Future GitHub Releases are complete before immutable publication
After separately authorized activation, future GitHub Releases SHALL be assembled as drafts with an explicit complete asset inventory, verified checksums, SBOMs, provenance and security evidence bound to the qualified source and artifacts before publication. The process SHALL verify immutable state and tag binding after publication and SHALL NOT describe historic mutable releases as retroactively protected. Release assets and local lookup/cleanup SHALL use explicit registered identities and cross-platform path handling.

#### Scenario: Draft lacks an expected asset
- **WHEN** draft inspection finds a missing, substituted or mismatched release asset
- **THEN** publication remains blocked until the exact expected inventory is complete

#### Scenario: Publish an immutable release
- **WHEN** all qualified assets are attached and verified
- **THEN** the coordinator publishes the draft and reads back immutable state, exact tag and asset identities
- **AND** it does not promise immutability of editable release title/notes or historic mutable releases

#### Scenario: Collect assets on a supported operating system
- **WHEN** asset inventory verification or cleanup runs on Windows, macOS or Linux
- **THEN** it resolves the same logical asset set with platform-native paths
- **AND** deletion or modification uses explicit registered lookup rather than filename patterns

### Requirement: Release evidence distinguishes security provenance and partial outcomes
Release evidence SHALL distinguish SBOM component inventory, vulnerability assessment, build provenance, artifact/release attestation and any applicable native signing/notarization. It SHALL identify scanner/database/tool versions, source and artifact digests, assessment time and exceptions without claiming that provenance proves secure bytes or SLSA L3. Partial npm/GitHub publication failure SHALL be reported precisely; retries SHALL preserve existing immutable bytes and identity rather than unpublish, move tags, replace assets or weaken protection.

#### Scenario: Provenance exists but vulnerability assessment fails
- **WHEN** an artifact has valid provenance but lacks a passing current security verdict
- **THEN** publication remains blocked
- **AND** the attestation is not substituted for vulnerability assessment

#### Scenario: npm publication succeeds but GitHub finalization fails
- **WHEN** the coordinator observes a partial release
- **THEN** it reports the exact completed and incomplete effects
- **AND** retry verifies already-published identity/integrity before reusing identical assets or directs a reviewed forward correction

### Requirement: Native modernization is an explicit future release interface
Source-repository hardening SHALL preserve npm distribution until a separately authorized modernization change modifies its contracts. Future native qualification SHALL provide explicit platform/architecture and bundled-component inventories, embedded runtime identities, exact artifact digests, SBOMs, current vulnerability evidence, build provenance and applicable signing/notarization evidence to the common publisher boundary. This hardening SHALL NOT restore an absent migration, treat a native executable as a container or claim native completion.

#### Scenario: Current baseline has only npm publication
- **WHEN** this hardening is implemented against the verified npm baseline
- **THEN** npm publishing and supported installation remain operational
- **AND** native bundle construction and signing stay with the separately authorized modernization owner

#### Scenario: Native work lands before hardening implementation
- **WHEN** a merged modernization change introduces new distribution artifacts
- **THEN** hardening inventories, contracts and tasks are explicitly reconciled with those merged specs before release changes
- **AND** bundled components are assessed as their actual artifact type rather than a fabricated image
