import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  approveModernLocalExecution, approveModernManualNativeExecution, localExecutionStore,
  prepareModernManualNativeExecution, readCompletedModernLocalExecution
} from '../src/application/governance/modern-local-approval.js';
import { executeModernLocalExecution } from '../src/application/governance/modern-local-execution.js';
import {
  localExecutionDigest, validateLocalExecutionPreview, validateLocalExecutionScopes,
  validateManualNativeExecutionScopes
} from '../src/domain/governance/activation/modern-local-runtime.js';
import * as executionRecords from '../src/domain/governance/activation/modern-local-runtime.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import { approveModernLocalFinalization, finalizeModernLocalCompletion, prepareModernLocalFinalization } from '../src/application/governance/modern-local-finalization.js';
import { approveModernLocalPublication, inspectModernLocalCompletion, publishModernLocalCompletion } from '../src/application/governance/modern-local-publication.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import {
  generatedManualFixture as generatedFixture, recordManualCommands as recordCommands, manualScopes as scopes
} from './fixtures/modern-manual-project.js';

const lane = process.env.LIFTOFF_HCL_TEST_LANE ?? 'auto';
const qualified = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.21.0';
if (!['auto', 'portable', 'native'].includes(lane) || lane === 'native' && !qualified) throw new Error('Invalid Manual execution host/lane.');
const engineLane = process.env.LIFTOFF_MANUAL_ENGINE_TEST_LANE ?? 'off';
if (!['off', 'native'].includes(engineLane) || engineLane === 'native' && (!qualified || lane === 'portable')) {
  throw new Error('Actual Manual engine qualification requires its explicit native network lane.');
}
const nativeIt = it.skipIf(!qualified || lane === 'portable'), engineIt = it.skipIf(engineLane !== 'native');
const workloads: Pick<ProjectOptions, 'projectType' | 'apiStack' | 'pattern'>[] = [
  { projectType: 'standard', apiStack: 'node-fastify' },
  { projectType: 'standard', apiStack: 'python-fastapi' },
  { projectType: 'standard', apiStack: 'go-huma' },
  ...projectCatalog.patterns.map(pattern => ({ projectType: 'genai', pattern: pattern.id }))
];
const { infrastructurePreparation: _preparation, infrastructureNetwork: _network, ...dependencyScopes } = scopes;

describe('independent Manual native consent', () => {
  nativeIt.each(workloads)('rederives complete generated %j source and actual tool prerequisites without preparation', async workload => {
    const fixture = await generatedFixture({ workload, frontend: true });
    const preview = await prepareModernManualNativeExecution(fixture.project, { kind: 'verify-manual-native', preparation: fixture.preparation });
    expect(preview.schemaVersion).toBe(6);
    expect(preview.preparation).toHaveLength(2);
    expect(await localExecutionStore(fixture.project).readState(preview.fingerprint)).toBeNull();
    fixture.retained.complete = true;
  }, 60_000);
  it('requires separate provider-distribution consent without promoting application network permission', () => {
    expect(validateManualNativeExecutionScopes(scopes)).toEqual(scopes);
    expect(() => validateLocalExecutionScopes(scopes)).toThrow();
    expect(() => validateManualNativeExecutionScopes(dependencyScopes)).toThrow();
    expect(validateManualNativeExecutionScopes({ ...scopes, dependencyPreparation: false, dependencyNetwork: false }))
      .toEqual({ ...scopes, dependencyPreparation: false, dependencyNetwork: false });
  });
  it.each(['infrastructurePreparation', 'infrastructureNetwork'] as const)('rejects missing or declined %s', field => {
    expect(() => validateManualNativeExecutionScopes({ ...scopes, [field]: false })).toThrow(/independent/);
    const missing: Record<string, unknown> = { ...scopes }; delete missing[field];
    expect(() => validateManualNativeExecutionScopes(missing)).toThrow();
  });
  it.each(['projectCode', 'hostCapabilitiesAcknowledged', 'workflowFinalization', 'publishLocalRecords'] as const)(
    'preserves the separate %s boundary', field => {
      expect(() => validateManualNativeExecutionScopes({ ...scopes, [field]: !scopes[field] })).toThrow();
    }
  );
  nativeIt('derives the complete actual preview and rejects generic or insufficient consent before claiming a workspace', async () => {
    const fixture = await generatedFixture(), store = localExecutionStore(fixture.project);
    const preview = await prepareModernManualNativeExecution(fixture.project, { kind: 'verify-manual-native', preparation: fixture.preparation });
    expect(preview.schemaVersion).toBe(6);
    expect(preview.checks.filter(check => check.id.startsWith('tofu-initialize:'))).toHaveLength(1);
    expect(preview.checks.find(check => check.id === 'tofu-validate:opentofu-application')?.status).toBe('inapplicable');
    expect(await store.readState(preview.fingerprint)).toBeNull();
    await expect(approveModernLocalExecution(fixture.project, preview.fingerprint, dependencyScopes)).rejects.toThrow(/dedicated/);
    await expect(approveModernManualNativeExecution(fixture.project, preview.fingerprint, { ...scopes, dependencyPreparation: false, dependencyNetwork: false }))
      .rejects.toThrow(/preparation/);
    expect(await store.read('consent', preview.fingerprint)).toBeNull();
    const consent = await approveModernManualNativeExecution(fixture.project, preview.fingerprint, scopes);
    expect(consent.schemaVersion).toBe(5);
    expect(await approveModernManualNativeExecution(fixture.project, preview.fingerprint, scopes)).toEqual(consent);
    expect(await store.readState(preview.fingerprint)).toBeNull();
    if (preview.schemaVersion !== 6) throw new Error('Expected independently identified Manual preview.');
    const { fingerprint: _fingerprint, ...body } = preview;
    const missingInit = { ...body, checks: body.checks.filter(check => !check.id.startsWith('tofu-initialize:')) };
    expect(() => validateLocalExecutionPreview({ ...missingInit, fingerprint: localExecutionDigest(missingInit) }, new Date())).toThrow(/cover/);
    const wrongTool = { ...body, tools: body.tools.map(tool => tool.id === 'tofu' ? { ...tool, version: '1.12.5' } : tool) };
    expect(() => validateLocalExecutionPreview({ ...wrongTool, fingerprint: localExecutionDigest(wrongTool) }, new Date())).toThrow();
    fixture.retained.complete = true;
  }, 60_000);
});

describe('real locked Manual engine, explicit network qualification only', () => {
  engineIt('executes generated Node and locked AzureRM checks through the production engine without finalizing or publishing', async () => {
    const fixture = await generatedFixture();
    const commands = recordCommands();
    const validateResult = executionRecords.validateLocalExecutionResult;
    vi.spyOn(executionRecords, 'validateLocalExecutionResult').mockImplementation((input, preview, workspace) => {
      console.info('MANUAL_NATIVE_RESULT_CANDIDATE ' + JSON.stringify({ input, workspace, commands }));
      return validateResult(input, preview, workspace);
    });
    const preview = await prepareModernManualNativeExecution(fixture.project, { kind: 'verify-manual-native', preparation: fixture.preparation });
    await approveModernManualNativeExecution(fixture.project, preview.fingerprint, scopes);
    const result = await executeModernLocalExecution(fixture.project, preview.fingerprint);
    console.info('MANUAL_NATIVE_ENGINE ' + JSON.stringify({ scope: 'production-engine-not-finalization-or-publication', preview, result, commands }));
    expect(result.complete).toBe(true);
    expect(result.schemaVersion).toBe(5);
    expect(result.cleanupComplete).toBe(true);
    expect(result.inputsUnchanged).toBe(true);
    if (result.schemaVersion !== 5) throw new Error('Missing native infrastructure proof.');
    expect(result.infrastructure.outputs).toHaveLength(1);
    const completed = await readCompletedModernLocalExecution(fixture.project, preview.fingerprint);
    expect(completed.result.resultDigest).toBe(result.resultDigest);
    for (const artifact of fixture.artifacts) {
      expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
    }
    fixture.retained.complete = true;
  }, 700_000);
  engineIt.each(workloads)('verifies the full generated %j workload, frontend and all environment roots with actual tools', async workload => {
    const fixture = await generatedFixture({ workload, frontend: true, environments: ['dev', 'staging', 'prod'] });
    const commands = recordCommands();
    try {
      const preview = await prepareModernManualNativeExecution(fixture.project, { kind: 'verify-manual-native', preparation: fixture.preparation });
      await approveModernManualNativeExecution(fixture.project, preview.fingerprint, scopes);
      const result = await executeModernLocalExecution(fixture.project, preview.fingerprint);
      console.info('MANUAL_NATIVE_WORKLOAD ' + JSON.stringify({ workload, preview, result }));
      expect(result.complete).toBe(true);
      if (result.schemaVersion !== 5) throw new Error('Missing native workload proof.');
      expect(result.infrastructure.outputs).toHaveLength(3);
      expect((await readCompletedModernLocalExecution(fixture.project, preview.fingerprint)).result.resultDigest).toBe(result.resultDigest);
      for (const artifact of fixture.artifacts) {
        expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
      }
      fixture.retained.complete = true;
    } finally { console.info('MANUAL_NATIVE_WORKLOAD_COMMANDS ' + JSON.stringify({ workload, commands })); }
  }, 700_000);
  engineIt.each(['none', 'single-maintainer-gitflow'] as const)(
    'finalizes and publishes the actual %s Node/frontend/three-environment result only after separate approvals', async profile => {
      const fixture = await generatedFixture({ profile, frontend: true, environments: ['dev', 'staging', 'prod'] });
      const preview = await prepareModernManualNativeExecution(fixture.project, { kind: 'verify-manual-native', preparation: fixture.preparation });
      await approveModernManualNativeExecution(fixture.project, preview.fingerprint, scopes);
      const execution = await executeModernLocalExecution(fixture.project, preview.fingerprint);
      console.info('MANUAL_NATIVE_COMPLETION_EXECUTION ' + JSON.stringify({ profile, preview, execution }));
      expect(execution.complete).toBe(true);
      if (execution.schemaVersion !== 5) throw new Error('Missing separately identified native proof.');
      expect(execution.infrastructure.outputs).toHaveLength(3);
      const finalization = await prepareModernLocalFinalization(fixture.project, { kind: 'finalize-local', executionFingerprint: preview.fingerprint });
      await expect(finalizeModernLocalCompletion(fixture.project, finalization.fingerprint)).rejects.toThrow(/consent/);
      await approveModernLocalFinalization(fixture.project, finalization.fingerprint, {
        finalizeLocal: true, workflowWrites: false, projectCode: false, dependencyPreparation: false,
        dependencyNetwork: false, publishLocalRecords: false
      });
      const finalized = await finalizeModernLocalCompletion(fixture.project, finalization.fingerprint);
      await expect(publishModernLocalCompletion(fixture.project, finalized.publicationFingerprint)).rejects.toThrow(/consent/);
      await approveModernLocalPublication(fixture.project, finalized.publicationFingerprint, {
        publishExactLocalBytes: true, finalizationFingerprint: finalization.fingerprint,
        candidateBinding: finalized.candidateBinding, targetSetDigest: finalized.targetSetDigest
      });
      const published = await publishModernLocalCompletion(fixture.project, finalized.publicationFingerprint);
      console.info('MANUAL_NATIVE_COMPLETION ' + JSON.stringify({ profile, finalization, finalized, published }));
      expect(published.status).toBe('local-complete-current');
      expect(published.committed).toBe(true);
      expect(published.authority).toBe('local-only');
      expect((await inspectModernLocalCompletion(fixture.project)).status).toBe('local-complete-current');
      for (const artifact of fixture.artifacts) {
        if (finalized.targets.some(target => target.pathParts.join('/') === artifact.pathParts.join('/'))) continue;
        expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
      }
      fixture.retained.complete = true;
    }, 700_000
  );
});
