import * as childProcess from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import type { GitHubMethod } from '../src/adapters/github/activation-rest.js';
import { canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import { buildSavedTransitionPlan } from '../src/governance-activation/transition-planning.js';
import { executeGitHubPhase, planGitHubPhase } from '../src/governance-activation/phase-github.js';
import { executeAzurePhase, planAzurePhase } from '../src/governance-activation/phase-azure.js';
import { executeCompositePhase, planCompositePhase } from '../src/governance-activation/phase-composite.js';
import { applicationArtifactFixture } from './helpers/application-artifact-fixture.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const fixtures: Awaited<ReturnType<typeof applicationArtifactFixture>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.mocked(childProcess.spawn).mockRestore();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function fixture() {
  const result = await applicationArtifactFixture({ defaultAzure: true, defaultGitHub: true });
  fixtures.push(result);
  vi.stubGlobal('fetch', result.fetch);
  return result;
}

describe('combined application producer dispatch', () => {
  it('plans both exact artifact operations once before independent provider composition', async () => {
    const f = await fixture();
    const built = await buildSavedTransitionPlan({
      inspection: f.input.inspection, runner: f.input.runner, now: f.input.now,
      phaseId: 'application-artifact-ready', adapters: f.input.adapters
    });
    const actions = built!.operations.filter((operation) => operation.remote).map((operation) => operation.actionId);
    expect(actions).toEqual(['github.artifact.build-dispatch', 'azure.artifact.readback']);
    const combined = await planCompositePhase(f.input);
    expect(await planGitHubPhase(f.input)).toEqual(combined);
    expect(await planAzurePhase(f.input)).toEqual(combined);
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(f.azureRequests).toEqual([]);
  });

  it('routes both compatibility facades to the same checkpointed build and independent OCI readback', async () => {
    const f = await fixture();
    const originalRunner = f.input.runner;
    f.input.runner = {
      async run(command, options) {
        if (command.executable !== 'gh' || command.args[0] !== 'api') return originalRunner.run(command, options);
        f.commands.push({ executable: command.executable, args: [...command.args] });
        const methods: readonly GitHubMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
        const method = methods.find((method) => method === command.args[command.args.indexOf('--method') + 1]);
        const endpoint = command.args.find((argument) => argument.startsWith('/'));
        if (!method || !endpoint) throw new Error('Only an exact fixture GitHub API request is allowed.');
        const response = await f.github.request({
          method, path: endpoint,
          ...(typeof options?.stdin === 'string' ? { body: JSON.parse(options.stdin) } : {})
        });
        if (Buffer.isBuffer(response.data)) throw new Error('Archive bytes must use the bounded binary collector, not text CommandRunner output.');
        return {
          status: 0, stderr: '', displayCommand: 'isolated fixture GitHub API',
          stdout: `HTTP/2 ${response.status}\n${Object.entries(response.headers).map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${JSON.stringify(response.data)}`
        };
      }
    };
    const archivePath = path.join(f.root, 'isolated-cli-archive-response');
    await writeFile(archivePath, Buffer.concat([
      Buffer.from('HTTP/2 200\r\nX-GitHub-Request-Id: FIXTURE-ARCHIVE-READ\r\n\r\n'),
      f.artifact.bytes
    ]), { mode: 0o600 });
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
      if (command !== 'gh') throw new Error('The binary read may run only the isolated GitHub CLI fixture.');
      if (!Array.isArray(args) || !args.includes(`/repos/owner/repo/actions/artifacts/${f.artifact.metadata.id}/zip`) ||
        args[args.indexOf('--method') + 1] !== 'GET' || args[args.indexOf('--hostname') + 1] !== 'github.com') {
        throw new Error('The binary fixture refuses another provider, resource or mutation.');
      }
      return actual.spawn(process.execPath, ['--input-type=module', '-e',
        'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(process.argv[1]));', archivePath
      ], options);
    });
    for (const execute of [executeGitHubPhase, executeAzurePhase]) {
      const outcome = await withProjectMutationLock(f.projectRoot, (lease) => execute({ ...f.input, lease }));
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        status: 'completed', resultState: 'verified',
        operation: { provider: 'github', operationId: '100', status: 'completed' },
        evidencePayload: { digest: f.imageDigest, buildRunId: 100 }
      });
      expect(outcome!.completedOperations?.map((operation) => operation.actionId))
        .toEqual(['github.artifact.build-dispatch', 'azure.artifact.readback']);
      expect(outcome!.liveReadback?.map((proof) => proof.provider)).toEqual(['github', 'azure']);
    }
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(f.protocol.requests.some((request) => request.path.split('?')[0] === '/repos/owner/repo/actions/artifacts')).toBe(false);
    expect(f.commands.some((command) => command.executable === 'gh' && command.args.includes('POST'))).toBe(true);
    expect(f.registryRequests.some((request) => request.url.endsWith(`/manifests/${f.imageDigest}`))).toBe(true);
  });

  it('retains one pending provider run without falling through to another dispatch or artifact listing', async () => {
    const f = await fixture();
    f.protocol.runStatus = 'queued';
    for (const execute of [executeGitHubPhase, executeAzurePhase]) {
      const outcome = await withProjectMutationLock(f.projectRoot, (lease) => execute({ ...f.input, lease }));
      expect(outcome).toMatchObject({ status: 'pending', operation: { operationId: '100', status: 'running' } });
    }
    expect(f.protocol.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(f.protocol.requests.some((request) => request.binary)).toBe(false);
    expect(f.registryRequests).toEqual([]);
  });

  it('blocks a nonterminal exact registry before any build dispatch or image read', async () => {
    const f = await fixture();
    f.registry.properties.provisioningState = 'Updating';
    const outcome = await withProjectMutationLock(f.projectRoot, (lease) => executeGitHubPhase({ ...f.input, lease }));
    expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [] });
    expect(outcome!.evidencePayload).toBeUndefined();
    expect(f.azureRequests).toHaveLength(1);
    expect(f.protocol.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(f.registryRequests).toEqual([]);
  });

  it.each(['repository', 'local', 'lifecycle'] as const)('never introduces combined Azure or build effects into %s scope', async (scope) => {
    const f = await fixture();
    const input = { ...f.input, inspection: { ...f.input.inspection, scope } };
    expect(await planCompositePhase(input)).toBeNull();
    expect(await executeCompositePhase(input)).toBeNull();
    await expect(buildSavedTransitionPlan({
      inspection: input.inspection, runner: input.runner, now: input.now,
      phaseId: 'application-artifact-ready', adapters: input.adapters
    })).rejects.toThrow(/cannot plan or execute/);
    expect(f.protocol.requests).toEqual([]);
    expect(f.azureRequests).toEqual([]);
  });

  it.each(['application-prerequisites-ready', 'application-foundation'] as const)(
    'requires exact private resource-changing inputs for %s without proposing placeholder effects',
    async (phaseId) => {
      const f = await fixture();
      const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === phaseId)!;
      const input = { ...f.input, phase };
      expect(await planAzurePhase(input)).toMatchObject({ operations: [], blockers: [expect.stringContaining('input-fields')] });
      expect(await executeAzurePhase(input)).toMatchObject({ status: 'blocked', completedOperations: [] });
      expect(f.protocol.requests).toEqual([]);
      expect(f.azureRequests).toEqual([]);
      expect(f.commands).toEqual([]);
    }
  );
});
