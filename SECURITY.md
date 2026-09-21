# Security Policy

## Supported versions

Security fixes target the current stable `@msn-control/liftoff` release on the canonical registry at `https://registry.npmjs.org`. Versions before 0.3.0 are unsupported. Check the canonical `latest` dist-tag and run `liftoff --version` after upgrading before reporting an issue that may already be resolved.

Managed registries can lag behind canonical npm. If an approved mirror exposes an older release, stop onboarding and ask the mirror owner to synchronize it; use direct canonical npm only where organizational policy permits. A successful installation of an older mirrored version does not make that version supported.

## Report a vulnerability

Do not disclose suspected vulnerabilities in a public issue, discussion, or pull request.

Use GitHub's private vulnerability reporting form:

https://github.com/voyager163/liftoff/security/advisories/new

Include the affected Liftoff version, operating system, reproduction steps, impact, and any suggested mitigation. Avoid including real credentials, customer data, or other sensitive material.

Maintainers will assess the report privately, coordinate remediation, and publish an advisory when disclosure is appropriate.

## Suspected secret exposure

Use the same private vulnerability route for suspected credential exposure, but
do not include the credential, private source, environment files or unredacted
scanner output. Provide only the affected version/commit, nonsecret location
and relevant context. Do not test the credential against its issuer.

Confirmed exposure requires separately authorized credential-owner revocation
or rotation and removal from current source where present. Deleting a file,
rewriting history or closing an alert alone does not invalidate a credential.
Untriaged detections and unremediated exposures cannot be waived through
time-bounded dependency-vulnerability exceptions.

## Policy proposals are not finding clearance

Normal PR admission requires complete successful candidate analysis, integrity,
functional checks, and actual finding-policy success. The separate
[policy-only maintenance contract](docs/repository-security.md#pull-request-admission-and-policy-adoption)
can qualify exact base-registered exception/disposition data for an existing
finding without clearing its blocked result before adoption. It cannot admit
new raw findings, future or stale grants, or confirmed unremediated exposures.
Incident/remediation history must remain intact.

Candidate owner, approval, and evidence-reference fields are traceability, not
authority. The maintainer's ordinary merge adopts qualified policy data; there
is no separate pre-merge approval command, receipt, or second reviewer. Later
assessments independently reload the adopted base. Admission is never publication
evidence: release qualification needs fresh actual source/artifact assessment.
These local foundations do not establish trusted production workflow integration
or hosted enforcement, which remain unqualified. Reporting and separately
authorized credential-owner remediation are unchanged.

## Repository protection and its limits

See [source-repository security](docs/repository-security.md) for declared scan
scope, the conditional pinned/redacted Gitleaks role, safe evidence, dependency
coverage, exceptions and release boundaries. Enabled GitHub settings, successful
unit tests or planned workflows do not prove completed source/history scans or
effective push/merge enforcement. Local commits and arbitrary unsupported
secret patterns cannot be universally prevented. No new support deadline,
corporate affiliation or security certification is implied.
