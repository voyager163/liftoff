## ADDED Requirements

### Requirement: Manifest artifact paths are structurally valid and project-confined
The system SHALL validate the complete shape of a supported manifest and SHALL prove that every artifact path resolves inside the discovered project root before reading, writing, moving, or deleting any artifact. Path validation MUST behave equivalently on Windows, macOS, and Linux and MUST reject traversal segments, absolute paths, drive-qualified paths, UNC paths, embedded platform separators, empty segments, and symlink resolutions outside the project.

#### Scenario: Read a valid portable manifest path
- **WHEN** a supported manifest records an artifact as non-empty platform-neutral path parts such as `["backend", "apis", "main.py"]`
- **THEN** the CLI resolves the path under the project root using the host platform and permits normal processing

#### Scenario: Reject parent traversal before filesystem access
- **WHEN** a manifest artifact includes `..` or another path representation that would resolve outside the project root
- **THEN** the command exits 1 before accessing the target and identifies the unsafe artifact path

#### Scenario: Reject Windows absolute and UNC paths cross-platform
- **WHEN** a manifest contains a drive-qualified or UNC artifact path, even when the CLI is running on macOS or Linux
- **THEN** the manifest is rejected as unsafe before any artifact access

#### Scenario: Reject embedded separators
- **WHEN** one manifest path part contains `/` or `\` instead of representing exactly one path segment
- **THEN** the CLI rejects the manifest with guidance to regenerate it or use a matching valid manifest

#### Scenario: Reject a symlink escape
- **WHEN** a validated-looking artifact path traverses an existing symlink whose resolved target is outside the project root
- **THEN** the CLI refuses the operation and leaves both the project and external target unchanged

#### Scenario: Reject malformed manifest fields with guidance
- **WHEN** a supported-version manifest has missing or incorrectly typed project metadata, artifact arrays, logical names, categories, path parts, hashes, or Liftoff version
- **THEN** the CLI exits 1 with a concise manifest-validation error rather than a JavaScript type error
