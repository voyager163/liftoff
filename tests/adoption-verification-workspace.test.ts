import {
  lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdoptionVerificationWorkspace, inspectRepairVerificationWorkspaces,
  openCompletedAdoptionVerificationResult, recoverRepairVerificationWorkspaces,
  sealCompletedAdoptionVerificationResult,
  type AdoptionVerificationWorkspaceRecord,
  type CreateAdoptionVerificationWorkspaceOptions,
  type RepairWorkspaceStorageOptions
} from '../src/application/repair/workspaces.js';
import {
  openWorkspaceSeal, repairWorkspaceAuthorityKey,
  validateWorkspaceRecord, validateWorkspaceRequest, workspaceRecordKey
} from '../src/application/repair/workspaces-records.js';
import {
  createRepairWorkspaceRegistryStore, createScopedUserLocalRecordStore
} from '../src/adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { liftoffVersion } from '../src/version.js';

const roots: string[] = [];

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'lf-adoption-ws-')));
  roots.push(directory);
  const project = path.join(directory, 'Existing Project');
  const boundary = path.join(directory, 'Observation Boundary');
  const home = path.join(directory, 'Private Home');
  await Promise.all([mkdir(project), mkdir(boundary), mkdir(home)]);
  await writeFile(path.join(project, 'application.ts'), 'export const existing = true;\n');
  const storage: RepairWorkspaceStorageOptions = {
    homedir: home, env: { XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined }
  };
  const request: CreateAdoptionVerificationWorkspaceOptions = {
    planFingerprint: canonicalSha256('exact adoption verification plan'),
    adoptionIdentity: {
      schemaVersion: 1,
      kind: 'liftoff-adoption-verification-execution',
      cliVersion: liftoffVersion,
      adoptionVerificationContractVersion: 1
    },
    patchStagingRoot: boundary,
    bindings: {
      inputDigest: canonicalSha256('exact adoption snapshots'),
      verificationPolicyDigest: canonicalSha256('exact adoption checks'),
      providerDigest: canonicalSha256([]),
      toolchainDigest: canonicalSha256('exact adoption tools')
    },
    approvedScopes: {
      projectCode: true,
      dependencyPreparation: false,
      network: false,
      lifecycle: false
    }
  };
  return { directory, project, boundary, home, storage, request };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('authenticated adoption verification workspaces', () => {
  it('records a distinct adoption identity and confines project-code effects to disposable roles', async () => {
    const f = await fixture();
    const before = await readFile(path.join(f.project, 'application.ts'));
    const workspace = await createAdoptionVerificationWorkspace(
      f.project, f.request, f.storage
    );
    const authority = await createScopedUserLocalRecordStore(
      f.project, 'repair-workspace-authority', f.storage
    ).read(repairWorkspaceAuthorityKey);
    const key = (authority!.value as { key: string }).key;
    const saved = await createRepairWorkspaceRegistryStore(
      f.project, f.storage
    ).read(workspaceRecordKey(workspace.workspaceId));
    const record = openWorkspaceSeal(
      saved!.value, key
    ) as AdoptionVerificationWorkspaceRecord;
    expect(record).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption-verification-workspace',
      planFingerprint: f.request.planFingerprint,
      adoptionIdentity: f.request.adoptionIdentity,
      approvedScopes: f.request.approvedScopes,
      phase: 'ready'
    });
    expect(Object.hasOwn(record, 'repairIdentity')).toBe(false);

    await workspace.runOwned({
      kind: 'verification',
      commandDigest: canonicalSha256('exact command'),
      network: false,
      lifecycle: false
    }, async () => {
      await writeFile(
        path.join(workspace.roles.project, 'private-result'),
        'isolated project-code effect\n'
      );
      return { value: undefined, allKnownCommandsSettled: true };
    });
    await workspace.checkpoint('verified');
    await workspace.releaseOwner();
    expect((await workspace.cleanup()).cleanupComplete).toBe(true);
    await expect(lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(f.project, 'application.ts'))).toEqual(before);
  });

  it('enforces separately granted preparation/network scopes before invoking an operation', async () => {
    const f = await fixture();
    const workspace = await createAdoptionVerificationWorkspace(
      f.project, f.request, f.storage
    );
    for (const activity of [
      {
        kind: 'preparation' as const,
        commandDigest: canonicalSha256('preparation'),
        network: false,
        lifecycle: false
      },
      {
        kind: 'verification' as const,
        commandDigest: canonicalSha256('network check'),
        network: true,
        lifecycle: false
      }
    ]) {
      const operation = vi.fn(async () => ({
        value: undefined, allKnownCommandsSettled: true
      }));
      await expect(workspace.runOwned(activity, operation)).rejects.toMatchObject({
        code: 'permission-denied'
      });
      expect(operation).not.toHaveBeenCalled();
    }
    await workspace.releaseOwner();
    expect((await workspace.cleanup()).cleanupComplete).toBe(true);
  });

  it('rejects executable requests and mixed or copied identity variants without invoking hooks', async () => {
    const f = await fixture();
    const hook = vi.fn(() => {
      throw new Error('Workspace validation must not execute caller hooks.');
    });
    const accessor = Object.defineProperty(
      { ...f.request }, 'adoptionIdentity', { enumerable: true, get: hook }
    );
    const proxy = new Proxy(f.request, {
      get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook
    });
    expect(() => validateWorkspaceRequest(accessor)).toThrow(/missing or unsupported fields/u);
    expect(() => validateWorkspaceRequest(proxy)).toThrow(/missing or unsupported fields/u);
    expect(hook).not.toHaveBeenCalled();

    expect(() => validateWorkspaceRequest({
      ...f.request,
      repairIdentity: {
        schemaVersion: 1,
        kind: 'liftoff-repair-execution',
        cliVersion: liftoffVersion,
        repairContractVersion: 1
      }
    })).toThrow(/missing or unsupported fields/u);

    const workspace = await createAdoptionVerificationWorkspace(
      f.project, f.request, f.storage
    );
    const authority = await createScopedUserLocalRecordStore(
      f.project, 'repair-workspace-authority', f.storage
    ).read(repairWorkspaceAuthorityKey);
    const saved = await createRepairWorkspaceRegistryStore(
      f.project, f.storage
    ).read(workspaceRecordKey(workspace.workspaceId));
    const record = openWorkspaceSeal(
      saved!.value, (authority!.value as { key: string }).key
    ) as AdoptionVerificationWorkspaceRecord;
    const expected = {
      projectRoot: record.projectRoot,
      directory: () => record.directory
    };
    expect(() => validateWorkspaceRecord({
      ...record,
      repairIdentity: {
        schemaVersion: 1,
        kind: 'liftoff-repair-execution',
        cliVersion: liftoffVersion,
        repairContractVersion: 1
      }
    }, expected)).toThrow(/missing or unsupported fields/u);
    const { adoptionIdentity: _adoptionIdentity, ...copied } = record;
    expect(() => validateWorkspaceRecord({
      ...copied,
      kind: 'liftoff-repair-workspace'
    }, expected)).toThrow(/missing or unsupported fields/u);
  });

  it('rejects forged identity versions and retains uncertain adoption workspaces for recovery', async () => {
    const f = await fixture();
    await expect(createAdoptionVerificationWorkspace(f.project, {
      ...f.request,
      adoptionIdentity: {
        ...f.request.adoptionIdentity,
        adoptionVerificationContractVersion: 2
      }
    } as unknown as CreateAdoptionVerificationWorkspaceOptions, f.storage))
      .rejects.toThrow(/not supported/u);

    const workspace = await createAdoptionVerificationWorkspace(
      f.project, f.request, f.storage
    );
    await expect(workspace.runOwned({
      kind: 'verification',
      commandDigest: canonicalSha256('uncertain command'),
      network: false,
      lifecycle: false
    }, async () => ({
      value: undefined,
      allKnownCommandsSettled: false
    }))).rejects.toMatchObject({ code: 'owner-uncertain' });
    expect(await recoverRepairVerificationWorkspaces(
      f.project, f.storage
    )).toMatchObject({
      status: 'blocked',
      cleanupComplete: false,
      retained: [expect.objectContaining({
        workspaceId: workspace.workspaceId,
        owner: 'uncertain',
        uncertainCommands: 1
      })]
    });
    expect((await lstat(workspace.directory)).isDirectory()).toBe(true);
  });

  it('recovers a released adoption workspace through authenticated shared disposal records', async () => {
    const f = await fixture();
    const workspace = await createAdoptionVerificationWorkspace(
      f.project, f.request, f.storage
    );
    await workspace.releaseOwner();
    expect(await inspectRepairVerificationWorkspaces(
      f.project, f.storage
    )).toMatchObject({
      status: 'retained',
      workspaces: [expect.objectContaining({
        workspaceId: workspace.workspaceId,
        owner: 'released'
      })]
    });
    expect(await recoverRepairVerificationWorkspaces(
      f.project, f.storage
    )).toMatchObject({
      status: 'complete',
      cleanupComplete: true
    });
    await expect(lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('seals results only after verified settlement and complete authenticated cleanup', async () => {
    const f = await fixture();
    const workspace = await createAdoptionVerificationWorkspace(
      f.project, f.request, f.storage
    );
    const payload = {
      kind: 'qualified-adoption-verification',
      digest: canonicalSha256('exact successful checks')
    };
    await expect(sealCompletedAdoptionVerificationResult(
      f.project, workspace.workspaceId, f.request.planFingerprint,
      payload, f.storage
    )).rejects.toThrow(/settled, verified and completely cleaned/u);
    await workspace.runOwned({
      kind: 'verification',
      commandDigest: canonicalSha256('successful check'),
      network: false,
      lifecycle: false
    }, async () => ({ value: undefined, allKnownCommandsSettled: true }));
    await workspace.checkpoint('verified');
    await workspace.releaseOwner();
    expect((await workspace.cleanup()).cleanupComplete).toBe(true);
    const sealed = await sealCompletedAdoptionVerificationResult(
      f.project, workspace.workspaceId, f.request.planFingerprint,
      payload, f.storage
    );
    expect(await openCompletedAdoptionVerificationResult(
      f.project, workspace.workspaceId, f.request.planFingerprint,
      sealed, f.storage
    )).toEqual(payload);
    await expect(openCompletedAdoptionVerificationResult(
      f.project, workspace.workspaceId, canonicalSha256('another plan'),
      sealed, f.storage
    )).rejects.toThrow();
    await expect(openCompletedAdoptionVerificationResult(
      f.project, workspace.workspaceId, f.request.planFingerprint,
      { ...(sealed as object), mac: '0'.repeat(64) }, f.storage
    )).rejects.toThrow(/authentication failed/u);
  });
});
