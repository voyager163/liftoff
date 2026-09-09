import { lstat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../adapters/filesystem/project-paths.js';
import { NodeCommandRunner, type CommandRunner } from '../process-runner.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';
import {
  activationBaselineDigest,
  normalizedSeedInput,
  normalizedPublicEnvironment,
  isProjectMutationReservationName,
  phaseInputDigest,
  remoteBindingDigest,
  type ActivationInputFile,
  type ActivationInputSnapshot
} from '../domain/governance/activation/inputs.js';
import { canonicalSha256 } from '../domain/governance/activation/canonical-json.js';
import { evidenceContextForPhase, type EvidenceFreshnessContext } from '../domain/governance/activation/evidence.js';
import { phaseContractDigests } from '../domain/governance/activation/graph.js';
import type { ManagedPhaseGraph, PhaseId, UserActivationState } from '../domain/governance/activation/types.js';
import { toSafeProjectName } from '../domain/project/planning.js';

export * from '../domain/governance/activation/inputs.js';

const sourceRoots = ['backend', 'frontend', 'functions', 'src', 'database', 'infrastructure', '.github/workflows', '.github/actions', '.github/rulesets', 'governance/rulesets', '.specify'] as const;
const publicFiles = ['.gitignore', '.dockerignore', '.env.example', 'runtime.config.example.json', 'Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml', 'package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock', 'go.mod', 'go.sum', '.liftoff/governance/policy.md', '.liftoff/governance/context.json', '.liftoff/governance/phase-graph.json'] as const;
const excludedDirectories = new Set(['node_modules', '.venv', 'venv', '.terraform', '.git', 'dist', 'build', 'out', '.next', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache']);
const excludedFile = /(?:^\.env(?:\.|$)(?!example$|sample$)|\.tfstate(?:\.|$)|\.tfplan$|\.pem$|\.key$|\.pfx$|\.p12$|\.pyc$|\.log$|^\.liftoff.*(?:tmp|bak)$|^\.npmrc$|^terraform\.rc$|^credentials(?:\.|$)|^local\.settings\.json$)/i;

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export async function readActivationInputSnapshot(
  projectRoot: string,
  manifest: LiftoffManifest,
  runner: CommandRunner = new NodeCommandRunner()
): Promise<ActivationInputSnapshot> {
  const files = new Map<string, string>();
  async function include(parts: readonly string[], logicalPath = parts.join('/'), seed = false): Promise<void> {
    const bytes = await readProjectFile(projectRoot, [...parts]);
    if (bytes === undefined) return;
    const text = bytes.toString('utf8');
    const digest = canonicalSha256(seed ? normalizedSeedInput(text) : text.replace(/\r\n/g, '\n'));
    const prior = files.get(logicalPath);
    if (prior !== undefined && prior !== digest) throw new Error(`Conflicting activation input copies for ${logicalPath}.`);
    files.set(logicalPath, digest);
  }
  async function walk(parts: readonly string[], logicalRoot = parts.join('/'), seed = false): Promise<void> {
    const root = await resolveProjectPath(projectRoot, [...parts]);
    let entries: Dirent[];
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (code(error) === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (isProjectMutationReservationName(entry.name) || excludedDirectories.has(entry.name) || excludedFile.test(entry.name)) continue;
      const child = [...parts, entry.name];
      const logical = `${logicalRoot}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, logical, seed);
      else if (entry.isFile()) await include(child, logical, seed);
      else throw new Error(`Activation input ${child.join('/')} must not be a symlink or special file.`);
    }
  }
  for (const root of sourceRoots) await walk(root.split('/'));
  for (const file of publicFiles) await include(file.split('/'));
  const localEnvironment = await readProjectFile(projectRoot, ['.env']);
  if (localEnvironment) {
    const values = normalizedPublicEnvironment(localEnvironment.toString('utf8'));
    if (Object.keys(values).length > 0) files.set('public-local-environment', canonicalSha256(values));
  }
  const seedName = `bootstrap-${toSafeProjectName(manifest.project.name)}`;
  let workflowSpecDigest: string | undefined;
  if (manifest.project.specWorkflow === 'spec-kit') {
    await walk(['specs', '000-liftoff-bootstrap'], 'seed', true);
  } else {
    await walk(['openspec', 'changes', seedName], 'seed', true);
    const archive = await resolveProjectPath(projectRoot, ['openspec', 'changes', 'archive']);
    let entries: Dirent[];
    try { entries = await readdir(archive, { withFileTypes: true }); }
    catch (error) { if (code(error) !== 'ENOENT') throw error; entries = []; }
    for (const entry of entries) {
      if (entry.name === seedName || entry.name.endsWith(`-${seedName}`)) {
        await walk(['openspec', 'changes', 'archive', entry.name], 'seed', true);
      }
    }
    await include(['openspec', 'config.yaml']);
    const workload = manifest.project.workload;
    const capability = `${workload.kind === 'standard' ? workload.apiStack : workload.pattern}-application-baseline`;
    const mainSpec = await readProjectFile(projectRoot, ['openspec', 'specs', capability, 'spec.md']);
    if (mainSpec !== undefined) workflowSpecDigest = canonicalSha256(mainSpec.toString('utf8').replace(/\r\n/g, '\n'));
  }
  async function git(args: string[], allowedMissing = false): Promise<string | null> {
    const result = await runner.run({ executable: 'git', args }, { cwd: projectRoot });
    if (result.status === 0 && !result.errorCode && !result.timedOut) return result.stdout.trim() || null;
    if (allowedMissing && (result.status === 1 || result.status === 128)) return null;
    throw new Error(`Unable to inspect allowed Git metadata: git ${args.join(' ')}.`);
  }
  let hasGit = false;
  try {
    const marker = await lstat(path.join(projectRoot, '.git'));
    if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory())) throw new Error('Activation Git marker must be a regular file or directory, not a symlink.');
    hasGit = true;
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
  const foundRoot = hasGit ? await git(['rev-parse', '--show-toplevel']) : null;
  const root = foundRoot && path.resolve(foundRoot) === path.resolve(projectRoot) ? foundRoot : null;
  const head = root ? await git(['rev-parse', '--verify', 'HEAD'], true) : null;
  const branch = root ? await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true) : null;
  const remotes = root ? (await git(['remote']))?.split(/\r?\n/).filter(Boolean) ?? [] : [];
  const pushUrls = remotes.includes('origin') ? (await git(['remote', 'get-url', '--push', '--all', 'origin']))?.split(/\r?\n/).filter(Boolean).sort() ?? [] : [];
  if (pushUrls.some((url) => /https?:\/\/[^/]*@/i.test(url))) throw new Error('Credential-bearing Git remote URLs cannot be activation inputs.');
  const project = { project: manifest.project, framework: manifest.framework, governance: manifest.governance.profile };
  const inventory: ActivationInputFile[] = [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, digest]) => ({ path, digest }));
  return { schemaVersion: 2, project, files: inventory, git: { head, branch, pushUrls }, baselineSha: activationBaselineDigest(project, inventory),
    ...(workflowSpecDigest ? { workflowSpecDigest } : {}) };
}

export function activationEvidenceContexts(
  graph: ManagedPhaseGraph,
  state: UserActivationState,
  snapshot: ActivationInputSnapshot,
  now = new Date()
): Record<PhaseId, EvidenceFreshnessContext> {
  const digests = phaseContractDigests(graph);
  return Object.fromEntries(graph.phases.map((phase) => [phase.id, {
    ...evidenceContextForPhase(phase.id, {
      repositoryId: state.repository.id,
      identity: state.identity,
      phaseGraphHash: state.identity.phaseGraphHash,
      baselineSha: snapshot.baselineSha,
      inputDigest: phaseInputDigest(phase.id, snapshot),
      liveReadbackProviders: phase.evidence.liveReadbackProviders,
      remoteBindingDigest: remoteBindingDigest(state.remoteBinding),
      now
    }),
    evidenceReferences: state.phases[phase.id].evidence,
    ...(phase.id === 'seed-archived' && snapshot.workflowSpecDigest ? { workflowSpecDigest: snapshot.workflowSpecDigest } : {}),
    ...(phase.id === 'pushed' && snapshot.git.pushUrls.length === 1 ? { publicationDestination: snapshot.git.pushUrls[0] } : {}),
    phaseContractDigest: digests[phase.id]
  }])) as Record<PhaseId, EvidenceFreshnessContext>;
}
