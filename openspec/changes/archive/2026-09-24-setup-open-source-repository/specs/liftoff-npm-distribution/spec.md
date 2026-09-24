## MODIFIED Requirements

### Requirement: npm publishing is explicit and authenticated
The system SHALL publish the scoped Liftoff package from the public Liftoff repository root through the existing npm trusted-publishing integration with public package access and provenance. The canonical repository's publishing job SHALL reference the approved GitHub release environment and use short-lived identity credentials. The GitHub environment SHALL require explicit maintainer confirmation, allow the sole maintainer to confirm their own initiated release, and disable administrative bypass. This change SHALL not inspect, alter, or claim enforcement of npm-side publisher, environment-binding, account, or token settings.

#### Scenario: Publish public scoped package
- **WHEN** release automation publishes `@msn-control/liftoff`
- **THEN** it publishes the standalone package prepared from the public repository root
- **AND** it uses public access configuration appropriate for a scoped npm package

#### Scenario: Publish with trusted credentials
- **WHEN** release automation authenticates to npm
- **THEN** the existing npm trusted-publishing integration authorizes the identified public repository workflow through short-lived identity credentials
- **AND** the publish emits provenance for the public source commit
- **AND** GitHub-side environment approval is not represented as proof of an npm-side environment binding

#### Scenario: Release metadata reads from repository root
- **WHEN** release automation reads the Liftoff package version or package metadata
- **THEN** it reads `package.json` from the public repository root

#### Scenario: Release is awaiting maintainer confirmation
- **WHEN** a qualified release reaches the publishing environment
- **THEN** publication remains blocked until the authorized maintainer explicitly approves
- **AND** the sole maintainer can provide that confirmation without an unavailable second reviewer or administrative bypass
- **AND** documentation describes the confirmation as deliberate authorization rather than independent review

#### Scenario: Existing npm account configuration is outside the setup boundary
- **WHEN** GitHub-side release safeguards are configured
- **THEN** the existing canonical repository and release-workflow identity are preserved
- **AND** npm publisher/account configuration is not inspected, migrated, or treated as a completion prerequisite
- **AND** setup does not introduce a long-lived npm token fallback

## ADDED Requirements

### Requirement: Publication is restricted to qualified release refs
Only a version-tag event in the canonical repository SHALL be eligible to publish. The tag SHALL identify the canonical package version and a commit reachable from the protected release branch `main`. Qualification and ref validation SHALL pass before a publication job becomes eligible for maintainer approval. Environment restrictions SHALL distinguish allowed tags from similarly named branches.

#### Scenario: Tag points outside the protected release history
- **WHEN** a `v*` tag identifies a commit not reachable from canonical `main`
- **THEN** release-ref validation fails before publication authorization
- **AND** matching a permitted tag-name pattern alone does not qualify the release

#### Scenario: Release identities disagree
- **WHEN** the canonical package name, semantic version, package/lock metadata, packed artifact, installed version, or release tag violates the existing release-identity requirements
- **THEN** qualification fails before publication
- **AND** the release environment is not used to bypass the mismatch

#### Scenario: An identically named branch or fork requests publication
- **WHEN** a workflow runs from a branch named like a version tag or from a fork repository
- **THEN** it cannot enter the canonical publishing path

### Requirement: Qualification and publishing have separate permissions
Release qualification SHALL run without publication credentials or OIDC grants. Publishing SHALL be confined to a separate approved job and SHALL use the exact artifact qualified for that release, bound to its commit, workflow run, canonical identity, and content digest. Publication SHALL preserve existing package checks, provenance, canonical post-publication verification, and stable/prerelease dist-tag behavior.

#### Scenario: Artifact is handed from qualification to publication
- **WHEN** the approved publishing job receives a qualified tarball
- **THEN** it verifies the expected artifact identity and digest and publishes that tarball
- **AND** it does not rebuild a potentially different package after approval

#### Scenario: Artifact identity changes
- **WHEN** the artifact digest, source revision, run identity, package name, or version differs from qualification evidence
- **THEN** publication fails explicitly
- **AND** a missing or mismatched artifact is not replaced by an unverified build

#### Scenario: Maintainer runs manual release verification
- **WHEN** the release workflow is manually dispatched
- **THEN** it runs a non-publishing path without npm credentials, OIDC permission, or release-environment approval
- **AND** neither an input value nor an arbitrary selected ref can convert that dispatch into publication

#### Scenario: Release verification runs on supported operating systems
- **WHEN** local package/identity checks use temporary paths on Windows, macOS, or Linux
- **THEN** artifact paths resolve portably, including paths containing spaces
- **AND** the existing isolated installation and canonical-registry verification contracts remain intact

### Requirement: Release tags have distinct creation and immutability controls
Version-tag creation SHALL be limited to explicitly authorized release authority. Version-tag updates and deletion SHALL be prohibited by a separate control with no standing bypass, so creation authority does not implicitly authorize moving or deleting an existing release tag.

#### Scenario: An unauthorized actor attempts to create a release tag
- **WHEN** an actor outside the approved release authority creates a `v*` tag
- **THEN** active tag controls reject the creation

#### Scenario: A release-authorized actor tries to move an existing tag
- **WHEN** the actor authorized to create version tags attempts to update or delete an existing protected version tag
- **THEN** the separate immutability control rejects the operation
- **AND** creation authority does not bypass that control

#### Scenario: Repository administrators change
- **WHEN** a new administrator is proposed for the personal repository
- **THEN** the maintainer reviews any role-based tag-creation authority before granting access
- **AND** documentation does not claim that an administrator role is permanently bound to one human

### Requirement: Future GitHub releases are immutable without rewriting historical releases
The repository SHALL enable GitHub release immutability for future releases and document assembling complete release assets in a draft before publication. Setup SHALL preserve historical releases and tags without recreation. Immutable GitHub assets and tags SHALL be distinguished from npm artifacts, dist-tags, account permissions, and editable release metadata.

#### Scenario: A future GitHub release is published
- **WHEN** the maintainer publishes a fully prepared draft with immutability enabled
- **THEN** its assets and associated tag receive GitHub's immutable-release protection and release attestation
- **AND** release notes are not incorrectly described as immutable bytes

#### Scenario: A previously published release is inspected
- **WHEN** a release predates activation of immutability
- **THEN** setup does not claim that its assets became retroactively immutable
- **AND** it does not delete or recreate the release to simulate that outcome

#### Scenario: A released artifact needs correction
- **WHEN** a published immutable artifact contains a mistake
- **THEN** the documented recovery uses a separately qualified new version instead of retagging or replacing that asset
- **AND** existing non-destructive npm recovery and canonical dist-tag verification remain applicable

### Requirement: GitHub publication setup has non-publishing evidence and preserves npm settings
GitHub-side release setup SHALL be verifiable without publishing a package, creating a version tag, or releasing a GitHub artifact. The setup report SHALL distinguish GitHub configuration readback and non-publishing workflow results from actual OIDC publication and npm-side enforcement. npm publisher changes, token restrictions, account 2FA, credential retirement, and migration away from npm SHALL remain outside this change rather than incomplete owner prerequisites.

#### Scenario: Repository setup reaches its account boundary
- **WHEN** an implementation task would inspect or mutate npm publisher connections, publishing access, account 2FA, or tokens
- **THEN** that activity is excluded from this change
- **AND** the future distribution migration is not implemented opportunistically
- **AND** current publishing behavior remains supported without claiming account-level lockdown

#### Scenario: Setup completes without publishing a version
- **WHEN** GitHub settings readback and safe verification are complete but no release has been authorized
- **THEN** GitHub configuration is reported as verified, live publication as unexercised, and npm settings as outside scope
- **AND** a throwaway publication is not performed to manufacture evidence

#### Scenario: GitHub configuration does not prove npm-side enforcement
- **WHEN** the release workflow and environment pass repository setup checks
- **THEN** the report does not infer npm publisher restrictions, account 2FA, or token policy from those results
- **AND** no npm account evidence is requested as a condition of completing this change
