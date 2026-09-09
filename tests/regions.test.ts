import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/args.js';
import { listRegions } from '../src/catalogs.js';
import { runCommand } from '../src/commands.js';
import { CaptureStream } from './helpers.js';

async function regions(args: string[]) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const run = vi.fn(async () => {
    throw new Error('Reference commands must not invoke external tools.');
  });
  const code = await runCommand(parseArgs(['regions', ...args]), {
    cwd: process.cwd(),
    stdout,
    stderr,
    runner: { run },
    terminal: { layout: 'plain', color: false }
  });
  expect(run).not.toHaveBeenCalled();
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('region reference commands', () => {
  it('filters an exact region instead of changing only the heading', async () => {
    const result = await regions(['--region', 'westus2']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Identifier: westus2');
    expect(result.stdout).not.toContain('Identifier: eastus');
    expect(result.stdout.match(/Identifier:/g)).toHaveLength(1);
  });

  it('resolves a unique human-friendly alias', async () => {
    const result = await regions(['--region', 'East US 2']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Identifier: eastus2');
    expect(result.stdout.match(/Identifier:/g)).toHaveLength(1);
  });

  it('rejects ambiguous exact filters with the explicit choices', async () => {
    const result = await regions(['--region', 'korea']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('koreacentral');
    expect(result.stderr).toContain('koreasouth');
    expect(result.stdout).not.toContain('Identifier:');
  });

  it('rejects unknown exact filters without listing unrelated regions', async () => {
    const result = await regions(['--region', 'mars']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown Azure region');
    expect(result.stdout).not.toContain('Identifier:');
  });

  it('preserves the unfiltered list', async () => {
    const result = await regions([]);
    expect(result.code).toBe(0);
    expect(result.stdout.match(/Identifier:/g)).toHaveLength(listRegions('azure').length);
  });

  it('preserves multi-match region search', async () => {
    const result = await regions(['search', 'korea']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Identifier: koreacentral');
    expect(result.stdout).toContain('Identifier: koreasouth');
    expect(result.stdout.match(/Identifier:/g)).toHaveLength(2);
  });

  it('preserves empty-search warnings and planned-provider rejection', async () => {
    const empty = await regions(['search', 'mars']);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('No Azure regions matched');
    const planned = await regions(['--cloud', 'aws']);
    expect(planned.code).toBe(1);
    expect(planned.stderr).toContain('provider adapter');
  });
});
