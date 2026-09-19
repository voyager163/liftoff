import { governanceActivationPolicyVersion } from './identity.js';

export const governancePolicySchemaVersion = 1 as const;

export const governancePolicyVersion = governanceActivationPolicyVersion;

export const requiredPolicyFragments = [
  'schemaVersion: 1',
  'profile: single-maintainer-gitflow',
  'policyVersion: "8"',
  'credential-policy schema 2',
  'organization_administration:read',
  'broader organization, billing and Actions-settings reads',
  'Schema-1 policies and original approvals',
  'reviewed endpoints and resource identities',
  'Repository-only enforcement is explicitly selected',
  'Repository proof is not production qualification',
  'separately approved main-update hold',
  'capability chapters, not execution order',
  'managed phase graph is the sole execution-order authority',
  'develop` is the integration branch and the **default branch**',
  'main` is production truth',
  'release/X.Y.Z',
  'hotfix/X.Y.Z',
  'required_approving_review_count: 0',
  'require_code_owner_review: false',
  'require_last_push_approval: false',
  'Do not create a `CODEOWNERS` file',
  'no required reviewers',
  'GITHUB_TOKEN',
  'Repository-scoped only',
  'One provisioning exception only:',
  'GitHub-hosted larger runner with',
  'Azure VNet injection',
  'private Staging DAST genuinely applies',
  'If DAST is inapplicable, provision no runner networking',
  'consume it without creating a duplicate',
  'unresolved input is a blocker',
  'Every Azure runner-network resource, remote state',
  'Staging subscription.',
  "Do not share or depend on another repository's or subscription's firewall",
  'selected access for only this repository',
  'Azure Firewall Basic',
  'Azure NAT Gateway',
  'takes precedence for new outbound connections',
  'NAT Gateway and an NSG do not filter HTTPS',
  'Disable implicit default outbound access',
  'current GitHub meta endpoint',
  'deny all unsolicited inbound connections',
  'non-overlapping address space',
  'private DNS',
  'perform no TLS interception',
  'A standard hosted preflight checks assignment',
  'Do not mark the prerequisite satisfied until readback proves',
  'maximum concurrency of one',
  'Remove in dependency order',
  'live Staging reachability',
  'Prefer an existing approved',
  'bootstrap-local',
  'encrypted at rest on the approved workstation',
  'copy local bootstrap state through GitHub artifacts',
  'private Blob DNS and authenticated backend access',
  'reviewed declarative imports',
  'state locking and Blob',
  'clean checkout produces a no-change plan',
  'retention clock does not start',
  'Retained local state must never run plan or apply',
  'destroying the encryption key',
  'The deletion record must contain no state payload',
  'Pre-answered platform defaults',
  'Dev LRS',
  'ZRS in every environment',
  '30 days read-only after verified remote import',
  'Derive the minimal namespace set',
  'Microsoft.Network',
  'GitHub.Network',
  'resource_provider_registrations = "none"',
  'missing required namespace and no unrelated provider',
  'provider-ready',
  'terminal `Registered` readback',
  'directly or transitively after its namespace registration',
  'retained subscription capabilities',
  'teardown from unregistering them',
  'Register subscription features only for intended capabilities',
  'SubscriptionNotRegisteredForFeature',
  'Do not broaden subscription features',
  'Microsoft.Network/AllowBringYourOwnPublicIpAddress',
  'Do not register the BYOIP feature as a workaround',
  "Validate every network service tag's direction and action",
  'AzurePlatformDNS',
  'used only in a Deny rule',
  'Allow rule for that tag',
  'allow TCP and UDP port 53 to the exact resolver addresses',
  'Production: zone-redundant HA',
  'User-assigned managed identity with OIDC federation',
  'Small — fewer than 1,000 users',
  'Cost-optimised with production safeguards',
  'GitHub Actions secret at the environment level',
  'Active LTS only',
  'Provision nothing that no code uses',
  'known service limits',
  'refactor the IaC to match the live resources and import',
  'GitHub Secret Protection',
  'Dependabot + Dependency Review',
  'CodeQL + Copilot Autofix',
  'Checkov',
  'Trivy',
  'Grype',
  'OWASP ZAP',
  'slsa-github-generator',
  'The SLSA L3 generator is the one approved exception to SHA-pinning',
  'expiring action-reference exception',
  'wildcard, blanket exemption',
  'OSSF Scorecard',
  'Explicitly excluded as duplicates',
  'build once',
  'qualified release or hotfix candidate SHA',
  'production `main` merge SHA',
  'explicitly dispatch',
  'zero traffic',
  'fresh baseline revision',
  'Rollback must never be gated',
  'Alerting is infrastructure as code',
  'Route everything to Slack',
  'Add a heartbeat',
  'Test that each alert fires',
  'shallow from deep checks',
  'DORA four keys',
  'trusted_root.jsonl',
  'Fail-closed sequencing.',
  'Prove each check fails',
  'STOP FOR EXPLICIT USER APPROVAL',
  'governance/activation-baseline.json',
  'rulesets idempotently last',
  'read the live rulesets'
] as const;

export const forbiddenPolicyFragments = [
  'DAST must run on a self-hosted runner',
  'self-hosted runner group with Staging access exists',
  'Consume it; never attempt to create it',
  'Treat it as an **external prerequisite**',
  'share a firewall across repository subscriptions',
  'NAT Gateway may coexist with Azure Firewall',
  'resource creation is sufficient proof of Staging connectivity',
  'retain local bootstrap state indefinitely',
  'upload local bootstrap state as a GitHub artifact',
  'delete local bootstrap state immediately after import',
  'retained local state remains an active backend',
  'provider registration may remain pending while resources are created',
  'approved minimum `bootstrap-local`; delegated private',
  'register all Azure providers',
  'unregister provider registrations during teardown',
  'resource_provider_registrations = "none" requires no explicit registrations',
  'register AllowBringYourOwnPublicIpAddress for every Standard public IP',
  'Allow AzurePlatformDNS in an outbound NSG rule',
  'register any feature named by SubscriptionNotRegisteredForFeature',
  'Set the **GitHub Actions app** as the bypass actor'
] as const;

export function validateGovernancePolicy(policy: string): void {
  const missing = requiredPolicyFragments.filter((fragment) =>
    !policy.includes(fragment)
  );
  if (missing.length > 0) {
    throw new Error(
      `Governance policy is missing required contract fragment: ${missing[0]}`
    );
  }
  const forbidden = forbiddenPolicyFragments.find((fragment) =>
    policy.includes(fragment)
  );
  if (forbidden) {
    throw new Error(
      `Governance policy contains forbidden legacy contract fragment: ${forbidden}`
    );
  }
  if (
    !/No change in this repository\s+requires another person's approval/.test(policy) ||
    !policy.includes('Never enable a ruleset whose required contexts have not been observed green')
  ) {
    throw new Error('Governance policy does not preserve fail-closed single-maintainer invariants.');
  }
}

export const secretValuePatterns = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgh[orsup]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/,
  /\bAccountKey=[^;\s]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
] as const;

export function assertGovernanceContentSafe(content: string): void {
  for (const pattern of secretValuePatterns) {
    if (pattern.test(content)) {
      throw new Error('Governance artifact contains a credential-shaped value.');
    }
  }
}
