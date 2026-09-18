import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import {
  validatePrivateRunnerAssignment, type PrivateRunnerAssignmentBinding
} from '../src/application/azure-activation/private-runner-assignment-binding.js';

const binding: PrivateRunnerAssignmentBinding = {
  schemaVersion: 1, repository: 'owner/repo', repositoryId: 42, organization: 'owner', organizationId: 7,
  groupId: 55, runnerGroupName: 'repo-private-group', definitionId: 300, runnerName: 'repo-private-linux',
  imageId: 'ubuntu-24.04', machineSize: '4-core', maxRunners: 2,
  networkConfigurationId: 'ncfg81', networkConfigurationName: 'repo-private-network', networkSettingsId: 'settings81',
  subnetId: '/subscriptions/11111111-2222-4333-8444-555555555555/resourceGroups/private-access/providers/Microsoft.Network/virtualNetworks/repo-vnet/subnets/runners',
  region: 'eastus', allowedWorkflows: ['owner/repo/.github/workflows/liftoff-environment-dev.yml@refs/heads/develop']
};

describe('pure private runner assignment binding', () => {
  it('validates observed assignment metadata without inventing an ephemeral job runner identity', () => {
    const parsed = validatePrivateRunnerAssignment(binding);
    expect(parsed).toEqual(binding);
    expect(parsed).not.toBe(binding);
    expect(parsed.allowedWorkflows).not.toBe(binding.allowedWorkflows);
    expect(parsed).not.toHaveProperty('runnerId');
  });

  it.each(['repositoryId', 'organizationId', 'groupId', 'definitionId'] as const)(
    'requires an actual positive numeric %s rather than a name or placeholder', (field) => {
      for (const value of [null, 0, -1, '55', Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => validatePrivateRunnerAssignment({ ...binding, [field]: value })).toThrow();
      }
    }
  );

  it.each(['runnerId', 'approved', 'runnerReady'] as const)('rejects the undeclared %s field', (field) => {
    expect(() => validatePrivateRunnerAssignment({ ...binding, [field]: 55 })).toThrow();
  });

  it('preserves exact fleet and workflow-count limits at eight, refusing nine', () => {
    const selectors = Array.from({ length: 8 }, (_, i) => `owner/repo/.github/workflows/fixture-${i}.yml@refs/heads/develop`);
    expect(validatePrivateRunnerAssignment({ ...binding, maxRunners: 8, allowedWorkflows: selectors }))
      .toMatchObject({ maxRunners: 8, allowedWorkflows: selectors });
    expect(() => validatePrivateRunnerAssignment({ ...binding, maxRunners: 9 })).toThrow();
    expect(() => validatePrivateRunnerAssignment({
      ...binding, allowedWorkflows: [...selectors, 'owner/repo/.github/workflows/fixture-8.yml@refs/heads/develop']
    })).toThrow();
  });

  it.each([
    { allowedWorkflows: [] },
    { allowedWorkflows: [binding.allowedWorkflows[0], binding.allowedWorkflows[0]] },
    { allowedWorkflows: ['owner/foreign/.github/workflows/run.yml@refs/heads/develop'] },
    { allowedWorkflows: ['owner/repo/.github/workflows/run.yml@refs/heads/*'] },
    { allowedWorkflows: ['owner/repo/.github/workflows/../run.yml@refs/heads/develop'] }
  ])('rejects non-exact repository or workflow restrictions $allowedWorkflows', ({ allowedWorkflows }) => {
    expect(() => validatePrivateRunnerAssignment({ ...binding, allowedWorkflows })).toThrow();
  });

  it('has no runtime graph edge to runner producers or environment/staging workflow renderers', async () => {
    const entry = fileURLToPath(new URL('../src/application/azure-activation/private-runner-assignment-binding.ts', import.meta.url));
    const result = await build({
      configFile: false, logLevel: 'silent',
      build: { ssr: entry, write: false, emptyOutDir: false, rollupOptions: { treeshake: false } }
    });
    const modules: string[] = [];
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!('output' in output)) throw new Error('The bounded source-boundary check must not start a watcher.');
      for (const chunk of output.output) if (chunk.type === 'chunk') modules.push(...Object.keys(chunk.modules));
    }
    expect(modules).toContain(entry);
    expect(modules.filter((id) =>
      /\/(?:producer-runner|private-runner-application-sources|environment-runtime-workflow|staging-security-workflow)\.ts$/u.test(id)
    )).toEqual([]);
  }, 15_000);
});
