import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { ensureWorkstationReady } from '../src/application/initialize/use-case.js';
import { buildProjectPlan } from '../src/planner.js';
import { PresentationSession } from '../src/terminal.js';
import { selectWorkstationRequirements, type ExecutableObserver } from '../src/workstation.js';
import type { CommandRunner, CommandResult, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { ExecutionContext } from '../src/application/context.js';
import { createWorkstationNoProgressStore } from '../src/adapters/filesystem/workstation-attempts.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const plan = buildProjectPlan({
  projectName: 'Causal setup', projectType: 'standard', apiStack: 'node-fastify',
  cloud: 'azure', region: 'eastus', environments: ['dev'], specWorkflow: 'openspec',
  agents: ['github-copilot'], includeFrontend: false
}, { requireProjectName: true });

class WorkstationRunner implements CommandRunner {
  calls: ExternalCommand[] = [];
  callOptions: (RunCommandOptions | undefined)[] = [];
  copilotVersion = '1.0.83';
  nodeVersion?: string;
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push(command);
    this.callOptions.push(options);
    const selected = selectWorkstationRequirements(plan).find((requirement) =>
      requirement.definition.probes.some((probe) => probe.executable === command.executable));
    const version = selected?.exactVersion ?? selected?.minimumVersion ?? '999.0.0';
    const stdout = command.executable === 'node' && this.nodeVersion
      ? `v${this.nodeVersion}`
      : command.executable === 'copilot'
      ? `GitHub Copilot CLI ${this.copilotVersion}.`
      : command.executable === 'brew' ? 'Homebrew 5.0.0' : version;
    return {
      command, displayCommand: [command.executable, ...command.args].join(' '),
      status: 0, signal: null, stdout, stderr: '', timedOut: false
    };
  }
}

const observer: ExecutableObserver = {
  async resolve(executable) {
    return {
      executable, resolution: 'resolved', resolvedPath: `/opt/homebrew/bin/${executable}`,
      realPath: `/opt/homebrew/Cellar/${executable}/test/bin/${executable}`,
      origin: 'brew', kind: 'executable', evidence: 'path-search'
    };
  },
  async inspect(candidate) {
    return { executable: candidate, resolution: 'missing', origin: 'unknown', evidence: 'documented-location' };
  }
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-workstation-init-'));
  roots.push(root);
  const cwd = path.join(root, 'project');
  await mkdir(cwd, { mode: 0o700 });
  const storage = { homedir: path.join(root, 'private-home'), env: {} };
  let output = '';
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const presentation = new PresentationSession({ stdout, stderr: stdout, snapshot: true, columns: 160 });
  const runner = new WorkstationRunner();
  const context: ExecutionContext = {
    cwd, stdout, stderr: stdout, presentation, runner, env: { PATH: '/opt/homebrew/bin' },
    workstationNoProgressStore: createWorkstationNoProgressStore(cwd, storage),
    workstationProbe: { host: { platform: 'darwin', linuxFamily: 'unknown' }, executableObserver: observer, includeHealthNotices: false }
  };
  return { context, runner, presentation, storage, output: () => output };
}

describe('causal workstation integration during initialization', () => {
  it('displays and executes the matching upgrade instead of repeating a missing-tool install', async () => {
    const { context, runner, presentation, output } = await fixture();
    runner.nodeVersion = '24.0.0';
    const first = await ensureWorkstationReady(plan, { installTools: true, yes: true }, context, runner, presentation);
    expect(first.ready).toBe(false);
    expect(runner.calls.some((command) => command.executable === 'brew' && command.args.includes('upgrade'))).toBe(true);
    expect(runner.calls.some((command) => command.executable === 'brew' && command.args.includes('install'))).toBe(false);
    expect(output()).toContain('below-minimum');
    expect(output()).toContain('no progress');
    expect(output()).not.toContain('Open a new terminal if PATH changed');
    expect(output()).not.toContain('Installed successfully');
    await ensureWorkstationReady(plan, { installTools: true, yes: true }, context, runner, presentation);
    expect(runner.calls.filter((command) => command.executable === 'brew' && command.args.includes('upgrade'))).toHaveLength(1);
  });

  it('continues for a compatible official preview without running an installer', async () => {
    const { context, runner, presentation } = await fixture();
    runner.copilotVersion = '1.0.84-5';
    const result = await ensureWorkstationReady(plan, { installTools: true, yes: true }, context, runner, presentation);
    expect(result.ready).toBe(true);
    expect(result.probes.find((probe) => probe.requirement.id === 'github-copilot')).toMatchObject({
      state: 'ready', reasonCode: 'compatible', detectedVersion: '1.0.84-5'
    });
    expect(runner.calls.some((command) => command.executable === 'brew')).toBe(false);
    expect(runner.callOptions.every((options) => options?.env?.PATH === '/opt/homebrew/bin')).toBe(true);
  });

  it('does not treat missing noninteractive tool consent as permission or a TTY prompt', async () => {
    const { context, runner, presentation } = await fixture();
    runner.nodeVersion = '24.0.0';
    const result = await ensureWorkstationReady(plan, {}, context, runner, presentation);
    expect(result.ready).toBe(false);
    expect(runner.calls.some((command) => command.executable === 'brew')).toBe(false);
  });

  it('does not repeat an unchanged remedy across a fresh runner and neutral command directory', async () => {
    const { context, runner, presentation, storage } = await fixture();
    runner.nodeVersion = '24.0.0';
    await ensureWorkstationReady(plan, { installTools: true, yes: true }, context, runner, presentation);
    const fresh = new WorkstationRunner();
    fresh.nodeVersion = '24.0.0';
    const nextContext = { ...context, runner: fresh, workstationNoProgressStore: createWorkstationNoProgressStore(context.cwd, storage) };
    const result = await ensureWorkstationReady(plan, { installTools: true, yes: true },
      nextContext, fresh, presentation, undefined, 'liftoff init', path.join(context.cwd, 'different-neutral-directory'));
    expect(result.ready).toBe(false);
    expect(fresh.calls.some((command) => command.executable === 'brew')).toBe(false);
  });
});
