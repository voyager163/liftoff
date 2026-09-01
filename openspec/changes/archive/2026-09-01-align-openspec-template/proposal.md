## Why

Liftoff hard-codes OpenSpec's `core` profile while OpenSpec 1.11 manages workflow selection and delivery through global configuration. Fresh Liftoff projects can therefore appear stale as soon as a developer reruns `openspec init`, and Liftoff currently has no explicit way to preserve the optional GitHub Copilot cloud-agent choice through its generated `openspec/config.yaml` overlay.

## What Changes

- Define the Liftoff OpenSpec template contract as all 12 OpenSpec 1.11 workflows delivered as both skills and commands.
- Inspect the global OpenSpec profile before any project write, display the exact required changes, and require dedicated consent before setting the global profile to `custom`, delivery to `both`, and workflows to the complete pinned list.
- **BREAKING**: A noninteractive OpenSpec `init` or `migrate` run whose global profile does not already match the Liftoff contract must supply the new profile-configuration authorization; `--yes`, `--force`, `--install-tools`, and `--install-dependencies` do not imply it.
- Add a default-off interactive choice plus `--copilot-cloud` and `--no-copilot-cloud` flags for the GitHub-hosted Copilot coding agent when OpenSpec and GitHub Copilot are selected.
- Pass explicit profile and cloud-agent arguments to the official pinned OpenSpec initializer, preserve `githubCopilot.cloudAgent` in Liftoff's write-once OpenSpec config overlay, and validate the complete generated integration surface before merging.
- Apply the same profile, consent, cloud-agent, and validation behavior to fresh migration targets.
- Document global-profile scope, independent consent, cloud-agent output, fresh-project parity, and the existing-project OpenSpec update path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-project-scaffold`: Change the official OpenSpec scaffold contract from the core profile to all pinned workflows with both delivery modes and optional Copilot cloud-agent output.
- `liftoff-cli-workflow`: Add the cloud-agent decision, related flags, plan presentation, validation rules, and an independent global-profile authorization boundary.
- `liftoff-workstation-bootstrap`: Detect, report, configure, and verify the required global OpenSpec profile without treating other consent flags as authorization.
- `liftoff-project-migration`: Reuse the complete OpenSpec profile and cloud-agent flow for fresh migration targets while preserving source immutability.
- `liftoff-user-documentation`: Explain the expanded OpenSpec contract, global configuration effect, cloud-agent opt-in, and update guidance.

## Impact

- Affected code includes CLI argument parsing, project planning and prompts, OpenSpec framework adapters, staged validation, generated OpenSpec configuration, initialization and migration orchestration, and terminal presentation.
- Tests must cover all 12 workflow artifacts for GitHub Copilot and Claude Code, matching and mismatched global profiles, consent and noninteractive failure paths, cloud opt-in and opt-out, configuration overlay preservation, migration parity, and Windows-safe command execution.
- Public CLI, workflow, prerequisite, safety, project-structure, and troubleshooting documentation changes.
- No new runtime dependency or OpenSpec version change; the contract remains pinned to OpenSpec 1.11.0.
