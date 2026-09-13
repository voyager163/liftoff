import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ViteDevServer } from 'vite';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import type { CommandRunner } from '../src/process-runner.js';
import { inspectActivationMigrationHistory } from '../src/governance-activation/migration-history.js';
import { writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import { writeHistoricalV2Fixture } from './fixtures/activation-v2/fixture.js';
import { createActivationSuccessorRuntime } from './fixtures/activation-successor-runtime.js';

const roots = new Set<string>();
const cacheRoot = path.resolve('tests', `.activation-successor-update-loader-${process.pid}-${randomUUID()}`);
let loader: ViteDevServer;
let commands: typeof import('../src/commands.js');
let args: typeof import('../src/args.js');
beforeAll(async () => {
  loader = await createActivationSuccessorRuntime(cacheRoot);
  commands = await loader.ssrLoadModule('/src/commands.ts');
  args = await loader.ssrLoadModule('/src/args.ts');
});
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
afterAll(async () => {
  await loader?.close();
  await rm(cacheRoot, { recursive: true, force: true });
});

class Capture extends Writable {
  text = '';
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.text += chunk.toString('utf8');
    callback();
  }
}

async function fixture(family = 2, workflow: 'openspec' | 'spec-kit' = 'openspec') {
  const directory = path.resolve('tests', `.activation-successor-update-${process.pid}-${randomUUID()}`);
  const projectRoot = path.join(directory, 'project with spaces');
  const home = path.join(directory, 'preview home');
  roots.add(directory);
  const source = family === 1 ? await writeHistoricalV1Fixture(projectRoot) : await writeHistoricalV2Fixture(projectRoot, { workflow });
  await mkdir(path.join(projectRoot, '.git'), { recursive: true });
  await writeFile(path.join(projectRoot, '.git', 'HEAD'), 'ref: refs/heads/develop\n');
  const calls: string[] = [];
  const runner: CommandRunner = {
    async run(command) {
      calls.push([command.executable, ...command.args].join(' '));
      if (['az', 'gh', 'curl'].includes(command.executable) ||
        command.args.some((arg) => ['install', 'init', 'archive', 'commit', 'push', 'state', 'apply', 'import'].includes(arg))) {
        throw new Error(`Unapproved migration effect: ${command.executable} ${command.args.join(' ')}`);
      }
      let stdout = '';
      let status = 0;
      if (command.executable === 'git') {
        if (command.args.join(' ') === 'rev-parse --show-toplevel') stdout = projectRoot;
        else if (command.args.join(' ') === 'rev-parse --verify HEAD') status = 1;
        else if (command.args[0] === 'symbolic-ref') stdout = 'develop';
      } else if (command.executable !== 'openspec') throw new Error('Only reviewed strict seed validation is available in this historical fixture.');
      return { command, displayCommand: [command.executable, ...command.args].join(' '), status, signal: null, stdout, stderr: '', timedOut: false };
    }
  };
  let ticks = 0;
  const clock = () => new Date(Date.parse('2026-09-12T00:00:00.000Z') + ticks++ * 1_000);
  async function run(extra: string[]) {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await commands.runCommand(args.parseArgs(['update', '--project', projectRoot, '--json', ...extra]), {
      cwd: directory, stdout, stderr, runner, updateNow: clock,
      updatePreview: { homedir: home, env: {}, clock }, env: {}
    });
    return { code, output: JSON.parse(stdout.text), stderr: stderr.text };
  }
  return { projectRoot, source, run, calls, home };
}

describe('reviewed update activation successor integration', { timeout: 60_000 }, () => {
  it.each(['openspec', 'spec-kit'] as const)('preserves frozen v2 %s while deferring desired Codex/default additions', async (workflow) => {
    const f = await fixture(2, workflow);
    const configPath = path.join(f.projectRoot, 'liftoff.config.json');
    const desired = {
      ...JSON.parse(await readFile(configPath, 'utf8')),
      agents: ['github-copilot', 'codex'],
      ...(workflow === 'spec-kit' ? { defaultAgent: 'codex' } : {})
    };
    const requestedBytes = Buffer.from(`${JSON.stringify(desired, null, '\t')}\r\n`);
    await writeFile(configPath, requestedBytes);
    const custom = path.join(f.projectRoot, '.agents', 'skills', 'custom', 'SKILL.md');
    await mkdir(path.dirname(custom), { recursive: true });
    await writeFile(custom, 'unowned custom skill\n');
    const checked = await f.run(['--check']);
    expect(checked.code, JSON.stringify(checked.output)).toBe(2);
    expect(checked.output).toMatchObject({
      activationMigration: { status: 'available', sourceIdentity: { activationContractVersion: 2 }, targetIdentity: currentActivationIdentity },
      deferredAgentRepair: {
        kind: 'agent-integration', status: 'separate-repair-required',
        recordedAgents: ['github-copilot'], requestedAgents: ['github-copilot', 'codex'], addAgents: ['codex'],
        changesDefault: workflow === 'spec-kit',
        recordedDefaultAgent: workflow === 'spec-kit' ? 'github-copilot' : null,
        requestedDefaultAgent: workflow === 'spec-kit' ? 'codex' : null
      }
    });
    expect(checked.output.deferredAgentRepair.command.args).toEqual([
      'repair', '--project', f.projectRoot, '--check', '--add-agents', 'codex',
      ...(workflow === 'spec-kit' ? ['--default-agent', 'codex'] : []), '--json'
    ]);
    expect(await readFile(configPath)).toEqual(requestedBytes);
    expect(await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'))).toEqual(f.source.files.get('governance/activation-state.json'));
    expect(f.calls.every((call) => call.startsWith('git '))).toBe(true);
    const selected = checked.output.plans.find((plan: { mode: string; eligible: boolean }) => plan.mode === 'normal' && plan.eligible);
    expect(selected).toBeDefined();
    const applied = await f.run(['--approve-plan', selected.fingerprint]);
    expect(applied.code, JSON.stringify(applied.output)).toBe(2);
    expect(applied.output).toMatchObject({ committed: true, activationMigration: { status: 'committed' }, deferredAgentRepair: { addAgents: ['codex'] } });
    const manifest = JSON.parse(await readFile(path.join(f.projectRoot, 'liftoff.manifest.json'), 'utf8'));
    expect(manifest.project.agents).toEqual(['github-copilot']);
    expect(manifest.project.defaultAgent).toBe(workflow === 'spec-kit' ? 'github-copilot' : undefined);
    expect(manifest.framework).toEqual(f.source.manifest.framework);
    expect(await readFile(configPath)).toEqual(requestedBytes);
    expect(await readFile(custom, 'utf8')).toBe('unowned custom skill\n');
    await expect(access(path.join(f.projectRoot, '.agents', 'skills', 'liftoff-setup', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const history = await inspectActivationMigrationHistory(f.projectRoot);
    if (history.status !== 'committed') throw new Error('Expected committed v3 successor.');
    const configCopy = history.index.files.find((file) => file.originalPathParts.join('/') === 'liftoff.config.json')!;
    expect(await readFile(path.join(f.projectRoot, ...configCopy.copyPathParts))).toEqual(requestedBytes);
  });

  it.each([1, 2])('checks v%s metadata read-only, commits v3, and reports resumable partial local readiness', async (family) => {
    const f = await fixture(family);
    const preview = await f.run(['--check']);
    expect(preview.code, JSON.stringify(preview.output)).toBe(2);
    expect(preview.output).toMatchObject({
      schemaVersion: 3, activationMigration: { status: 'available', targetIdentity: currentActivationIdentity },
      receipt: { status: 'issued' }
    });
    expect(preview.output.activationMigration.sourceIdentity.activationContractVersion).toBe(family);
    expect(f.calls.every((command) => command.startsWith('git '))).toBe(true);
    for (const [file, content] of f.source.files) expect(await readFile(path.join(f.projectRoot, ...file.split('/')))).toEqual(content);
    const selected = preview.output.plans.find((plan: { mode: string; eligible: boolean }) => plan.mode === 'normal' && plan.eligible);
    expect(selected).toBeDefined();
    const applied = await f.run(['--approve-plan', selected.fingerprint]);
    expect(applied.code, JSON.stringify(applied.output)).toBe(2);
    expect(applied.output).toMatchObject({ committed: true, activationMigration: { status: 'committed' }, revalidation: { status: 'blocked' } });
    const history = await inspectActivationMigrationHistory(f.projectRoot);
    expect(history).toMatchObject({ status: 'committed', state: { schemaVersion: 3, identity: currentActivationIdentity } });
    if (history.status !== 'committed') throw new Error('Expected committed history.');
    for (const file of history.index.files) expect(await readFile(path.join(f.projectRoot, ...file.copyPathParts))).toEqual(f.source.files.get(file.originalPathParts.join('/')));
    const snapshotId = history.index.snapshotId;
    const again = await f.run(['--check']);
    expect(again.output).toMatchObject({ activationMigration: { status: 'committed', snapshotId } });
    expect((await inspectActivationMigrationHistory(f.projectRoot)).status).toBe('committed');
  });

  it('rejects missing approval without confusing JSON with authorization', async () => {
    const f = await fixture();
    await f.run(['--check']);
    const applied = await f.run([]);
    expect(applied.code).toBe(1);
    expect(applied.output).toMatchObject({ approval: { status: 'required' } });
    expect(await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'))).toEqual(f.source.files.get('governance/activation-state.json'));
  });

  it('rejects a source change after review without snapshotting or replacing concurrent bytes', async () => {
    const f = await fixture();
    const checked = await f.run(['--check']);
    const selected = checked.output.plans.find((plan: { mode: string; eligible: boolean }) => plan.mode === 'normal' && plan.eligible);
    const manifestPath = path.join(f.projectRoot, 'liftoff.manifest.json');
    const concurrent = Buffer.concat([await readFile(manifestPath), Buffer.from('\n')]);
    await writeFile(manifestPath, concurrent);
    const applied = await f.run(['--approve-plan', selected.fingerprint]);
    expect(applied.code).toBe(1);
    expect(applied.output.committed).not.toBe(true);
    expect(await readFile(manifestPath)).toEqual(concurrent);
    expect(await readFile(path.join(f.projectRoot, 'governance', 'activation-state.json'))).toEqual(f.source.files.get('governance/activation-state.json'));
  });
});
