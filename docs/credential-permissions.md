# Credential provider permissions and policy admission

Liftoff policy 8 and credential-policy schema 2 preserve the actual GitHub
permission names and disclose their broader read reach. A successful provider
probe is evidence about credential use, not independent permission to execute
an operation or reuse an old approval.

## Actual current GitHub permission requirements

The documented provider minimum for the current preflight endpoints is:

| Provider permission | Level | Required operation |
| --- | --- | --- |
| `metadata` | `read` | Selected repository identity |
| `organization_administration` | `read` | `GET /orgs/{org}/actions/hosted-runners` |
| `organization_network_configurations` | `read` | `GET /orgs/{org}/settings/network-configurations` |

`organization_hosted_runners` is not the documented provider permission.
Liftoff does not substitute that name for `organization_administration`.

Administration read also authorizes other organization reads, including billing
usage, Actions permission settings, Actions cache usage and installation
metadata. These are examples, not an exhaustive restriction on that grant.
The full provider scope is every endpoint authorized by organization
Administration read.
Selecting one repository constrains repository grants; it does not narrow these
organization-wide Administration reads to that repository.

Authoritative references:

- [Fine-grained PAT permission matrix](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#organization-permissions-for-administration)
- [GitHub App permission matrix](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#organization-permissions-for-administration)
- [Documented permission parameter names](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#organization-permissions)

## Current policy boundary

Current policy stores `providerPermissions` in its original App or PAT shape
and requires `providerReadDisclosure` for organization, billing and
Actions-settings reads. The exact documented minimum is supported; extra,
missing, aliased or write grants remain blocked. Missing observation is not
filled from a default permission list.

Usage dispatch and policy creation/finalization still require fresh exact
privately issued approval binding the current policy identity, actual grants,
disclosure, principal, resource/workflow targets, intended endpoints and expiry.
The provider's reach does not authorize unrelated reads or any additional writes.
An existing schema-1 policy or policy-7 approval cannot satisfy these checks.

Human `governance plan` and `governance approve` output displays the broader read
reach, exact operations/grants, plan digest and expiry before approval is stored.
Machine plans retain the same structured disclosure; JSON adds no authority.

Discovery retains the actual App permission object or the PAT grant's original
repository/organization/other permission objects. Reviews include those raw
grants, the documented minimum, its additional read reach, and the precise
policy admission result. Additional or missing permissions remain unsupported; they are
not normalized away.

For blocked verification, `github.credential.verify-policy` carries a
`permissionReview` containing the actual target and permission boundary. It is
read-only and cannot produce a completed readiness receipt or a replacement
policy. Proposed enrollment and dispatch retain their real write effect classes
and expose the same boundary; they are not relabeled read-only.

The source-bound public artifact preserves the actual provider permissions and
disclosure. Existing-App usage and its separate policy-finalization review use
the original private dispatch records and independently verified run/artifact
identity. Neither permission metadata nor a successful workflow status alone
can complete readiness. Synthetic protocol tests are not live qualification.

After provider/run/source/ZIP-digest verification, credential extraction uses
the shared in-memory `extractWorkflowReport` reader with the literal report
filename and a 32 KiB expanded JSON limit. Credential-specific schema, raw-grant,
principal, nonce and policy checks remain separate from ZIP integrity.

## Independent unresolved boundaries

PAT bearer/grant and actual lifetime proof remain separate from this mapping
correction. `access_granted_at` is not token creation, and owner/expiry matching
is not exact bearer binding. The exact automated create-only secret request
also remains distinct from GitHub's documented create-or-update operation.
Neither blocker is a claim that all GitHub enrollment is impossible.

Existing secret values, schema-1 policies/history, original approvals and
retained-state dates are not rewritten. The exact pre-amendment policy-7
candidate has an isolated reader and separately reviewed successor lane.
No broader grant is requested automatically. Separate provider/host
qualification remains required.

The legacy masked-enrollment helper cannot create current policy from a secret
write timestamp. It fails before prompting or writing because that does not
establish exact PAT identity, lifetime or conditional creation.

## Legacy dispatch admission

The former `github.credential.challenge` action is a diagnostic identity, not a
second execution alias. Its shared workflow checkpoint keys differ from the
current `github.credential.usage-challenge` keys.

Before current credential planning or execution, the credential admission
reader checks the original retained project plans and their exact original
private checkpoint keys. It reuses the shared workflow checkpoint reader with
the original operation, workflow binding and dispatch inputs. Original plan,
payload, project-creation and private approval identities must agree.

A retained legacy prepared, response or observed-run checkpoint blocks new
execution, including when the current phase state has lost its pending handle.
A recorded run ID is not itself terminal settlement. Old unsupported execution
remains non-executing until its original recovery boundary is resolved. A new
nonce, action name, configuration or approval is not evidence that no old POST
occurred, and current policy denial is not the migration-safety guard.

The reader is bounded to the existing `governance/plans` directory (256 entries,
256 KiB per plan, 4 MiB total, 32 distinct legacy operations and the shared
reader's 16-attempt bound). It never enumerates private-store directories:
private reads use only keys derived from retained original operations and
their original approval hashes. The default executor persists its original
plan before provider preparation. Missing/inconsistent known plan or state
references, malformed or changed files, and unsupported original identities
fail closed; removing such references is not supported recovery.
The shared guarded file reader rejects links and special file modes, rechecks
paths and metadata, and prevents POSIX FIFO substitutions from blocking a read.
The remaining aggregate byte budget is enforced before opening another plan,
not after reading beyond the limit. Failed inspection never means that no
earlier effect exists.

Execution repeats this check under the real cooperating project lease before
policy admission, credential access or any new-action checkpoint lookup. The
guard writes no record, creates no retrospective preparation, sends no provider
request and never retags or rewrites old receipts.

## Fully settled stages requiring another review

A running credential workflow returns `pending` only with its actual running
operation. A fully settled, verified usage stage returns `review-required` with
review kind `credential-usage`, not a fabricated running handle. The review
contains exact public verification inputs and retained artifact references.
Failed, unknown or partially settled work remains blocked.

The review's `sourcePlanDigest` identifies the current reviewed stage plan.
The original dispatch plan digest and unchanged actual provider operation remain
distinct, including during separately approved readback recovery.

A genuinely completed enrollment stage uses review kind
`credential-enrollment`; its payload contains only actual enrollment references
and the required next-stage bindings. It does not guess a future workflow or run
ID. This result shape does not make currently unsupported new enrollment
executable, waive the provider-permission policy boundary, or complete
`credential-ready` without its separate finalization review.

A privately recorded provider run ID whose exact readback is temporarily
unavailable can remain `pending` only while its retained state is genuinely
running. The response-only handle creates no observed-run, usage, artifact or
policy proof. If the shared dispatcher reports a known terminal state with
unavailable readback, the credential consumer preserves that exact terminal
handle in a blocked result rather than changing it to running or losing it.
Both cases resume by exact-ID readback, never by another dispatch.
