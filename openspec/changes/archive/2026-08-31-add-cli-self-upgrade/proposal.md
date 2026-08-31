## Why

Developers currently have to leave Liftoff and manually reconstruct the correct global npm command to move the CLI itself to a newer stable release. That is easily confused with `liftoff update`, which upgrades generated project artifacts rather than the installed CLI.

## What Changes

- Add an imperative `liftoff upgrade` command that upgrades a supported global npm installation of `@msn-control/liftoff` to the exact stable version published through the authoritative npm release channel.
- Add `liftoff upgrade --check` as a read-only availability check with the standard clean/update-available/failure exit-code contract.
- Add human and `--json` results that distinguish current, update available, upgraded, blocked, and failed states without including registry credentials or local paths.
- Honor the developer's configured npm registry: compare against canonical npm, require the configured registry to expose the exact target, and never rewrite npm configuration or silently bypass an approved mirror.
- Detect and refuse local, `npx`, unsupported package-manager, ambiguous, downgrade, and prerelease self-upgrades with an exact manual remedy.
- Execute npm through an argument array without a shell, never invoke elevation, stream installation output, and verify both installed package metadata and the replacement `liftoff --version` before reporting success.
- Keep CLI upgrade independent from projects: it never reads or writes a Liftoff manifest or generated artifact, and successful completion recommends `liftoff update --check` separately.
- Update doctor freshness guidance, telemetry command allowlists, package smoke verification, CLI documentation, and cross-platform tests.

## Capabilities

### New Capabilities

- `liftoff-cli-self-upgrade`: Defines supported installation discovery, stable-version resolution, registry policy, check and apply behavior, verification, output, safety, and cross-platform semantics for upgrading the installed Liftoff CLI.

### Modified Capabilities

- `liftoff-cli-workflow`: Add `upgrade` to the explicit command surface, help lifecycle, output, and exit-code behavior while preserving `update` for projects.
- `liftoff-npm-distribution`: Support verified in-place replacement of a global npm installation through the configured approved registry.
- `liftoff-project-doctor`: Point stable-version freshness remediation to the new self-upgrade command while retaining read-only diagnostics.
- `liftoff-cli-telemetry`: Recognize the aggregate `upgrade` command without collecting target versions, registries, paths, or flags.
- `liftoff-user-documentation`: Explain CLI upgrade versus project update, check mode, registry behavior, supported installations, and recovery.

## Impact

This affects command definitions and parsing, version and registry lookup, process execution, global installation discovery, output schemas, telemetry allowlists, doctor remedies, package smoke tests, terminal snapshots, documentation, and Windows/macOS/Linux verification. It does not change generated project manifests or make project updates part of CLI self-upgrade.
