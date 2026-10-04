import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { assertBoundProjectPath } from '../../adapters/filesystem/bound-project-files.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { PlanValidationError } from '../../domain/project/planning.js';
import type { ExternalCommand, ManifestLayoutBinding } from '../../domain/project/contracts.js';
import type { LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { manifestPathAliasKey } from '../../domain/project/manifest/layout.js';
import { modernLocalBounds } from '../../domain/governance/activation/modern-local-inputs.js';
import { modernManifestMatchesObservation } from './manifest.js';
import { getEnvironment } from './catalog.js';

export type ModernHelperRequest =
  | { command: 'dev'; action?: string; profile?: string }
  | { command: 'infra'; action?: string; environment?: string };

function invalid(message: string): never {
  throw new PlanValidationError([message]);
}
const overlaps = (left: string, right: string) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

/** Observes declared paths for printed guidance only; never executes the returned command. */
export async function buildModernHelperCommand(
  projectRoot: string, manifest: LiftoffManifestV8, request: ModernHelperRequest
): Promise<ExternalCommand> {
  const action = request.action ?? (request.command === 'dev' ? 'up' : 'plan');
  const allowed = request.command === 'dev' ? ['up', 'down', 'logs', 'reset'] : ['init', 'plan', 'apply', 'output'];
  if (!allowed.includes(action)) invalid(`Unsupported ${request.command} action: ${action}.`);
  const environment = request.command === 'infra'
    ? request.environment ?? manifest.project.workload.environments[0] : undefined;
  if (request.command === 'infra' &&
    (!environment || !getEnvironment(environment) || !manifest.project.workload.environments.some(value => value === environment))) {
    invalid(`Environment ${environment} is not selected for this project. Selected environments: ${manifest.project.workload.environments.join(', ')}.`);
  }
  if (manifest.activeLayout.state !== 'bound') {
    invalid('Active layout is unresolved; no helper command was emitted. Record a reviewed active binding first; generation provenance is not a fallback.');
  }
  const { inspectModernInstalledActivation } = await import('../governance/modern-installed-preflight.js');
  const installed = await inspectModernInstalledActivation(projectRoot);
  if (installed.status === 'blocked') invalid(`Project control inspection failed: ${installed.blockers.join('; ')}`);
  if (!modernManifestMatchesObservation(manifest, installed.snapshot)) {
    invalid('The manifest changed during helper inspection; inspect the current project again.');
  }
  const root = installed.snapshot.root;
  const retained = installed.retention.flatMap(obligation => obligation.protectedPaths).map(manifestPathAliasKey);
  async function binding(kind: ManifestLayoutBinding['kind'], id: string): Promise<string> {
    const entry = manifest.activeLayout.bindings.find(value =>
      value.kind === kind && (value.kind === 'component' ? value.component : value.logicalName) === id);
    if (!entry) invalid(`Missing active ${kind} binding ${id}; no helper command was emitted. Record a reviewed binding instead of inferring a generated path.`);
    if (retained.some(protectedPath => overlaps(manifestPathAliasKey(entry.pathParts), protectedPath))) {
      invalid(`Active binding ${id} overlaps preserved state/key retention; no payload was inspected or helper command emitted.`);
    }
    await assertBoundProjectPath(root, entry.pathParts, { pathLabel: `Active binding ${id}`, invalid });
    const target = path.join(root, ...entry.pathParts);
    let details;
    try { details = await lstat(target); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') invalid(`Missing active binding ${id} at ${entry.pathParts.join('/')}.`);
      throw error;
    }
    if (details.isSymbolicLink() || (kind === 'component' ? !details.isDirectory() : !details.isFile() || details.nlink !== 1)) {
      invalid(`Active binding ${id} must be a real ${kind === 'component' ? 'directory' : 'single-link regular file'}.`);
    }
    for (let depth = 1; depth <= entry.pathParts.length - (kind === 'artifact' ? 1 : 0); depth += 1) {
      let count = 0;
      for await (const child of await opendir(path.join(root, ...entry.pathParts.slice(0, depth)))) {
        if (++count > modernLocalBounds.directoryEntries) {
          invalid(`Active binding ${id} exceeds the ${modernLocalBounds.directoryEntries}-entry directory observation limit.`);
        }
        if (['.git', '.liftoff', 'liftoff.manifest.json'].includes(child.name.normalize('NFKC').toLowerCase())) {
          invalid(`Active binding ${id} crosses a nested project or repository boundary; no helper command was emitted.`);
        }
      }
    }
    return target;
  }
  if (request.command === 'dev') {
    const compose = await binding('artifact', 'docker-compose');
    const args = ['compose', '--project-directory', path.dirname(compose), '--file', compose];
    if (action === 'up') args.push(...(request.profile ? ['--profile', request.profile] : []), 'up', '--build');
    else if (action === 'logs') args.push('logs', '-f');
    else args.push('down', ...(action === 'reset' ? ['--volumes'] : []));
    return { executable: 'docker', args };
  }
  const directory = await binding('component', `opentofu-environment:${environment}`);
  const args = [`-chdir=${directory}`, action];
  if (action === 'plan' || action === 'apply') {
    args.push(`-var-file=${await binding('artifact', `opentofu-${environment}-tfvars`)}`);
  }
  return { executable: 'tofu', args };
}
