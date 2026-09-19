# Security Policy

## Supported versions

The current source candidate is Liftoff 0.13.0, an unpublished native-only candidate.
Signed artifacts, supported-host qualification, and verified delivery channels remain
release blockers. Report the exact output of `liftoff --version` and the installation
owner; do not use npm's `latest` dist-tag as evidence of native availability or support.

The npm distribution line ends at v0.12.3 and remains available for explicit historical
recovery. Versions before 0.3.0 are unsupported. Where organizational policy requires a
managed npm registry, verify the exact selected historical version through that registry
and ask its owner to resolve any mismatch; a successful mirrored installation does not
establish native availability.
A successful installation of an older mirrored version does not make that version supported.
Historical recovery does not authorize a new npm release
or a bypass of registry policy.

## Report a vulnerability

Do not disclose suspected vulnerabilities in a public issue, discussion, or pull request.

Use GitHub's private vulnerability reporting form:

https://github.com/voyager163/liftoff/security/advisories/new

Include the affected Liftoff version, operating system, reproduction steps, impact, and any suggested mitigation. Avoid including real credentials, customer data, or other sensitive material.

Maintainers will assess the report privately, coordinate remediation, and publish an advisory when disclosure is appropriate.
