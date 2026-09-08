import type { ParsedArgs } from '../../domain/project/contracts.js';

export function readStringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function readBooleanFlag(flags: ParsedArgs['flags'], name: string): boolean | undefined {
  const value = flags[name];
  return typeof value === 'boolean' ? value : undefined;
}

export function readListFlag(flags: ParsedArgs['flags'], name: string): string[] | undefined {
  const value = flags[name];
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value;
  }
  return undefined;
}
