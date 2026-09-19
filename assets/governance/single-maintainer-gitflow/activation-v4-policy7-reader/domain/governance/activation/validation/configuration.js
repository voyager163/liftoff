import { normalizeApprovalCostCeiling } from '../approvals.js';
                                                                                                    
import { phaseIdSet, record, exact, exactWithOptional, stringField, booleanField, integerField, publicJson, enumValue, requireVersion, hexDigest } from './common.js';

export function validateActivationConfiguration(value         )                          {
  const config = exactWithOptional(value, ['schemaVersion', 'phases'], ['repository', 'azure', 'budget'], 'activationInputs');
  requireVersion(config.schemaVersion, 1, 'activationInputs.schemaVersion');
  const phases                                    = {};
  for (const [id, inputs] of Object.entries(record(config.phases, 'activationInputs.phases'))) {
    const phaseId = enumValue         (id, phaseIdSet, 'activationInputs.phases');
    phases[phaseId] = record(publicJson(inputs, `activationInputs.phases.${id}`), `activationInputs.phases.${id}`);
  }
  let repository                                       ;
  if (config.repository !== undefined) {
    const target = exactWithOptional(config.repository, ['name'], ['defaultBranch', 'visibility', 'create'], 'activationInputs.repository');
    const name = stringField(target, 'name', 'activationInputs.repository');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)) {
      throw new Error('activationInputs.repository.name must be owner/repository.');
    }
    const defaultBranch = target.defaultBranch === undefined ? undefined : stringField(target, 'defaultBranch', 'activationInputs.repository');
    if (defaultBranch !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(defaultBranch) ||
      defaultBranch.includes('..') || defaultBranch.includes('//') || defaultBranch.endsWith('/') || defaultBranch.endsWith('.lock'))) {
      throw new Error('activationInputs.repository.defaultBranch must be a safe Git branch name.');
    }
    repository = {
      name,
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
      ...(target.visibility === undefined ? {} : { visibility: enumValue                      (target.visibility, new Set(['private', 'public']), 'activationInputs.repository.visibility') }),
      ...(target.create === undefined ? {} : { create: booleanField(target, 'create', 'activationInputs.repository') })
    };
  }
  let azure                                  ;
  if (config.azure !== undefined) {
    const target = exact(config.azure, ['subscriptionId', 'tenantId', 'region'], 'activationInputs.azure');
    const subscriptionId = stringField(target, 'subscriptionId', 'activationInputs.azure');
    const tenantId = stringField(target, 'tenantId', 'activationInputs.azure');
    const region = stringField(target, 'region', 'activationInputs.azure');
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
    const nil = '00000000-0000-0000-0000-000000000000';
    if (!uuid.test(subscriptionId) || !uuid.test(tenantId) || subscriptionId === nil || tenantId === nil ||
      !/^[a-z][a-z0-9]+$/u.test(region)) {
      throw new Error('activationInputs.azure requires concrete subscription/tenant GUIDs and an Azure region name.');
    }
    azure = { subscriptionId: subscriptionId.toLowerCase(), tenantId: tenantId.toLowerCase(), region };
  }
  let budget                                   ;
  if (config.budget !== undefined) {
    const cost = exact(config.budget, ['currency', 'fixedMonthlyCents', 'usageMonthlyCents'], 'activationInputs.budget');
    budget = normalizeApprovalCostCeiling({
      currency: stringField(cost, 'currency', 'activationInputs.budget'),
      fixedMonthlyCents: integerField(cost, 'fixedMonthlyCents', 'activationInputs.budget'),
      usageMonthlyCents: integerField(cost, 'usageMonthlyCents', 'activationInputs.budget')
    });
  }
  return { schemaVersion: 1, phases, ...(repository ? { repository } : {}), ...(azure ? { azure } : {}), ...(budget ? { budget } : {}) };
}

export function validateActivationConfigurationBinding(value         )                                 {
  const binding = exact(value, ['schemaVersion', 'reference', 'digest'], 'configurationBinding');
  requireVersion(binding.schemaVersion, 1, 'configurationBinding.schemaVersion');
  const reference = stringField(binding, 'reference', 'configurationBinding');
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\)/u.test(reference) || reference.includes('\0')) {
    throw new Error('Configuration binding requires the original canonical absolute input reference.');
  }
  publicJson(reference, 'configurationBinding.reference');
  return { schemaVersion: 1, reference, digest: hexDigest(binding.digest, 'configurationBinding.digest') };
}
