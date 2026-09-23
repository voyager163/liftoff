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

If the private form is unavailable, do not post the finding publicly. This
project does not promise a response time or operate a paid bug-bounty program.

## Other concerns

Use [SUPPORT.md](SUPPORT.md) for public technical help and the separate private
contact in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#reporting-and-enforcement)
for conduct concerns. Do not use security advisories to report conduct issues.
