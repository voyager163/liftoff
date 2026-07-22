## Context

The audit of Liftoff 0.3.0 found failures across four trust boundaries: command-line input, manifest-controlled filesystem access, reconciliation of generated files with user-owned files, and generated cloud/application output. The most serious failures allow `update --apply` to remove a path outside the project or overwrite an untracked destination while reporting the operation as safe.

Liftoff runs on Node.js across Windows, macOS, and Linux. Generated projects persist beyond a single CLI release, so fixes must preserve valid manifest-v2 projects while refusing malformed or unsafe state. Rendering must remain deterministic, and generated artifacts must continue to use append-only logical names.

## Goals / Non-Goals

**Goals:**

- Keep every manifest-derived read, write, move, and delete inside the discovered project root.
- Make update classification account for both the recorded source and current destination before declaring a write safe.
- Reject malformed CLI/configuration input with concise, command-specific guidance.
- Generate Azure infrastructure whose names, Function identity settings, queue wiring, and formatting are valid by construction.
- Make generated Go, GenAI, messaging, observability, and frontend starter paths executable enough to satisfy their documented contracts.
- Add regression coverage at each trust boundary and for every generated runtime.

**Non-Goals:**

- Introduce manifest schema v3 or automatically repair an unsafe manifest.
- Provide transaction-level rollback across every file in an update; the design provides preflight checks and atomic per-file replacement instead.
- Implement product-specific prompts, domain logic, retrieval ranking, or production UI design.
- Add AWS or GCP deployment support.
- Require live Azure credentials in the normal unit-test suite.

## Decisions

### 1. Centralize manifest validation and project-confined path resolution

Add a structural manifest validator and a single path-resolution boundary used by validation, reconciliation, reads, writes, and deletions. A manifest path must be a non-empty array of non-empty path segments. Segments containing `.` or `..`, either slash style, drive prefixes, UNC prefixes, or absolute paths are rejected.

The resolver will use Node's `path.resolve()` and `path.relative()` rather than string-prefix checks. Existing ancestors will be inspected with `lstat()` and `realpath()` so a symlink may be followed only when its resolved target remains under the project root. For a path that does not exist yet, the nearest existing parent is checked before creating the file.

This keeps platform behavior explicit and avoids separate POSIX and Windows security logic. Merely normalizing `..` was rejected because normalization can hide that an untrusted manifest attempted to escape.

### 2. Treat occupied destinations as conflicts

Reconciliation will inspect the rendered destination before classifying a new or moved artifact:

- An absent destination remains `new` or a clean `moved` destination.
- A destination whose bytes already equal the current render can be adopted without rewriting it; apply only refreshes recorded state.
- A destination containing different bytes is a conflict, even when the recorded old path is clean.
- `--force` may overwrite that conflict only after all path-confinement checks pass.

For clean moves, the old managed path is removed only after the destination write succeeds. Orphans and untracked paths are never deleted. Adding a new reconciliation status was rejected because the existing `conflict` state already carries the required user-facing and force semantics.

### 3. Preflight mutations and fail accurately

Apply will validate every path and classify every destination before its first mutation. Individual files will be written to a sibling temporary file and atomically renamed into place where the platform supports it. Only `ENOENT` is treated as absence; permission, type, and I/O errors propagate.

If a mutation fails, apply exits 1, names the failed artifact and operation, does not print a success summary, and does not rewrite the manifest as if the failed operation completed. A subsequent check can reconcile any earlier successful per-file writes. A broad rollback mechanism was rejected because it would itself risk removing user data after a partial failure.

### 4. Define command-specific CLI grammar

Replace permissive unknown-flag handling with a command definition table containing supported subcommands and typed flags. Parsing produces typed usage errors for unknown commands, unsupported subcommands, missing values, invalid booleans, and extra positional arguments. `cli.ts` catches parse errors as well as command errors, so expected input failures never print a JavaScript stack trace.

JSON configuration receives explicit runtime type guards using existing catalog lookups; no validation dependency is added to the runtime-only CLI package. Subcommand `--help` is handled before required-option validation.

### 5. Generate bounded, collision-resistant Azure names

Introduce one template-side Azure naming helper. Per-environment tfvars will contain a short lowercase alphanumeric suffix derived deterministically from the full safe project name and environment using a truncated SHA-256 digest. Resource templates will use service-specific prefixes and bounded components instead of repeating the project name and suffix.

The generated variable includes OpenTofu validation for length and character rules, and documentation explains how to override the suffix if a rare global collision occurs. Random rendering was rejected because it would violate deterministic artifact generation; an OpenTofu random resource was rejected because it would make names unknown until apply and complicate imports.

### 6. Make Function identity and queue configuration internally consistent

The Function app continues to use a user-assigned identity for Service Bus. Generated settings will include both `ServiceBusConnection__fullyQualifiedNamespace` and `ServiceBusConnection__clientId`, with the receiver role assigned to the same principal.

The Function host storage remains access-key configured through the `azurerm_linux_function_app` resource. The conflicting identity-style `AzureWebJobsStorage__accountName` app setting is removed unless storage is later converted completely to identity-based hosting with all required roles.

The Service Bus queue resource name, Function app setting, environment template, and output all use `var.function_worker_queue_name`. Hardcoded duplicate queue names are removed.

### 7. Replace advertised no-op starter paths with minimal working boundaries

Generated GenAI agents will instantiate PydanticAI through a lazy provider boundary and include tests using PydanticAI's test model or an injected model, avoiding live model credentials. Missing production model configuration produces an explicit configuration error rather than a successful placeholder response.

Redis messaging will publish with `XADD`; Azure messaging will send with the asynchronous Service Bus client. Both implementations use dependency injection so generated tests remain offline. Langfuse tracing activates when configured and otherwise uses an explicit disabled tracer rather than pretending a remote trace occurred.

Generated frontends will call the selected backend starter route, expose loading/success/error state, and read a configurable API base URL. This remains starter behavior, not a product-specific interface.

The Go stack gains a tracked `go.sum` artifact for its pinned module versions, and the generated-stack test runs `go test ./...` from a fresh render without a preparatory mutation.

### 8. Verify generated output at behavioral boundaries

Regression coverage will include:

- POSIX, Windows-drive, UNC, traversal, embedded-separator, and symlink path cases.
- New and moved destination collisions, force behavior, and mutation failures.
- Binary-level CLI probes for unknown flags, bad subcommands, missing values, config types, and help.
- Fresh Python, Node.js, Go, frontend, and Function worker build/test commands.
- `tofu fmt -check`, `tofu init -backend=false`, and `tofu validate`, plus static assertions for every generated Azure name and Function identity setting.

Live Azure apply remains a release qualification step rather than a unit test.

## Risks / Trade-offs

- [Risk] Strict parsing breaks scripts that relied on ignored typos or extra arguments. -> Mitigation: return precise usage text and document the behavior as breaking.
- [Risk] Symlink checks reject an unusual project layout that intentionally links generated files outside the project. -> Mitigation: explicitly disallow that unsafe ownership model and explain the remedy.
- [Risk] Existing projects may report more conflicts after destination-aware reconciliation. -> Mitigation: preserve files by default and require explicit `--force`.
- [Risk] Updated generated integrations add maintenance work as upstream SDKs evolve. -> Mitigation: pin compatible dependency ranges and execute generated-project tests in CI.
- [Risk] Offline name generation cannot guarantee global Azure uniqueness. -> Mitigation: use a collision-resistant suffix, enforce service limits, and document an override.
- [Risk] Static OpenTofu validation cannot prove a live deployment. -> Mitigation: keep a documented authenticated plan/apply release check.

## Migration Plan

1. Land manifest/path guards and destination-collision tests before changing any apply behavior.
2. Make mutation errors explicit and retain manifest-v2 compatibility for valid projects.
3. Enable strict CLI/config parsing and update packaged command documentation.
4. Update Azure naming, Function identity/queue wiring, and OpenTofu checks.
5. Add generated Go checksum metadata and functional starter integrations with generated-project tests.
6. Run the full Liftoff check, package smoke test, generated-stack matrix, and OpenTofu validation.
7. Release as the next compatibility-significant Liftoff version. Existing valid projects use `liftoff update` normally; unsafe manifests fail with a remedy instead of being auto-repaired.

Rollback is a package-version rollback. Projects already updated remain valid manifest-v2 projects; generated files are not automatically reverted.

## Open Questions

None. The decisions above define the implementation boundary for this change.
