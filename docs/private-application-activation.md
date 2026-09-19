# Private application activation

These `0.13.0` candidate implementations are **unqualified**. Local protocol
tests do not authorize external effects, qualify a provider/host/profile
combination, or complete coordinated release qualification. Supply actual
resource identities, actors, effect permissions, spending limits and execution
windows through the owning reviewed plan. An implementation request, ambient
credential or monthly infrastructure budget is not disposable qualification
authority.

Recorded API workload facts are separate from generation provenance. Current
adopted manifests, including those with valid `standard` or `genai` facts, do
not authorize the generated bootstrap lifecycle. Until their registered local
profile engine is available, governance reports `missing-local-engine`
without inventing a seed, normalizing user files as generated seed evidence,
running baseline commands or archiving project-owned changes. Supported
historical manifests retain their original generated-workload source contract.

## Private resource execution

`application-private-*` implements resource-changing OpenTofu execution
separately from the released state-only repair/import engine. It requires an
exact inspected HCL closure, pinned local provider mirror and native tools,
protected variable reference, private workspace, explicit writer identity and
backend, and individually declared resource targets/actions.

Preparation uses an existing Azure Blob lease and a protected local copy of the
original state. It produces an immutable saved plan and a public review
projection. A later, separately approved apply executes those exact saved
bytes once. Resource intents are durably recorded before the native process;
candidate/original state and uncertain effects remain private. Independent ARM
observations and an actual no-change refresh-only provider plan precede
conditional state publication and private readback. A Blob lease excludes
cooperating state writers, not arbitrary portal or ARM writers; no
cross-provider atomic rollback is claimed.

The supported stages distinguish prerequisite resources, separately reviewed
RBAC, application dependencies and complete application deployment.
Preparation or dependency completion returns `review-required`, never a
verified phase or a completed external handle disguised as pending. The
governance engine retains the exact source plan and private review, and does
not dispatch an unchanged settled stage again.

The current private reader supports numeric `count` instances and the current
generated Azure resource families. It does not infer resource ownership from a
name or require tags absent from generated source. Existing state membership
and exact resource IDs remain authoritative; conflicting ownership tags are
refused. Queue-scoped Service Bus role assignments require independent actual
scope and role-definition readback.

Function App infrastructure readback uses the documented separate
`GET .../config/web` and read-only `POST .../config/appsettings/list` operations.
Their exact endpoints and methods are part of the private plan's read
inventory. Storage-account and configured-setting facts come from actual
responses, not copied expectations; protected values are compared privately
and withheld from observations. A running Function App host does not by
itself prove that an application package or trigger was deployed successfully.

Recovery preserves original plans, approvals, native inputs and candidates.
It can inspect, publish an explicitly selected accounted retained candidate,
or close an unapplied transaction. It never repeats a native apply or silently
abandons resource effects.

## Required backend and frontend artifacts

`application-artifact-set/1` derives required roles from the current manifest's
registered component/profile facets. A configured frontend cannot be omitted,
given the backend image, or hidden behind the single-image compatibility API.
Each role has its own explicit build recipe, component boundary, workflow,
registry repository and actual immutable image/report evidence, with one
common source commit/tree and one original whole-phase approval.

Partial successes remain in private role custody. Continuation independently
revalidates completed roles and uses original dispatch checkpoints for pending
roles; it does not construct per-role replacement plans or expose aggregate
image outputs early. Complete-set and explicit role references retain the
original plan, header/body and set commitments.

Private deployment selects either the legacy singular `artifact`, or an
explicit `artifactSet` with `artifact: null`, a complete reference, source SHA
and required role-to-address/image/registry mappings. Registered HCL image
variables bind backend and frontend roles; resource names do not. The whole
private saved plan still executes once and each role gets actual ACR, ARM and
health readback. Backend JSON health remains unchanged; frontend
`frontend-html/1` verifies a bounded document at its actual HTTPS ingress,
not API health, arbitrary HTTP 200 or browser end-to-end behavior.

## Initial empty state

An absent application backend is not a leased backend. The explicit
`azure.application-private.initialize` substage is available through the
prerequisite/foundation producer. Its phase configuration contains:

- `privateExecution.mode: "initialize"` with the exact private intent;
- `initialization: { mode: "create", checkpoint: null, readbackWindow: null }`.

This substage uses the admitted OpenTofu 1.12.6 executable in a fresh protected
directory, with a fixed provider-free configuration and isolated environment.
Its reviewed recipe includes backend-disabled initialization, a dedicated local
workspace, a saved no-refresh plan, independent JSON verification that the plan
has no resource, drift, deferred or output changes, and application of only those
unchanged saved-plan bytes. It then independently reads the native state back.
No project code, provider, credential or remote backend is used by that native
recipe; its private local files and tool execution are explicit effects.

The resulting native state has its own lineage, serial one, no resources or
outputs, and `check_results: null`. Liftoff preserves the exact native bytes;
it does not construct a state document or normalize a state-pull rendering.
An original checkpoint precedes native execution, and the verified candidate
is retained in encrypted custody before the conditional-create
`If-None-Match: *` write. Existing or foreign state is never overwritten or
adopted as this initialization. Prototype protocol-1 initialization records
block the new protocol-2 recipe rather than acquiring native provenance.

Initialization never applies application infrastructure or acquires an Azure
Blob lease. Its conditional-create handle is reported as CAS capability,
**not acquired locking proof**. The result requires a separately approved
ordinary preparation. Unsettled or incomplete native initialization retains its
checkpoint and directory, blocks publication and cannot be blindly retried.

After an uncertain PUT, use an exact original `transactionId`/`journalRef` in
`initialization.checkpoint`, `mode: "readback"`, and a separately approved
`readbackWindow`. Recovery reads the exact output and original private custody;
it cannot perform another PUT or select an unrelated latest operation. It
preserves the original intent and its timestamps.
Failure-checkpoint storage errors are reported explicitly; they do not erase
an uncertain PUT or permit cleanup of the retained native workspace.

## Immutable registry promotion

Generated environments have distinct registries. Copying a development
receipt or rebuilding an image does not establish the same artifact in another
registry.

`application-registry-promotion.ts` and `application-registry-copy.ts` implement
the explicit `azure.artifact.promote` operation. Its
`staging-qualified.registryPromotion` or
`production-rehearsed.registryPromotion` configuration binds the original
privately issued build, source and target registry IDs/repositories, immutable
OCI digest, actual Azure identity, independent disposable registry authority,
and concrete byte/count/request/deadline limits.

The adapter validates source configurations, manifests/indexes, compressed
layers and their expanded diff IDs; uses repository-scoped credentials held
only in memory; records each pre-effect intent; and independently reads target
bytes. Identical existing output is zero-write. Unknown outcomes recover by
exact output readback, not upload replay or reconstruction of lost secret
upload parameters. Upload credentials and state bytes do not enter public
receipts.

`application-registry-promotion-admission.ts` owns the private approval, lease,
source and effect-checkpoint guards. `application-registry-promotion.ts`
composes that same opaque issued authority with the copy adapter to complete
receipts. Only the adapter's byte verifier issues live readbacks;
`application-registry-readback.ts` validates retained metadata without issuing
authority. Deserialized, copied, changed or differently authorized readbacks
cannot complete a promotion.

A promoted deployment can explicitly name `sourceRegistryResourceId` separately
from its deployment `registryResourceId`. The original build receipt remains
unchanged; both immutable digest equality and actual deployment-registry
readback are required. Promotion returns another review, not staging
qualification.

A set-mode source adds `artifactSet: { role, bodyDigest, setDigest }` to its
original build reference. The source reader validates the entire privately
completed set before selecting one role; another role or a partial set cannot
authorize promotion. The original build registry and production deployment
mirror remain separate identities in rehearsal provenance.

## Development and staging proof

Development consumes an explicitly referenced completed private foundation and
the original build. The completed receipt reader reopens original private
approval, plan and effect custody and re-reads actual state/resources without
another lease, apply, publication or receipt rewrite. The registered runtime
workflow then establishes actual health/schema, exact source/run/job and
independent ARM revision/traffic observations.

Runtime source uses stable runner group/label routing. A separate reviewed
`runnerAssignment` binds real post-creation provider IDs and original creation
or reconciliation evidence. Worker instance IDs come from actual provider
jobs, not predictions embedded in source. A group/network assignment is
admission, not a substitute for same-job runtime or private-access proof.

Staging security source likewise embeds only runner group/label names.
Execution dispatch binds the actual assigned group ID and an optional explicit
runner-instance pin (`none` when no instance is pinned). The program checks the
source commitment and the fully hydrated qualification commitment before
provider/scanner work, then compares the actual provider job's runner and group
IDs. Independent retained runner-assignment readback remains mandatory; stable
routing names and dispatch declarations alone are not assignment proof.

The staging composite separates native deployment, optional registry
promotion, and security qualification. The security workflow uses pinned
Trivy/ZAP executables, an explicitly pinned fresh local vulnerability
database, bounded processes, scoped registry credentials and strict output
parsers. Findings fail the actual job. Health, schema and scans share one
dedicated job; a private target additionally requires actual DNS, verified TLS
socket-peer and response witnesses. Independent native resource and runner
assignment readback is retained in a private witness.

Future workflow IDs, execution commits, image digests, endpoints and database
digests may remain explicitly null when publishing source. They are not
fabricated or embedded as circular source dependencies. Execution requires
their actual later values in the exact approved dispatch inputs.

## Rehearsal and full enforcement

The production rehearsal coordinator retains distinct rollout preparation,
rollout completion, rollback preparation, rollback completion and final
read-only comparison. Rollout alone cannot complete rehearsal. Original
configuration, private state ownership, immutable artifact, revisions and
traffic must be restored under separately approved rollback authority.

Shared existing-backend planning lives in `application-private-planning.ts`;
`application-private-custody.ts` reopens original plans, approvals and effect
intents and projects retained results without granting execution authority.
`application-rehearsal-authority.ts` owns rehearsal admission and its private
issuance registry, deriving its own source and exact companion operations.
Execution and receipt readers use these owners directly, so reading custody
does not import the native execution coordinator or replace its guards.

Full green/red proof additionally requires genuine staging/rehearsal
predecessors and actual reviewed, unmerged positive and controlled-negative
fixtures, including `release/**` and `hotfix/**`. Repository-only evidence,
arbitrary workflow conclusions and header-only predecessor assertions do not
grant full production authority. The synchronous header compatibility facade
therefore never returns qualified success; enforcing consumers use the
asynchronous private-witness/provider readers.

Full native staging/rehearsal composition and every required
provider/host/profile combination still
require integration acceptance and separately authorized live qualification.
These boundaries must remain visible as implementation or qualification
blocks, rather than being hidden by file presence or a blanket success flag.
