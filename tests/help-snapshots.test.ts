import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { visibleLength } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';

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

describe('reference and helper presentation hierarchy', () => {
  for (const [args, expected] of [
    [['patterns'], 'multi-agent'],
    [['providers'], 'azure'],
    [['regions', 'search', 'korea'], 'koreacentral'],
    [['dev', 'logs'], 'docker compose logs -f'],
    [['infra', 'plan', '--env', 'staging'], 'tofu plan -var-file=environments/staging.tfvars']
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
