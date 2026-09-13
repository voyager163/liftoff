import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunner, CommandResult, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { InfrastructureRepairCandidate } from '../src/application/repair/infrastructure.js';
import { validateRepairCandidate } from '../src/application/repair/validation.js';
import { buildRepairPreview, loadRepairPreview, repairApprovalStore } from '../src/application/repair/preview.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix)); roots.push(root); return root;
}
function candidate(): InfrastructureRepairCandidate {
  return {
    layout: 'legacy-shared', blockers: [], artifacts: [], snapshots: [], mutations: [], statePaths: [], resourceGroups: [], directoryInventory: [],
    files: [{ pathParts: ['infrastructure', 'opentofu', 'azure', 'environments', 'dev', 'main.tf'], content: '# preserved source\n' }]
  };
}
class Runner implements CommandRunner {
  calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [];
  constructor(readonly result: Partial<CommandResult> = {}, readonly version = '1.12.6') {}
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    if (!['--version', 'fmt'].includes(command.args[0])) expect(await readFile(path.join(options!.cwd!, 'main.tf'), 'utf8')).toBe('# preserved source\n');
    return {
      command, displayCommand: '', status: 0, signal: null, stdout: '{"valid":true,"error_count":0}',
      stderr: '', timedOut: false, ...this.result,
      ...(command.args[0] === '--version' ? { stdout: `OpenTofu v${this.version}`, status: 0, timedOut: false } : {})
    };
  }
}
describe('isolated local repair validation', () => {
  it.each(['1.12.5', '1.13.0', '1.12.6-beta.1'])('rejects an incompatible OpenTofu %s without installing anything', async (version) => {
    const runner = new Runner({}, version);
    await expect(validateRepairCandidate(candidate(), ['dev'], runner)).rejects.toThrow('Prepare that executable separately');
    expect(runner.calls.map(({ command }) => command.args[0])).toEqual(['--version']);
  });

  it('validates only backend-disabled staged roots and removes temporary material', async () => {
    const runner = new Runner();
    await validateRepairCandidate(candidate(), ['dev'], runner, {
      TF_CLI_ARGS_init: '-upgrade -backend=true', ARM_CLIENT_SECRET: 'not-for-validation'
    });
    expect(runner.calls.map(({ command }) => command.args[0])).toEqual(['--version', 'fmt', 'init', 'validate']);
    expect(runner.calls[2].command.args).toContain('-backend=false');
    expect(runner.calls[2].command.args).toContain('-lockfile=readonly');
    for (const call of runner.calls) {
      expect(call.options?.timeoutMs).toBeLessThanOrEqual(120000);
      expect(call.options?.maxOutputBytes).toBeLessThanOrEqual(65536);
      expect(call.options?.env?.TF_CLI_ARGS_init).toBeUndefined();
      expect(call.options?.env?.ARM_CLIENT_SECRET).toBeUndefined();
      await expect(stat(call.options!.cwd!)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it.each([
    { timedOut: true, stdout: 'sensitive output' }, { status: 1, stderr: 'sensitive diagnostic' },
    { stdout: '{"valid":false,"error_count":1}' }, { stdout: 'not-json' }
  ])('rejects failed or unproven validation without echoing configuration: %j', async (result) => {
    const runner = new Runner(result);
    await expect(validateRepairCandidate(candidate(), ['dev'], runner)).rejects.not.toThrow(/sensitive output|sensitive diagnostic/);
    await expect(stat(runner.calls[0].options!.cwd!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
describe('repair external authority', () => {
  it('binds previews to project, bytes, plan, recipe, date and live scope', async () => {
    const projectRoot = await directory('liftoff-repair-authority-');
    const home = await directory('liftoff-repair-home-');
    const storage = { homedir: home, env: {} };
    const now = new Date('2026-09-13T00:00:00Z');
    const input = {
      projectRoot, snapshots: [{ pathParts: ['main.tf'], content: Buffer.from('original') }],
      mutations: [{ type: 'write' as const, pathParts: ['main.tf'], content: 'target' }],
      scope: { environments: ['dev'] }, live: true, subscription: '11111111-2222-3333-4444-555555555555', now
    };
    const preview = buildRepairPreview(input);
    await createScopedUserLocalRecordStore(projectRoot, 'repair-preview', storage).write(preview.fingerprint, preview);
    expect(await loadRepairPreview(projectRoot, preview.fingerprint, now, storage)).toEqual(preview);
    const changed = buildRepairPreview({ ...input, snapshots: [{ pathParts: ['main.tf'], content: Buffer.from('edited') }] });
    expect(changed.fingerprint).not.toBe(preview.fingerprint);
    await expect(loadRepairPreview(projectRoot, preview.fingerprint, new Date(now.getTime() + 900000), storage)).rejects.toThrow(/expired/);
    const other = await directory('liftoff-repair-other-');
    await expect(loadRepairPreview(other, preview.fingerprint, now, storage)).rejects.toThrow(/No matching/);
  });
  it('seals exact repair transactions and revokes consumed authority', async () => {
    const projectRoot = await directory('liftoff-repair-seal-'), home = await directory('liftoff-repair-home-');
    const store = repairApprovalStore(projectRoot, { homedir: home, env: {} });
    const fingerprint = 'a'.repeat(64), digest = 'b'.repeat(64);
    await store.write(fingerprint, digest);
    expect(await store.verify(fingerprint, digest)).toBe(true);
    expect(await store.verify(fingerprint, 'c'.repeat(64))).toBe(false);
    await store.remove(fingerprint, digest);
    expect(await store.verify(fingerprint, digest)).toBe(false);
  });
});
