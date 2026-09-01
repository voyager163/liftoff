## Context

See `proposal.md` for motivation. Liftoff currently models every GenAI project with a required `PatternDefinition`. Interactive initialization presents the catalog in array order, with RAG first, and supplies no pattern default. Planning rejects a GenAI project without a recognized pattern; configuration, schema-v6 workload identity, generated filenames, routes, frontend behavior, governance context, and bootstrap specs all consume that stable pattern identifier.

The renderer already separates common GenAI output from narrow RAG, streaming, fine-tuning, and worker branches. All non-RAG and non-streaming patterns share a general invocation implementation, so a neutral pattern can use the existing architecture without introducing nullable planning state.

Generated application files are project-owned under manifest schema v6. Selecting a specialization after generation therefore cannot be implemented as managed-core update.

## Goals / Non-Goals

**Goals:**

- Give uncertain users an honest, first-class GenAI selection.
- Make uncertainty the safe interactive default instead of privileging RAG.
- Preserve deterministic noninteractive creation through a stable identifier.
- Produce a useful, runnable, offline-testable generic PydanticAI scaffold.
- Keep all eight existing pattern identities and generated behavior unchanged.
- Make generic project identity consistent across configuration, manifest, governance, documentation, and bootstrap artifacts.

**Non-Goals:**

- Making the GenAI pattern nullable or adding an `unknown` manifest state.
- Automatically detecting the correct pattern from a project description.
- Generating a union of every specialized pattern.
- Adding an in-place generic-to-specialized migration command.
- Reducing or redesigning the common GenAI cloud and local-service baseline.
- Changing managed-core update authority or manifest schema version.

## Decisions

### 1. Add `generic` as a real append-only pattern identifier

The catalog gains a ninth entry:

```text
id:              generic
label:           Generic GenAI Starter
aliases:         generic, undecided, unsure, not-sure
scaffold status: foundation
frontend starter: Generic AI playground
route prefix:    /api/ai
worker:          false
```

The catalog label remains suitable for plans, generated READMEs, pattern listings, and governance context. Interactive initialization renders the special user-facing label `I'm not sure yet - Generic GenAI starter` for this entry without storing that sentence as project identity.

`generic` is inserted first in the pattern catalog and passed as the explicit default to the pattern chooser. Pressing Enter therefore chooses generic; numeric and identifier selection remain deterministic. `--pattern generic` and the documented aliases resolve through the existing catalog lookup.

Alternative considered: map the uncertainty choice to `prompt`. Rejected because configuration and manifests would falsely claim an intentional prompt-based architecture, and generated guidance would hide the user's unresolved decision.

Alternative considered: allow a missing or null pattern. Rejected because it would spread optionality through every GenAI plan, manifest reader, renderer, governance adapter, validation path, and update guard while producing less explicit project state.

### 2. Keep generic distinct from the prompt-based pattern

The prompt pattern remains a deliberate specialization with named prompt templates, invocation semantics, and structured-output examples. Generic instead promises only a neutral text-in/result-out AI boundary:

```text
POST /api/ai/run
{ "input": "..." }
        |
        v
generic_agent.run_generic()
        |
        v
PydanticAI AgentRunner + tracing
```

The generic artifacts use stable logical names already shared across pattern renders (`pattern-agent`, `pattern-agent-test`, and `pattern-prompt`) while their project paths are derived from the new identifier:

```text
backend/orchestration/agents/generic_agent.py
backend/orchestration/prompts/generic.md
backend/tests/test_generic_orchestration.py
```

The generated agent prompt uses neutral wording such as “Respond safely and usefully to this general-purpose AI request.” It does not claim retrieval, conversation history, tools, streaming, fine-tuned endpoints, supervisors, or pipelines. The test injects a fake runner and disabled tracer so it remains offline.

Alternative considered: reuse the prompt pattern's files byte-for-byte. Rejected because the two catalog identities would then promise different semantics while producing misleading prompt-specialized guidance.

### 3. Reuse the common GenAI baseline but omit specialized branches

Generic receives the existing common FastAPI/PydanticAI backend, model configuration, Scalar, auth boundary, logging and tracing, base PostgreSQL schema, messaging and blob abstractions, Docker Compose, environments, Azure OpenTofu, and optional Langfuse profile. These are the approved cross-pattern GenAI foundation, not a claim that a specialized workflow has been selected.

Because `worker` is false and the identifier is neither `rag`, `streaming`, nor `fine-tuned`, generic omits:

- Azure Functions worker files and worker infrastructure;
- RAG retrieval packages, pgvector extension, and ingestion endpoints;
- streaming response adapters;
- fine-tuning evaluation datasets;
- specialized chat, tool, supervisor, and workflow structures.

Alternative considered: make generic a new minimal dependency and infrastructure profile. Rejected as a separate generated-stack redesign that would require new lock sets, service selection, infrastructure contracts, and migration policy. The first generic pattern should be neutral in application semantics while remaining compatible with the tested GenAI baseline.

### 4. Generate a neutral optional frontend

The existing frontend generator uses pattern metadata and a common request client. Generic uses:

```text
descriptor: Generic GenAI Starter
starter:    Generic AI playground
route:      /api/ai/run
method:     POST
body field: input
```

Visible text must avoid references to RAG, search, chat, agent automation, streaming, fine-tuning, or workflows. The frontend remains a project-owned `frontend` provisioning group under the existing lifecycle contract.

### 5. Persist generic identity without a schema migration

`PatternId` and the catalog gain `generic`; schema v6 already records a validated pattern identifier and requires GenAI pattern identity. Fresh generic projects record:

```json
{
  "projectType": "genai",
  "pattern": "generic"
}
```

The same identifier flows into manifest workload identity, `GENAI_PATTERN`, model configuration, governance context, generated README, and bootstrap capability naming. Existing manifest versions remain structurally compatible because catalog identifiers are append-only and readers resolve them through the current catalog.

No existing pattern identifier, alias, logical artifact name, or manifest schema changes.

### 6. Keep later specialization outside update

Changing `generic` to `rag`, `chatbot`, or another specialized identifier remains a pattern migration. `liftoff update` continues rejecting pattern changes and cannot rewrite project-owned application files.

Generated and public documentation explains that teams specialize through a reviewed project change: design the required architecture, add or replace project-owned routes and integrations, update desired identity only as part of that migration, and verify the resulting application. This change does not create that migration automation.

### 7. Extend the complete pattern verification matrix

Tests and fixtures expand from eight to nine patterns:

- exact pattern catalog order and aliases;
- interactive choice rendering and Enter-default behavior;
- noninteractive `--pattern generic`;
- project-plan and approved-stack identity;
- deterministic artifact and logical-name snapshots;
- generic backend route, agent, prompt, test, and exclusions;
- optional frontend request contract and neutral copy;
- manifest/config/governance/bootstrap identity;
- Docker/OpenTofu non-worker validation;
- documentation and terminal snapshots;
- Windows, macOS, and Linux generation paths.

Existing per-pattern snapshots must remain byte-identical except where global pattern counts or choice screens intentionally add the generic option.

## Risks / Trade-offs

- **[Users assume generic can be converted automatically later]** -> State at selection time and in generated guidance that specialization is reviewed project migration work, not update.
- **[Generic duplicates the prompt pattern]** -> Give generic a narrower neutral contract and retain prompt-specific named-template and structured-output language.
- **[The common GenAI baseline feels heavy for an undecided project]** -> Describe it as the tested deployable foundation; defer service-minimization to a separate architecture change.
- **[Making generic the first default changes interaction snapshots]** -> Update all rich, compact, plain, and scripted prompt coverage while preserving explicit selections.
- **[New identifier breaks exhaustive switches or fixtures]** -> Use the `PatternId` type and complete nine-pattern matrices to expose missing handling at build and test time.
- **[Specialized artifacts leak into generic output]** -> Assert exact forbidden paths, worker absence, no pgvector schema, neutral route behavior, and neutral frontend text.

## Migration Plan

1. Add the `generic` pattern type and catalog entry with stable aliases and neutral metadata.
2. Make the interactive generic choice first and default while preserving explicit pattern selection.
3. Add or specialize generic route, agent, prompt, test, frontend, documentation, bootstrap, and governance rendering.
4. Extend catalog, planner, manifest, template, logical-name, container, infrastructure, and cross-platform fixtures.
5. Update public and generated guidance with the uncertainty-safe choice and later migration boundary.
6. Run the complete build, test, generated-template, package-smoke, and OpenSpec validation suite.

Rollback before release removes the append-only candidate and its fixtures. After release, the `generic` identifier cannot be repurposed or removed; corrections ship as compatible template and documentation fixes for newly generated projects.
