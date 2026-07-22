## Context

Mission Control currently contains OpenSpec planning configuration but does not yet provide a project bootstrapper. The proposed Liftoff CLI will be a Node.js command-line tool intended for future npm packaging as `@mission-control/liftoff` with a `liftoff` binary. Liftoff generates Python FastAPI/PydanticAI GenAI applications, optional Vue 3/Tailwind frontends, local Docker Compose stacks, OpenTofu infrastructure, and spec-driven workflow assets.

The CLI must run on macOS, Linux, and Windows. All filesystem behavior must use Node.js path utilities and explicit generated file manifests so the generator can validate, preview, and safely create output without relying on platform-specific separators or broad pattern matching.

## Goals / Non-Goals

**Goals:**

- Provide a Node.js CLI with interactive and non-interactive project creation flows.
- Generate all eight GenAI application patterns using the approved Mission Control stack.
- Make Azure complete in V1 while modeling AWS and GCP as planned provider adapters.
- Generate OpenTofu infrastructure, Docker Compose local development, and dev/test/prod environment configuration.
- Generate OpenSpec by default, allow Spec Kit selection, and tailor governance files to the selected stack.
- Keep file generation safe, previewable, cross-platform, and repeatable.

**Non-Goals:**

- Publishing the npm package in this change.
- Implementing deploy/apply automation for cloud resources beyond generated OpenTofu artifacts and helper command surfaces.
- Providing production-complete AWS or GCP infrastructure in V1.
- Implementing full authentication/identity flows in generated applications beyond placeholders and integration boundaries.
- Generating domain-specific business logic.

## Decisions

### Node CLI, Python Generated Application

Liftoff will be implemented as a Node.js CLI so it can be packaged and distributed through npm. The generated backend will be Python with FastAPI and PydanticAI. This keeps the generator easy to install with `npx @mission-control/liftoff` while preserving PydanticAI as the enterprise-approved application framework.

Alternatives considered:
- Python CLI: simpler sharing of Pydantic models, but weaker fit for npm distribution.
- Hybrid Node wrapper over Python: increases install complexity and makes local prerequisites less predictable.

### Declarative Catalogs and Project Plan

The CLI will use explicit catalogs for patterns, providers, regions, generated files, environment defaults, and governance workflows. Prompt answers and flags will resolve into a `ProjectPlan` before any file is written. `liftoff plan` and the interactive create confirmation will present this plan to the developer.

Alternatives considered:
- Direct prompt-to-file rendering: faster to implement, but harder to preview, validate, test, and extend.
- Template discovery by filesystem globbing: flexible, but conflicts with the requirement to use explicit generated artifact tracking.

### Azure Complete, AWS/GCP Planned

V1 will generate complete Azure OpenTofu infrastructure. AWS and GCP will appear as planned provider adapters in catalogs and prompts but will not generate placeholder infrastructure. Interactive prompts will mark them as planned. Non-interactive use with unsupported providers will fail with a clear message.

Alternatives considered:
- Hide AWS/GCP: reduces confusion, but loses roadmap visibility.
- Generate stub provider folders: creates misleading artifacts that look deployable.

### OpenTofu Infrastructure

Generated infrastructure will use OpenTofu. Azure output will include provider configuration, modules/resources for the approved services, environment tfvars for dev/test/prod, local state by default, and documented remote-state examples.

Alternatives considered:
- Bicep: strong Azure-native fit, but weaker future provider consistency.
- Terraform-only branding: less aligned with the requested OpenTofu standard.

### Region Resolution

The CLI will support exact Azure region slugs and human-friendly aliases. Interactive input such as `korea` will resolve to matching regions and ask the developer to disambiguate. Non-interactive ambiguous input will fail and list valid slugs. The default Azure region will be East US (`eastus`).

Alternatives considered:
- Require exact slugs only: precise but unfriendly.
- Pick the first fuzzy match automatically: convenient but risky for infrastructure location.

### All Eight Patterns With Declared Scaffold Depth

V1 will support RAG, chatbot, agent-based, prompt-based, multi-agent, fine-tuned model, real-time/streaming, and workflow/pipeline patterns. The CLI will use pattern-specific modules and declare each pattern's scaffold depth internally so generated output does not overpromise advanced behavior.

Alternatives considered:
- Support only the first four patterns: lower implementation risk, but does not meet the V1 scope.
- Generate identical scaffolds for all patterns: easy, but fails to provide meaningful guided output.

### Optional Pattern-Aware Frontend

The frontend will be optional. When selected, Liftoff will generate a Vue 3/Tailwind frontend appropriate to the selected pattern, such as a chat UI for chatbot, retrieval UI for RAG, prompt playground for prompt-based apps, or run console for agent/workflow patterns. Scalar remains mandatory for the backend developer portal regardless of frontend selection.

Alternatives considered:
- Always generate frontend: unnecessary for API-only projects.
- Ask many frontend customization questions: slows down the bootstrap flow.

### Local Development Stack

Generated projects will include Docker Compose for local development. The default stack will include backend services, PostgreSQL with pgvector, Redis, Azurite, and Mailpit. Langfuse will be generated behind an observability compose profile. Local messaging will use a narrow messaging interface with Redis Streams as the local substitute for Azure Service Bus.

Alternatives considered:
- Cloud-only local development: less useful for developers.
- Always run the full observability stack: heavier default experience.
- Require Azure Service Bus during local development: reduces offline usefulness.

### Spec-Driven Workflow Generation

OpenSpec will be the default spec-driven workflow. Liftoff will ask developers to choose OpenSpec or Spec Kit, defaulting to OpenSpec. OpenSpec projects will receive `openspec/config.yaml`, specs/changes folders, and a seed bootstrap change. Spec Kit projects will receive a constitution and templates under the selected convention. Generated governance content will reflect the selected stack and folder layout.

Alternatives considered:
- OpenSpec only: simpler, but does not satisfy the requirement to ask between OpenSpec and Spec Kit.
- Generate empty governance folders only: misses the opportunity to encode project standards.

### Safe File Creation

`liftoff create` will generate only into a new or empty directory by default. Existing non-empty directories will stop with a clear error unless a future explicit override is provided. The generator will track files through a manifest rather than deleting or modifying by pattern matching.

Alternatives considered:
- Merge into any existing folder: convenient but high risk.
- Always overwrite: unsafe and surprising.

## Risks / Trade-offs

- Supporting all eight patterns in V1 increases implementation and testing scope. Mitigation: implement a shared scaffold core with pattern modules and test each pattern's generated manifest separately.
- Azure-complete infrastructure can become complex quickly. Mitigation: use small explicit modules, environment tfvars, and local state by default with remote-state examples.
- Redis Streams differs from Azure Service Bus semantics. Mitigation: keep messaging behind a narrow interface and document local behavior as a development substitute.
- Region alias data can become stale. Mitigation: keep provider region catalogs explicit, test common aliases, and fail clearly on unknown or ambiguous input.
- Generated code spans Node, Python, Vue, Docker, and OpenTofu. Mitigation: separate generator tests from generated-project smoke checks and use fixtures for expected manifests.
- Cross-platform file creation can drift if tests assume POSIX paths. Mitigation: use Node path utilities everywhere and include Windows path scenarios in tests.

## Migration Plan

This is a new capability, so no migration of existing user data is required. Implementation can land incrementally behind the new `liftoff` CLI command. Rollback consists of removing the CLI entrypoint, generated templates, catalogs, and tests before release because no runtime production system depends on the change.

## Open Questions

- Which exact Spec Kit file convention should be treated as canonical if the repository does not already contain a Spec Kit standard?
- Should remote OpenTofu state setup become part of V1 or remain documented as a follow-up after local-state generation is working?
- Which CI/CD templates, if any, should Liftoff generate in the first implementation pass?