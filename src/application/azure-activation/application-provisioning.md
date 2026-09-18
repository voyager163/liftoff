# Application activation interfaces

These are unqualified source implementations. Local protocol tests do not
qualify a provider, host, deployment, native package, or release.

## Infrastructure boundary

`planApplicationPrerequisites` and `planApplicationFoundation` return no
executable operations and an explicit implementation blocker. Their execution
functions perform no credential, state, provider, or project command access.
An already recorded operation is retained, not reinterpreted as completion.

The missing interface is a **resource-changing application infrastructure
planner/executor** binding all of:

- Exact saved-plan bytes and approved owned resource effects.
- The real private backend, acquired runtime lease, qualified private workspace,
  calling principal, and current source/artifact bindings.
- A durable private checkpoint before each effect, actual provider-issued
  request/operation IDs after a response, independent readback, and bounded
  partial recovery without blind retries.

The released `OpenTofuStateDriver` rejects resource changes and applies only
private state transformations. The private bootstrap/import interfaces are
also not application deployment authority. Configuration flags, an available
backend, a fabricated lease object, or a whole-root apply with a placeholder
image cannot fill this gap.

`inspectApplicationPrerequisiteResources` and
`inspectApplicationFoundationResources` expose exact **declared target
inventories**, not a qualified resource-changing plan or a complete
full-profile provider inventory. Prerequisite targets require separate explicit
Azure caller, workload principal/client, and role-assignment identities.
Nothing derives a workload principal from the calling principal or silently
generates a role assignment name.

`AzureApplicationProvisioningClient` exposes strict GET observations only.
It validates actual nested ARM properties, resource ID/type/name, identity
tenant, scoped role assignment, and returned request identity. It has no
application PUT or ACR build-scheduling API.

## Artifact planning and execution

`planApplicationArtifactReady` returns **both** the registered
`github.artifact.build-dispatch` and `azure.artifact.readback` operations.
The central dispatcher must invoke `executeApplicationArtifactReady` once for
the combined result; it must not prepend a legacy first-artifact/hash fallback
or separately dispatch the same build.

The phase uses an explicitly reviewed `budget` and these public phase inputs:

| Input | Meaning |
| --- | --- |
| `subscriptionId`, `tenantId`, `region` | Explicit phase bindings, or the declared common Azure bindings |
| `principalId` | Expected Azure readback caller **object ID**, checked against the actual scoped AAD token; not a client ID or inferred workload identity |
| `resourceGroup`, `acrName`, `imageName` | Exact registry resource and image repository; nested image repositories are supported |
| `workflow` | Existing `WorkflowRunBinding`: actual repository/workflow/actor IDs, exact source/ref/workflow digest, first attempt, required job names |
| `artifactName` | One exact run-bound provenance artifact name |
| `platform` | Explicit `linux/amd64` or `linux/arm64` OCI image platform; not deployment/platform qualification |
| `maxRunMinutes` | Explicit 1-30 minute job ceiling; every actual job must be listed and have a bounded timeout |
| `expectedDigest` | Optional prior known immutable digest; fresh output still requires the complete verified OCI chain and independent exact-digest registry read |
| `dispatchInputs` | Exactly `source_sha`, `registry_resource_id`, `image_repository`, `artifact_name`, and `platform`, matching the other bindings |

Generic flags, guessed names, input aliases, missing principal/cost/time scope,
unbounded/reusable jobs, matrix fan-out, environment-bound jobs, broad GitHub
token writes, cancellation of unrelated operations, additional unreviewed
jobs, and changed operations remain non-executable. Workflow token permissions
must explicitly limit repository contents to read access, with optional OIDC
issuance; application deployment or repository-control authority is separate.

Execution uses `assertAzurePhaseAuthority` and `assertGitHubPhaseAuthority`,
the real project mutation lease, and project-bound privately issued approvals.
The default ARM and GitHub transports remain real; no verification step is
conditional on an injected test transport.

The GitHub dispatch uses the existing immutable `governance-operation` store
and `dispatchApprovedWorkflowRun`. A client correlation ID is never a provider
run ID. Lost responses retain the prepared record and permit exact correlation
readback only. Pending and failed verification retain the known operation and
completed dispatch effect. If no provider ID is known, a blocked result names
the private checkpoint instead of inventing a pending handle. An unreadable
checkpoint is explicitly unresolved, never reported as not dispatched.
Previously recorded operation handles also survive invalid continuation
inputs. A missing original private checkpoint cannot turn a recorded operation
or a recovery request into a new dispatch.
Known provider rejections are distinguished from uncertain server/transport
failures. Neither display status authorizes a retry; only the shared
checkpoint contract and a fresh exact recovery approval can permit one.

## Build report and registry proof

The uniquely named artifact must contain one bounded regular UTF-8 JSON file,
`liftoff-application-build.json`. The ZIP envelope rejects additional members,
links, traversal, unsupported compression/encryption, bad CRC/lengths,
comments, and oversized expansion.

Its schema is:

```text
schemaVersion: 1
kind: "liftoff-application-build"
source: { repository, repositoryId, commitSha }
producer: { workflowId, workflowPath, workflowDigest, runId, runAttempt, actorId, jobId }
image: { registryResourceId, loginServer, repository, digest }
oci: { manifestBase64, configBase64 }
```

The source/producer fields must match independent GitHub run, job, check,
workflow-source and artifact observations. OCI manifest bytes must hash to
the selected image digest; the configuration descriptor must match the actual
configuration bytes, platform, full source revision and repository labels.
Multi-platform indexes are not silently converted to their first image.
This is source/workflow-bound artifact provenance, not a separate signed
attestation or a sandbox for user-authored build code.

The final ACR check exchanges an explicitly principal/tenant-bound AAD token
for a registry token and then a single-repository **pull-only** credential.
It requests `/v2/<repository>/manifests/<exact-digest>` and checks both raw bytes
and `Docker-Content-Digest`. It never uses catalog/tag/list order, Docker login,
ambient ACR CLI account selection, credential argv, or registry writes.
HTTP origins are restricted to the independently observed Azure registry,
redirects are refused, and time/response bounds apply.

Raw credentials, archive contents and OCI configuration bytes are not written
to public evidence or private operation records. Returned proof contains only
the verified public identities/digests. Failed image/provenance readback never
undoes or forgets an already submitted workflow, and no cross-provider atomic
rollback is claimed.
