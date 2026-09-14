import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  createRepairWorkspaceRegistryStore, createScopedUserLocalRecordStore,
  type RepairWorkspaceRegistryValue
} from '../../adapters/filesystem/update-previews.js';
import {
  assertRegisteredWorkspace, assertWorkspaceDisjoint, canonicalWorkspaceBoundary,
  createRegisteredWorkspaceDirectory, deleteRegisteredWorkspace, ensureRepairWorkspaceParents,
  hasRepairWorkspaceCleanupLease, repairWorkspaceDirectory, repairWorkspaceLocation, withRepairWorkspaceCleanupLease,
  type RepairWorkspaceLocation
} from '../../adapters/filesystem/repair-workspaces.js';
import {
  maximumRepairWorkspaces, openWorkspaceSeal, repairWorkspaceAuthorityKey, repairWorkspaceIndexKey,
  validateWorkspaceActivity, validateWorkspaceAuthority, validateWorkspaceIndex, validateWorkspaceRecord,
  validateWorkspaceRequest, workspaceRecordKey, workspaceSeal, type RepairWorkspaceIndex
} from './workspaces-records.js';
import {
  RepairWorkspaceError, repairWorkspaceRoleNames,
  type CreateRepairVerificationWorkspaceOptions, type RepairVerificationWorkspace,
  type RepairWorkspaceCheckpoint, type RepairWorkspaceCleanupResult, type RepairWorkspaceInspection,
  type RepairWorkspaceIssue, type RepairWorkspaceRecord, type RepairWorkspaceRecoveryResult,
  type RepairWorkspaceStorageOptions, type RepairWorkspaceSummary
} from './workspaces-types.js';

export * from './workspaces-types.js';
export { getRepairWorkspaceRoot } from '../../adapters/filesystem/repair-workspaces.js';

const liveOwners = new Set<string>();
type Saved<T> = { value: T; digest: string };

interface Context {
  location: RepairWorkspaceLocation;
  options: RepairWorkspaceStorageOptions;
  registry: ReturnType<typeof createRepairWorkspaceRegistryStore>;
  authority: ReturnType<typeof createScopedUserLocalRecordStore>;
  key: string;
}

function issue(error: unknown): RepairWorkspaceIssue {
  if (error instanceof RepairWorkspaceError) return { code: error.code, message: error.message };
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'EACCES' || code === 'EPERM') {
    return { code: 'permission-denied', message: 'Private workspace access was denied; metadata and uncertain paths remain retained.' };
  }
  if (code === 'preview-busy') {
    return { code: 'registry-busy', message: 'Private workspace metadata is busy; retry only after its owner releases it.' };
  }
  return { code: 'registry-unavailable', message: 'Private workspace storage could not complete the operation; no broader cleanup authority was inferred.' };
}

function workspaceError(error: unknown): RepairWorkspaceError {
  const failure = issue(error);
  return new RepairWorkspaceError(failure.code, failure.message, { cause: error });
}

function now(context: Context): string {
  const value = (context.options.clock ?? (() => new Date()))();
  if (!Number.isFinite(value.getTime())) throw new RepairWorkspaceError('invalid-request', 'Private workspace clock is invalid.');
  return value.toISOString();
}

async function openContext(
  projectRoot: string, storage: RepairWorkspaceStorageOptions, create: boolean
): Promise<Context | null> {
  const env = storage.env ?? process.env;
  const options: RepairWorkspaceStorageOptions = {
    ...storage, homedir: storage.homedir ?? os.homedir(), platform: storage.platform ?? process.platform,
    env: { XDG_STATE_HOME: env.XDG_STATE_HOME, LOCALAPPDATA: env.LOCALAPPDATA }
  };
  const location = await repairWorkspaceLocation(projectRoot, options);
  const registry = createRepairWorkspaceRegistryStore(location.projectRoot, options);
  const authority = createScopedUserLocalRecordStore(location.projectRoot, 'repair-workspace-authority', options);
  const index = await registry.read(repairWorkspaceIndexKey);
  let stored = await authority.read(repairWorkspaceAuthorityKey);
  if (!index && !stored && !create) return null;
  if (!index && stored) {
    throw new RepairWorkspaceError('registry-invalid', 'Private workspace authority exists without its index; existing scope must not be rediscovered by directory names.');
  }
  if (!stored) {
    if (!create || index) {
      throw new RepairWorkspaceError('unauthenticated-record', 'Private workspace authority is missing; indexed paths cannot be cleaned.');
    }
    stored = await authority.write(repairWorkspaceAuthorityKey, {
      schemaVersion: 1, kind: 'liftoff-repair-workspace-authority',
      projectRoot: location.projectRoot, key: randomBytes(32).toString('hex')
    });
  }
  const key = validateWorkspaceAuthority(stored.value, location.projectRoot);
  const context = { location, options, registry, authority, key };
  if (index) validateWorkspaceIndex(openWorkspaceSeal(index.value, key), location.projectRoot);
  else if (create) {
    await registry.compareExchange(repairWorkspaceIndexKey, null, workspaceSeal({
      schemaVersion: 1, kind: 'liftoff-repair-workspace-index', projectRoot: location.projectRoot,
      revision: 1, workspaces: []
    } satisfies RepairWorkspaceIndex, key));
  }
  return context;
}

async function assertAuthority(context: Context): Promise<void> {
  const current = await context.authority.read(repairWorkspaceAuthorityKey);
  if (!current || validateWorkspaceAuthority(current.value, context.location.projectRoot) !== context.key) {
    throw new RepairWorkspaceError('unauthenticated-record', 'Private workspace authority changed during the operation.');
  }
}

async function readIndex(context: Context): Promise<Saved<RepairWorkspaceIndex>> {
  await assertAuthority(context);
  const saved = await context.registry.read(repairWorkspaceIndexKey);
  if (!saved) throw new RepairWorkspaceError('registry-invalid', 'The authenticated private workspace index disappeared.');
  return {
    value: validateWorkspaceIndex(openWorkspaceSeal(saved.value, context.key), context.location.projectRoot),
    digest: saved.digest
  };
}

async function saveIndex(context: Context, prior: Saved<RepairWorkspaceIndex>, value: RepairWorkspaceIndex): Promise<void> {
  validateWorkspaceIndex(value, context.location.projectRoot);
  await assertAuthority(context);
  await context.registry.compareExchange(repairWorkspaceIndexKey, prior.digest, workspaceSeal(value, context.key));
}

function recordFrom(context: Context, workspaceId: string, saved: RepairWorkspaceRegistryValue): Saved<RepairWorkspaceRecord> {
  const value = validateWorkspaceRecord(openWorkspaceSeal(saved.value, context.key), {
    projectRoot: context.location.projectRoot,
    directory: (id) => repairWorkspaceDirectory(context.location, id)
  });
  if (value.workspaceId !== workspaceId) {
    throw new RepairWorkspaceError('scope-mismatch', 'Private workspace record was copied to another workspace identity.');
  }
  return { value, digest: saved.digest };
}

async function readRecord(context: Context, workspaceId: string): Promise<Saved<RepairWorkspaceRecord>> {
  await assertAuthority(context);
  const saved = await context.registry.read(workspaceRecordKey(workspaceId));
  if (!saved) throw new RepairWorkspaceError('registry-invalid', 'An indexed private workspace has no authenticated record.');
  return recordFrom(context, workspaceId, saved);
}

async function saveRecord(
  context: Context, previous: Saved<RepairWorkspaceRecord>, value: RepairWorkspaceRecord
): Promise<Saved<RepairWorkspaceRecord>> {
  const next = { ...value, revision: previous.value.revision + 1, updatedAt: now(context) };
  validateWorkspaceRecord(next, {
    projectRoot: context.location.projectRoot, directory: (id) => repairWorkspaceDirectory(context.location, id)
  });
  await assertAuthority(context);
  const saved = await context.registry.compareExchange(
    workspaceRecordKey(next.workspaceId), previous.digest, workspaceSeal(next, context.key)
  );
  return { value: next, digest: saved.digest };
}

function ownerState(record: RepairWorkspaceRecord): RepairWorkspaceSummary['owner'] {
  if (record.owner.state === 'released') return 'released';
  return record.owner.state === 'active' && liveOwners.has(record.owner.tokenDigest) ? 'active' : 'uncertain';
}

function ownerIssue(record: RepairWorkspaceRecord): RepairWorkspaceIssue | null {
  const state = ownerState(record);
  if (state === 'released') return null;
  return state === 'active'
    ? { code: 'owner-active', message: 'The authenticated workspace owner has not released its scope; cleanup is blocked.' }
    : { code: 'owner-uncertain', message: 'Workspace ownership or command settlement is uncertain. PID, parent exit and age cannot authorize cleanup.' };
}

async function summarize(context: Context, record: RepairWorkspaceRecord): Promise<RepairWorkspaceSummary> {
  const issues: RepairWorkspaceIssue[] = [];
  const ownership = ownerIssue(record);
  if (ownership) issues.push(ownership);
  try {
    if (await hasRepairWorkspaceCleanupLease(context.location, record.workspaceId)) {
      issues.push({ code: 'owner-uncertain', message: 'A private cleanup owner is active or uncertain; the existing lease cannot be removed by PID or age.' });
    }
    if (record.creationIdentity) {
      const exists = await assertRegisteredWorkspace(record, context.location,
        ['cleaning', 'cleanup-failed', 'cleaned'].includes(record.phase));
      if (record.phase === 'cleaned' && exists) {
        throw new RepairWorkspaceError('identity-changed', 'A path exists at an already-cleaned workspace identity; it is not newly owned.');
      }
    } else issues.push({ code: 'identity-changed', message: 'Workspace allocation did not establish its complete creation identity.' });
  } catch (error) { issues.push(issue(error)); }
  return {
    workspaceId: record.workspaceId, directory: record.directory, planFingerprint: record.planFingerprint,
    phase: record.phase, lastCheckpoint: record.lastCheckpoint,
    owner: ownerState(record), commandsStarted: record.activities.started,
    commandsSettled: record.activities.settled, uncertainCommands: record.activities.uncertain,
    cleanupComplete: record.cleanup.complete, issues
  };
}

async function retireIndexEntry(context: Context, workspaceId: string): Promise<void> {
  const index = await readIndex(context);
  if (!index.value.workspaces.includes(workspaceId)) return;
  await saveIndex(context, index, {
    ...index.value, revision: index.value.revision + 1,
    workspaces: index.value.workspaces.filter((id) => id !== workspaceId)
  });
}

async function cleanupOne(context: Context, workspaceId: string): Promise<RepairWorkspaceCleanupResult> {
  let removedEntries = 0;
  let began = false;
  try {
    let saved = await readRecord(context, workspaceId);
    const ownership = ownerIssue(saved.value);
    if (ownership) return { workspaceId, status: 'blocked', cleanupComplete: false, removedEntries, retained: true, issues: [ownership] };
    await withRepairWorkspaceCleanupLease(context.location, workspaceId, async (lease) => {
      saved = await readRecord(context, workspaceId);
      if (ownerIssue(saved.value)) throw new RepairWorkspaceError('owner-uncertain', 'Workspace release changed before cleanup.');
      const exists = await assertRegisteredWorkspace(saved.value, context.location,
        ['cleaning', 'cleanup-failed', 'cleaned'].includes(saved.value.phase));
      if (saved.value.phase === 'cleaned') {
        if (exists) throw new RepairWorkspaceError('identity-changed', 'Already-cleaned workspace path is occupied; it is not owned.');
        return;
      }
      const priorRemoved = saved.value.cleanup.removedEntries;
      saved = await saveRecord(context, saved, { ...saved.value, phase: 'cleaning' });
      began = true;
      const guard = async () => {
        await lease.assertHeld();
        const index = await readIndex(context);
        if (!index.value.workspaces.includes(workspaceId) ||
          (await readRecord(context, workspaceId)).digest !== saved.digest) {
          throw new RepairWorkspaceError('registry-invalid', 'Workspace authority changed before a cleanup effect.');
        }
      };
      try {
        await deleteRegisteredWorkspace(saved.value, context.location, {
          ...context.options,
          beforeWorkspaceOperation: async (operation, target) => {
            await context.options.beforeWorkspaceOperation?.(operation, target);
            await guard();
          }
        }, async (removed) => {
          removedEntries = removed;
          await lease.assertHeld();
          saved = await saveRecord(context, saved, {
            ...saved.value, cleanup: { removedEntries: priorRemoved + removed, complete: false }
          });
        });
        saved = await saveRecord(context, saved, {
          ...saved.value, phase: 'cleaned',
          cleanup: { removedEntries: priorRemoved + removedEntries, complete: true }
        });
      } catch (error) {
        try {
          saved = await saveRecord(context, saved, {
            ...saved.value, phase: 'cleanup-failed',
            cleanup: { removedEntries: priorRemoved + removedEntries, complete: false }
          });
        } catch {
          throw new RepairWorkspaceError('cleanup-failed', 'Cleanup and its progress checkpoint could not complete; authenticated prior metadata remains retained.', { cause: error });
        }
        throw error;
      }
    });
    await retireIndexEntry(context, workspaceId);
    return { workspaceId, status: 'cleaned', cleanupComplete: true, removedEntries, retained: false, issues: [] };
  } catch (error) {
    return {
      workspaceId, status: began ? 'incomplete' : 'blocked', cleanupComplete: false,
      removedEntries, retained: true, issues: [issue(error)]
    };
  }
}

export async function createRepairVerificationWorkspace(
  root: string, request: CreateRepairVerificationWorkspaceOptions, storage: RepairWorkspaceStorageOptions = {}
): Promise<RepairVerificationWorkspace> {
  try {
    const input = validateWorkspaceRequest(request);
    const project = await canonicalWorkspaceBoundary(root);
    const staging = await canonicalWorkspaceBoundary(input.patchStagingRoot);
    const intended = await repairWorkspaceLocation(project.directory, storage);
    assertWorkspaceDisjoint(project.directory, staging.directory, intended.registryDirectory);
    const context = await openContext(project.directory, storage, true);
    if (!context) throw new RepairWorkspaceError('registry-unavailable', 'Workspace registration could not be created.');
    assertWorkspaceDisjoint(project.directory, staging.directory, context.location.root);
    const index = await readIndex(context);
    if (index.value.workspaces.length >= maximumRepairWorkspaces) {
      throw new RepairWorkspaceError('limits-exceeded', 'Too many retained workspaces; resolve registered cleanup before creating another.');
    }
    const workspaceId = randomBytes(32).toString('hex');
    const tokenDigest = canonicalSha256(randomBytes(32).toString('hex'));
    const directory = repairWorkspaceDirectory(context.location, workspaceId);
    const timestamp = now(context);
    const value: RepairWorkspaceRecord = {
      schemaVersion: 1, kind: 'liftoff-repair-workspace', workspaceId, revision: 1,
      projectRoot: project.directory, projectIdentity: project.identity,
      patchStagingRoot: staging.directory, patchStagingIdentity: staging.identity,
      planFingerprint: input.planFingerprint, repairIdentity: input.repairIdentity,
      bindings: input.bindings, approvedScopes: input.approvedScopes, directory,
      creationIdentity: null,
      roles: Object.fromEntries(repairWorkspaceRoleNames.map((role) =>
        [role, { path: path.join(directory, role), identity: null }])) as RepairWorkspaceRecord['roles'],
      owner: { tokenDigest, processId: process.pid, state: 'active', release: null },
      phase: 'allocating', lastCheckpoint: 'allocating',
      activities: { started: 0, settled: 0, uncertain: 0, inFlight: [] },
      cleanup: { removedEntries: 0, complete: false }, createdAt: timestamp, updatedAt: timestamp
    };
    validateWorkspaceRecord(value, { projectRoot: project.directory, directory: (id) => repairWorkspaceDirectory(context.location, id) });
    const registration = await context.registry.compareExchange(workspaceRecordKey(workspaceId), null, workspaceSeal(value, context.key));
    await saveIndex(context, index, {
      ...index.value, revision: index.value.revision + 1, workspaces: [...index.value.workspaces, workspaceId]
    });
    let saved = { value, digest: registration.digest };
    liveOwners.add(tokenDigest);
    try {
      const parents = new Map(await ensureRepairWorkspaceParents(context.location));
      value.creationIdentity = await createRegisteredWorkspaceDirectory(directory, parents, context.options);
      parents.set(directory, value.creationIdentity);
      for (const role of repairWorkspaceRoleNames) {
        value.roles[role].identity = await createRegisteredWorkspaceDirectory(value.roles[role].path, parents, context.options);
      }
      saved = await saveRecord(context, saved, { ...value, phase: 'ready', lastCheckpoint: 'ready' });
    } catch (error) {
      liveOwners.delete(tokenDigest);
      try {
        await saveRecord(context, saved, {
          ...value, phase: 'failed', lastCheckpoint: 'failed',
          owner: { ...value.owner, state: 'released', release: { releasedAt: now(context), allKnownCommandsSettled: true } }
        });
      } catch {
        throw new RepairWorkspaceError('registry-unavailable', 'Workspace allocation failed and release could not be authenticated; retained scope is uncertain.', { cause: error });
      }
      throw error;
    }
    let serial: Promise<void> = Promise.resolve();
    let uncertain = false;
    let released = false;
    let inFlight = 0;
    const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = serial.then(operation);
      serial = result.then(() => undefined, () => undefined);
      return result;
    };
    const currentOwner = async () => {
      const current = await readRecord(context, workspaceId);
      if (current.digest !== saved.digest || current.value.owner.tokenDigest !== tokenDigest ||
        current.value.owner.state !== 'active' || released || uncertain) {
        throw new RepairWorkspaceError('owner-uncertain', 'The original in-memory workspace owner no longer holds this exact registered scope.');
      }
      await assertRegisteredWorkspace(current.value, context.location, false);
    };
    const checkpoint = (phase: RepairWorkspaceCheckpoint) => exclusive(async () => {
      if (!['copying', 'preparing', 'verifying', 'verified', 'failed'].includes(phase)) {
        throw new RepairWorkspaceError('invalid-request', 'Workspace checkpoint is unsupported.');
      }
      await currentOwner();
      saved = await saveRecord(context, saved, { ...saved.value, phase, lastCheckpoint: phase });
    });
    return Object.freeze({
      workspaceId, directory,
      roles: Object.freeze(Object.fromEntries(repairWorkspaceRoleNames.map((role) =>
        [role, value.roles[role].path])) as RepairVerificationWorkspace['roles']),
      checkpoint,
      runOwned: async <T>(
        requested: Parameters<RepairVerificationWorkspace['runOwned']>[0],
        operation: () => Promise<{ value: T; allKnownCommandsSettled: boolean }>
      ): Promise<T> => {
        const activityId = randomBytes(32).toString('hex');
        await exclusive(async () => {
          await currentOwner();
          const activity = validateWorkspaceActivity(requested, saved.value);
          saved = await saveRecord(context, saved, {
            ...saved.value, phase: activity.kind === 'preparation' ? 'preparing' : 'verifying',
            lastCheckpoint: activity.kind === 'preparation' ? 'preparing' : 'verifying',
            activities: {
              ...saved.value.activities, started: saved.value.activities.started + 1,
              inFlight: [...saved.value.activities.inFlight, { ...activity, id: activityId }]
            }
          });
          inFlight++;
        });
        let completed: { value: T; allKnownCommandsSettled: boolean } | undefined;
        let failure: unknown;
        try { completed = await operation(); }
        catch (error) { failure = error; }
        await exclusive(async () => {
          const settled = completed?.allKnownCommandsSettled === true && failure === undefined;
          inFlight--;
          uncertain ||= !settled;
          saved = await saveRecord(context, saved, {
            ...saved.value,
            owner: { ...saved.value.owner, state: uncertain ? 'uncertain' : 'active' },
            ...(uncertain ? { phase: 'failed' as const, lastCheckpoint: 'failed' as const } : {}),
            activities: {
              started: saved.value.activities.started,
              settled: saved.value.activities.settled + (settled ? 1 : 0),
              uncertain: saved.value.activities.uncertain + (settled ? 0 : 1),
              inFlight: saved.value.activities.inFlight.filter((entry) => entry.id !== activityId)
            }
          });
        });
        if (!completed || completed.allKnownCommandsSettled !== true || failure !== undefined) {
          throw new RepairWorkspaceError('owner-uncertain', 'Command settlement was not proven; the workspace must remain retained.', { cause: failure });
        }
        return completed.value;
      },
      releaseOwner: () => exclusive(async () => {
        await currentOwner();
        if (inFlight || saved.value.activities.inFlight.length || saved.value.activities.uncertain || uncertain) {
          throw new RepairWorkspaceError('owner-uncertain', 'Known workspace commands remain active or uncertain; no release proof was issued.');
        }
        saved = await saveRecord(context, saved, {
          ...saved.value,
          owner: { ...saved.value.owner, state: 'released', release: { releasedAt: now(context), allKnownCommandsSettled: true } }
        });
        released = true;
        liveOwners.delete(tokenDigest);
      }),
      cleanup: () => exclusive(() => cleanupOne(context, workspaceId))
    });
  } catch (error) { throw workspaceError(error); }
}

export async function inspectRepairVerificationWorkspaces(
  root: string, storage: RepairWorkspaceStorageOptions = {}
): Promise<RepairWorkspaceInspection> {
  const result: RepairWorkspaceInspection = {
    schemaVersion: 1, kind: 'liftoff-repair-workspaces', projectRoot: root,
    status: 'absent', workspaces: [], issues: []
  };
  try {
    const context = await openContext(root, storage, false);
    if (!context) return result;
    result.projectRoot = context.location.projectRoot;
    const index = await readIndex(context);
    for (const workspaceId of index.value.workspaces) {
      try { result.workspaces.push(await summarize(context, (await readRecord(context, workspaceId)).value)); }
      catch (error) { result.issues.push(issue(error)); }
    }
    result.status = result.issues.length || result.workspaces.some((entry) => entry.issues.length)
      ? 'blocked' : result.workspaces.length ? 'retained' : 'absent';
  } catch (error) {
    result.status = 'blocked';
    result.issues.push(issue(error));
  }
  return result;
}

export async function recoverRepairVerificationWorkspaces(
  root: string, storage: RepairWorkspaceStorageOptions = {}
): Promise<RepairWorkspaceRecoveryResult> {
  const result: RepairWorkspaceRecoveryResult = {
    schemaVersion: 1, kind: 'liftoff-repair-workspace-recovery', projectRoot: root,
    status: 'absent', cleanupComplete: true, results: [], retained: [], issues: []
  };
  try {
    const context = await openContext(root, storage, false);
    if (!context) return result;
    result.projectRoot = context.location.projectRoot;
    const index = await readIndex(context);
    for (const workspaceId of index.value.workspaces) result.results.push(await cleanupOne(context, workspaceId));
    const inspection = await inspectRepairVerificationWorkspaces(root, storage);
    result.retained = inspection.workspaces;
    result.issues = inspection.issues;
    result.cleanupComplete = result.results.every((entry) => entry.cleanupComplete) &&
      inspection.status === 'absent';
    result.status = result.cleanupComplete ? result.results.length ? 'complete' : 'absent'
      : result.results.some((entry) => entry.cleanupComplete) ? 'partial' : 'blocked';
  } catch (error) {
    result.cleanupComplete = false;
    result.status = result.results.some((entry) => entry.cleanupComplete) ? 'partial' : 'blocked';
    result.issues.push(issue(error));
  }
  return result;
}
