import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codingAgents, developmentWorkflows, governanceProfiles } from '../src/application/project/catalog.js';
import { commandDefinitions } from '../src/cli/args/definitions.js';
import { parseArgs } from '../src/cli/args/parser.js';

function expandSynopsis(syntax: string): string[] {
  if (!/^liftoff(?:\s|$)/.test(syntax) || /[\r\n`"'$;{}()]/.test(syntax) || /\[[^\]]*\[/.test(syntax)) {
    throw new Error('Unsupported command synopsis grammar.');
  }
  syntax = syntax.replace(/\\\|/g, '|');
  const optional = syntax.match(/\[([^[\]]+)\]/);
  if (optional) {
    const index = optional.index;
    if (index === undefined) throw new Error('Optional synopsis group has no location.');
    const before = syntax.slice(0, index);
    const after = syntax.slice(index + optional[0].length);
    const expanded = [
      ...expandSynopsis(`${before}${after}`),
      ...expandSynopsis(`${before}${optional[1]}${after}`)
    ];
    if (expanded.length > 128) throw new Error('Command synopsis expansion exceeds its bound.');
    return expanded;
  }
  const value = syntax.match(/<([A-Za-z0-9._|-]+)>/);
  if (value) {
    const index = value.index;
    if (index === undefined) throw new Error('Synopsis value has no location.');
    const name = value[1];
    if (!name || name === '...') throw new Error('Unsupported synopsis value.');
    const choices = name.includes('|') ? name.split('|') :
      name === 'target' ? developmentWorkflows.map(workflow => workflow.id) :
      name === 'profile' ? governanceProfiles.map(profile => profile.id) :
      [name === 'fingerprint' ? 'a'.repeat(64) :
        name === 'list' ? codingAgents.map(agent => agent.id).join(',') :
        name === 'agent' ? codingAgents[0]?.id ?? '' :
        name === 'UUID' ? '00000000-0000-4000-8000-000000000001' : 'example'];
    if (choices.some(choice => !choice)) throw new Error('Empty synopsis alternative.');
    const expanded = choices.flatMap(choice => expandSynopsis(
      `${syntax.slice(0, index)}${choice}${syntax.slice(index + value[0].length)}`
    ));
    if (expanded.length > 128) throw new Error('Command synopsis expansion exceeds its bound.');
    return expanded;
  }
  if (/[<>\[\]|\\]/.test(syntax)) throw new Error('Unclosed or unsupported command synopsis notation.');
  return [syntax.trim().replace(/\s+/g, ' ')];
}

function parseSynopsis(syntax: string) {
  return expandSynopsis(syntax).map(command => parseArgs(command.split(' ').slice(1)));
}

describe('documented lifecycle command synopses', () => {
  it('expands optional project and flag groups independently', () => {
    expect(expandSynopsis('liftoff assess [project] [--json]')).toEqual([
      'liftoff assess', 'liftoff assess --json', 'liftoff assess project', 'liftoff assess project --json'
    ]);
    expect(parseSynopsis('liftoff assess [project] [--json]')).toHaveLength(4);
  });

  it('checks every enumerated workflow target and exact fingerprint placeholder', () => {
    expect(parseSynopsis('liftoff workflow set <openspec\\|spec-kit\\|manual> [project] --approve-plan <fingerprint>'))
      .toHaveLength(6);
    for (const parsed of parseSynopsis('liftoff update --recover --approve-plan <fingerprint>')) {
      expect(parsed.flags['approve-plan']).toBe('a'.repeat(64));
    }
  });

  it('refuses more than 128 synopsis expansions', () => {
    expect(() => expandSynopsis(`liftoff assess ${Array.from({ length: 8 }, () => '[--json]').join(' ')}`))
      .toThrow('expansion exceeds its bound');
  });

  it.each([
    'liftoff assess [project', 'liftoff assess project]', 'liftoff assess <project',
    'liftoff assess <...>', 'liftoff assess <manual|>', 'liftoff assess [project [--json]]',
    'liftoff assess "project with spaces"',
    'liftoff assess $(pwd)', 'liftoff assess; echo success', 'liftoff assess\n--json'
  ])('refuses unsupported or malformed notation: %s', syntax => {
    expect(() => expandSynopsis(syntax)).toThrow();
  });

  it.each(['liftoff setup', 'liftoff doctor project', 'liftoff capabilities --invented-option'])(
    'does not turn unsupported public syntax into a passing example: %s', syntax => {
      expect(() => parseSynopsis(syntax)).toThrow();
    }
  );

  it('parses all lifecycle table expansions and matches the registered command inventory', async () => {
    const reference = await readFile(path.join(process.cwd(), 'docs/cli-reference.md'), 'utf8');
    const sections = reference.split(/^## Lifecycle$/m);
    if (sections.length !== 2) throw new Error('CLI reference must have exactly one lifecycle section.');
    const lifecycle = sections[1]?.split(/^## /m)[0];
    if (!lifecycle) throw new Error('CLI reference has no lifecycle section.');
    const syntaxes = lifecycle.split('\n').flatMap(line => {
      const syntax = line.match(/^\|\s*`(liftoff [^`]+)`\s*\|/)?.[1];
      return syntax ? [syntax] : [];
    });
    expect(syntaxes.length).toBeGreaterThan(0);
    const parsed = syntaxes.flatMap(parseSynopsis);
    const commands = new Set(parsed.map(command => command.command));
    expect(reference).toContain('Run `liftoff help`');
    commands.add(parseArgs(['help']).command);
    expect([...commands].filter(command => typeof command === 'string' && Object.hasOwn(commandDefinitions, command)).sort())
      .toEqual(Object.keys(commandDefinitions).sort());
    for (const [name, definition] of Object.entries(commandDefinitions)) {
      const documented = new Set(parsed.filter(command => command.command === name)
        .map(command => command.subcommand).filter(subcommand => subcommand !== undefined));
      expect([...documented].every(subcommand => definition.subcommands?.includes(subcommand)), name).toBe(true);
    }
  });
});
