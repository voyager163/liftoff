import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultMacMigrationDependencies, runMacMigration, type MacMigrationRequest } from '../application/upgrade/mac-migration.js';
import type { MacNpmManager } from '../domain/distribution/mac-migration.js';
import { macMigrationBridge } from '../domain/distribution/mac-migration-bridge.js';

export const macMigrationHelp = `Liftoff standalone Apple Silicon npm migration (SOURCE ONLY)

Default: preview. No old Liftoff upgrade command is invoked.
Public apply remains blocked: native signing, minimum-host and cask providers are unqualified.

liftoff-migrate-npm [--npm <absolute-npm-cli-or-link> --node <absolute-node>
  --prefix <absolute-old-prefix> --manager <homebrew-node|nvm|volta|custom>
  [--manager-root <absolute-root>] [--manager-executable <absolute-executable>]]
  [--brew <approved-existing-brew>] [--recovery <verified-offline-old-package>]
  [--apply <exact-preview-sha256> --journal <new-private-directory>]
liftoff-migrate-npm --recover <exact-journal-sha256> --journal <private-directory>
  [--dead-lock <exact-lock-owner-sha256>]
liftoff-migrate-npm --inspect <exact-journal-sha256> --journal <private-directory>

Output is one JSON report. Preview does not modify installations, projects, user
configuration or shared caches. Private temporary observations are removed.
Unproven/multiple owners require exact selection; no nvm/Volta directory sweep.
No Homebrew bootstrap, sudo, forced overwrite, global cleanup or registry change.
Recovery never overwrites newer cask/user installs. Partial journals are retained.
Inspection rechecks selected settled state without removal, installation, recovery
or journal/lock writes. A prior success is not proof of the current installation.
PATH selection and parent-shell aliases/hash are separate: open a fresh shell and
inspect 'type -a liftoff'; the utility cannot repair its parent's command cache.

${macMigrationBridge.notice}
`;

export function parseMacMigration(args: string[]): MacMigrationRequest {
  const values = new Map<string, string>();
  const accepted = ['--npm', '--node', '--prefix', '--manager', '--manager-root', '--manager-executable',
    '--brew', '--recovery', '--apply', '--journal', '--recover', '--dead-lock', '--inspect'];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!accepted.includes(flag) || values.has(flag) || !value || value.startsWith('--') || /[\u0000-\u001f]/.test(value)) {
      throw new Error('Invalid or repeated standalone migration option. Use --help.');
    }
    values.set(flag, value);
  }
  const paths = accepted.filter(flag => !['--manager', '--apply', '--recover', '--dead-lock', '--inspect'].includes(flag));
  for (const flag of paths) {
    const value = values.get(flag);
    if (value && (!path.isAbsolute(value) || path.resolve(value) !== value)) throw new Error(`${flag} requires a canonical absolute path.`);
  }
  for (const flag of ['--apply', '--recover', '--dead-lock', '--inspect']) {
    if (values.has(flag) && !/^[a-f0-9]{64}$/.test(values.get(flag)!)) throw new Error(`${flag} requires an exact lowercase SHA-256.`);
  }
  const fields = ['--npm', '--node', '--prefix', '--manager'];
  const selected = fields.some(flag => values.has(flag));
  if (selected && !fields.every(flag => values.has(flag))) throw new Error('Old owner selection requires npm, node, prefix and manager.');
  const manager = values.get('--manager');
  if (manager && !['homebrew-node', 'nvm', 'volta', 'custom'].includes(manager)) throw new Error('Unsupported old npm manager.');
  if (values.has('--inspect')) {
    if (!values.has('--journal') || [...values.keys()].some(flag => !['--inspect', '--journal'].includes(flag))) {
      throw new Error('Inspection requires only its exact journal selectors.');
    }
    return { inspect: { journalRoot: values.get('--journal')!, journalSha256: values.get('--inspect')! } };
  }
  if (values.has('--recover')) {
    if (!values.has('--journal') || [...values.keys()].some(flag => !['--recover', '--journal', '--dead-lock'].includes(flag))) {
      throw new Error('Recovery requires only its exact journal and optional dead-lock selectors.');
    }
    return { recover: { journalRoot: values.get('--journal')!, journalSha256: values.get('--recover')!,
      ...(values.has('--dead-lock') ? { deadLockSha256: values.get('--dead-lock')! } : {}) } };
  }
  if (values.has('--dead-lock') || values.has('--journal') !== values.has('--apply') ||
    !selected && (values.has('--manager-root') || values.has('--manager-executable'))) throw new Error('Contradictory migration options.');
  return {
    ...(selected ? { selection: { npm: values.get('--npm')!, node: values.get('--node')!, prefix: values.get('--prefix')!,
      manager: manager as MacNpmManager, ...(values.has('--manager-root') ? { managerRoot: values.get('--manager-root')! } : {}),
      ...(values.has('--manager-executable') ? { managerExecutable: values.get('--manager-executable')! } : {}) } } : {}),
    ...(values.has('--brew') ? { brew: values.get('--brew')! } : {}),
    ...(values.has('--recovery') ? { recovery: values.get('--recovery')! } : {}),
    ...(values.has('--apply') ? { apply: { review: values.get('--apply')!, journalRoot: values.get('--journal')! } } : {})
  };
}

export async function macMigrationMain(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(macMigrationHelp); return 0; }
  let request: MacMigrationRequest;
  try {
    request = parseMacMigration(args);
  } catch {
    process.stderr.write('Invalid standalone migration request; use --help. No migration was performed.\n');
    return 1;
  }
  const result = await runMacMigration(request, defaultMacMigrationDependencies());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.blockers.length || ['blocked', 'partial'].includes(result.status) ? 1 :
    result.status === 'installed' && result.verification?.path === 'unresolved' ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await macMigrationMain();
}
