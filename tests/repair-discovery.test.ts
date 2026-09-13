import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverRepairEligibility, repairCommandLimits } from '../src/application/repair/discovery.js';
import type { InfrastructureRepairCandidate } from '../src/application/repair/infrastructure.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { parseArgs } from '../src/args.js';

const subscription = '11111111-2222-3333-4444-555555555555';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const candidate = (): InfrastructureRepairCandidate => ({
  layout: 'legacy-shared', blockers: [], snapshots: [], mutations: [], artifacts: [], files: [], directoryInventory: [],
  statePaths: [['terraform.tfstate']], resourceGroups: [{ environment: 'dev', name: 'example-dev' }]
});
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'liftoff-repair-discovery-'));
  roots.push(value);
  return value;
}
class Runner implements CommandRunner {
  calls: { command: ExternalCommand; options?: RunCommandOptions }[] = [];
  constructor(readonly group: Partial<CommandResult> = { stdout: 'false' }, readonly accountId = subscription) {}
  async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push({ command, options });
    return {
      command, displayCommand: '', status: 0, signal: null, stderr: '', timedOut: false,
      stdout: JSON.stringify({ id: this.accountId, tenantId: 'tenant', state: 'Enabled' }),
      ...(command.args[0] === 'group' ? this.group : {})
    };
  }
}
describe('public repair command grammar', () => {
  it('registers independent check, apply and recovery', () => {
    expect(parseArgs(['repair', 'project with spaces', '--check', '--live', '--subscription', subscription]).command).toBe('repair');
    expect(parseArgs(['repair', '--approve-plan', 'a'.repeat(64)]).flags['approve-plan']).toBe('a'.repeat(64));
    expect(parseArgs(['repair', '--recover', '--json']).flags.recover).toBe(true);
  });
  it.each([
    ['--check', '--approve-plan', 'a'.repeat(64)],
    ['--check', '--recover'], ['--recover', '--approve-plan', 'a'.repeat(64)],
    ['--approve-plan', 'a'.repeat(64), '--live', '--subscription', subscription],
    ['--approve-plan', 'no'], ['--live'], ['--subscription', subscription],
    ['--live', '--subscription', 'a-name'], ['--force'], ['--yes'],
    ['some-project', '--project', 'another-project']
  ])('rejects invalid authority before inspection: %j', (...args) => {
    expect(() => parseArgs(['repair', ...args])).toThrow();
  });
});
describe('repair metadata discovery', () => {
  it('does not equate missing local state with verified undeployed scope', async () => {
    const runner = new Runner();
    const result = await discoverRepairEligibility(await root(), candidate(), { live: false, runner });
    expect(result.status).toBe('unknown');
    expect(result.blockers.join(' ')).toContain('not proof');
    expect(runner.calls).toEqual([]);
  });
  it('never reads state payloads or makes live calls when state metadata exists', async () => {
    const project = await root(), runner = new Runner();
    await writeFile(path.join(project, 'terraform.tfstate'), 'private-do-not-read', { mode: 0o000 });
    const result = await discoverRepairEligibility(project, candidate(), { live: true, subscription, runner });
    expect(result.status).not.toBe('verified-undeployed');
    expect(JSON.stringify(result)).not.toContain('private-do-not-read');
    expect(runner.calls).toEqual([]);
  });
  it('requires exact account and bounded group absence readbacks', async () => {
    const project = await root(), runner = new Runner();
    const result = await discoverRepairEligibility(project, candidate(), { live: true, subscription, runner });
    expect(result.status).toBe('verified-undeployed');
    expect(runner.calls).toHaveLength(2);
    for (const call of runner.calls) {
      expect(call.command.args).toContain(subscription);
      expect(call.options).toMatchObject({ ...repairCommandLimits, cwd: project });
    }
  });
  it('rejects a different subscription before group reads', async () => {
    const runner = new Runner(undefined, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const result = await discoverRepairEligibility(await root(), candidate(), { live: true, subscription, runner });
    expect(result.status).toBe('unknown');
    expect(result.blockers.join(' ')).toContain('exact enabled subscription');
    expect(runner.calls).toHaveLength(1);
  });
  it('rejects overlapping environment ownership rather than creating two owners', async () => {
    const runner = new Runner(), source = candidate();
    source.resourceGroups.push({ environment: 'prod', name: 'EXAMPLE-DEV' });
    const result = await discoverRepairEligibility(await root(), source, { live: true, subscription, runner });
    expect(result.status).toBe('unknown');
    expect(result.blockers.join(' ')).toContain('overlap');
    expect(runner.calls).toHaveLength(0);
  });
  it('keeps existing resources out of local repair', async () => {
    const result = await discoverRepairEligibility(await root(), candidate(), {
      live: true, subscription, runner: new Runner({ stdout: 'true' })
    });
    expect(result.status).toBe('stateful');
    expect(result.blockers.join(' ')).toContain('separately approved');
  });
  it.each([
    { stdout: 'false', timedOut: true },
    { stdout: 'false', status: 1, stderr: 'private provider diagnostic' },
    { stdout: 'false', outputLimitExceeded: true },
    { stdout: '{"exists":false}' },
    { stdout: 'invalid' }
  ])('never converts failed or invalid metadata to absence: %j', async (response) => {
    const result = await discoverRepairEligibility(await root(), candidate(), { live: true, subscription, runner: new Runner(response) });
    expect(result.status).toBe('unknown');
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('private provider diagnostic');
  });
});
