import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args/parser.js';
import { loadPackagedProfilesCatalog } from '../src/adapters/packaged-assets/resource-catalog.js';

const guides = [
  'assessment',
  'azure-deployment',
  'project-adoption',
  'native-installation',
  'skills'
] as const;

function exampleArguments(command: string): string[] {
  const substituted = command
    .replace(/<(?:fingerprint|full-64-character-lowercase-hex|64-character-fingerprint)>/g, 'a'.repeat(64))
    .replace(/<owner>/g, 'direct')
    .replace(/<[^>]+>/g, 'fixture-project');
  if (/["'`|;&<>\\]/.test(substituted)) {
    throw new Error(`Example needs an explicit native-shell parsing case: ${command}`);
  }
  return substituted.split(/\s+/).slice(1);
}

describe('literal lifecycle guide command admission', () => {
  it.each(guides)('parses every unquoted Liftoff bash example in docs/%s.md without executing it', async (guide) => {
    const markdown = await readFile(new URL(`../docs/${guide}.md`, import.meta.url), 'utf8');
    const commands = [...markdown.matchAll(/```(?:bash|sh)\r?\n([\s\S]*?)```/g)]
      .flatMap((match) => match[1].replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/))
      .map((line) => line.trim())
      .filter((line) => line.startsWith('liftoff '));
    expect(commands.length).toBeGreaterThan(0);
    const profiles = loadPackagedProfilesCatalog().profiles;
    for (const command of commands) {
      const parsed = parseArgs(exampleArguments(command));
      expect(parsed.command, command).toBeDefined();
      if (parsed.command === 'assess' || parsed.command === 'adopt') {
        const profile = parsed.flags.profile;
        if (profile !== undefined) {
          expect(typeof profile, command).toBe('string');
          expect(Object.hasOwn(profiles, String(profile)), command).toBe(true);
        }
      }
    }
  });
});
