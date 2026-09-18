import { compareSemver, isStableSemver } from '../../semver.js';

export function applicationPrivateVersionMatches(version: string, constraint: unknown): boolean {
  if (!isStableSemver(version) || typeof constraint !== 'string' || constraint.length > 256) return false;
  const clauses = constraint.split(',').map((part) => part.trim());
  if (clauses.length === 0 || clauses.length > 8) return false;
  return clauses.every((clause) => {
    const match = /^(~>|>=|<=|!=|>|<|=)?\s*(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/u.exec(clause);
    if (!match || match[4] === undefined && match[1] !== '~>') return false;
    const minimum = `${match[2]}.${match[3]}.${match[4] ?? '0'}`;
    const compared = compareSemver(version, minimum);
    switch (match[1] ?? '=') {
      case '=': return compared === 0;
      case '!=': return compared !== 0;
      case '>': return compared > 0;
      case '>=': return compared >= 0;
      case '<': return compared < 0;
      case '<=': return compared <= 0;
      case '~>': {
        const maximum = match[4] === undefined ? `${Number(match[2]) + 1}.0.0` : `${match[2]}.${Number(match[3]) + 1}.0`;
        return compared >= 0 && compareSemver(version, maximum) < 0;
      }
      default: return false;
    }
  });
}
