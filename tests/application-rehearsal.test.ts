import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { evidenceBodyDigest, evidenceHeaderDigest } from '../src/domain/governance/activation/evidence.js';
import type { PhaseAdapterExecutionInput, PhaseAdapterOutcome, PhasePlanningInput } from '../src/governance-activation/transition-ports.js';
import type { StateBackendMetadata } from '../src/domain/repair/stateful.js';
import type { TransitionOperation } from '../src/domain/governance/activation/types.js';
import { stateBindingDigest, stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import { storePhaseReview } from '../src/governance-activation/phase-reviews.js';
import { evidenceHeaderFor } from '../src/governance-activation/transition-records.js';
import { assertAzurePhaseAuthority } from '../src/application/azure-activation/authority.js';
import {
  applicationPrivateProtocol, type ApplicationPrivateAuthority, type ApplicationPrivateSavedPlan
} from '../src/application/azure-activation/application-private-contracts.js';
import {
  applicationRehearsalBinding, applicationRehearsalCompanionOperations, applicationRehearsalInputs,
  applicationRehearsalPrivateInputs, applicationRehearsalPrivateIntent, applicationRehearsalProtocol, rehearsalRecord,
  rehearsalPrivateArtifact, requireApplicationRehearsalStaging,
  type ApplicationRehearsalInputs, type ApplicationRehearsalPrivateReview
} from '../src/application/azure-activation/application-rehearsal-inputs.js';
import {
  applicationRehearsalEngineSeamBlocker, applicationRehearsalReviewOutcome,
  assertIssuedApplicationRehearsalAuthority, executeApplicationRehearsalExecution, planApplicationRehearsalExecution,
  type ApplicationRehearsalPrivateAuthority
} from '../src/application/azure-activation/application-rehearsal-execution.js';
import {
  assertIssuedApplicationRehearsalAuthority as assertOwnedRehearsalAuthority,
  createApplicationRehearsalAuthority
} from '../src/application/azure-activation/application-rehearsal-authority.js';
import {
  ApplicationRehearsalRecordStore, applicationRehearsalStepReview, assertApplicationRehearsalInventoryRestored,
  assertApplicationRehearsalNativeReadbackInputs, assertApplicationRehearsalStateRestored,
  publicApplicationRehearsalInventory, readApplicationRehearsalBuild,
  readApplicationRehearsalInventory, readApplicationRehearsalPhaseReview, readCompletedApplicationRehearsalReceipt,
  type ApplicationRehearsalRetainedStep,
  type ApplicationRehearsalStepKind, type CompletedApplicationRehearsalReceipt
} from '../src/application/azure-activation/application-rehearsal-receipt.js';
import { currentGovernanceManifest } from './governance-activation-fixtures.js';
import { custody, fixtureBinding, privateActivationFixture, privateTarget } from './helpers/private-activation-fixture.js';
import { applicationArtifactFixture } from './helpers/application-artifact-fixture.js';

const runFile = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === 'production-rehearsed')!;
const group = `/subscriptions/${fixtureBinding.subscriptionId}/resourceGroups/rg-app`;
const appId = `${group}/providers/Microsoft.App/containerApps/application`;
const environmentId = `${group}/providers/Microsoft.App/managedEnvironments/application-environment`;
const registryId = `${group}/providers/Microsoft.ContainerRegistry/registries/crliftoff`;
const identityId = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload`;
const address = 'module.application.azurerm_container_app.application';
const secret = 'SYNTHETIC_PRIVATE_REHEARSAL_CONFIGURATION';
const evidence = (id: string) => ({ evidenceId: id, headerDigest: canonicalSha256(`${id}-header`), bodyDigest: canonicalSha256(`${id}-body`) });

function configuration(root: string): ApplicationRehearsalInputs {
  const held = custody(root), backend = privateTarget();
  backend.backend.key = 'production.tfstate';
  const candidate = {
    evidence: evidence('candidate'), imageRef: `crliftoff.azurecr.io/team/app@sha256:${'c'.repeat(64)}`,
    sourceSha: 'b'.repeat(40), registryResourceId: registryId
  };
  const baseline = {
    artifact: {
      evidence: evidence('baseline'), imageRef: `crliftoff.azurecr.io/team/app@sha256:${'d'.repeat(64)}`,
      sourceSha: 'a'.repeat(40), registryResourceId: registryId
    },
    revisionName: 'application--baseline',
    workloadIdentity: {
      resourceId: identityId, principalId: '11111111-2222-4333-8444-555555555559',
      clientId: '11111111-2222-4333-8444-555555555558', tenantId: fixtureBinding.tenantId
    }
  };
  return {
    disposableTarget: {
      authorityKind: 'disposable-operator-qualification',
      target: {
        environment: 'prod', subscriptionId: fixtureBinding.subscriptionId, tenantId: fixtureBinding.tenantId,
        resourceGroup: 'rg-app', appName: 'application', resourceId: appId
      },
      actor: { operator: 'isolated-fixture-operator', githubActorId: 7, azurePrincipalId: fixtureBinding.principalId },
      spendCeilingCents: 50, maxDurationMinutes: 20,
      permittedEffects: ['azure-read', 'github-read', 'azure-resource-provision', 'backend-state-read', 'backend-state-write'],
      notBefore: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-15T00:15:00.000Z'
    },
    privateExecution: {
      schemaVersion: 1, mode: 'prepare', scope: 'rehearsal-rollout', binding: fixtureBinding, backend, custody: held,
      writer: {
        ...fixtureBinding, clientId: '11111111-2222-4333-8444-555555555557',
        account: '42', keychainPath: held.keyReference.keychainPath, service: 'org.liftoff.azure-application-writer.fixture'
      },
      source: {
        rootPathParts: ['infrastructure', 'opentofu', 'azure', 'environments', 'prod'],
        backendPathParts: ['infrastructure', 'opentofu', 'azure', 'environments', 'prod', 'backend.tf'],
        variablesRef: `state-workspace:${held.workspaceId}/${randomUUID()}`,
        provider: {
          source: 'registry.opentofu.org/hashicorp/azurerm', version: '4.30.0',
          mirrorDirectory: path.join(root, 'mirror'),
          binary: { path: path.join(root, 'mirror', 'terraform-provider-azurerm'), sha256: canonicalSha256('isolated-provider') }
        }
      },
      targets: [{
        address, type: 'azurerm_container_app', resourceId: appId, actions: ['update'], role: null,
        expected: {
          name: 'application', resource_group_name: 'rg-app', container_app_environment_id: environmentId,
          revision_mode: 'Single', 'tags.liftoff-repository-id': '42',
          'identity.0.type': 'UserAssigned', 'identity.0.identity_ids.0': identityId,
          'template.0.container.0.image': candidate.imageRef,
          'template.0.container.0.name': 'app', 'template.0.container.0.cpu': 0.25, 'template.0.container.0.memory': '0.5Gi',
          'template.0.min_replicas': 1, 'template.0.max_replicas': 1,
          'ingress.0.external_enabled': true, 'ingress.0.target_port': 8080, 'ingress.0.transport': 'auto'
        },
        runtime: { url: 'https://application.fixture.azurecontainerapps.io/health', statusField: 'status', statusValue: 'ok' }
      }],
      artifact: rehearsalPrivateArtifact(candidate), maxCommandMs: 5000,
      notBefore: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-15T00:15:00.000Z', releaseUntil: '2026-09-15T00:16:00.000Z'
    },
    rehearsal: { stage: 'rollout', staging: evidence('staging'), baseline, candidate, rolloutReview: null, rollbackReview: null }
  };
}

function review(config: ApplicationRehearsalInputs): ApplicationRehearsalPrivateReview {
  const p = config.privateExecution;
  return {
    schemaVersion: 1, protocol: applicationPrivateProtocol, phaseId: 'production-rehearsed', transactionId: randomUUID(),
    journalRef: `state-workspace:${p.custody.workspaceId}/${randomUUID()}`,
    planRef: `state-workspace:${p.custody.workspaceId}/${randomUUID()}`,
    intentDigest: canonicalSha256({
      protocol: applicationPrivateProtocol, intent: applicationRehearsalPrivateIntent(p),
      budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 }
    }), sourceDigest: canonicalSha256('original-source'),
    backendBindingDigest: stateBindingDigest(p.backend.backend), binding: p.binding, artifact: p.artifact,
    tools: {
      tofu: p.custody.tools.tofu.sha256, python: p.custody.tools.python.sha256, provider: p.source.provider.binary.sha256,
      providerVersion: p.source.provider.version, hostId: p.custody.tools.hostId
    },
    changes: [{
      address, type: 'azurerm_container_app', action: 'update', targetResourceId: appId,
      changedAttributes: ['template'], computedOutputs: ['latest_revision_name', 'latest_revision_fqdn']
    }], expiresAt: p.expiresAt
  };
}

function setStage(config: ApplicationRehearsalInputs, stage: 'rollout' | 'rollback' | 'verify', mode: 'prepare' | 'apply' | 'recover') {
  const result = structuredClone(config), p = result.privateExecution;
  if (p.mode !== 'prepare') throw new Error('Fixture stage creation always starts from the original intent.');
  const selected = stage === 'rollout' ? result.rehearsal.candidate : result.rehearsal.baseline.artifact;
  p.scope = stage === 'rollout' ? 'rehearsal-rollout' : 'rehearsal-rollback';
  p.artifact = rehearsalPrivateArtifact(selected);
  p.targets = p.targets.map((target) => ({
    ...target, expected: { ...target.expected, 'template.0.container.0.image': selected.imageRef }
  }));
  result.rehearsal.stage = stage;
  const ref = { sourcePlanDigest: canonicalSha256('original-plan'), reviewDigest: canonicalSha256('original-review') };
  result.rehearsal.rolloutReview = stage === 'rollout' && mode === 'prepare' ? null : ref;
  result.rehearsal.rollbackReview = stage === 'rollout' || mode === 'prepare' ? null : ref;
  const reviewed = review(result);
  result.privateExecution = mode === 'prepare' ? p : mode === 'apply' ? { ...p, mode, reviewed } : {
    ...p, mode, reviewed, recovery: 'inspect', checkpoint: { transactionId: reviewed.transactionId, journalRef: reviewed.journalRef },
    candidateRef: null, recoveryWindow: { notBefore: p.notBefore, expiresAt: p.expiresAt, releaseUntil: p.releaseUntil }
  };
  return result;
}

async function fixture() {
  const f = await privateActivationFixture('production-rehearsed', {});
  cleanups.push(f.cleanup);
  f.inspection.manifest = parseManifest(currentGovernanceManifest('Production rehearsal fixture', ['dev', 'staging', 'prod']));
  const config = configuration(f.root);
  f.inspection.activationInputs!.budget = { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 };
  const install = (value: ApplicationRehearsalInputs) => {
    f.inspection.activationInputs!.phases['production-rehearsed'] = structuredClone({ ...value });
  };
  install(config);
  const diagnostic: TransitionOperation = {
    phaseId: 'production-rehearsed', adapter: 'azure-opentofu', actionId: 'azure.production-readback',
    mutationClass: 'azure-read', remote: true, destructive: false,
    destination: { type: 'subscription', identity: appId, subscriptionId: fixtureBinding.subscriptionId },
    inputs: { purpose: 'isolated-retention-and-reader-tests-only' }
  };
  const input = await f.execution({ operations: [diagnostic] });
  input.clock = () => f.now;
  const authority = (execution: PhaseAdapterExecutionInput): ApplicationPrivateAuthority => ({
    input: execution, operation: diagnostic, operations: [diagnostic],
    async assertCurrent() { await assertAzurePhaseAuthority(execution, diagnostic); },
    async assertRelease() { throw new Error('Read-only fixture never releases or acquires a cloud lease.'); }
  });
  return {
    ...f, config, input, install, diagnostic, authority,
    planning(): PhasePlanningInput { return { ...f.planning(), adapters: input.adapters }; }
  };
}

async function retained(f: Awaited<ReturnType<typeof fixture>>, kind: ApplicationRehearsalStepKind = 'rollout-prepared') {
  return withProjectMutationLock(f.projectRoot, async (lease) => {
    const input = { ...f.input, lease }, authority = f.authority(input), store = new ApplicationRehearsalRecordStore(input, f.config);
    const found = await store.find();
    const root = found.root ?? await store.start(0, canonicalSha256('original-source'), authority);
    const step: ApplicationRehearsalRetainedStep = {
      schemaVersion: 1, protocol: applicationRehearsalProtocol, rootDigest: canonicalSha256(root), kind,
      plan: input.plan, reviewed: review(f.config), recordedAt: f.now.toISOString(),
      snapshot: {
        ref: `state-workspace:${f.config.privateExecution.custody.workspaceId}/${randomUUID()}`,
        purpose: 'inspection', scope: canonicalSha256('private-scope'), digest: canonicalSha256('not-execution-proof')
      }
    };
    return { root, step, store, input, authority };
  });
}

function initialProvider(config: ApplicationRehearsalInputs) {
  const template = {
    containers: [{
      name: 'app', image: config.rehearsal.baseline.artifact.imageRef, resources: { cpu: 0.25, memory: '0.5Gi' },
      env: [{ name: 'PRIVATE_SETTING', value: secret }, { name: 'DB', secretRef: 'database' }], command: [], args: []
    }], scale: { minReplicas: 1, maxReplicas: 1 }
  };
  const identity = config.rehearsal.baseline.workloadIdentity;
  const app = {
    id: appId, name: 'application', type: 'Microsoft.App/containerApps', location: 'eastus', tags: { 'liftoff-repository-id': '42' },
    identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: { principalId: identity.principalId, clientId: identity.clientId } } },
    properties: {
      provisioningState: 'Succeeded', runningStatus: 'Running', latestRevisionName: 'application--baseline', latestReadyRevisionName: 'application--baseline',
      managedEnvironmentId: environmentId,
      configuration: {
        activeRevisionsMode: 'Single', registries: [{ server: 'crliftoff.azurecr.io', identity: identityId }],
        ingress: { fqdn: 'application.fixture.azurecontainerapps.io', external: true, targetPort: 8080, transport: 'auto',
          traffic: [{ latestRevision: true, weight: 100 }] },
        secrets: [{ name: 'database', keyVaultUrl: 'https://fixture.vault.azure.net/secrets/database/original-version', identity: identityId }]
      }, template
    }
  };
  const attributes = {
    id: appId, name: 'application', resource_group_name: 'rg-app', tags: { 'liftoff-repository-id': '42' },
    container_app_environment_id: environmentId, revision_mode: 'Single',
    identity: [{ type: 'UserAssigned', identity_ids: [identityId] }],
    template: [{ min_replicas: 1, max_replicas: 1, container: [{
      name: 'app', image: config.rehearsal.baseline.artifact.imageRef, cpu: 0.25, memory: '0.5Gi',
      env: [{ name: 'PRIVATE_SETTING', value: secret }, { name: 'DB', secret_name: 'database' }]
    }] }],
    registry: [{ server: 'crliftoff.azurecr.io', identity: identityId }],
    ingress: [{ external_enabled: true, target_port: 8080, transport: 'auto', traffic_weight: [{ percentage: 100, latest_revision: true }] }],
    secret: [{ name: 'database', value: secret }],
    latest_revision_name: 'application--baseline', latest_revision_fqdn: 'application--baseline.fixture.azurecontainerapps.io'
  };
  return {
    app, revisions: [{
      id: `${appId}/revisions/application--baseline`, name: 'application--baseline', type: 'Microsoft.App/containerApps/revisions',
      properties: { active: true, provisioningState: 'Provisioned', healthState: 'Healthy', runningState: 'Running', template }
    }],
    identity: {
      id: identityId, name: 'workload', type: 'Microsoft.ManagedIdentity/userAssignedIdentities', tags: { 'liftoff-repository-id': '42' },
      properties: { principalId: identity.principalId, clientId: identity.clientId, tenantId: identity.tenantId }
    },
    registry: {
      id: registryId, name: 'crliftoff', type: 'Microsoft.ContainerRegistry/registries', tags: { 'liftoff-repository-id': '42' },
      properties: { provisioningState: 'Succeeded', loginServer: 'crliftoff.azurecr.io', adminUserEnabled: false }
    },
    native: {
      version: 4, terraform_version: '1.12.6', lineage: randomUUID(), serial: 1,
      outputs: { secret: { value: secret, type: 'string', sensitive: true } },
      resources: [{
        module: 'module.application', mode: 'managed', type: 'azurerm_container_app', name: 'application',
        provider: 'provider["registry.opentofu.org/hashicorp/azurerm"]',
        instances: [{ schema_version: 2, attributes, private: 'UNCHANGED_PROVIDER_PRIVATE', dependencies: ['azurerm_container_registry.owned'] }]
      }, {
        mode: 'managed', type: 'azurerm_container_registry', name: 'owned',
        provider: 'provider["registry.opentofu.org/hashicorp/azurerm"]',
        instances: [{ schema_version: 2, attributes: { id: registryId, name: 'crliftoff', admin_enabled: false } }]
      }]
    }
  };
}

async function providerFixture() {
  const f = await fixture();
  const filename = path.join(f.root, 'provider.json'), script = path.join(f.root, 'provider.mjs'), audit = path.join(f.root, 'provider-audit.jsonl');
  await writeFile(filename, JSON.stringify(initialProvider(f.config)), { mode: 0o600 });
  await writeFile(audit, '', { mode: 0o600 });
  await writeFile(script, `
import fs from 'node:fs';
import crypto from 'node:crypto';
const [file, audit, command, target, image] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (command === 'transition') {
  if (!['rollout', 'rollback'].includes(target)) process.exit(64);
  const name = 'application--' + target;
  state.app.properties.latestRevisionName = name;
  state.app.properties.latestReadyRevisionName = name;
  state.app.properties.template.containers[0].image = image;
  for (const revision of state.revisions) revision.properties.active = false;
  state.revisions.push({ id: state.app.id + '/revisions/' + name, name, type: 'Microsoft.App/containerApps/revisions',
    properties: { active: true, provisioningState: 'Provisioned', healthState: 'Healthy', runningState: 'Running',
      template: structuredClone(state.app.properties.template) } });
  const attributes = state.native.resources[0].instances[0].attributes;
  attributes.template[0].container[0].image = image;
  attributes.latest_revision_name = name;
  attributes.latest_revision_fqdn = name + '.fixture.azurecontainerapps.io';
  state.native.serial++;
  fs.writeFileSync(file, JSON.stringify(state), { mode: 384 });
  fs.appendFileSync(audit, JSON.stringify({ kind: 'fixture-transition', target }) + '\\n');
} else if (command === 'read') {
  let data;
  if (target === state.app.id) data = state.app;
  else if (target === state.app.id + '/revisions') data = { value: state.revisions };
  else if (target === state.identity.id) data = state.identity;
  else if (target === state.registry.id) data = state.registry;
  else data = state.revisions.find(revision => revision.id === target);
  if (!data) process.exit(66);
  const requestId = crypto.randomUUID();
  fs.appendFileSync(audit, JSON.stringify({ kind: 'independent-get', target, requestId }) + '\\n');
  process.stdout.write(JSON.stringify({ status: 200, requestId, data }));
} else if (command === 'state') {
  fs.appendFileSync(audit, JSON.stringify({ kind: 'independent-native-state-read' }) + '\\n');
  process.stdout.write(JSON.stringify(state.native));
} else process.exit(64);
`, { mode: 0o600 });
  const run = async (command: string, target = '', image = '') => runFile(process.execPath,
    [script, filename, audit, command, target, image], { timeout: 5000, maxBuffer: 1024 * 1024 });
  const input: PhaseAdapterExecutionInput = {
    ...f.input, adapters: {
      ...f.input.adapters, azureActivation: {
        storage: f.storage, transport: {
          async request(request, binding) {
            expect(request.method).toBe('GET');
            expect(binding).toEqual(fixtureBinding);
            const response = rehearsalRecord(JSON.parse((await run('read', request.resourceId)).stdout));
            return { status: 200, requestId: String(response.requestId), data: response.data };
          }
        }
      }
    }
  };
  const operation = applicationRehearsalCompanionOperations(f.planning(), f.config, canonicalSha256('original-source'))[1];
  const read = (image: string) => withProjectMutationLock(f.projectRoot, (lease) => {
    const current = { ...input, lease };
    return readApplicationRehearsalInventory(current, f.config, operation, image, f.authority(current));
  });
  const bytes = async () => Buffer.from((await run('state')).stdout);
  const metadata: StateBackendMetadata = {
    backendId: f.config.privateExecution.backend.backend.id, bindingDigest: stateBindingDigest(f.config.privateExecution.backend.backend),
    exists: true, version: 'fixture-v1', etag: '"fixture-etag"', size: 1, observedAt: f.now.getTime()
  };
  const mutate = async (change: (state: ReturnType<typeof initialProvider>) => void) => {
    const state: ReturnType<typeof initialProvider> = JSON.parse(await readFile(filename, 'utf8'));
    change(state);
    await writeFile(filename, JSON.stringify(state), { mode: 0o600 });
  };
  return {
    ...f, input, operation, read, bytes, metadata, mutate,
    transition: (stage: 'rollout' | 'rollback') => run('transition', stage,
      stage === 'rollout' ? f.config.rehearsal.candidate.imageRef : f.config.rehearsal.baseline.artifact.imageRef),
    audit: async () => (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map((line) => rehearsalRecord(JSON.parse(line)))
  };
}

describe('production rehearsal exact staged inputs', () => {
  it('admits only the explicit existing prod target and exact stage schema without preparatory outputs', async () => {
    const f = await fixture();
    expect(applicationRehearsalInputs(f.planning())).toEqual(f.config);
    for (const [stage, mode] of [
      ['rollout', 'apply'], ['rollback', 'prepare'], ['rollback', 'apply'], ['verify', 'recover']
    ] as const) {
      const config = setStage(f.config, stage, mode);
      f.install(config);
      expect(applicationRehearsalInputs(f.planning())).toEqual(config);
    }
    expect(f.inspection.state.phaseOutputs?.['production-rehearsed']).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['missing actor', (config: Record<string, unknown>) => { delete rehearsalRecord(rehearsalRecord(config.disposableTarget).actor).operator; }],
    ['monthly budget as disposable authority', (config: Record<string, unknown>) => { delete rehearsalRecord(config.disposableTarget).spendCeilingCents; }],
    ['unknown success ledger', (config: Record<string, unknown>) => { config.nativeQualification = { successful: true }; }],
    ['caller rollback report', (config: Record<string, unknown>) => { rehearsalRecord(config.rehearsal).rollbackSucceeded = true; }],
    ['a dev root', (config: Record<string, unknown>) => {
      rehearsalRecord(rehearsalRecord(config.privateExecution).source).rootPathParts = ['infrastructure', 'opentofu', 'azure', 'environments', 'dev'];
    }],
    ['resource creation', (config: Record<string, unknown>) => {
      const targets = rehearsalRecord(config.privateExecution).targets;
      if (!Array.isArray(targets)) throw new Error('Fixture targets missing.');
      rehearsalRecord(targets[0]).actions = ['create'];
    }],
    ['wrong writer principal', (config: Record<string, unknown>) => { rehearsalRecord(rehearsalRecord(config.privateExecution).writer).principalId = randomUUID(); }],
    ['a foreign state owner', (config: Record<string, unknown>) => { rehearsalRecord(rehearsalRecord(rehearsalRecord(config.privateExecution).backend).backend).ownerId = '99'; }],
    ['same baseline and candidate', (config: Record<string, unknown>) => {
      const value = rehearsalRecord(config.rehearsal);
      rehearsalRecord(value.baseline).artifact = value.candidate;
    }],
    ['blanket effect duplicate', (config: Record<string, unknown>) => { rehearsalRecord(config.disposableTarget).permittedEffects = ['azure-read', 'azure-read']; }],
    ['oversized duration', (config: Record<string, unknown>) => { rehearsalRecord(config.disposableTarget).maxDurationMinutes = 121; }],
    ['window outside disposable grant', (config: Record<string, unknown>) => { rehearsalRecord(config.privateExecution).expiresAt = '2026-09-15T00:17:00.000Z'; }]
  ])('rejects %s before any provider or process access', async (_name, change) => {
    const f = await fixture(), data: Record<string, unknown> = structuredClone({ ...f.config });
    change(data);
    f.inspection.activationInputs!.phases['production-rehearsed'] = data;
    expect(() => applicationRehearsalInputs(f.planning())).toThrow();
    expect((await executeApplicationRehearsalExecution(f.input)).status).toBe('blocked');
    expect(f.calls).toEqual([]);
  });

  it('cannot reinterpret a verify request as apply, publish or closed-unapplied recovery', async () => {
    const f = await fixture();
    f.install(setStage(f.config, 'verify', 'apply'));
    expect(() => applicationRehearsalInputs(f.planning())).toThrow(/verify-read-only/u);
    const config = setStage(f.config, 'verify', 'recover');
    const raw: Record<string, unknown> = structuredClone({ ...config.privateExecution });
    raw.recovery = 'close-unapplied';
    expect(() => applicationRehearsalPrivateInputs(raw)).toThrow(/recovery-no-reapply/u);
    raw.recovery = 'publish-retained';
    expect(() => applicationRehearsalPrivateInputs(raw)).toThrow(/recovery-original/u);
    raw.candidateRef = `state-workspace:${config.privateExecution.custody.workspaceId}/${randomUUID()}`;
    expect(applicationRehearsalPrivateInputs(raw).mode).toBe('recover');
    f.inspection.activationInputs!.phases['production-rehearsed'] = { ...config, privateExecution: raw };
    expect(() => applicationRehearsalInputs(f.planning())).toThrow(/verify-read-only/u);
  });

  it('permits bounded inspection of an interrupted preparation without inventing a saved-plan review', async () => {
    const f = await fixture(), config = setStage(f.config, 'rollout', 'recover');
    if (config.privateExecution.mode !== 'recover') throw new Error('Expected fixture recovery.');
    config.privateExecution.reviewed = null;
    config.rehearsal.rolloutReview = null;
    f.install(config);
    expect(applicationRehearsalInputs(f.planning())).toEqual(config);
    config.privateExecution.recovery = 'publish-retained';
    f.install(config);
    expect(() => applicationRehearsalInputs(f.planning())).toThrow(/original-review-required/u);
    expect(f.calls).toEqual([]);
  });

  it.each(['variables', 'tool'] as const)('does not let an original saved-plan review approve substituted %s', async (field) => {
    const f = await fixture(), config = setStage(f.config, 'rollout', 'apply');
    if (field === 'variables') config.privateExecution.source.variablesRef =
      `state-workspace:${config.privateExecution.custody.workspaceId}/${randomUUID()}`;
    else config.privateExecution.custody.tools.tofu.sha256 = canonicalSha256('another-native-tool');
    f.install(config);
    expect(() => applicationRehearsalInputs(f.planning())).toThrow(/exact-original-intent-and-tools/u);
    expect(f.calls).toEqual([]);
  });

  it('keeps source/artifact/actor/backend binding stable across the rollback handoff, but not across substitution', async () => {
    const f = await fixture(), rollback = setStage(f.config, 'rollback', 'prepare');
    rollback.privateExecution.source.variablesRef = `state-workspace:${rollback.privateExecution.custody.workspaceId}/${randomUUID()}`;
    expect(applicationRehearsalBinding(rollback)).toBe(applicationRehearsalBinding(f.config));
    rollback.rehearsal.baseline.artifact.sourceSha = 'e'.repeat(40);
    expect(applicationRehearsalBinding(rollback)).not.toBe(applicationRehearsalBinding(f.config));
  });

  it('declares GH source/build reads and independent revision/backend reads without a fabricated dispatch', async () => {
    const f = await fixture();
    const readResource = f.config.privateExecution.backend.privateEndpointId;
    const operations = applicationRehearsalCompanionOperations(f.planning(), f.config, canonicalSha256('source'), [readResource]);
    expect(operations[0]).toMatchObject({ actionId: 'github.application-rehearsal.source-receipt', mutationClass: 'github-read' });
    expect(operations[1]).toMatchObject({ actionId: 'azure.application-rehearsal.receipt', mutationClass: 'backend-state-read' });
    expect(operations[1].effects?.map((entry) => entry.destination.identity)).toEqual(expect.arrayContaining([
      appId, `${appId}/revisions`, `${appId}/revisions/application--baseline`, readResource
    ]));
    expect(operations.flatMap((entry) => [entry, ...entry.effects ?? []]).some((entry) =>
      ['github-workflow-dispatch', 'azure-resource-provision', 'registry-publish', 'backend-state-write'].includes(entry.mutationClass))).toBe(false);
    const rollback = setStage(f.config, 'rollback', 'prepare');
    rollback.disposableTarget.notBefore = '2026-09-15T00:01:00.000Z';
    expect(applicationRehearsalCompanionOperations(f.planning(), rollback, canonicalSha256('source'))[0]).toEqual(operations[0]);
  });

  it('requires current qualified staging, not missing or caller-authored source assertions', async () => {
    const f = await fixture();
    expect(() => requireApplicationRehearsalStaging(f.planning(), f.config)).toThrow(/original activation receipt/u);
    f.inspection.state.phases['staging-qualified'].state = 'verified';
    f.inspection.state.phaseOutputs = { 'staging-qualified': { values: { sourceSha: f.config.rehearsal.candidate.sourceSha, qualified: true }, resources: [] } };
    expect(() => requireApplicationRehearsalStaging(f.planning(), f.config)).toThrow(/original activation receipt/u);
  });
});

describe('retained rehearsal stage boundaries and issued authority', () => {
  it('fails closed by default without invoking a resource executor or allocating a replacement rehearsal', async () => {
    const f = await fixture(), before = JSON.stringify(f.inspection.state);
    expect(await planApplicationRehearsalExecution(f.planning())).toEqual({ operations: [], blockers: [applicationRehearsalEngineSeamBlocker] });
    expect(await executeApplicationRehearsalExecution(f.input)).toEqual({ status: 'blocked', blocker: applicationRehearsalEngineSeamBlocker });
    expect(JSON.stringify(f.inspection.state)).toBe(before);
    expect(await new ApplicationRehearsalRecordStore(f.input, f.config).find()).toEqual({ root: null, closed: false, next: 0 });
    expect(f.calls).toEqual([]);
  });

  it('cannot manufacture execution by installing a success-shaped core callback', async () => {
    const f = await fixture();
    const execute = vi.fn(async () => ({
      status: 'executed' as const, transactionId: randomUUID(), journalRef: `state-workspace:${randomUUID()}/${randomUUID()}`,
      retainedCandidateRef: null, state: 'published-verified' as const, effects: [], observations: [], identities: [],
      additionalReview: null, atomicAcrossProviders: false as const, qualification: 'unqualified-source-component' as const
    }));
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) =>
      executeApplicationRehearsalExecution({ ...f.input, lease }, { privateEngine: { executeApplicationPrivatePlan: execute } }));
    expect(outcome.status).toBe('blocked');
    expect(outcome.resultState).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('rejects forged issued-authority callbacks and does not mint a completed receipt', async () => {
    const f = await fixture(), companions = applicationRehearsalCompanionOperations(f.planning(), f.config, canonicalSha256('source'));
    const forged: ApplicationRehearsalPrivateAuthority = {
      ...f.authority(f.input), protocol: applicationRehearsalProtocol, additionalOperations: companions,
      disposable: {
        ...f.config.disposableTarget, executionWindow: { notBefore: f.config.disposableTarget.notBefore, expiresAt: f.config.disposableTarget.expiresAt },
        approval: { envelopeId: f.input.plan.approval.envelopeId!, envelopeHash: f.input.plan.approval.envelopeHash!,
          approvedAt: f.now.toISOString(), planDigest: f.input.plan.planDigest, savedPlanDigest: canonicalSha256(f.input.plan) }
      }, assertCurrent: vi.fn(async () => undefined)
    };
    await expect(assertIssuedApplicationRehearsalAuthority(forged)).rejects.toThrow(/authentic-issued-authority/u);
    await expect(readCompletedApplicationRehearsalReceipt(f.input, forged, companions)).rejects.toThrow(/authentic-issued-authority/u);
    expect(forged.assertCurrent).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('derives its own rehearsal admission instead of accepting caller-supplied preparation', async () => {
    const f = await fixture();
    const prepared = { config: f.config, source: { digest: canonicalSha256('caller-source') }, operations: [], companions: [] };
    expect(assertOwnedRehearsalAuthority).toBe(assertIssuedApplicationRehearsalAuthority);
    await withProjectMutationLock(f.projectRoot, async (lease) => {
      // @ts-expect-error Preparation data is not a caller-installable authority or proof.
      await expect(createApplicationRehearsalAuthority({ ...f.input, lease }, prepared)).rejects.toThrow(/original activation receipt/u);
    });
    expect(await new ApplicationRehearsalRecordStore(f.input, f.config).find()).toEqual({ root: null, closed: false, next: 0 });
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['rollout-prepared', 'rollout', 'apply'],
    ['rollout-completed', 'rollback', 'prepare'],
    ['rollback-prepared', 'rollback', 'apply'],
    ['rollback-completed', 'verify', 'recover']
  ] as const)('%s is review-required, never complete or a completed-handle pending result', async (kind, nextStage, nextMode) => {
    const f = await fixture(), { root, step } = await retained(f, kind);
    const outcome = applicationRehearsalReviewOutcome(f.input, root, step);
    expect(outcome.status).toBe('review-required');
    expect(outcome.review?.payload).toMatchObject({ completedStep: kind, next: { stage: nextStage, mode: nextMode } });
    expect(outcome.resultState).toBeUndefined();
    expect(outcome.operation).toBeUndefined();
    expect(outcome.outputs).toBeUndefined();
    expect(outcome.evidencePayload).toBeUndefined();
    expect(outcome.stateOverride).toBeUndefined();
    expect(outcome.review?.sourcePlanDigest).toBe(f.input.plan.planDigest);
  });

  it('loads the original private review by exact sourcePlanDigest even after the active phase points elsewhere', async () => {
    const f = await fixture(), { root, step } = await retained(f);
    const outcome = applicationRehearsalReviewOutcome(f.input, root, step);
    const reference = { sourcePlanDigest: f.input.plan.planDigest, reviewDigest: canonicalSha256(outcome.review) };
    await expect(readApplicationRehearsalPhaseReview(f.planning(), reference, f.input.plan)).rejects.toThrow(/private-phase-review-required/u);
    await withProjectMutationLock(f.projectRoot, () => storePhaseReview(f.inspection, f.input.plan, outcome, f.now, f.storage));
    f.inspection.state.phases['production-rehearsed'].executionPlanDigest = canonicalSha256('subsequent-rollback-plan');
    f.inspection.reviews = [{ ...outcome.review!, sourcePlanDigest: canonicalSha256('caller-replacement') }];
    expect(await readApplicationRehearsalPhaseReview(f.planning(), reference, f.input.plan)).toEqual(outcome.review);
    await expect(readApplicationRehearsalPhaseReview(f.planning(), { ...reference, sourcePlanDigest: canonicalSha256('other') }, f.input.plan))
      .rejects.toThrow(/original-review-plan/u);
    await expect(readApplicationRehearsalPhaseReview(f.planning(), { ...reference, reviewDigest: canonicalSha256('other') }, f.input.plan))
      .rejects.toThrow(/original-review-binding/u);
  });

  it('cannot convert a pending external operation or prepared outputs into a retained phase review', async () => {
    const f = await fixture(), { root, step } = await retained(f);
    const outcome: PhaseAdapterOutcome = { ...applicationRehearsalReviewOutcome(f.input, root, step), status: 'pending' };
    await expect(withProjectMutationLock(f.projectRoot, () =>
      storePhaseReview(f.inspection, f.input.plan, outcome, f.now, f.storage))).rejects.toThrow(/settled stage/u);
    outcome.status = 'review-required';
    outcome.resultState = 'verified';
    await expect(withProjectMutationLock(f.projectRoot, () =>
      storePhaseReview(f.inspection, f.input.plan, outcome, f.now, f.storage))).rejects.toThrow(/settled stage/u);
  });

  it('retains one backend reservation despite changed candidate/source/approval inputs', async () => {
    const f = await fixture(), { root } = await retained(f);
    const changed = structuredClone(f.config);
    changed.rehearsal.candidate.sourceSha = 'f'.repeat(40);
    const found = await new ApplicationRehearsalRecordStore(f.input, changed).find();
    expect(found).toMatchObject({ root, closed: false, next: 1 });
    expect(found.root?.bindingDigest).not.toBe(applicationRehearsalBinding(changed));
    const records = createScopedUserLocalRecordStore(f.projectRoot, 'governance-operation', f.storage);
    expect(await records.read(canonicalSha256({
      protocol: applicationRehearsalProtocol, backend: root.backendKey, sequence: 1, kind: 'started'
    }))).toBeNull();
  });
});

describe('independent process/provider rollout and rollback observations', () => {
  it.each(['plan', 'variables'] as const)('refuses a retained native refresh with substituted %s bytes', async (kind) => {
    const f = await fixture(), directory = path.join(f.root, 'retained-native');
    const nativeRoot = path.join(directory, 'environments', 'prod');
    await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
    const savedBytes = Buffer.from('ORIGINAL_EXACT_PRIVATE_SAVED_PLAN'), variables = Buffer.from(JSON.stringify({ private: secret }));
    const ref = `state-workspace:${f.config.privateExecution.custody.workspaceId}/${randomUUID()}`, scope = canonicalSha256('private-scope');
    const saved: Pick<ApplicationPrivateSavedPlan, 'directory' | 'source' | 'savedPlan' | 'variables'> = {
      directory: { path: directory, identity: { device: 'fixture', inode: 'fixture', birthtime: 'fixture', uid: process.getuid?.() ?? 0, mode: 0o700 } },
      source: {
        schemaVersion: 1, rootPathParts: f.config.privateExecution.source.rootPathParts,
        backendPathParts: f.config.privateExecution.source.backendPathParts, files: [], directories: [], resources: [], digest: canonicalSha256('source')
      },
      savedPlan: { ref, purpose: 'plan', scope, digest: stateDigest(savedBytes) },
      variables: { ref, purpose: 'inspection', scope, digest: stateDigest(variables) }
    };
    await writeFile(path.join(nativeRoot, 'review.tfplan'), savedBytes, { mode: 0o600 });
    await writeFile(path.join(nativeRoot, 'liftoff.private.tfvars.json'), variables, { mode: 0o600 });
    await expect(assertApplicationRehearsalNativeReadbackInputs(saved)).resolves.toBeUndefined();
    await writeFile(path.join(nativeRoot, kind === 'plan' ? 'review.tfplan' : 'liftoff.private.tfvars.json'), 'CHANGED_PRIVATE_BYTES', { mode: 0o600 });
    await expect(assertApplicationRehearsalNativeReadbackInputs(saved)).rejects.toThrow(/retained-native-input-changed/u);
    expect(f.calls).toEqual([]);
  });

  it('preserves exact IDs and workload principals when generated resources have no optional ownership tag', async () => {
    const f = await providerFixture();
    Reflect.deleteProperty(f.config.privateExecution.targets[0]!.expected, 'tags.liftoff-repository-id');
    await f.mutate((state) => {
      Reflect.deleteProperty(state.app, 'tags');
      Reflect.deleteProperty(state.identity, 'tags');
      Reflect.deleteProperty(state.registry, 'tags');
    });
    const observed = await f.read(f.config.rehearsal.baseline.artifact.imageRef);
    expect(observed.workloadIdentity).toEqual(f.config.rehearsal.baseline.workloadIdentity);
    expect(observed.configuration.tags).toBeNull();
    await f.mutate((state) => { state.identity.tags = { 'liftoff-repository-id': 'foreign-owner' }; });
    await expect(f.read(f.config.rehearsal.baseline.artifact.imageRef)).rejects.toThrow(/resource-ownership/);
  });

  it('reads real separate fixture resource/revision/traffic/state observations for rollout then exact restoration', async () => {
    const f = await providerFixture(), oldImage = f.config.rehearsal.baseline.artifact.imageRef;
    const originalBytes = await f.bytes(), before = await f.read(oldImage);
    await f.transition('rollout');
    const promotedBytes = await f.bytes(), promoted = await f.read(f.config.rehearsal.candidate.imageRef);
    expect(promoted.revisionName).toBe('application--rollout');
    expect(promoted.traffic).toEqual([{ revisionName: 'application--rollout', weight: 100, label: null }]);
    expect(() => assertApplicationRehearsalStateRestored(originalBytes, promotedBytes, f.metadata, address)).toThrow(/not-restored/u);
    await f.transition('rollback');
    const restoredBytes = await f.bytes(), restored = await f.read(oldImage);
    expect(restored.revisionName).toBe('application--rollback');
    expect(() => assertApplicationRehearsalInventoryRestored(before, restored)).not.toThrow();
    expect(() => assertApplicationRehearsalStateRestored(originalBytes, restoredBytes, f.metadata, address)).not.toThrow();
    expect(new Set([...before.readbacks, ...promoted.readbacks, ...restored.readbacks].map((read) => read.requestId)).size).toBe(18);
    expect(JSON.stringify(publicApplicationRehearsalInventory(restored))).not.toContain(secret);
    expect(JSON.stringify(publicApplicationRehearsalInventory(restored))).not.toContain('configuration');
    const audit = await f.audit();
    expect(audit.filter((entry) => entry.kind === 'fixture-transition').map((entry) => entry.target)).toEqual(['rollout', 'rollback']);
    expect(audit.filter((entry) => entry.kind === 'independent-get')).toHaveLength(18);
    expect(audit.filter((entry) => entry.kind === 'independent-native-state-read')).toHaveLength(3);
  });

  it.each([
    ['wrong image', (state: ReturnType<typeof initialProvider>) => { state.app.properties.template.containers[0]!.image = 'unreviewed:latest'; }],
    ['traffic split', (state: ReturnType<typeof initialProvider>) => { state.app.properties.configuration.ingress.traffic[0]!.weight = 50; }],
    ['stale latest-ready revision', (state: ReturnType<typeof initialProvider>) => { state.app.properties.latestReadyRevisionName = 'application--unrelated'; }],
    ['foreign workload principal', (state: ReturnType<typeof initialProvider>) => { state.identity.properties.principalId = randomUUID(); }],
    ['foreign resource owner', (state: ReturnType<typeof initialProvider>) => { state.app.tags['liftoff-repository-id'] = '99'; }],
    ['unhealthy revision', (state: ReturnType<typeof initialProvider>) => { state.revisions[0]!.properties.healthState = 'Unhealthy'; }],
    ['independent revision mismatch', (state: ReturnType<typeof initialProvider>) => { state.revisions[0]!.properties.template.scale.maxReplicas = 2; }]
  ])('does not mistake Running for proof: rejects %s', async (_name, change) => {
    const f = await providerFixture();
    await f.mutate(change);
    await expect(f.read(f.config.rehearsal.baseline.artifact.imageRef)).rejects.toThrow();
    expect((await f.audit()).some((entry) => entry.kind === 'fixture-transition')).toBe(false);
  });

  it.each([
    ['environment value', (state: ReturnType<typeof initialProvider>) => { state.app.properties.template.containers[0]!.env[0]!.value = 'not-original'; }],
    ['secret reference', (state: ReturnType<typeof initialProvider>) => { state.app.properties.configuration.secrets[0]!.keyVaultUrl += '-different'; }],
    ['scaling', (state: ReturnType<typeof initialProvider>) => { state.app.properties.template.scale.maxReplicas = 3; }],
    ['registry identity', (state: ReturnType<typeof initialProvider>) => { state.app.properties.configuration.registries[0]!.identity = `${identityId}-other`; }]
  ])('refuses image-only rollback with changed %s', async (_name, change) => {
    const f = await providerFixture(), before = await f.read(f.config.rehearsal.baseline.artifact.imageRef);
    await f.transition('rollout');
    await f.transition('rollback');
    await f.mutate((state) => {
      change(state);
      state.revisions.at(-1)!.properties.template = structuredClone(state.app.properties.template);
    });
    const after = await f.read(f.config.rehearsal.baseline.artifact.imageRef);
    expect(() => assertApplicationRehearsalInventoryRestored(before, after)).toThrow(/configuration-not-restored/u);
  });

  it.each([
    ['private configuration', (state: Record<string, unknown>) => {
      const resources = state.resources;
      if (!Array.isArray(resources)) throw new Error('Missing native resources.');
      const instances = rehearsalRecord(resources[0]).instances;
      if (!Array.isArray(instances)) throw new Error('Missing native instances.');
      rehearsalRecord(rehearsalRecord(instances[0]).attributes).secret = [{ name: 'database', value: 'not-original' }];
    }],
    ['foreign resource', (state: Record<string, unknown>) => {
      if (!Array.isArray(state.resources)) throw new Error('Missing native resources.');
      state.resources.pop();
    }],
    ['state output', (state: Record<string, unknown>) => { state.outputs = {}; }],
    ['lineage', (state: Record<string, unknown>) => { state.lineage = randomUUID(); }],
    ['serial rewind', (state: Record<string, unknown>) => { state.serial = 1; }]
  ])('requires exact retained state ownership and rejects changed %s', async (_name, change) => {
    const f = await providerFixture(), before = await f.bytes();
    await f.transition('rollout');
    await f.transition('rollback');
    const raw = rehearsalRecord(JSON.parse((await f.bytes()).toString('utf8')));
    change(raw);
    expect(() => assertApplicationRehearsalStateRestored(before, Buffer.from(JSON.stringify(raw)), f.metadata, address)).toThrow();
  });

  it('does not accept repeated readback IDs as independent original verification', async () => {
    const f = await providerFixture(), before = await f.read(f.config.rehearsal.baseline.artifact.imageRef);
    const after = structuredClone(before);
    expect(() => assertApplicationRehearsalInventoryRestored(before, after)).toThrow(/configuration-not-restored/u);
  });

  it('detects a resource/traffic race between the independent revision reads and the final resource GET', async () => {
    const f = await providerFixture(), transport = f.input.adapters.azureActivation!.transport!;
    f.input.adapters.azureActivation!.transport = {
      async request(request, binding) {
        const response = await transport.request(request, binding);
        if (request.resourceId === registryId) await f.mutate((state) => { state.app.properties.configuration.ingress.external = false; });
        return response;
      }
    };
    await expect(f.read(f.config.rehearsal.baseline.artifact.imageRef)).rejects.toThrow(/resource-readback-race/u);
    expect((await f.audit()).filter((entry) => entry.kind === 'independent-get')).toHaveLength(6);
  });

  it('requires concrete receipt issuance before any backend reservation can be closed', async () => {
    const f = await providerFixture(), before = await f.read(f.config.rehearsal.baseline.artifact.imageRef);
    const { root, step } = await retained(f);
    const reference = { sourcePlanDigest: step.plan.planDigest, reviewDigest: canonicalSha256(applicationRehearsalStepReview(root, step)) };
    const fakeBuild = {
      reference: f.config.rehearsal.candidate, originalPlanDigest: canonicalSha256('build-plan'),
      source: { repositoryId: 42, commitSha: 'b'.repeat(40), treeSha: 'a'.repeat(40), readerActorId: 7 },
      build: {
        digest: `sha256:${'c'.repeat(64)}`, configDigest: `sha256:${'d'.repeat(64)}`, imageRef: f.config.rehearsal.candidate.imageRef,
        registryResourceId: registryId, sourceSha: 'b'.repeat(40), runId: 100, runAttempt: 1, workflowId: 4,
        actorId: 7, jobId: 1000, platform: 'linux/amd64'
      },
      artifact: { id: 55, name: 'fixture', digest: `sha256:${'c'.repeat(64)}` }, observedAt: f.now.toISOString()
    };
    const fake: CompletedApplicationRehearsalReceipt = {
      kind: 'completed-private-application-rehearsal.v1', protocol: applicationRehearsalProtocol, rehearsalId: root.rehearsalId,
      rolloutReview: reference, rollbackReview: reference,
      rollout: { ...step.reviewed, sourcePlanDigest: step.plan.planDigest }, rollback: { ...step.reviewed, sourcePlanDigest: step.plan.planDigest },
      privateSnapshots: { original: step.snapshot.ref, promoted: step.snapshot.ref, restored: step.snapshot.ref, verification: step.snapshot.ref },
      original: publicApplicationRehearsalInventory(before), promoted: publicApplicationRehearsalInventory(before),
      restored: publicApplicationRehearsalInventory(before), candidateBuild: fakeBuild, baselineBuild: fakeBuild,
      originalConfigurationRestored: true, originalStateOwnershipRestored: true, atomicAcrossProviders: false,
      qualification: 'unqualified-source-component'
    };
    await expect(withProjectMutationLock(f.projectRoot, (lease) => {
      const input = { ...f.input, lease };
      return new ApplicationRehearsalRecordStore(input, f.config).close(root, fake, f.authority(input));
    })).rejects.toThrow(/concrete-receipt-required/u);
    expect((await new ApplicationRehearsalRecordStore(f.input, f.config).find()).closed).toBe(false);
  });
});

describe('original GitHub source/build receipt read-only companion', () => {
  async function buildFixture() {
    const f = await applicationArtifactFixture();
    cleanups.push(f.cleanup);
    vi.stubGlobal('fetch', f.fetch);
    const outcome = await f.execute();
    expect(outcome.status, outcome.blocker).toBe('completed');
    const payload = {
      ...rehearsalRecord(outcome.evidencePayload), planDigest: f.input.plan.planDigest,
      savedPlanDigest: canonicalSha256(f.input.plan), outputBindings: outcome.outputs
    };
    const header = evidenceHeaderFor({
      inspection: f.input.inspection, phase: f.input.phase, plan: f.input.plan, result: 'verified', now: f.input.now,
      payload, liveReadback: outcome.liveReadback
    });
    const reference = {
      evidence: { evidenceId: 'original-build', headerDigest: evidenceHeaderDigest(header), bodyDigest: evidenceBodyDigest(payload, outcome.liveReadback) },
      imageRef: f.report.image.loginServer + '/' + f.report.image.repository + '@' + f.imageDigest,
      sourceSha: f.config.workflow.sourceSha, registryResourceId: f.config.registryResourceId
    };
    f.input.inspection.evidence = [{ evidenceId: reference.evidence.evidenceId, header, payload, liveReadback: outcome.liveReadback }];
    f.input.inspection.contexts['application-artifact-ready'].reviewedPlans = [f.input.plan];
    const operation: TransitionOperation = {
      phaseId: 'production-rehearsed', adapter: 'github', actionId: 'github.application-rehearsal.source-receipt',
      mutationClass: 'github-read', remote: true, destructive: false,
      destination: { type: 'repository', identity: 'owner/repo', repository: 'owner/repo' }, inputs: { actorId: 7 }
    };
    const current: PhaseAdapterExecutionInput = { ...f.input, phase };
    const authorize = vi.fn(async () => undefined);
    const authority: ApplicationPrivateAuthority = {
      input: current, operation, operations: [operation], assertCurrent: authorize,
      async assertRelease() { throw new Error('A source receipt cannot acquire/release state or write GitHub.'); }
    };
    const before = f.protocol.requests.length;
    return { ...f, current, reference, operation, authority, before, payload };
  }

  it('reopens the genuine original private build checkpoint and actual source, run, job, archive and OCI metadata', async () => {
    const f = await buildFixture();
    const result = await readApplicationRehearsalBuild(f.current, f.reference, false, f.operation, f.authority);
    expect(result).toMatchObject({
      originalPlanDigest: f.input.plan.planDigest, source: { repositoryId: 42, commitSha: f.config.workflow.sourceSha, readerActorId: 7 },
      build: { runId: 100, runAttempt: 1, actorId: 7, jobId: 1000, imageRef: f.reference.imageRef },
      artifact: { id: 55, digest: f.artifact.metadata.digest }
    });

    expect(f.protocol.requests.slice(f.before).every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.slice(f.before).some((request) => request.path.includes('/git/commits/'))).toBe(true);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-fixture-sentinel');
  });

  it('keeps original build provenance separate from an explicitly mirrored production registry', async () => {
    const f = await buildFixture();
    const original = structuredClone(f.reference);
    const targetRegistryResourceId = `/subscriptions/${fixtureBinding.subscriptionId}/resourceGroups/rg-prod/providers/Microsoft.ContainerRegistry/registries/crproduction`;
    const digest = original.imageRef.slice(original.imageRef.indexOf('@') + 1);
    const mirrored = {
      ...original, sourceRegistryResourceId: original.registryResourceId,
      registryResourceId: targetRegistryResourceId, imageRef: `crproduction.azurecr.io/team/app@${digest}`
    };
    const result = await readApplicationRehearsalBuild(f.current, mirrored, false, f.operation, f.authority);
    expect(result.reference.registryResourceId).toBe(targetRegistryResourceId);
    expect(result.build.registryResourceId).toBe(original.registryResourceId);
    expect(result.build.imageRef).toBe(original.imageRef);
    expect(f.reference).toEqual(original);
    expect(f.protocol.requests.slice(f.before).every((request) => request.method === 'GET')).toBe(true);
    await expect(readApplicationRehearsalBuild(f.current, { ...mirrored, sourceRegistryResourceId: targetRegistryResourceId },
      false, f.operation, f.authority)).rejects.toThrow(/original-build-binding|build-read-operation/);
  });

  it.each(['actor', 'rerun', 'source', 'archive', 'correlation'] as const)('rejects changed original %s without redispatch', async (fault) => {
    const f = await buildFixture();
    if (fault === 'actor') f.protocol.actorId = 99;
    if (fault === 'rerun') f.protocol.runs.get(100)!.run_attempt = 2;
    if (fault === 'source') f.protocol.runs.get(100)!.head_sha = 'f'.repeat(40);
    if (fault === 'archive') f.artifact.bytes[0] = 0;
    if (fault === 'correlation') f.protocol.runs.get(100)!.display_title = 'unrelated-build';
    await expect(readApplicationRehearsalBuild(f.current, f.reference, false, f.operation, f.authority)).rejects.toThrow();
    expect(f.protocol.requests.slice(f.before).every((request) => request.method === 'GET')).toBe(true);
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('rejects a real successful build and matching public receipt when its original private effect record is unavailable', async () => {
    const f = await buildFixture(), home = path.join(f.root, 'without-private-build-authority');
    await mkdir(home, { mode: 0o700 });
    f.current.adapters.githubActivation = { ...f.current.adapters.githubActivation, storage: { ...f.storage, homedir: home } };
    await expect(readApplicationRehearsalBuild(f.current, f.reference, false, f.operation, f.authority)).rejects.toThrow(/private-build-checkpoint/u);
    expect(f.protocol.requests.slice(f.before).every((request) => request.method === 'GET')).toBe(true);
  });
});
