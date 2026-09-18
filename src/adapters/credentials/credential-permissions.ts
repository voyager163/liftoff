import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { credentialPolicySchemaVersion, governanceActivationPolicyVersion } from '../../domain/governance/policy/identity.js';
import {
  requiredCredentialProviderPermissions, runnerPreflightProviderPermissions, runnerPreflightProviderReadDisclosure,
  runnerPreflightOrganizationPermissions, runnerPreflightRepositoryPermissions,
  type CredentialProviderPermissionMap, type ObservedCredentialPermissions
} from '../../domain/governance/activation/types.js';
import { GitHubActivationError, object } from '../github/activation-rest.js';

export const credentialApiPermissions = runnerPreflightProviderPermissions;
export type { CredentialProviderPermissionMap, ObservedCredentialPermissions } from '../../domain/governance/activation/types.js';

export const credentialProviderScopeBlocker =
  'The actual provider grant requires policy 8 and credential-policy schema 2 with broader organization, billing and Actions-settings read disclosure. Original policies and approvals cannot authorize it; fresh exact permission observations and plan-bound approval are required.';

export interface CredentialProviderPermissionBoundary {
  kind: 'github-credential-permission-boundary.v2';
  apiVersion: '2026-03-10';
  requiredProviderPermissions: ObservedCredentialPermissions;
  observedProviderPermissions: ObservedCredentialPermissions;
  providerGrantMatch: 'exact-minimum' | 'unsupported-additional-or-missing';
  additionalOrganizationReadReach: readonly string[];
  additionalReadReachScope: 'all-organization-administration-read-endpoints';
  source: string;
  providerReadDisclosure: typeof runnerPreflightProviderReadDisclosure;
  policy: {
    policyVersion: string;
    schemaVersion: number;
    repository: readonly string[];
    organization: readonly string[];
    admission: 'exact-provider-read-scope' | 'unsupported-provider-grants';
  };
  blockers: readonly string[];
}

function permissionMap(value: unknown): CredentialProviderPermissionMap {
  const raw = object(value, 'Provider credential permissions');
  if (Object.keys(raw).length > 128) throw new GitHubActivationError('credential-permission-shape', 'Provider permission inventory exceeds its bound.');
  const entries = Object.entries(raw);
  if (entries.some(([key, level]) =>
    !/^[a-z][a-z0-9_]{0,99}$/u.test(key) || /^(?:github_pat_|gh[pousr]_)/u.test(key) ||
    typeof level !== 'string' || !['read', 'write', 'admin'].includes(level))) {
    throw new GitHubActivationError('credential-permission-shape', 'Provider grants must contain only explicit permission names and read/write/admin levels; response material was withheld.');
  }
  return Object.fromEntries(entries) as CredentialProviderPermissionMap;
}

/** Preserve the actual provider shape and keys, including safe-to-display unsupported grants. Never rename Administration to Hosted runners. */
export function observeCredentialPermissions(kind: ObservedCredentialPermissions['kind'], value: unknown): ObservedCredentialPermissions {
  if (kind === 'github-app') return { kind, permissions: permissionMap(value) };
  const raw = object(value, 'PAT grant permissions');
  if (Object.keys(raw).sort().join(',') !== 'organization,other,repository') {
    throw new GitHubActivationError('credential-permission-shape', 'PAT grant permission scopes are missing or unsupported.');
  }
  return { kind, permissions: {
    repository: permissionMap(raw.repository), organization: permissionMap(raw.organization), other: permissionMap(raw.other)
  } };
}

export function validateObservedCredentialPermissions(value: unknown, kind: ObservedCredentialPermissions['kind']): ObservedCredentialPermissions {
  const raw = object(value, 'Observed provider grants');
  if (Object.keys(raw).sort().join(',') !== 'kind,permissions' || raw.kind !== kind) {
    throw new GitHubActivationError('credential-permission-shape', 'Observed provider grants do not identify the selected credential class.');
  }
  return observeCredentialPermissions(kind, raw.permissions);
}

export function requiredCredentialPermissions(kind: ObservedCredentialPermissions['kind']): ObservedCredentialPermissions {
  return requiredCredentialProviderPermissions(kind);
}

export function credentialPermissionBoundary(observation: ObservedCredentialPermissions): CredentialProviderPermissionBoundary {
  const observed = validateObservedCredentialPermissions(observation, observation.kind);
  const required = requiredCredentialPermissions(observed.kind);
  const exact = canonicalSha256(observed) === canonicalSha256(required);
  return {
    kind: 'github-credential-permission-boundary.v2', apiVersion: '2026-03-10',
    requiredProviderPermissions: required, observedProviderPermissions: observed,
    providerGrantMatch: exact ? 'exact-minimum' : 'unsupported-additional-or-missing',
    additionalOrganizationReadReach: [
      'GET /organizations/{org}/settings/billing/usage',
      'GET /orgs/{org}/actions/permissions',
      'GET /orgs/{org}/actions/cache/usage',
      'GET /orgs/{org}/installations'
    ],
    additionalReadReachScope: 'all-organization-administration-read-endpoints',
    source: 'https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#organization-permissions-for-administration',
    providerReadDisclosure: runnerPreflightProviderReadDisclosure,
    policy: {
      policyVersion: governanceActivationPolicyVersion,
      schemaVersion: credentialPolicySchemaVersion, repository: [...runnerPreflightRepositoryPermissions],
      organization: [...runnerPreflightOrganizationPermissions], admission: exact ? 'exact-provider-read-scope' : 'unsupported-provider-grants'
    },
    blockers: exact ? [] : ['The raw observed provider grant differs from the exact documented minimum. Additional reads/writes and missing permissions are not automatically accepted.']
  };
}

export function assertCredentialProviderPolicyPermitted(observation?: ObservedCredentialPermissions): void {
  if (!observation) {
    throw new GitHubActivationError('credential-provider-observation', 'The actual provider grant observation is required; a schema number, approval or default permission set cannot substitute for readback.');
  }
  if (credentialPermissionBoundary(observation).providerGrantMatch !== 'exact-minimum') {
    throw new GitHubActivationError('credential-provider-permissions', 'The actual provider grant has additional or missing permissions; preserve the raw observation and review it. No broader grant is implicitly approved.');
  }
}
