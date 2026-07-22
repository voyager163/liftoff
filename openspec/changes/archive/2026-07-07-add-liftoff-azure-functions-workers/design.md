## Context

Liftoff currently generates backend API code under `backend/apis`, shared GenAI orchestration under `backend/orchestration`, and pattern workers under `backend/workers` for patterns with asynchronous work. That structure is sufficient for local or containerized workers, but Azure Functions workers have their own runtime contract: `host.json`, trigger bindings, local settings, Function app hosting, app settings, and deployment lifecycle.

The generated project should make that boundary explicit without forcing users to choose a new framework. Liftoff is still Azure-only in V1, and all generated paths must remain cross-platform by using path parts rather than slash-delimited path construction.

## Goals / Non-Goals

**Goals:**

- Generate a clear top-level `functions/` area for Azure Functions workers when the selected pattern includes background or event-driven work.
- Keep Azure trigger adapters separate from reusable GenAI orchestration code in `backend/orchestration`.
- Extend environment templates and generated Azure OpenTofu output so Function app settings and hosting are represented without committed secrets.
- Track every generated Function artifact in `liftoff.manifest.json` using existing path-parts semantics.
- Preserve current CLI behavior and avoid breaking existing non-worker or backend-only scaffolds.

**Non-Goals:**

- Adding a new CLI prompt or option for function runtime selection.
- Supporting AWS Lambda, Google Cloud Functions, Durable Functions orchestration, or multiple language runtimes.
- Replacing the FastAPI backend or moving API routes into Azure Functions.
- Implementing code deployment automation for Function app packages beyond generated scaffold and infrastructure configuration.

## Decisions

1. Generate Azure Functions workers under `functions/<pattern>-worker`.

   Worker patterns already have explicit catalog metadata through `pattern.worker`. Liftoff should use that existing signal and generate one Function app scaffold per worker-enabled pattern, with a deterministic folder such as `functions/rag-worker` or `functions/workflow-worker`. This keeps the behavior explicit and avoids adding speculative worker-selection prompts.

   Alternative considered: place Azure Functions files under `backend/workers`. That hides the separate Azure Functions runtime contract and makes `host.json` and Function app settings look like ordinary backend code.

2. Keep `backend/orchestration` as the shared AI/domain logic boundary.

   Generated Function code should act as a trigger adapter and call into shared orchestration boundaries where appropriate. This keeps Service Bus, timer, or queue triggers thin and prevents duplicating agent, prompt, model, and retrieval code.

   Alternative considered: generate all worker logic inside each Function app. That would make initial deployment simpler but would duplicate business logic and drift from the current backend orchestration layout.

3. Represent Function configuration separately from backend configuration.

   Environment output should include Function-specific templates, such as `environments/<env>/functions.env`, alongside backend environment settings. The Function templates should use placeholders or references for storage, Service Bus, and secrets instead of concrete credentials.

   Alternative considered: append Function settings to `backend.env`. That blurs deployment boundaries and makes it harder to configure the API and worker independently.

4. Extend the Azure OpenTofu scaffold in the existing Azure infrastructure surface.

   Function app hosting belongs under `infrastructure/opentofu/azure` with the rest of the Azure resources. The generated infrastructure should model the Function app, hosting/storage requirements, managed identity, app settings, and Service Bus access needed by the worker scaffold.

   Alternative considered: create a separate infrastructure tree for functions. That would split one Azure environment across multiple state roots and make the generated project harder to reason about.

5. Keep manifest and tests path-part based.

   New artifacts should be added through the existing `add(logicalName, category, pathParts, content)` helper so the manifest records arrays of path parts. Tests should assert paths using `path.join()` or joined path parts rather than hardcoded platform separators.

## Risks / Trade-offs

- Function app code may need shared backend code at deployment time → Document the boundary and keep the generated Function adapter thin so teams can package shared code consistently with their deployment process.
- More generated files for worker patterns → Limit Function scaffolding to patterns that already set `pattern.worker` and keep non-worker patterns unchanged.
- Azure Functions infrastructure adds app settings and identity surface area → Generate placeholders, managed identity wiring, and Key Vault or secret-reference guidance rather than committing secret values.
- Local development can differ from cloud bindings → Keep local settings as examples and use stable messaging/orchestration interfaces so local Redis Streams and cloud Service Bus remain replaceable behind the same boundary.

## Migration Plan

- Existing generated projects are unaffected until regenerated or manually updated.
- Implement the scaffold as additive output for worker-enabled patterns.
- Update tests to cover worker-enabled and non-worker patterns, frontend-enabled and frontend-disabled generation, manifest tracking, and generated validation.
- Rollback is removing the Function artifacts and restoring infrastructure/environment tests to the previous worker-only expectations.

## Open Questions

- Should future releases expose a CLI flag to choose between container workers, Azure Functions workers, or both?
- Should deployment packaging guidance live only in generated documentation, or should Liftoff eventually generate a packaging script for Function apps that include shared backend code?