import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { visibleLength } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';
import path from 'node:path';
import { commandShellForPlatform, formatShellCommand } from '../src/adapters/process/shell-command.js';

const layouts = [
  { name: 'rich', columns: 100 },
  { name: 'compact', columns: 80 },
  { name: 'plain', columns: 50 }
] as const;

async function screen(args: string[], columns: number): Promise<{ out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd: process.cwd(),
    stdout,
    stderr,
    terminal: { snapshot: true, columns }
  });
  expect(code).toBe(0);
  return { out: stdout.text(), err: stderr.text() };
}

describe('complete help screens', () => {
  for (const layout of layouts) {
    it(`snapshots ${layout.name} general help`, async () => {
      const result = await screen(['help'], layout.columns);
      expect(result.err).toBe('');
      expect(result.out).toMatchSnapshot();
      if (layout.name === 'rich') {
        expect(result.out.split('\n').every((line) => visibleLength(line) <= layout.columns)).toBe(true);
      }
    });

    for (const command of ['init', 'update', 'upgrade', 'doctor', 'governance', 'regions', 'dev'] as const) {
      it(`snapshots ${layout.name} ${command} command help`, async () => {
        const result = await screen([command, '--help'], layout.columns);
        expect(result.err).toBe('');
        expect(result.out).toMatchSnapshot();
        expect(result.out).toContain(`liftoff ${command}`);
        if (layout.name === 'rich') {
          expect(result.out.split('\n').every((line) => visibleLength(line) <= layout.columns)).toBe(true);
        }
      });
    }

    it(`snapshots ${layout.name} governance assessment help`, async () => {
      const result = await screen(['governance', 'assess', '--help'], layout.columns);
      expect(result.err).toBe('');
      expect(result.out).toContain('liftoff governance assess [project-path] [--json] [--live]');
      expect(result.out).not.toContain('--execute');
      expect(result.out).toMatchSnapshot();
      if (layout.name === 'rich') {
        expect(result.out.split('\n').every((line) => visibleLength(line) <= layout.columns)).toBe(true);
      }
    });
  }
});

describe('update help review sequence', () => {
  it('explains previews, receipts, exact approval, protected scope, and exit behavior', async () => {
    const { out, err } = await screen(['update', '--help'], 50);
    expect(err).toBe('');
    for (const phrase of [
      'Start with `liftoff update --check`',
      'then run `liftoff update`',
      'default: no',
      'project bytes unchanged',
      'user-local liftoff/update-previews',
      'outside the repository',
      'receipt is not approval',
      'same checkout and receipt store',
      '--approve-plan <fingerprint>',
      'full lowercase 64-hex SHA-256 fingerprint',
      'separately previewed forced plan',
      'owned-core conflicts and retired aliases',
      'provisioning collisions remain protected',
      'force cannot bypass compatibility',
      'force and JSON are not consent',
      'schema-3 result on stdout',
      'interactive approval uses stderr',
      'Exit 0:',
      '2: drift or committed migration with incomplete revalidation',
      '1: rejected or failed operation'
    ]) {
      expect(out).toContain(phrase);
    }
    expect(out).not.toContain('--apply');
    expect(out).not.toContain('Option: --yes');
  });

  it('keeps help available before discovery regardless of JSON or the approval flag', async () => {
    const plain = await screen(['update', '--help'], 50);
    const withApproval = await screen([
      'update', '--project', path.join(process.cwd(), 'package.json', 'not-a-project'),
      '--json', '--approve-plan', 'a'.repeat(64), '--help'
    ], 50);
    expect(withApproval).toEqual(plain);
  });
});

describe('reference and helper presentation hierarchy', () => {
  for (const [args, expected] of [
    [['patterns'], 'multi-agent'],
    [['providers'], 'azure'],
    [['regions', 'search', 'korea'], 'koreacentral'],
    [['dev', 'logs'], formatShellCommand(
      { executable: 'docker', args: ['compose', 'logs', '-f'] },
      commandShellForPlatform(process.platform)
    )],
    [['infra', 'plan', '--env', 'staging'], formatShellCommand({
      executable: 'tofu',
      args: [
        `-chdir=${path.join('infrastructure', 'opentofu', 'azure', 'environments', 'staging')}`,
        'plan', '-var-file=staging.tfvars'
      ]
    }, commandShellForPlatform(process.platform))]
  ] as const) {
    it(`renders ${args.join(' ')} consistently in rich and plain modes`, async () => {
      const rich = await screen([...args], 100);
      const plain = await screen([...args], 50);

      expect(rich.out).toContain(expected);
      expect(rich.out).toMatch(/[┌└│]/);
      expect(plain.out).toContain(expected);
      expect(plain.out).not.toMatch(/[┌┐└┘│]/);
      expect(plain.out).not.toMatch(/\u001B\[/);
    });
  }
});
