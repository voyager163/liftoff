import { describe, expect, it } from 'vitest';
import { getCommandHelp, parseArgs } from '../src/args.js';
import { adoptionRequestIssue } from '../src/application/project-evolution/adoption/request.js';

describe('scoped lifecycle command admission', () => {
  it.each(['status', 'plan', 'resume', 'verify', 'apply-next'])(
    'requires explicit selection for repository %s without inventing default scope',
    (subcommand) => {
      const selected = parseArgs(['governance', subcommand, '--scope', 'repository', '--json']);
      expect(selected.flags.scope).toBe('repository');
      expect(parseArgs(['governance', subcommand]).flags.scope).toBeUndefined();
      const scope = getCommandHelp('governance').optionGroups
        .flatMap((group) => group.entries)
        .find((entry) => entry.syntax.startsWith('--scope'));
      expect(scope?.defaultValue).toBe('activation');
    }
  );

  it.each(['repositories', 'all', 'Repository', 'local,repository', ''])(
    'rejects unsupported scope %j before target discovery',
    (scope) => {
      expect(() => parseArgs(['governance', 'plan', `--scope=${scope}`])).toThrow();
    }
  );

  it('retains the original relative input argument for boundary resolution, not a shell-expanded command', () => {
    const project = "C:\\Projects\\Client's API & worker";
    const inputs = '..\\approved inputs\\azure.json';
    const parsed = parseArgs([
      'governance', 'plan', '--project', project, '--scope', 'activation', '--inputs', inputs, '--json'
    ]);
    expect(parsed.flags).toEqual({ project, scope: 'activation', inputs, json: true });
  });

  it('does not let scope or output selection grant execution or assessment authority', () => {
    const parsed = parseArgs(['governance', 'apply-next', '--scope', 'repository', '--json']);
    expect(parsed.flags.execute).toBeUndefined();
    expect(parsed.flags.plan).toBeUndefined();
    expect(() => parseArgs(['governance', 'verify', '--scope', 'repository', '--execute'])).toThrow();
    expect(() => parseArgs(['governance', 'assess', '--scope', 'repository'])).toThrow();
  });

  it.each(['--approve-plan', '--plan', '--force', '--yes', '--execute'])(
    'does not add universal approval option %s to ordinary upgrade',
    (flag) => {
      expect(() => parseArgs(['upgrade', flag, 'a'.repeat(64)])).toThrow(/Unknown flag/);
    }
  );

  it('distinguishes installation upgrade and fresh-target migration in help', () => {
    expect(getCommandHelp('upgrade').description).toContain('verified installation owner');
    expect(getCommandHelp('upgrade').description).not.toContain('global npm');
    expect(getCommandHelp('migrate').description).toContain('fresh migration target');
    expect(getCommandHelp('migrate').description).toContain('not in-place adoption');
  });

  it.each(['--yes', '--force', '--apply', '--execute'])(
    'rejects generic migration approval %s before any installation observation',
    (flag) => {
      expect(() => parseArgs(['installation', 'migrate', '--to', 'direct', flag])).toThrow(/Unknown flag/);
    }
  );

  it.each(['homebrew-cask', 'winget', 'direct'])('admits only exact reviewed %s migration syntax', (owner) => {
    const fingerprint = 'b'.repeat(64);
    const parsed = parseArgs([
      'installation', 'migrate', '--to', owner, '--candidate', 'candidate with spaces',
      '--approve-plan', fingerprint, '--json'
    ]);
    expect(parsed.flags['approve-plan']).toBe(fingerprint);
    expect(parsed.flags.candidate).toBe('candidate with spaces');
  });

  it.each([
    ['installation'],
    ['installation', 'migrate'],
    ['installation', 'migrate', '--to', 'npm'],
    ['installation', 'migrate', '--to', 'direct', '--approve-plan', 'b'.repeat(8)],
    ['installation', 'migrate', '--to', 'direct', '--approve-plan', 'B'.repeat(64)],
    ['installation', 'migrate', '--to', 'direct', '--check', '--approve-plan', 'b'.repeat(64)],
    ['installation', 'migrate', '--recover', '--to', 'direct'],
    ['installation', 'inspect', '--to', 'direct'],
    ['installation', 'inspect', '--approve-plan', 'b'.repeat(64)],
    ['installation', 'inspect', '--recover'],
    ['installation', 'inspect', 'some-project']
  ])('rejects missing, mixed, or stale-approval syntax %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it.each(['list', 'plan', 'inspect', 'install', 'update', 'remove', 'migrate'])(
    'routes the registered skills %s operation without positional fallback',
    (subcommand) => {
      const args = ['skills', subcommand];
      if (!['list', 'inspect'].includes(subcommand)) args.push('--host', 'copilot,codex');
      if (subcommand === 'migrate') args.push('--scope', 'project', '--project', 'project with spaces');
      const parsed = parseArgs(args);
      expect(parsed.subcommand).toBe(subcommand);
      expect(parsed.positional).toEqual([]);
    }
  );

  it.each([
    ['skills', 'unknown'],
    ['skills', 'install'],
    ['skills', 'install', '--host', 'all'],
    ['skills', 'install', '--host', 'copilot,copilot'],
    ['skills', 'install', '--host', 'copilot', '--yes'],
    ['skills', 'install', '--host', 'copilot', '--apply'],
    ['skills', 'install', '--host', 'copilot', '--home', 'other-home'],
    ['skills', 'install', '--host', 'copilot', '--check', '--approve-plan', 'a'.repeat(64)],
    ['skills', 'inspect', '--approve-plan', 'a'.repeat(64)],
    ['skills', 'list', '--scope', 'project'],
    ['skills', 'migrate', '--host', 'copilot'],
    ['skills', 'install', '--host', 'copilot', '--scope', 'user', '--project', 'some-project']
  ])('rejects ambiguous or overbroad skills authority %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it('preserves an explicit adoption boundary and independent verification permissions', () => {
    const parsed = parseArgs([
      'adopt', 'project with spaces', '--verify-plan', 'c'.repeat(64),
      '--allow-dependency-preparation', '--allow-network', '--json'
    ]);
    expect(parsed.positional).toEqual(['project with spaces']);
    expect(parsed.flags['verify-plan']).toBe('c'.repeat(64));
    expect(parsed.flags['approve-plan']).toBeUndefined();
    expect(parseArgs(['adopt', '--help']).flags.help).toBe(true);
  });

  it.each([
    ['adopt'],
    ['adopt', 'project', '--project', 'other'],
    ['adopt', 'project', '--yes'],
    ['adopt', 'project', '--force'],
    ['adopt', 'project', '--approve-plan', 'c'.repeat(63)],
    ['adopt', 'project', '--approve-plan', `${'c'.repeat(64)}\n`],
    ['adopt', 'project', '--check', '--approve-plan', 'c'.repeat(64)],
    ['adopt', 'project', '--check', '--verify-plan', 'c'.repeat(64)],
    ['adopt', 'project', '--approve-plan', 'c'.repeat(64), '--verify-plan', 'c'.repeat(64)],
    ['adopt', 'project', '--approve-plan', 'c'.repeat(64), '--allow-network'],
    ['adopt', 'project', '--allow-dependency-preparation'],
    ['adopt', 'project', '--recover', '--proposal', 'patch.json']
  ])('rejects implicit or mixed adoption authority %j before effects', (...argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it('also rejects undeclared and wrongly typed application API input', () => {
    expect(adoptionRequestIssue({ project: 'project', ...{ yes: true } })).not.toBeNull();
    expect(adoptionRequestIssue({ project: 'project', check: 'true' })).not.toBeNull();
    expect(adoptionRequestIssue({ project: 'project', approvePlan: `${'c'.repeat(64)}\n` })).not.toBeNull();
  });

  it('admits only the read-only whole-project assessment surface', () => {
    expect(parseArgs([
      'assess', 'existing project', '--component', 'frontend', '--profile', 'vue-component',
      '--inputs', '../public inputs.json', '--json'
    ])).toMatchObject({
      command: 'assess', positional: ['existing project'],
      flags: { component: 'frontend', profile: 'vue-component', inputs: '../public inputs.json', json: true }
    });
    for (const flag of ['--live', '--execute', '--yes', '--force', '--check', '--format']) {
      expect(() => parseArgs(['assess', flag])).toThrow(/Unknown flag/);
    }
    expect(() => parseArgs(['assess', 'one-project', '--project', 'another'])).toThrow(/either positionally/);
  });
});
