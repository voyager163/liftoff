import path from 'node:path';
import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  heartbeatInventoryPath, heartbeatReportingEntry, heartbeatWorkflowPath, heartbeatWorkflowText,
  parseHeartbeatInventory, qualifiedHeartbeatTooling
} from '../../domain/project/telemetry-heartbeat.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { projectTelemetryRecordPath } from '../../domain/project/telemetry-consent.js';
import { isProjectTelemetryEvent, type ProjectTelemetryEvent } from '../../telemetry/contract.js';
import { NodeCommandRunner } from '../../process-runner.js';
import { parseTelemetryFile, readTelemetryFile, telemetryJson, telemetryRoot, telemetrySnapshotIdentity } from './telemetry-consent.js';
import { errorCode } from './errors.js';

export async function readHeartbeatRepository(root: string, env: NodeJS.ProcessEnv, requireIdentity = true, signal?: AbortSignal) {
  if (signal?.aborted) throw new FileSystemError('Heartbeat preparation was cancelled before repository reads.');
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'].some(key => env[key] !== undefined)) {
    throw new FileSystemError('Heartbeat repository scope cannot use redirected Git metadata.');
  }
  const repository = await telemetryRoot(root);
  if (path.resolve(root) !== repository.root) throw new FileSystemError('Heartbeat requires the canonical exact repository root, not an alias.');
  const runner = new NodeCommandRunner();
  const git = async (args: string[]) => {
    const result = await runner.run({ executable: 'git', args: ['-c', 'core.fsmonitor=false', ...args] },
      { cwd: repository.root, env, timeoutMs: 5_000, maxOutputBytes: 8192, signal });
    if (result.status !== 0 || result.timedOut || result.outputLimitExceeded || result.aborted) {
      throw new FileSystemError('Heartbeat repository boundary or identity could not be independently verified.');
    }
    return result.stdout.trim();
  };
  if ((await telemetryRoot(await git(['rev-parse', '--show-toplevel']))).root !== repository.root) {
    throw new FileSystemError('Heartbeat repository boundary could not be independently verified.');
  }
  const gitDirectory = await telemetryRoot(path.resolve(repository.root, await git(['rev-parse', '--git-common-dir'])));
  let identity: string | undefined;
  if (requireIdentity) {
    const origin = await git(['config', '--local', '--get-all', 'remote.origin.url']);
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/u.exec(origin);
    if (!match) throw new FileSystemError('Heartbeat requires one independently verified canonical GitHub origin without credentials.');
    identity = match[1];
  }
  if (signal?.aborted) throw new FileSystemError('Heartbeat preparation was cancelled before inventory reads.');
  const inventoryFile = await readTelemetryFile(repository.root, heartbeatInventoryPath, 64 * 1024);
  if (signal?.aborted) throw new FileSystemError('Heartbeat preparation was cancelled before workflow reads.');
  const workflowFile = await readTelemetryFile(repository.root, heartbeatWorkflowPath, 256 * 1024);
  if (workflowFile.content !== undefined) heartbeatWorkflowText(workflowFile.content);
  const inventory = inventoryFile.content === undefined ? undefined :
    parseHeartbeatInventory(telemetryJson(inventoryFile.content, 'Heartbeat inventory'));
  return { ...repository, gitRoot: gitDirectory.root, gitPhysical: gitDirectory.physical, identity,
    inventoryFile, workflowFile, inventory };
}

export async function assertHeartbeatTargetsWritable(repository: Awaited<ReturnType<typeof readHeartbeatRepository>>): Promise<void> {
  for (const file of [repository.inventoryFile, repository.workflowFile]) {
    if (file.mode !== undefined && (file.mode & 0o222) === 0) {
      throw new FileSystemError('Heartbeat target is read-only; no repository writes are permitted.');
    }
    for (let depth = 0; depth < file.pathParts.length; depth++) {
      const directory = path.join(repository.root, ...file.pathParts.slice(0, depth));
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o222) === 0) {
          throw new FileSystemError('Heartbeat target directory is unsafe or read-only.');
        }
        await access(directory, constants.W_OK);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') break;
        throw error;
      }
    }
    if (file.content !== undefined) await access(path.join(repository.root, ...file.pathParts), constants.W_OK);
  }
}

const proofBrand: unique symbol = Symbol('release-owned-heartbeat-report');
export interface HeartbeatReportProof { readonly [proofBrand]: true }
const proofs = new WeakMap<HeartbeatReportProof, {
  event: string; env: NodeJS.ProcessEnv; verify(): Promise<boolean>;
}>();

// Only this independently reading adapter can mint a proof, and only from release-owned qualification.
export async function readQualifiedHeartbeatReportProof(input: {
  projectRoot: string; repositoryRoot: string; env: NodeJS.ProcessEnv;
  manifest: ReturnType<typeof telemetrySnapshotIdentity>; event: ProjectTelemetryEvent; signal?: AbortSignal;
}): Promise<HeartbeatReportProof | undefined> {
  const tooling = qualifiedHeartbeatTooling;
  if (!tooling || input.signal?.aborted || input.env.DO_NOT_TRACK === '1' || input.env.LIFTOFF_TELEMETRY === '0' ||
      input.env.CI !== 'true' || input.env.GITHUB_ACTIONS !== 'true' ||
      input.event.source !== 'ci-heartbeat' || input.event.cliVersion !== tooling.cliVersion || !isProjectTelemetryEvent(input.event)) {
    return undefined;
  }
  async function observe() {
    const repository = await readHeartbeatRepository(input.repositoryRoot, input.env, true, input.signal);
    const project = await telemetryRoot(input.projectRoot);
    if (path.resolve(input.projectRoot) !== project.root) throw new FileSystemError('Heartbeat selected root is an alias.');
    const relative = path.relative(repository.root, project.root);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new FileSystemError('Heartbeat selected root is outside the independently verified repository.');
    }
    const selectedRoot = relative ? relative.split(path.sep) : [];
    const recordFile = await readTelemetryFile(project.root, projectTelemetryRecordPath, 4096);
    const record = parseTelemetryFile(recordFile);
    const manifest = await readTelemetryFile(project.root, ['liftoff.manifest.json']);
    if (!record?.enabled || record.projectId !== input.event.projectId ||
        JSON.stringify(telemetrySnapshotIdentity(manifest)) !== JSON.stringify(input.manifest) ||
        !repository.inventory || !repository.workflowFile.content) {
      throw new FileSystemError('Heartbeat current project enrollment, manifest or enabled inventory is unavailable.');
    }
    const entry = heartbeatReportingEntry({
      inventory: repository.inventory, workflow: repository.workflowFile.content,
      repository: repository.identity!, selectedRoot, projectId: record.projectId, enabled: record.enabled, tooling: tooling!
    });
    const expectedJob = `project_${entry.projectId.replaceAll('-', '_')}`;
    if (input.env.GITHUB_REPOSITORY !== repository.identity || input.env.GITHUB_JOB !== expectedJob ||
        !['schedule', 'workflow_dispatch'].includes(input.env.GITHUB_EVENT_NAME ?? '') ||
        !/^refs\/heads\/[^\r\n]+$/u.test(input.env.GITHUB_REF ?? '') ||
        input.env.GITHUB_WORKFLOW_REF !== `${repository.identity}/${heartbeatWorkflowPath.join('/')}@${input.env.GITHUB_REF}` ||
        !input.env.GITHUB_WORKSPACE || (await telemetryRoot(input.env.GITHUB_WORKSPACE)).root !== repository.root) {
      throw new FileSystemError('Heartbeat owned workflow/job and repository execution bindings do not match.');
    }
    return {
      root: repository.root, physical: repository.physical, gitRoot: repository.gitRoot, gitPhysical: repository.gitPhysical,
      identity: repository.identity, projectRoot: project.root, projectPhysical: project.physical,
      manifest: telemetrySnapshotIdentity(manifest), record: telemetrySnapshotIdentity(recordFile),
      inventory: telemetrySnapshotIdentity(repository.inventoryFile), workflow: telemetrySnapshotIdentity(repository.workflowFile),
      selectedRoot, job: input.env.GITHUB_JOB, ref: input.env.GITHUB_REF, workflowRef: input.env.GITHUB_WORKFLOW_REF
    };
  }
  const observed = JSON.stringify(await observe());
  if (input.env.DO_NOT_TRACK === '1' || input.env.LIFTOFF_TELEMETRY === '0') return undefined;
  const proof: HeartbeatReportProof = Object.freeze({ [proofBrand]: true as const });
  proofs.set(proof, { event: JSON.stringify(input.event), env: input.env,
    verify: async () => {
      if (input.signal?.aborted || input.env.DO_NOT_TRACK === '1' || input.env.LIFTOFF_TELEMETRY === '0' ||
          input.env.CI !== 'true' || input.env.GITHUB_ACTIONS !== 'true' || qualifiedHeartbeatTooling !== tooling) return false;
      const current = JSON.stringify(await observe());
      return input.env.DO_NOT_TRACK !== '1' && input.env.LIFTOFF_TELEMETRY !== '0' && current === observed;
    }
  });
  return proof;
}

export async function heartbeatReportProofAllows(
  value: HeartbeatReportProof | undefined, event: unknown, env: NodeJS.ProcessEnv
): Promise<boolean> {
  if (!value || !qualifiedHeartbeatTooling || env.DO_NOT_TRACK === '1' || env.LIFTOFF_TELEMETRY === '0') return false;
  const proof = proofs.get(value);
  return proof !== undefined && proof.env === env && isProjectTelemetryEvent(event) &&
    proof.event === JSON.stringify(event) && await proof.verify();
}
