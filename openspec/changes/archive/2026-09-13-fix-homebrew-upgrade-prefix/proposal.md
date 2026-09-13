## Why

`liftoff upgrade` rejects a valid global installation under Homebrew's stable prefix when the active Homebrew Node/npm reports its versioned Cellar prefix. This prevents the installed 0.11.3 CLI from upgrading even though the package and canonical release are available.

## What Changes

- Recognize a verified standard macOS Homebrew global installation when the active Node/npm uses a different prefix within the same Homebrew installation.
- Bind npm discovery, registry checks, installation, and replacement verification to the verified installation prefix without changing persistent configuration.
- Preserve rejection of local, linked, cache-based, ambiguous, and unsafe installations.
- Add regression coverage and document the one-time workaround for older CLIs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-cli-self-upgrade`: Support independently verified Homebrew prefix targeting while retaining installation confinement, registry policy, and read-only check behavior.

## Impact

The CLI self-upgrade service, focused upgrade tests, and upgrade troubleshooting documentation. No dependency, activation identity, project migration, or global installation changes are required during development.
