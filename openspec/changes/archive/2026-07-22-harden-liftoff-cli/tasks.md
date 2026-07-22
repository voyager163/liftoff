## 1. Manifest And Path Safety

- [x] 1.1 Add runtime manifest shape validation for project identity, artifact metadata, hashes, and path-part arrays with user-facing validation errors.
- [x] 1.2 Add a cross-platform project-path resolver that rejects traversal, absolute, drive-qualified, UNC, empty, and embedded-separator path parts.
- [x] 1.3 Add existing-parent `lstat`/`realpath` containment checks that reject symlink escapes while allowing paths that resolve inside the project.
- [x] 1.4 Route manifest validation, artifact reads, writes, moves, and deletions through the validated resolver and propagate every non-`ENOENT` filesystem error.
- [x] 1.5 Add POSIX, Windows-drive, UNC, separator, malformed-manifest, and symlink regression tests proving external files are never accessed or changed.

## 2. Collision-Safe Reconciliation

- [x] 2.1 Add regression fixtures for occupied new destinations, occupied moved destinations, already-matching destinations, and clean relocations.
- [x] 2.2 Update reconciliation to inspect both recorded and rendered destinations, adopt identical bytes, and classify different pre-existing bytes as conflicts.
- [x] 2.3 Add apply preflight so every path and collision is validated before the first artifact mutation.
- [x] 2.4 Implement atomic per-file replacement and remove an old managed path only after its validated destination succeeds.
- [x] 2.5 Make write, replacement, move-cleanup, and manifest failures exit 1 with the artifact operation and without a success summary or false manifest state.
- [x] 2.6 Cover retry behavior after partial I/O failure and confirm skipped or forced conflicts remain visible according to the manifest contract.

## 3. Strict CLI And Configuration Input

- [x] 3.1 Define each command's supported positional arguments, subcommands, and typed flags in one reusable command-definition table.
- [x] 3.2 Reject unknown flags, invalid subcommands, missing values, invalid boolean forms, duplicate incompatible options, and extra positional arguments before command execution.
- [x] 3.3 Catch parser and command usage errors at the binary entrypoint and add command-specific `--help` output without JavaScript stack traces.
- [x] 3.4 Add runtime JSON configuration guards for strings, booleans, environment arrays, and catalog-backed values while preserving documented flag precedence.
- [x] 3.5 Add binary-level tests proving mistyped create flags and helper subcommands fail without writing projects or printing fallback commands.

## 4. Deployable Azure OpenTofu

- [x] 4.1 Add a centralized Azure naming helper with service-specific prefixes, character rules, maximum lengths, and deterministic per-environment hash suffixes.
- [x] 4.2 Render bounded names and suffix validation for Key Vault, storage, registry, Container Apps, Functions, PostgreSQL, Redis, Service Bus, and Communication Services.
- [x] 4.3 Wire Function Service Bus settings to the attached user-assigned identity client ID and receiver-role principal.
- [x] 4.4 Use one coherent Function host-storage authentication mode and remove incomplete identity-style storage settings.
- [x] 4.5 Drive the provisioned Service Bus queue, Function setting, environment template, and output from `function_worker_queue_name`.
- [x] 4.6 Correct generated HCL formatting and add representative `tofu fmt -check`, backendless init, validation, naming-limit, and identity-wiring tests.

## 5. Functional Generated Starters

- [x] 5.1 Add a tracked Go checksum artifact with an append-only logical name and make a fresh generated Go project pass `go test ./...` without rewriting module metadata.
- [x] 5.2 Replace successful GenAI placeholder responses with a lazy PydanticAI agent boundary and explicit missing-model-configuration errors.
- [x] 5.3 Add generated offline orchestration tests using injected or PydanticAI test models for representative pattern contracts.
- [x] 5.4 Implement Redis Streams and asynchronous Azure Service Bus publishers behind the generated messaging interface with injected-client unit tests.
- [x] 5.5 Implement configured Langfuse tracing plus an explicit disabled tracer that never claims a remote trace was created.
- [x] 5.6 Add frontend API-base configuration, route-aware request submission, and loading, success, and error states while preserving safe project-name encoding.
- [x] 5.7 Extend generated Python, Node.js, Go, frontend, and Function worker smoke checks to execute their documented fresh-project build and test commands.

## 6. Compatibility, Documentation, And Release Gates

- [x] 6.1 Update logical-name fixtures, generated manifests, and reconciliation expectations for every newly tracked artifact without renaming existing identifiers.
- [x] 6.2 Update the packaged README and generated documentation for strict CLI errors, unsafe-manifest remedies, collision behavior, Azure suffix overrides, Function identity, and starter integration configuration.
- [x] 6.3 Add Windows CI coverage for manifest path validation, project-root containment, collision handling, and generated path portability alongside Linux checks.
- [x] 6.4 Run the Liftoff workspace check, package smoke install, generated-stack matrix, OpenTofu checks, and focused safety regressions as the final release gate.
