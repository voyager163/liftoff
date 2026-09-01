## Why

GenAI initialization currently requires users to choose a specialized pattern before Liftoff can continue, even when they do not yet know whether the application needs RAG, conversation, agents, streaming, or workflows. This encourages accidental architecture choices—especially RAG, which appears first—instead of providing a truthful neutral starting point.

## What Changes

- Add an append-only `generic` GenAI pattern representing an intentionally undecided, general-purpose GenAI application.
- Present `I'm not sure yet - Generic GenAI starter` as the first and default interactive pattern choice.
- Accept `--pattern generic` and the equivalent configuration value in deterministic noninteractive flows.
- Generate a neutral FastAPI/PydanticAI invocation route, agent runner, prompt, offline test, and optional prompt-playground frontend.
- Exclude RAG retrieval and pgvector, ingestion or task workers, chat persistence, agent tools, streaming transport, fine-tuning datasets, and workflow-specific output from the generic scaffold.
- Record `generic` honestly in configuration, manifest identity, project documentation, bootstrap specs, and governance context.
- Preserve every existing pattern identifier and behavior.
- State that later specialization of a generated generic project is reviewed project migration work, not `liftoff update`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `liftoff-cli-workflow`: Add and default the interactive uncertainty choice, accept the generic identifier, and list nine GenAI patterns.
- `liftoff-project-scaffold`: Define the neutral generic backend and optional frontend while excluding specialized pattern assets.
- `liftoff-manifest-contract`: Add `generic` as an append-only pattern identity recorded consistently in generated configuration and schema-v6 manifests.
- `liftoff-user-documentation`: Explain when to select the generic starter, what it omits, and why later specialization is a project migration.

## Impact

This affects pattern types and catalogs, interactive choices and defaults, noninteractive validation, pattern-aware rendering, frontend metadata, generated configuration and manifest identity, governance and bootstrap context, catalog and logical-name contract fixtures, cross-platform snapshots, generated-project verification, and user documentation.
