## 1. Revise the canonical policy

- [x] 1.1 Integrate the supplied governance baseline into `assets/governance/single-maintainer-gitflow/policy.md` while preserving the Liftoff frontmatter and activation protocol; verify the rendered policy still contains schema identity, read-only Phase 0, explicit approval, and activation-baseline text.
- [x] 1.2 Add the sole VNet-injected GitHub-hosted larger runner prerequisite, prohibit self-hosted fallback, and add a preflight-before-DAST fail-closed requirement; verify no normative self-hosted Staging runner instruction remains.
- [x] 1.3 Add every settled platform default, unused-service prohibition, cost and service-limit disclosure, and import-first IaC reconciliation rule; verify each fixed decision appears in the canonical rendered policy.
- [x] 1.4 Add the narrow expiring SLSA L3 action-pinning exception while preserving Trivy as the only vulnerability gate and Grype as non-gating; verify the policy rejects blanket or expired pinning exceptions.
- [x] 1.5 Clarify candidate SHA, production merge SHA, package-version metadata, token-safe checked back-merges, explicit follow-on dispatch, and same-run tag and Release publication; verify the policy no longer requires qualification to bind a not-yet-created `main` SHA or rely on token-generated tag events.

## 2. Advance and enforce the policy contract

- [x] 2.1 Increment the governance policy version in the canonical frontmatter and `src/repository-governance.ts`, then verify generated context and handoff output report the same policy version.
- [x] 2.2 Extend fail-closed policy validation with explicit fragments for the runner model, platform defaults, infrastructure reconciliation, SLSA exception, dual commit identities, token recursion, and retained Liftoff activation envelope; verify removing each critical behavior makes validation fail.
- [x] 2.3 Update deterministic policy hashes, managed-core expectations, and focused governance tests to cover the revised behavior groups; verify `npx vitest run tests/repository-governance.test.ts` passes.

## 3. Update user-facing governance guidance

- [x] 3.1 Update `docs/repository-governance.md` to describe the VNet-injected runner prerequisite, applicable fixed defaults, candidate-to-production identity chain, token-safe back-merges, and local-only update behavior; verify all documented claims match the canonical policy.
- [x] 3.2 Update any affected generated-guide, manifest, CLI, and documentation snapshots without weakening cross-platform path assertions; verify `npx vitest run tests/documentation.test.ts tests/repository-governance.test.ts` passes on the repository's existing test runner.

## 4. Validate the complete handoff

> Local validation note: this Microsoft-managed laptop blocks direct public
> registries and requires `https://packagefeedproxy.microsoft.io/npm/`. The
> focused governance suite and all registry-independent checks pass, but the
> proxy currently returns missing-package errors for generated-stack and package
> smoke installs. Tasks 4.2 and 4.3 remain pending until GitHub-hosted validation,
> where public package access is available.

- [x] 4.1 Run `openspec validate update-gitflow-governance-policy --strict` and resolve every artifact or delta-spec error.
- [ ] 4.2 Run `npm run check` and verify the complete TypeScript build and test suite passes.
- [ ] 4.3 Run `npm run smoke:package` and `npm pack --dry-run --json`, verifying the revised canonical policy and public governance documentation remain in the published package.
