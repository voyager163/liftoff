import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { activationContractVersion, activationStateSchemaVersion, approvalEnvelopeSchemaVersion, credentialPolicySchemaVersion, evidenceHeaderSchemaVersion, governanceActivationPolicyVersion, liftoffActivationPackageVersion, liftoffManifestArtifactVersion, phaseGraphSchemaVersion, supersessionSchemaVersion } from '../../domain/governance/policy/identity.js';
import { requiredCredentialProviderPermissions, runnerPreflightProviderReadDisclosure, runnerPreflightDisplayNameTemplate, runnerPreflightOrganizationPermissions, runnerPreflightPatLifetimeDays, runnerPreflightRepositoryPermissions, runnerPreflightRotationLeadDays, runnerPreflightSecretName } from '../../domain/governance/activation/types.js';

export function credentialPolicySchema(): Record<string, unknown> {
  const activationIdentityProperties = {
    liftoffVersion: { const: liftoffActivationPackageVersion },
    manifestArtifactVersion: { const: liftoffManifestArtifactVersion },
    policyVersion: { const: governanceActivationPolicyVersion },
    activationContractVersion: { const: activationContractVersion },
    phaseGraphSchemaVersion: { const: phaseGraphSchemaVersion },
    phaseGraphHash: { const: currentActivationIdentity.phaseGraphHash },
    activationStateSchemaVersion: { const: activationStateSchemaVersion },
    evidenceHeaderSchemaVersion: { const: evidenceHeaderSchemaVersion },
    approvalEnvelopeSchemaVersion: { const: approvalEnvelopeSchemaVersion },
    supersessionSchemaVersion: { const: supersessionSchemaVersion },
    credentialPolicySchemaVersion: { const: credentialPolicySchemaVersion }
  } satisfies Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://mission-control.local/liftoff/governance/credential-policy.schema.v2.json',
    title: 'Liftoff governance credential policy v2',
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'identity',
      'repository',
      'owner',
      'authKind',
      'displayNameTemplate',
      'displayName',
      'secretName',
      'createdAt',
      'expiresAt',
      'rotationLeadDays',
      'rotationDueAt',
      'permissions',
      'providerPermissions',
      'providerReadDisclosure',
      'allowedWorkflows',
      'nonForwarding',
      'status',
      'proof',
      'app',
      'pat'
    ],
    properties: {
      schemaVersion: { const: credentialPolicySchemaVersion },
      identity: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(activationIdentityProperties),
        properties: activationIdentityProperties
      },
      repository: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'owner', 'name', 'fullName'],
        properties: {
          id: { type: 'string', minLength: 1 },
          owner: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          fullName: { type: 'string', minLength: 1 }
        }
      },
      owner: { type: 'string', minLength: 1 },
      authKind: { enum: ['github-app', 'fine-grained-pat'] },
      displayNameTemplate: { const: runnerPreflightDisplayNameTemplate },
      displayName: { type: 'string', pattern: '^[A-Za-z0-9_.-]+-runner-preflight-read$' },
      secretName: { const: runnerPreflightSecretName },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      rotationLeadDays: { const: runnerPreflightRotationLeadDays },
      rotationDueAt: { type: 'string', format: 'date-time' },
      permissions: {
        type: 'object',
        additionalProperties: false,
        required: ['repository', 'organization'],
        properties: {
          repository: {
            type: 'array',
            const: [...runnerPreflightRepositoryPermissions]
          },
          organization: {
            type: 'array',
            const: [...runnerPreflightOrganizationPermissions]
          }
        }
      },
      providerPermissions: {
        oneOf: [
          { const: requiredCredentialProviderPermissions('github-app') },
          { const: requiredCredentialProviderPermissions('fine-grained-pat') }
        ]
      },
      providerReadDisclosure: { const: runnerPreflightProviderReadDisclosure },
      allowedWorkflows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'jobs'],
          properties: {
            path: { type: 'string', minLength: 1 },
            jobs: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              uniqueItems: true
            }
          }
        }
      },
      nonForwarding: { const: true },
      status: { enum: ['active', 'expiring', 'expired', 'compromised'] },
      proof: {
        type: 'object',
        additionalProperties: false,
        required: ['verifiedAt', 'readbackDigest', 'readbackProvider', 'payloadFree'],
        properties: {
          verifiedAt: { type: 'string', format: 'date-time' },
          readbackDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          readbackProvider: { enum: ['github-api', 'adapter-fixture'] },
          payloadFree: { const: true }
        }
      },
      app: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['installationId', 'appSlug', 'selection', 'repositoryFullName', 'permissionsVerifiedAt', 'token'],
            properties: {
              installationId: { type: 'integer', minimum: 1 },
              appSlug: { type: 'string', minLength: 1 },
              selection: { const: 'selected-repository' },
              repositoryFullName: { type: 'string', minLength: 1 },
              permissionsVerifiedAt: { type: 'string', format: 'date-time' },
              token: {
                type: 'object',
                additionalProperties: false,
                required: ['strategy', 'ttlSeconds', 'generatedBy'],
                properties: {
                  strategy: { const: 'installation-token' },
                  ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
                  generatedBy: { const: 'github-app' }
                }
              }
            }
          }
        ]
      },
      pat: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['lifetimeDays', 'selectedRepositoryOnly', 'createdBy'],
            properties: {
              lifetimeDays: { const: runnerPreflightPatLifetimeDays },
              selectedRepositoryOnly: { const: true },
              createdBy: { const: 'manual-masked-entry' }
            }
          }
        ]
      }
    },
    allOf: [
      {
        if: { properties: { authKind: { const: 'github-app' } }, required: ['authKind'] },
        then: {
          properties: {
            app: { type: 'object' },
            pat: { type: 'null' },
            providerPermissions: { const: requiredCredentialProviderPermissions('github-app') }
          }
        }
      },
      {
        if: { properties: { authKind: { const: 'fine-grained-pat' } }, required: ['authKind'] },
        then: {
          properties: {
            app: { type: 'null' },
            pat: { type: 'object' },
            providerPermissions: { const: requiredCredentialProviderPermissions('fine-grained-pat') }
          }
        }
      }
    ]
  };
}

export function renderCredentialPolicySchema(): string {
  return canonicalJson(credentialPolicySchema());
}
