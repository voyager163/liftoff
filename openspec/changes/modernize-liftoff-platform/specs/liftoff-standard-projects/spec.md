## MODIFIED Requirements

### Requirement: Standard API stacks share an operational contract
The system SHALL generate every standard API stack with port `8000`, health and readiness endpoints, the application's actual OpenAPI document, a Scalar reference, PostgreSQL integration, a stack-native health test, and one documented runtime configuration contract. Scalar and schema routes SHALL retain their published canonical locations and satisfy the shared prefix-safe direct/proxy contract, including trailing-slash forms, relative canonicalization redirects, query preservation, actual JSON content type, and schema identity. Supplied process environment SHALL override the selected project configuration file, which SHALL override nonsecret defaults. Native and Docker Compose startup SHALL resolve the same applicable application, database, service, and readiness settings. Omitted messaging or tracing boundaries SHALL not create prerequisites, and standard stacks SHALL not require pgvector or pattern-specific workers.

#### Scenario: Inspect a generated standard API
- **WHEN** a developer generates any supported standard API stack
- **THEN** the backend exposes `GET /health`, `GET /ready`, its real OpenAPI document, and OpenAPI-backed Scalar documentation
- **AND** the runtime listens on port `8000` and its documentation does not depend on frontend-root routing

#### Scenario: Process environment overrides the selected standard configuration
- **WHEN** a supported standard runtime value is set in both process environment and the selected project configuration file
- **THEN** the application uses the process-environment value
- **AND** documented precedence matches running behavior

#### Scenario: Native and Compose recipes agree for standard projects
- **WHEN** the same standard project starts natively and through Docker Compose
- **THEN** both resolve the same selected configuration values
- **AND** Compose changes only service addresses required for container networking

## ADDED Requirements

### Requirement: Scalar schema references preserve the browser-visible prefix
Generated Go/Huma and Node.js/Fastify APIs SHALL use schema references that resolve under the browser-visible application prefix rather than hard-coded origin-root URLs. Standard Python/FastAPI and every supported GenAI variant SHALL satisfy the same contract. Direct and prefix-stripping proxy access SHALL preserve the existing canonical documentation and schema endpoints without requiring trusted forwarded-host headers, absolute host reconstruction, a fixed deployment prefix, or a frontend-root schema workaround.

#### Scenario: Open documentation directly
- **WHEN** the canonical documentation endpoint is opened without a proxy
- **THEN** Scalar resolves and loads the application's own OpenAPI document
- **AND** its reference does not depend on a particular public host or deployment prefix

#### Scenario: Open documentation behind a prefix-stripping proxy
- **WHEN** the browser accesses the application under a non-root prefix that the proxy removes before forwarding
- **THEN** Scalar's schema request retains that browser-visible prefix and reaches the same application schema
- **AND** it does not request an origin-root schema outside the selected application

#### Scenario: Go and Node share the defect correction
- **WHEN** the supported Go/Huma and Node.js/Fastify outputs are qualified
- **THEN** both satisfy the same prefix-preserving reference behavior
- **AND** fixing only the reported Go URL does not qualify the unchanged Node defect

#### Scenario: Forwarded host metadata is untrusted
- **WHEN** a direct or proxied request supplies absent, unexpected, or attacker-controlled forwarded-host metadata
- **THEN** documentation links and canonicalization do not reconstruct a destination from that metadata
- **AND** schema navigation stays relative to the actual application entry point

### Requirement: Documentation and schema canonicalization preserves prefix and query
Both canonical and trailing-slash forms of the published documentation and OpenAPI routes SHALL resolve successfully under direct access and a prefix-stripping proxy. A form that requires canonicalization SHALL return a relative, prefix-preserving `Location` and retain the original query string without loss or double encoding. A form served without redirection SHALL provide the same declared documentation or schema response. Canonicalization SHALL NOT redirect to an origin-root path, derive an authority from forwarding headers, or create a loop.

#### Scenario: Canonical and trailing-slash documentation URLs are opened
- **WHEN** each form is requested directly and under a non-root application prefix
- **THEN** the final documentation page loads the correct same-application schema in every case
- **AND** any redirect keeps the visible prefix rather than escaping to the host root

#### Scenario: A schema URL requires a redirect
- **WHEN** a schema route's noncanonical slash form is requested with a query string
- **THEN** its `Location` is relative and resolves to the canonical schema within the original visible prefix
- **AND** the query string retains duplicate keys, blank values, and encoded characters without dropping or double encoding them

#### Scenario: Canonicalization is followed through a proxy
- **WHEN** a client follows the returned relative redirect behind a prefix-stripping proxy
- **THEN** it reaches the intended canonical endpoint without an additional prefix, lost prefix, or redirect loop
- **AND** the same request has equivalent route semantics without the proxy

### Requirement: Schema qualification verifies JSON content and application identity
Qualification SHALL exercise the actual generated application routes for Go/Huma, Node.js/Fastify, standard Python/FastAPI, and supported GenAI variants, directly and through a prefix-stripping proxy, using canonical and trailing-slash forms with representative queries. Schema responses SHALL have a real JSON media type, parse as OpenAPI, and preserve the application's actual `paths` and `components` structure and content across variants, including whether optional structures are present. HTTP 200, a nonempty body, a Scalar page, an empty substitute schema, or SPA HTML SHALL NOT count as schema proof. HTTP URL semantics SHALL remain independent from native filesystem separators.

#### Scenario: Every route variant returns the same schema
- **WHEN** the qualification matrix fetches the real document through direct/proxied canonical/trailing-slash entry points
- **THEN** each result has the declared JSON content type and valid OpenAPI structure
- **AND** its `paths` and `components` match the actual canonical application schema rather than a separately maintained fixture document

#### Scenario: A fallback page returns HTTP 200
- **WHEN** a schema request returns HTML from a frontend or catch-all route
- **THEN** qualification fails despite the successful status code
- **AND** the diagnostic identifies the content-type or schema mismatch

#### Scenario: A schema silently loses routes or models
- **WHEN** a proxied response parses as JSON but omits or changes application paths or components
- **THEN** schema identity comparison fails
- **AND** a syntactically valid or empty document is not accepted as equivalent

#### Scenario: Python and GenAI require the same evidence
- **WHEN** Python standard and supported GenAI variants are qualified without production model credentials
- **THEN** their documentation, redirects, query handling, JSON media type, and schema identity pass the same matrix
- **AND** their framework defaults are not assumed correct without evidence

#### Scenario: Qualify generated projects across host platforms
- **WHEN** affected projects are generated and exercised on Windows, macOS, and Linux using native project paths with spaces
- **THEN** generated logical artifact identities remain stable and HTTP paths use URL semantics
- **AND** filesystem path handling cannot introduce backslashes or host-dependent behavior into public routes

### Requirement: Existing documentation handlers evolve only through reviewed per-file changes
Fixing generated Scalar/OpenAPI output SHALL NOT authorize ordinary update or CLI installation to overwrite existing project-owned handlers. Supported existing-project remediation SHALL use explicit observed application mappings, exact before/after effects, preserved business routes and references, independently authorized staged checks, and separate file approval. Unsupported or ambiguous custom routing SHALL remain a blocker rather than trigger whole-template replacement.

#### Scenario: An existing Go or Node application has custom handlers
- **WHEN** a reviewed repair or adoption plan applies the known prefix-safe routing correction
- **THEN** only its exact mapped handler and reference changes commit after matching route qualification
- **AND** custom business endpoints, unrelated files, and original provenance remain protected

#### Scenario: A managed update sees newer backend templates
- **WHEN** `liftoff update` runs after the generator fix is installed
- **THEN** it does not overwrite, restore, or classify project handlers as managed template drift
- **AND** an assessment finding can recommend the separate supported per-file evolution preview
