import { canonicalJson } from './canonical-json.js';
import { currentActivationIdentity } from './graph.js';
import { createModernActivationIdentityReader } from './modern-identity.js';
import type { ModernActivationSourceInput } from './modern-record-contracts.js';
import type { ManifestContractContext } from '../../project/manifest/context.js';
import {
  activationContractVersion,
  activationStateSchemaVersion,
  approvalEnvelopeSchemaVersion,
  credentialPolicySchemaVersion,
  evidenceHeaderSchemaVersion,
  governanceActivationPolicyVersion,
  liftoffActivationPackageVersion,
  liftoffManifestArtifactVersion,
  phaseGraphSchemaVersion,
  supersessionSchemaVersion
} from '../policy/identity.js';
import {
  runnerPreflightDisplayNameTemplate,
  runnerPreflightOrganizationPermissions,
  runnerPreflightPatLifetimeDays,
  runnerPreflightRepositoryPermissions,
  runnerPreflightRotationLeadDays,
  runnerPreflightSecretName
} from './types.js';

function credentialPolicySchema(): Record<string, unknown> {
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
  return credentialPolicySchemaForIdentity(activationIdentityProperties, credentialPolicySchemaVersion);
}

function credentialPolicySchemaForIdentity(
  activationIdentityProperties: Record<string, unknown>,
  schemaVersion: 1 | 2
): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://mission-control.local/liftoff/governance/credential-policy.schema.v${schemaVersion}.json`,
    title: `Liftoff governance credential policy v${schemaVersion}`,
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
      'allowedWorkflows',
      'nonForwarding',
      'status',
      'proof',
      'app',
      'pat'
    ],
    properties: {
      schemaVersion: { const: schemaVersion },
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
            pat: { type: 'null' }
          }
        }
      },
      {
        if: { properties: { authKind: { const: 'fine-grained-pat' } }, required: ['authKind'] },
        then: {
          properties: {
            app: { type: 'null' },
            pat: { type: 'object' }
          }
        }
      }
    ]
  };
}

export function renderCredentialPolicySchema(): string {
  return canonicalJson(credentialPolicySchema());
}

/** A schema for the validated modern identity, not an enrolled credential or readback receipt. */
export function renderModernCredentialPolicySchema(
  catalog: ManifestContractContext['catalog'],
  input: ModernActivationSourceInput
): string {
  const identity = createModernActivationIdentityReader(catalog).validateReadableModernActivationIdentity(input);
  const properties = Object.fromEntries(Object.entries(identity).map(([key, value]) => [key, { const: value }]));
  return canonicalJson(credentialPolicySchemaForIdentity(properties, identity.credentialPolicySchemaVersion));
}
