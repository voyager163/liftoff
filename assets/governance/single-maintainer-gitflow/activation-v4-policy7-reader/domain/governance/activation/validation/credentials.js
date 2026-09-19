import { credentialPolicySchemaVersion } from '../../policy/identity.js';
                                                                                  
import { runnerPreflightDisplayNameTemplate, runnerPreflightOrganizationPermissions, runnerPreflightPatLifetimeDays, runnerPreflightRepositoryPermissions, runnerPreflightRotationLeadDays, runnerPreflightSecretName } from '../types.js';
import { exact, stringField, integerField, stringArray, enumValue, requireVersion, hexDigest, isoTimestamp, dateDaysBetween, addDaysIso, exactStringSet, assertNoDuplicateStrings } from './common.js';
import { validateActivationIdentity } from './identity.js';

export function validateCredentialRepositoryIdentity(value         , path        )                               {
  const repository = exact(value, ['id', 'owner', 'name', 'fullName'], path);
  const owner = stringField(repository, 'owner', path);
  const name = stringField(repository, 'name', path);
  const fullName = stringField(repository, 'fullName', path);
  if (fullName !== `${owner}/${name}`) {
    throw new Error(`${path}.fullName must equal owner/name.`);
  }
  return {
    id: stringField(repository, 'id', path),
    owner,
    name,
    fullName
  };
}

export function validateCredentialPolicy(value         )                   {
  const policy = exact(value, [
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
  ], 'credentialPolicy');
  requireVersion(policy.schemaVersion, credentialPolicySchemaVersion, 'credentialPolicy.schemaVersion');
  const permissions = exact(policy.permissions, ['repository', 'organization'], 'credentialPolicy.permissions');
  if (policy.nonForwarding !== true) {
    throw new Error('credentialPolicy.nonForwarding must be true.');
  }
  if (policy.secretName !== runnerPreflightSecretName) {
    throw new Error(`credentialPolicy.secretName must be ${runnerPreflightSecretName}.`);
  }
  if (policy.displayNameTemplate !== runnerPreflightDisplayNameTemplate) {
    throw new Error(`credentialPolicy.displayNameTemplate must be ${runnerPreflightDisplayNameTemplate}.`);
  }
  if (!Array.isArray(policy.allowedWorkflows)) {
    throw new Error('credentialPolicy.allowedWorkflows must be an array.');
  }
  if (policy.allowedWorkflows.length === 0) {
    throw new Error('credentialPolicy.allowedWorkflows must contain at least one workflow.');
  }
  const repository = validateCredentialRepositoryIdentity(policy.repository, 'credentialPolicy.repository');
  if (policy.owner !== repository.owner) {
    throw new Error('credentialPolicy.owner must match credentialPolicy.repository.owner.');
  }
  const displayName = stringField(policy, 'displayName', 'credentialPolicy');
  if (displayName !== `${repository.name.toLowerCase()}-runner-preflight-read`) {
    throw new Error('credentialPolicy.displayName must be derived from the canonical repository name.');
  }
  const createdAt = isoTimestamp(policy.createdAt, 'credentialPolicy.createdAt');
  const expiresAt = isoTimestamp(policy.expiresAt, 'credentialPolicy.expiresAt');
  const rotationLeadDays = integerField(policy, 'rotationLeadDays', 'credentialPolicy');
  requireVersion(rotationLeadDays, runnerPreflightRotationLeadDays, 'credentialPolicy.rotationLeadDays');
  const rotationDueAt = isoTimestamp(policy.rotationDueAt, 'credentialPolicy.rotationDueAt');
  if (rotationDueAt !== addDaysIso(expiresAt, -runnerPreflightRotationLeadDays)) {
    throw new Error('credentialPolicy.rotationDueAt must equal expiresAt minus the rotation lead.');
  }
  const repositoryPermissions = stringArray(permissions.repository, 'credentialPolicy.permissions.repository');
  const organizationPermissions = stringArray(permissions.organization, 'credentialPolicy.permissions.organization');
  assertNoDuplicateStrings(repositoryPermissions, 'credentialPolicy.permissions.repository');
  assertNoDuplicateStrings(organizationPermissions, 'credentialPolicy.permissions.organization');
  exactStringSet(repositoryPermissions, runnerPreflightRepositoryPermissions, 'credentialPolicy.permissions.repository');
  exactStringSet(organizationPermissions, runnerPreflightOrganizationPermissions, 'credentialPolicy.permissions.organization');
  const authKind = enumValue                                   (
    policy.authKind,
    new Set(['github-app', 'fine-grained-pat']),
    'credentialPolicy.authKind'
  );
  const proof = exact(policy.proof, ['verifiedAt', 'readbackDigest', 'readbackProvider', 'payloadFree'], 'credentialPolicy.proof');
  if (proof.payloadFree !== true) {
    throw new Error('credentialPolicy.proof.payloadFree must be true.');
  }
  const app = policy.app === null
    ? null
    : exact(policy.app, [
        'installationId',
        'appSlug',
        'selection',
        'repositoryFullName',
        'permissionsVerifiedAt',
        'token'
      ], 'credentialPolicy.app');
  const pat = policy.pat === null
    ? null
    : exact(policy.pat, [
        'lifetimeDays',
        'selectedRepositoryOnly',
        'createdBy'
      ], 'credentialPolicy.pat');
  if (authKind === 'github-app') {
    if (app === null || pat !== null) {
      throw new Error('credentialPolicy.github-app requires app metadata and no PAT metadata.');
    }
    if (integerField(app, 'installationId', 'credentialPolicy.app') <= 0) {
      throw new Error('credentialPolicy.app.installationId must be positive.');
    }
    if (app.selection !== 'selected-repository') {
      throw new Error('credentialPolicy.app.selection must be selected-repository.');
    }
    if (stringField(app, 'repositoryFullName', 'credentialPolicy.app') !== repository.fullName) {
      throw new Error('credentialPolicy.app.repositoryFullName must match the policy repository.');
    }
  } else {
    if (pat === null || app !== null) {
      throw new Error('credentialPolicy.fine-grained-pat requires PAT metadata and no App metadata.');
    }
    requireVersion(pat.lifetimeDays, runnerPreflightPatLifetimeDays, 'credentialPolicy.pat.lifetimeDays');
    if (dateDaysBetween(createdAt, expiresAt) !== runnerPreflightPatLifetimeDays) {
      throw new Error('credentialPolicy fine-grained PAT expiry must be exactly 30 days after creation.');
    }
    if (pat.selectedRepositoryOnly !== true) {
      throw new Error('credentialPolicy.pat.selectedRepositoryOnly must be true.');
    }
    if (pat.createdBy !== 'manual-masked-entry') {
      throw new Error('credentialPolicy.pat.createdBy must be manual-masked-entry.');
    }
  }
  const typedApp = app === null
    ? null
    : {
        installationId: integerField(app, 'installationId', 'credentialPolicy.app'),
        appSlug: stringField(app, 'appSlug', 'credentialPolicy.app'),
        selection: enumValue                       (app.selection, new Set(['selected-repository']), 'credentialPolicy.app.selection'),
        repositoryFullName: stringField(app, 'repositoryFullName', 'credentialPolicy.app'),
        permissionsVerifiedAt: isoTimestamp(app.permissionsVerifiedAt, 'credentialPolicy.app.permissionsVerifiedAt'),
        token: (() => {
          const token = exact(app.token, ['strategy', 'ttlSeconds', 'generatedBy'], 'credentialPolicy.app.token');
          const ttlSeconds = integerField(token, 'ttlSeconds', 'credentialPolicy.app.token');
          if (ttlSeconds <= 0 || ttlSeconds > 3600) {
            throw new Error('credentialPolicy.app.token.ttlSeconds must be between 1 and 3600.');
          }
          return {
            strategy: enumValue                      (token.strategy, new Set(['installation-token']), 'credentialPolicy.app.token.strategy'),
            ttlSeconds,
            generatedBy: enumValue              (token.generatedBy, new Set(['github-app']), 'credentialPolicy.app.token.generatedBy')
          };
        })()
      };
  return {
    schemaVersion: credentialPolicySchemaVersion,
    identity: validateActivationIdentity(policy.identity),
    repository,
    owner: stringField(policy, 'owner', 'credentialPolicy'),
    authKind,
    displayNameTemplate: runnerPreflightDisplayNameTemplate,
    displayName,
    secretName: runnerPreflightSecretName,
    createdAt,
    expiresAt,
    rotationLeadDays: runnerPreflightRotationLeadDays,
    rotationDueAt,
    permissions: {
      repository: [...runnerPreflightRepositoryPermissions],
      organization: [...runnerPreflightOrganizationPermissions]
    },
    allowedWorkflows: (() => {
      const workflowPaths = new Set        ();
      return policy.allowedWorkflows.map((entry, index) => {
      const workflow = exact(entry, ['path', 'jobs'], `credentialPolicy.allowedWorkflows[${index}]`);
      const jobs = stringArray(workflow.jobs, `credentialPolicy.allowedWorkflows[${index}].jobs`);
      if (jobs.length === 0) {
        throw new Error(`credentialPolicy.allowedWorkflows[${index}].jobs must contain at least one job.`);
      }
      assertNoDuplicateStrings(jobs, `credentialPolicy.allowedWorkflows[${index}].jobs`);
      const workflowPath = stringField(workflow, 'path', `credentialPolicy.allowedWorkflows[${index}]`);
      if (!workflowPath.startsWith('.github/workflows/')) {
        throw new Error(`credentialPolicy.allowedWorkflows[${index}].path must be a GitHub Actions workflow path.`);
      }
      if (workflowPaths.has(workflowPath)) {
        throw new Error(`credentialPolicy.allowedWorkflows contains duplicate workflow ${workflowPath}.`);
      }
      workflowPaths.add(workflowPath);
      return {
        path: workflowPath,
        jobs
      };
      });
    })(),
    nonForwarding: true,
    status: enumValue(policy.status, new Set(['active', 'expiring', 'expired', 'compromised']), 'credentialPolicy.status'),
    proof: {
      verifiedAt: isoTimestamp(proof.verifiedAt, 'credentialPolicy.proof.verifiedAt'),
      readbackDigest: hexDigest(proof.readbackDigest, 'credentialPolicy.proof.readbackDigest'),
      readbackProvider: enumValue(proof.readbackProvider, new Set(['github-api', 'adapter-fixture']), 'credentialPolicy.proof.readbackProvider'),
      payloadFree: true
    },
    app: typedApp,
    pat: pat === null
      ? null
      : {
          lifetimeDays: runnerPreflightPatLifetimeDays,
          selectedRepositoryOnly: true,
          createdBy: 'manual-masked-entry'
        }
  };
}
