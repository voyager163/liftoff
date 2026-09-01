## Context

See `proposal.md` for motivation. Liftoff 0.8.0 runs OpenSpec 1.11.0 in an empty staging tree with `--profile core`, then overlays a workload-specific `openspec/config.yaml`. OpenSpec stores workflow profile and delivery in global configuration, not project configuration, while the Copilot cloud-agent preference is project-local. Liftoff currently validates only one skill marker per selected agent and does not retain the cloud-agent preference when it replaces the initializer's config with its seed overlay.

The current staging and destination merge transaction remains the safety boundary for project files. Global OpenSpec configuration is a separate machine-level side effect and must receive separate consent before staging starts.

## Goals / Non-Goals

**Goals:**

- Make fresh OpenSpec scaffolds deterministic against the pinned 1.11.0 workflow catalog.
- Keep subsequent `openspec init` or `openspec update` behavior aligned by establishing the same global profile that generated the project.
- Preserve existing project-file staging, ownership, and rollback boundaries.
- Make Copilot cloud-agent setup explicit, default-off, and reproducible in the final OpenSpec config.
- Reuse the same behavior for `init` and fresh migration targets on macOS, Linux, and Windows.

**Non-Goals:**

- Do not hand-write or hash-manage OpenSpec skills, commands, or cloud-agent files.
- Do not make `liftoff update` regenerate framework-owned output in existing projects.
- Do not enable the Copilot cloud coding agent by default.
- Do not add project-local OpenSpec profile support that OpenSpec 1.11 does not provide.
- Do not change the pinned OpenSpec version or the Spec Kit initialization contract.

## Decisions

### 1. Define one explicit OpenSpec 1.11 template contract

Add a framework-specific constant containing the ordered workflow identifiers:

`propose`, `explore`, `new`, `continue`, `apply`, `update`, `ff`, `sync`, `archive`, `bulk-archive`, `verify`, and `onboard`.

The same contract declares profile `custom` and delivery `both`. Expected skill, command, and cloud-agent paths will also be explicit named lists derived from the selected supported agent, never wildcard discovery. This follows the repository rule that generated artifacts are tracked by exact names.

Alternative considered: pass `--profile custom` and inherit whatever the user selected. This can generate zero or partial workflows and is not a stable Liftoff template contract.

### 2. Inspect and configure OpenSpec through its CLI

Before project staging, run `openspec config list --json` with the same pinned executable selected by the plan. Parse only the required `profile`, `delivery`, and `workflows` fields, tolerate unrelated fields, compare workflow membership independent of order, and reject malformed or failed output.

If the profile differs, show the current and required values plus the exact allowlisted commands. Interactive runs request a separate confirmation. Noninteractive runs require `--configure-openspec-profile`; `--yes` and existing consent flags do not imply it.

After authorization, invoke the pinned CLI to:

1. Set `workflows` to the complete JSON array.
2. Set `delivery` to `both`.
3. Set `profile` to `custom`.
4. Re-read and verify the effective configuration.

Setting `profile` last avoids activating an empty custom profile if an earlier command fails. Using `openspec config set` preserves unrelated upstream fields and avoids depending on platform-specific global config paths. No project files are staged until verification succeeds.

Alternative considered: write an isolated `XDG_CONFIG_HOME` for generation. A later `openspec update` would read the user's real global profile and could immediately remove the expanded workflows, recreating the reported drift.

Alternative considered: edit OpenSpec's JSON file directly. That couples Liftoff to private path and serialization details and would require separate atomicity and unknown-field preservation logic.

### 3. Treat the global profile change as its own durable consent

Add `--configure-openspec-profile` as a one-run authorization flag accepted by `init` and `migrate`, but not persisted in `liftoff.config.json`. Interactive consent defaults to No and occurs after plan confirmation and tool readiness but before staging.

An authorized global change is not rolled back if a later project phase fails. It is a machine-wide user choice that may already be observed by other projects or processes; restoring a stale snapshot would risk overwriting concurrent changes. Liftoff will report the successful machine change separately from any later project failure.

### 4. Model Copilot cloud setup as transient Liftoff input and persistent OpenSpec state

Add a transient boolean project option and resolved plan field exposed as `--copilot-cloud` / `--no-copilot-cloud`. It is valid only when OpenSpec and GitHub Copilot are selected. Interactive flows ask after agent selection and default to No. A fully specified `--yes` run that omits the option resolves to false.

The option is not accepted from or written to `liftoff.config.json`, because opting into a GitHub Actions workflow is a consent decision and OpenSpec already owns its persistent state. The generated plan displays the choice.

The OpenSpec initializer receives an explicit cloud flag. Liftoff's API and Power Apps OpenSpec config renderers include:

```yaml
githubCopilot:
  cloudAgent: true|false
```

when GitHub Copilot is selected, so the write-once config overlay retains the initializer decision. Claude-only and Spec Kit plans omit the field and cloud flags.

### 5. Validate complete staged output without expanding Liftoff ownership

Keep the existing minimal markers used by `liftoff validate` and `liftoff doctor` for backward compatibility with previously generated core-profile projects. Add an initialization-only OpenSpec contract check that verifies regular files at every expected skill and command path for each selected agent. When cloud setup is enabled, require both cloud-agent files; when disabled, require them to be absent in the fresh stage.

The files remain origin `framework`, stay excluded from Liftoff manifest hashes, and remain managed by OpenSpec after generation. Liftoff's generated config and bootstrap change remain write-once seed content.

Alternative considered: expand persistent manifest validation to all workflow paths. That would make existing valid core-profile projects fail immediately after upgrading Liftoff and would make Liftoff police later, intentional OpenSpec profile changes.

### 6. Share preparation and validation across init and migrate

Extract the profile inspection, consent, configuration, command construction, and staged contract validation so both onboarding paths call the same operations. Migration performs every machine-level action before target writes and continues to stage framework files only under the fresh target; the source remains read-only.

### 7. Document the existing-project path instead of changing update ownership

New projects use the complete contract automatically after any required global-profile consent. Existing projects align by selecting all workflows and both delivery through OpenSpec configuration, then running `openspec update`. Cloud-agent changes remain an OpenSpec init/config/update operation. Plain `liftoff update` continues to exclude framework-owned files.

## Risks / Trade-offs

- [Global profile changes affect every OpenSpec project on the machine] -> Display the exact scope and values, default interactive consent to No, and require a dedicated automation flag.
- [The three upstream config commands are not one atomic operation] -> Set the workflow list and delivery before activating `custom`, verify the final state, and stop before project writes on any failure.
- [A concurrent process can change global config between verification and init] -> Pass `--profile custom`, keep the interval small, and make missing staged artifacts fail validation before destination mutation.
- [Future OpenSpec releases can add workflows or move generated paths] -> Pin the 1.11.0 contract in the supported-stack baseline and update the explicit lists only through reviewed baseline maintenance.
- [Cloud files include a GitHub Actions workflow] -> Keep the option default-off, describe both files before consent, and never infer opt-in from agent selection or `--yes`.
- [Existing core-profile projects do not gain workflows through Liftoff update] -> Document the explicit `openspec config profile` plus `openspec update` migration path and retain framework ownership.
- [A later project failure leaves an authorized global profile change in place] -> Report machine configuration separately and do not risk overwriting concurrent global state through automatic rollback.

## Migration Plan

1. Add the explicit OpenSpec profile and generated-path catalog with unit tests against OpenSpec 1.11.0.
2. Add read-only global profile inspection and mismatch presentation.
3. Add dedicated interactive and noninteractive authorization, apply the allowlisted config commands, and verify the result.
4. Add cloud-agent parsing, prompting, planning, command arguments, and config-overlay preservation.
5. Add complete staged output validation for GitHub Copilot, Claude Code, and both.
6. Wire the shared behavior into `init` and `migrate`.
7. Update public guidance and lifecycle snapshots.
8. Run targeted unit and real-framework smoke tests using an isolated test configuration so tests never modify a developer's real global OpenSpec config.

Rollback the Liftoff release by reverting these code and documentation changes. Do not automatically restore a user's global OpenSpec profile; users can select another profile with OpenSpec's own configuration command.
