import { describe, expect, it } from 'vitest';
import { workstationRequirementCatalog, type WorkstationRequirementId } from '../src/workstation-catalog.js';
import type { CommandRunner } from '../src/process-runner.js';
import {
  blockingReadinessFailures,
  extractVersion,
  probeRequirement,
  probeWorkstation,
  selectWorkstationRequirements,
  workstationScopeReadiness,
  type RequirementProbeResult,
  type SelectedRequirement,
  type WorkstationRequirementSelection
} from '../src/workstation.js';

function selected(id: WorkstationRequirementId): SelectedRequirement {
  const definition = workstationRequirementCatalog[id];
  return {
    id, definition, severity: definition.severity, reasons: ['test selection'],
    minimumVersion: definition.minimumVersion, exactVersion: definition.exactVersion,
    releaseLine: definition.releaseLine, allowPrerelease: definition.allowPrerelease ?? false
  };
}

function runner(output: string, failedHealth = false): CommandRunner {
  return {
    async run(command) {
      const health = ['doctor', 'account', 'info', 'auth'].includes(command.args[0]);
      return {
        command, displayCommand: [command.executable, ...command.args].join(' '),
        status: health && failedHealth ? 1 : 0, signal: null, timedOut: false,
        stdout: health ? '' : output, stderr: health && failedHealth ? 'Sign in through the owner-controlled CLI.' : ''
      };
    }
  };
}

describe('bounded workstation version grammars', () => {
  it.each([
    ['github-copilot', 'GitHub Copilot CLI 1.0.83.', '1.0.83'],
    ['github-copilot', 'GitHub Copilot CLI 1.0.83', '1.0.83'],
    ['github-copilot', 'GitHub Copilot CLI 1.0.84-5.', '1.0.84-5'],
    ['github-copilot', 'GitHub Copilot CLI 1.0.84-5', '1.0.84-5'],
    ['github-copilot', '1.0.84-5.', '1.0.84-5'],
    ['github-copilot', 'GitHub Copilot CLI 1.0.84-0.3.7+build.14.', '1.0.84-0.3.7+build.14'],
    ['claude', '2.1.10 (Claude Code)', '2.1.10'],
    ['claude', 'Claude Code 2.1.10-beta.2.', '2.1.10-beta.2'],
    ['codex', 'codex-cli 0.107.0-alpha.12', '0.107.0-alpha.12'],
    ['codex', 'Codex CLI 0.107.0+build.7.', '0.107.0+build.7'],
    ['python', 'Python 3.14.0rc1', '3.14.0rc1'],
    ['go', 'go version go1.27rc1 windows/amd64', '1.27rc1'],
    ['openspec', '1.11.0-1', '1.11.0-1'],
    ['spec-kit', 'specify-cli, version 1.0.1-2', '1.0.1-2'],
    ['uv', 'uv 0.12.7 (abc123 2026-09-12)', '0.12.7'],
    ['docker', 'Docker version 29.0.0, build abc123', '29.0.0'],
    ['opentofu', 'OpenTofu v1.12.6\non darwin_arm64', '1.12.6'],
    ['github-cli', 'gh version 2.80.0 (2026-01-01)', '2.80.0'],
    ['node', 'v24.20.0+build.1', '24.20.0+build.1'],
    ['azure-cli', '{"python":"3.14.0","azure-cli":"2.81.0","extensions":{}}', '2.81.0']
  ] as const)('parses the registered %s version format', (id, output, version) => {
    expect(extractVersion(output, id)).toBe(version);
  });

  it('preserves the unqualified punctuation regression without weakening a framework grammar', () => {
    expect(extractVersion('1.0.84-5.')).toBe('1.0.84-5');
    expect(extractVersion('GitHub Copilot CLI 1.0.83.')).toBe('1.0.83');
    expect(extractVersion('1.11.0-1.', 'openspec')).toBeUndefined();
  });

  it.each([
    'GitHub Copilot CLI 1.0.83..',
    'GitHub Copilot CLI 1.0.83.4',
    'GitHub Copilot CLI 1.0.84-5..',
    'GitHub Copilot CLI 1.0.84-rc..1',
    'GitHub Copilot CLI 1.0.84-',
    'GitHub Copilot CLI 1.0.84+',
    'GitHub Copilot CLI 1.0.84-01',
    'GitHub Copilot CLI 01.0.84',
    'GitHub Copilot CLI 1.0',
    'Run node 24.20.0 to install this application.',
    'GitHub Copilot CLI 1.0.83\nGitHub Copilot CLI 1.0.84',
    'x'.repeat(16_385)
  ])('does not turn malformed or ambiguous output into readiness', async (output) => {
    const probe = await probeRequirement(selected('github-copilot'), {
      async run(command) {
        return {
          command, displayCommand: command.executable, status: 0, signal: null, timedOut: false,
          stdout: command.executable === 'code' ? 'other.extension' : output, stderr: ''
        };
      }
    });
    expect(probe).toMatchObject({ state: 'unhealthy', reasonCode: 'version-unparseable' });
    expect(probe.detectedVersion).toBeUndefined();
  });
});

describe('separate compatibility and channel policy', () => {
  it.each([
    ['github-copilot', 'GitHub Copilot CLI 1.0.84-5.'],
    ['claude', '2.1.10-beta.1 (Claude Code)'],
    ['codex', 'codex-cli 0.107.0-alpha.12']
  ] as const)('accepts compatible official preview %s with a notice', async (id, output) => {
    const probe = await probeRequirement(selected(id), runner(output));
    expect(probe).toMatchObject({ state: 'ready', reasonCode: 'compatible', identity: { resolution: 'resolved' } });
    expect(probe.notices).toContainEqual(expect.objectContaining({ code: 'preview-channel', state: 'notice' }));
    expect(blockingReadinessFailures([probe])).toEqual([]);
  });

  it.each([
    ['node', 'v24.20.0-rc.1'],
    ['npm', '12.0.2-0.3.7'],
    ['python', 'Python 3.14.0rc1'],
    ['go', 'go version go1.27rc1 linux/amd64'],
    ['uv', 'uv 0.12.7-rc.1'],
    ['openspec', '1.11.0-1'],
    ['spec-kit', 'specify-cli 1.0.1-2'],
    ['opentofu', 'OpenTofu v1.12.6-rc1']
  ] as const)('retains the stable constraint for %s', async (id, output) => {
    const probe = await probeRequirement(selected(id), runner(output));
    expect(probe).toMatchObject({
      state: 'outdated', reasonCode: 'incompatible-channel',
      required: { allowPrerelease: false }, identity: { resolution: 'resolved' }
    });
    expect(probe.notices.some((notice) => notice.code === 'preview-channel')).toBe(false);
  });

  it.each([
    ['node', 'v24.19.0', 'below-minimum'],
    ['npm', '12.0.1', 'below-minimum'],
    ['python', 'Python 3.13.8', 'release-line-mismatch'],
    ['go', 'go version go1.28.0 darwin/arm64', 'release-line-mismatch'],
    ['uv', 'uv 0.13.0', 'release-line-mismatch'],
    ['openspec', '1.11.1', 'exact-version-mismatch'],
    ['spec-kit', 'specify-cli 1.0.2', 'exact-version-mismatch'],
    ['opentofu', 'OpenTofu v1.12.5', 'below-minimum']
  ] as const)('reports the specific %s constraint mismatch', async (id, output, reasonCode) => {
    expect(await probeRequirement(selected(id), runner(output))).toMatchObject({ state: 'outdated', reasonCode });
  });

  it.each([
    ['openspec', '1.11.0+build.9'],
    ['spec-kit', '1.0.1+build.9'],
    ['node', 'v24.20.0+build.9']
  ] as const)('does not confuse %s build metadata with a prerelease', async (id, output) => {
    expect(await probeRequirement(selected(id), runner(output))).toMatchObject({
      state: 'ready', reasonCode: 'compatible', detectedVersion: output.replace(/^v/, '')
    });
  });

  it('keeps an available newer release advisory even outside the supported release line', async () => {
    const probe = await probeRequirement(selected('node'), runner('v24.20.0'), {
      availableUpdates: { node: { version: '25.0.0', source: 'reviewed release metadata' } }
    });
    expect(probe.state).toBe('ready');
    expect(probe.notices).toContainEqual(expect.objectContaining({ code: 'update-available', state: 'notice' }));
    expect(blockingReadinessFailures([probe])).toEqual([]);
  });

  it('reports a stable agent update without demanding a preview downgrade', async () => {
    const probe = await probeRequirement(selected('codex'), runner('codex-cli 0.107.0-alpha.12'), {
      availableUpdates: { codex: { version: '0.107.0', source: 'official releases' } }
    });
    expect(probe.state).toBe('ready');
    expect(probe.notices.map((notice) => notice.code)).toEqual(['preview-channel', 'authentication', 'update-available']);
  });

  it('does not accept a success-shaped result with a failure cause', async () => {
    const probe = await probeRequirement(selected('node'), runner('v24.20.0'));
    const contradictory: RequirementProbeResult = { ...probe, reasonCode: 'probe-failed' };
    expect(blockingReadinessFailures([contradictory])).toEqual([contradictory]);
  });

  it('does not allow a consumer to weaken the registered runtime floor or channel', async () => {
    const requirement = { ...selected('node'), minimumVersion: '24.0.0', allowPrerelease: true };
    expect(await probeRequirement(requirement, runner('v24.19.0')))
      .toMatchObject({ state: 'outdated', reasonCode: 'below-minimum', required: { minimumVersion: '24.20.0' } });
    expect(await probeRequirement(requirement, runner('v24.20.0-rc.1')))
      .toMatchObject({ state: 'outdated', reasonCode: 'incompatible-channel', required: { allowPrerelease: false } });
  });

  it.each([
    { exactVersion: '1.10.0' },
    { minimumVersion: 'not-a-version' },
    { releaseLine: '2' }
  ])('rejects unsupported framework constraints without executing anything: %j', async (overrides) => {
    let calls = 0;
    const probe = await probeRequirement({ ...selected('openspec'), ...overrides }, {
      async run() {
        calls += 1;
        throw new Error('An unsupported constraint must not execute a probe.');
      }
    });
    expect(probe).toMatchObject({ state: 'not-observable', reasonCode: 'unsupported-constraint' });
    expect(blockingReadinessFailures([probe])).toEqual([probe]);
    expect(calls).toBe(0);
  });

  it('uses registry-owned commands rather than a supplied definition command', async () => {
    const requirement = selected('node');
    requirement.definition = { ...requirement.definition, probes: [{ executable: 'not-allowlisted', args: ['write'] }] };
    const calls: string[] = [];
    const probe = await probeRequirement(requirement, {
      async run(command, options) {
        calls.push(command.executable);
        return runner('v24.20.0').run(command, options);
      }
    });
    expect(probe.state).toBe('ready');
    expect(calls).toEqual(['node']);
  });

  it('retains compatible Claude readiness when the optional doctor adapter throws', async () => {
    const probe = await probeRequirement(selected('claude'), {
      async run(command, options) {
        if (command.args[0] === 'doctor') throw new Error('doctor observation failed');
        return runner('2.1.10 (Claude Code)').run(command, options);
      }
    });
    expect(probe.state).toBe('ready');
    expect(probe.notices).toContainEqual(expect.objectContaining({ code: 'health', state: 'unhealthy' }));
  });

  it.each([
    { timedOut: true },
    { aborted: true },
    { outputLimitExceeded: true },
    { errorCode: 'EACCES' }
  ])('does not accept a partial successful-looking version probe: %j', async (failure) => {
    const probe = await probeRequirement(selected('node'), {
      async run(command, options) {
        return { ...await runner('v24.20.0').run(command, options), ...failure };
      }
    });
    expect(probe).toMatchObject({ state: 'unhealthy', reasonCode: 'probe-failed' });
  });
});

describe('operation-scoped workstation requirements', () => {
  const agents = [
    { id: 'github-copilot', label: 'GitHub Copilot' },
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'OpenAI Codex' }
  ] as const;
  const subsets = Array.from({ length: 7 }, (_, index) => agents.filter((_, bit) => (index + 1) & (1 << bit)));
  const plan = (workflow: 'openspec' | 'spec-kit', selectedAgents = [...agents]): WorkstationRequirementSelection => ({
    workload: { kind: 'standard', apiStack: { id: 'node-fastify' }, provider: { id: 'azure' } },
    specWorkflow: { id: workflow },
    framework: { version: workflow === 'openspec' ? '1.11.0' : '1.0.1' },
    agents: selectedAgents
  });

  for (const workflow of ['openspec', 'spec-kit'] as const) {
    it.each(subsets)('probes exactly the selected agent set with ' + workflow + ': %j', async (...subset) => {
      const requirements = selectWorkstationRequirements(plan(workflow, subset), { scope: 'local' });
      const agentRequirements = requirements.filter((requirement) => agents.some((agent) => agent.id === requirement.id));
      expect(agentRequirements.map((requirement) => requirement.id)).toEqual(subset.map((agent) => agent.id));
      const probes = await probeWorkstation(agentRequirements, {
        async run(command) {
          const output = command.executable === 'copilot' ? 'GitHub Copilot CLI 1.0.84-5.' :
            command.executable === 'codex' ? 'codex-cli 0.107.0-alpha.12' : '2.1.10-beta.1 (Claude Code)';
          return { command, displayCommand: command.executable, status: 0, signal: null, timedOut: false, stdout: output, stderr: '' };
        }
      });
      expect(probes.every((probe) => probe.state === 'ready')).toBe(true);
      expect(requirements.some((requirement) => requirement.id === 'azure-cli' || requirement.id === 'github-cli')).toBe(false);
    });
  }

  it('requires actual applicable local baseline executables, not cloud authentication', async () => {
    const requirements = selectWorkstationRequirements(plan('openspec'), { scope: 'local' });
    for (const id of ['docker', 'opentofu']) {
      const requirement = requirements.find((entry) => entry.id === id)!;
      expect(requirement.severity).toBe('blocking');
      const probe = await probeRequirement(requirement, {
        async run(command) {
          return { command, displayCommand: command.executable, status: null, signal: null, timedOut: false, stdout: '', stderr: '', errorCode: 'ENOENT' };
        }
      });
      expect(workstationScopeReadiness([probe], 'local').ready).toBe(false);
    }
    const docker = await probeRequirement(requirements.find((entry) => entry.id === 'docker')!, runner('Docker version 29.0.0, build abc123', true));
    expect(workstationScopeReadiness([docker], 'local').ready).toBe(true);
  });

  it('checks authentication only for the separate required activation capabilities', async () => {
    const localAzure = await probeRequirement(selected('azure-cli'), runner('{"azure-cli":"2.81.0"}', true));
    expect(workstationScopeReadiness([localAzure], 'local').ready).toBe(true);
    const requirements = selectWorkstationRequirements(plan('openspec'), { scope: 'activation' });
    expect(requirements.map((requirement) => requirement.id)).toEqual(['node', 'opentofu', 'azure-cli', 'github-cli']);
    const azure = await probeRequirement(requirements.find((entry) => entry.id === 'azure-cli')!, runner('{"azure-cli":"2.81.0"}', true));
    expect(workstationScopeReadiness([azure], 'activation')).toMatchObject({
      ready: false, toolFailures: [],
      authenticationFailures: [{ requirementId: 'azure-cli', notice: { code: 'authentication', state: 'unhealthy' } }]
    });
  });

  it('does not presume Azure authentication or agents for a local-state migration', () => {
    expect(selectWorkstationRequirements(plan('openspec'), { scope: 'migration' }).map((requirement) => requirement.id))
      .toEqual(['node', 'opentofu']);
    expect(selectWorkstationRequirements(plan('openspec'), { scope: 'migration', requiredTools: ['azure-cli'] }).map((requirement) => requirement.id))
      .toEqual(['node', 'opentofu', 'azure-cli']);
    expect(selectWorkstationRequirements(plan('openspec'), { scope: 'lifecycle' }).map((requirement) => requirement.id))
      .toEqual(['node']);
  });
});
