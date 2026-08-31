## ADDED Requirements

### Requirement: Reviewed baseline refreshes may cross npm major versions
The system SHALL distinguish a focused advisory remediation from a reviewed supported-stack baseline refresh. A focused remediation SHALL continue selecting the smallest compatible patched release, while a baseline refresh MAY upgrade packaged npm templates across stable major versions only after source compatibility changes, deterministic lock regeneration, security audit, and representative install, build, lint, and test verification are complete.

#### Scenario: Fix one advisory between baseline releases
- **WHEN** a supported current-major patch resolves a newly disclosed advisory
- **THEN** the packaged template uses the smallest verified compatible patch
- **AND** unrelated dependency majors remain unchanged

#### Scenario: Promote a new frontend baseline
- **WHEN** a reviewed baseline refresh moves Vite, its framework plugin, or Tailwind to a newer stable major
- **THEN** the generated frontend source and configuration are migrated together with its manifest and lockfile
- **AND** production build verification passes before the baseline is accepted

#### Scenario: Major candidate remains vulnerable
- **WHEN** a candidate major graph contains an unresolved finding without a valid exact exception
- **THEN** baseline promotion remains blocked

### Requirement: Packaged npm freshness inventory is explicit
The system SHALL maintain explicit named inventory entries for the Liftoff package, telemetry service, standard Node.js backend, standard frontend, and current immutable Power Apps starter package graphs. Freshness and security checks SHALL resolve these paths with platform-native path handling and SHALL fail when a packaged npm graph is absent from the appropriate inventory.

#### Scenario: Check every npm dependency surface
- **WHEN** baseline verification runs
- **THEN** it reports the current and candidate identity for every explicit npm inventory entry
- **AND** no recursive filesystem pattern determines which package graphs are in scope

#### Scenario: Add a packaged npm lock on Windows
- **WHEN** a new generated npm lockfile is introduced
- **THEN** CI fails until its path-part entry and applicable verification are added
- **AND** the inventory resolves equivalently on Windows, macOS, and Linux

### Requirement: Baseline npm verification preserves metadata
Every packaged npm graph SHALL install through its committed lockfile using the baseline and oldest-supported npm compatibility lanes applicable to that graph. Verification SHALL fail if installation, build, lint, or test changes package metadata.

#### Scenario: Verify a refreshed packaged graph
- **WHEN** a package manifest or lockfile changes during baseline refresh
- **THEN** the corresponding generated project completes all documented checks
- **AND** a before-and-after byte comparison confirms that package metadata was not rewritten
