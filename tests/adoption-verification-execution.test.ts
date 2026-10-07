import {
  chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScopedUserLocalRecordStore, type UpdatePreviewOptions
} from '../src/adapters/filesystem/update-previews.js';
import {
  saveAdoptionCompatibilityPlan, type AdoptionCompatibilityReview
} from '../src/application/adoption/compatibility-plan.js';
import {
  saveAdoptionDestinationPlan
} from '../src/application/adoption/destination-plan.js';
import { inspectAdoptionCandidate } from '../src/application/adoption/candidate.js';
import {
  executeAdoptionVerification, readAdoptionVerificationResult
} from '../src/application/adoption/verification-execution.js';
import {
  saveAdoptionVerificationConsent
} from '../src/application/adoption/verification-consent.js';
import {
  saveAdoptionVerificationPlan
} from '../src/application/adoption/verification-plan.js';
import {
  createAdoptionReview, saveAdoptionPreview,
  type AdoptionReviewInspection
} from '../src/application/adoption/preview.js';
import {
  inspectRepairVerificationWorkspaces
} from '../src/application/repair/workspaces.js';
import * as repairWorkspaces from '../src/application/repair/workspaces.js';
import type {
  CommandResult, CommandRunner, RunCommandOptions
} from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
const now = new Date('2026-10-07T14:00:00.000Z');

async function directory(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function put(root: string, pathParts: readonly string[], content: string) {
  const filename = path.join(root, ...pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, { mode: 0o640 });
}

function compatibilityReview(
  review: AdoptionReviewInspection,
  destinationPlanFingerprint: string,
  network: boolean,
  preparationCwd?: string[]
): AdoptionCompatibilityReview {
  const inventory = review.report.inventory;
  const backend = inventory.files.find(file =>
    file.currentTargetLogicalName !== null &&
    file.currentTargetLogicalName !== 'root-readme');
  if (!backend) throw new Error('Missing backend fixture.');
  return {
    schemaVersion: 1,
    kind: 'liftoff-adoption-compatibility-review',
    projectRoot: inventory.projectRoot,
    reviewFingerprint: review.preview.fingerprint,
    destinationPlanFingerprint,
    inventoryDigest: inventory.inspectionDigest,
    targetLayoutDigest: inventory.target.digest,
    dynamicReferencesReviewed: true,
    unresolvedMappings: [],
    files: inventory.files.map((file, index) => ({
      sourcePathParts: [...file.pathParts],
      expectedDigest: file.digest,
      expectedMode: file.mode,
      decision: 'preserve-current-path',
      targetPathParts: [...file.pathParts],
      targetIdentity: file.currentTargetLogicalName === null
        ? { kind: 'custom-component', logicalName: `custom-file-${index + 1}` }
        : { kind: 'active-binding', logicalName: file.currentTargetLogicalName }
    })),
    references: inventory.references.map(reference => ({
      referenceId: reference.id,
      disposition: 'unchanged-reviewed',
      afterTargetPathParts: [...reference.targetPathParts]
    })),
    verification: {
      commands: [{
        executable: 'node',
        args: [backend.pathParts.join('/')],
        cwdPathParts: [],
        timeoutMs: 30_000,
        maxOutputBytes: 16_384,
        network
      }],
      preparation: preparationCwd ? [{
        provider: 'npm-ci',
        version: 1,
        cwdPathParts: preparationCwd,
        packageSource: 'npmjs',
        network: false,
        lifecycle: 'disabled'
      }] : []
    }
  };
}

async function prepared(
  script = 'if (!process.env.LIFTOFF_APPLICATION_VERIFICATION) process.exit(9);\n',
  network = false,
  preparation = false
) {
  const root = await directory('lf adoption execution ');
  const home = await directory('lf adoption execution home ');
  const storage: UpdatePreviewOptions = {
    homedir: home, env: {}, clock: () => now
  };
  const fixture = adoptionFixture(
    'node-fastify', 'single-maintainer-gitflow', 'openspec'
  );
  const backend = fixture.request.adoptionObservations.find(entry =>
    entry.logicalName !== 'root-readme');
  if (!backend) throw new Error('Missing backend fixture.');
  const source = preparation ? {
    ...fixture.source,
    activeLayout: {
      ...fixture.source.activeLayout,
      bindings: [
        ...fixture.source.activeLayout.bindings,
        {
          kind: 'artifact' as const,
          logicalName: 'node-backend-package',
          pathParts: [...backend.pathParts.slice(0, 2), 'package.json']
        }
      ]
    }
  } : fixture.source;
  await put(root, backend.pathParts, script);
  const preliminary = preparation
    ? await inspectAdoptionCandidate(root, source)
    : undefined;
  const preparationTarget = preliminary?.report.inventory.target.artifacts.find(
    artifact => artifact.logicalName === 'node-backend-package'
  );
  if (preparation && !preparationTarget) {
    throw new Error('Missing package target fixture.');
  }
  const preparationCwd = preparationTarget?.pathParts.slice(0, -1);
  let inspection: Parameters<typeof saveAdoptionVerificationPlan>[8];
  if (preparation) {
    await put(root, [...preparationCwd!, 'package.json'], JSON.stringify({
      name: 'preserved-application',
      version: '1.0.0',
      private: true,
      scripts: { test: `node ${backend.pathParts.slice(2).join('/')}` }
    }));
    await put(root, [...preparationCwd!, 'package-lock.json'], JSON.stringify({
      name: 'preserved-application',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'preserved-application',
          version: '1.0.0'
        }
      }
    }));
    const tools = await directory('lf adoption fake npm ');
    await mkdir(path.join(tools, 'node_modules', 'npm', 'bin'), {
      recursive: true
    });
    await writeFile(path.join(tools, 'npm'), '#!/bin/sh\nexit 1\n');
    await chmod(path.join(tools, 'npm'), 0o755);
    await writeFile(
      path.join(tools, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      'console.log("npm 12.0.2");\n'
    );
    await writeFile(
      path.join(tools, 'node_modules', 'npm', 'package.json'),
      JSON.stringify({ name: 'npm', version: '12.0.2' })
    );
    inspection = {
      env: {
        ...process.env,
        PATH: [tools, path.dirname(process.execPath)].join(path.delimiter)
      },
      runner: {
        run: async (command: ExternalCommand) => commandResult(command, {
          stdout: command.args.some(argument =>
            argument.endsWith('npm-cli.js'))
            ? 'npm 12.0.2'
            : `Node.js ${process.version}`
        })
      }
    };
  }
  await put(
    root, ['README.md'],
    `Preserved application: "${backend.pathParts.join('/')}"\n`
  );
  const review = await createAdoptionReview(root, source, now);
  await saveAdoptionPreview(review.preview, now, storage);
  const destination = await saveAdoptionDestinationPlan(
    root, review.preview.fingerprint, source, now, storage
  );
  const compatibility = await saveAdoptionCompatibilityPlan(
    compatibilityReview(
      review, destination.plan.report.fingerprint, network,
      preparationCwd
    ),
    source, now, storage
  );
  const verification = await saveAdoptionVerificationPlan(
    root, review.preview.fingerprint,
    destination.plan.report.fingerprint,
    compatibility.plan.report.fingerprint,
    source, now, storage, inspection
  );
  return {
    root, home, storage, source, backend, review, inspection,
    destination, compatibility, verification
  };
}

async function grant(input: Awaited<ReturnType<typeof prepared>>) {
  return saveAdoptionVerificationConsent(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    input.verification.plan.report.fingerprint,
    input.source, now,
    {
      projectCode: true,
      dependencyPreparation:
        input.verification.plan.report.requiredPermissions
          .includes('dependency-preparation'),
      declaredNetwork:
        input.verification.plan.report.requiredPermissions
          .includes('declared-network')
    },
    input.storage,
    input.inspection
  );
}

function execute(
  input: Awaited<ReturnType<typeof prepared>>,
  options: Parameters<typeof executeAdoptionVerification>[6] = {}
) {
  return executeAdoptionVerification(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    input.verification.plan.report.fingerprint,
    input.source,
    {
      inspection: input.inspection,
      ...options,
      storage: input.storage
    }
  );
}

function readResult(input: Awaited<ReturnType<typeof prepared>>) {
  return readAdoptionVerificationResult(
    input.root,
    input.review.preview.fingerprint,
    input.destination.plan.report.fingerprint,
    input.compatibility.plan.report.fingerprint,
    input.verification.plan.report.fingerprint,
    input.source,
    { storage: input.storage, inspection: input.inspection }
  );
}

function commandResult(
  command: ExternalCommand,
  overrides: Partial<CommandResult> = {}
): CommandResult {
  return {
    command, displayCommand: 'captured', status: 0, signal: null,
    stdout: command.args.includes('--version') ? process.version : '',
    stderr: '', timedOut: false, outputLimitExceeded: false,
    processTreeSettled: true, processSpawned: true,
    ...overrides
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  );
});

describe('authenticated adoption verification execution', () => {
  it('runs exact checks in a disposable copy and persists a signed current receipt', async () => {
    const input = await prepared();
    await grant(input);
    const original = await readFile(
      path.join(input.root, ...input.backend.pathParts)
    );
    const result = await execute(input);
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption-verification-result',
      projectRoot: input.root,
      verificationPlanFingerprint:
        input.verification.plan.report.fingerprint,
      status: 'passed',
      commands: [{ index: 0, passed: true }],
      preparation: [],
      blockers: [],
      inputsUnchanged: true,
      cleanupComplete: true,
      compatibility: 'verified-by-declared-checks',
      approval: 'not-requested',
      transaction: 'not-authorized',
      publication: 'not-authorized',
      receiptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(await readResult(input)).toEqual(result);
    expect(await execute(input)).toEqual(result);
    expect(await readFile(
      path.join(input.root, ...input.backend.pathParts)
    )).toEqual(original);
    expect(await readdir(input.root)).not.toContain('liftoff.manifest.json');
    expect(await inspectRepairVerificationWorkspaces(
      input.root, input.storage
    )).toMatchObject({ status: 'absent', workspaces: [] });
  });

  it('admits only one execution attempt for the exact plan under concurrent callers', async () => {
    const input = await prepared();
    await grant(input);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const runner: CommandRunner = {
      run: vi.fn(async (command: ExternalCommand) => {
        if (!command.args.includes('--version')) {
          enter();
          await blocked;
        }
        return commandResult(command);
      })
    };
    const first = execute(input, { runner });
    await entered;
    await expect(execute(input, { runner })).rejects.toThrow(
      /attempt already owns this exact plan/u
    );
    release();
    await expect(first).resolves.toMatchObject({
      status: 'passed',
      compatibility: 'verified-by-declared-checks'
    });
    expect(vi.mocked(runner.run).mock.calls.filter(([command]) =>
      !command.args.includes('--version')
    )).toHaveLength(1);
  });

  it('recovers a verified cleaned attempt without rerunning checks when receipt persistence fails', async () => {
    const input = await prepared();
    await grant(input);
    const runner: CommandRunner = {
      run: vi.fn(async (command: ExternalCommand) => commandResult(command))
    };
    const seal = vi.spyOn(
      repairWorkspaces, 'sealCompletedAdoptionVerificationResult'
    ).mockRejectedValueOnce(new Error('injected receipt persistence failure'));
    await expect(execute(input, { runner })).rejects.toThrow(
      /injected receipt persistence failure/u
    );
    const callsAfterFailure = vi.mocked(runner.run).mock.calls.length;
    seal.mockRestore();
    await expect(execute(input, { runner })).resolves.toMatchObject({
      status: 'passed',
      compatibility: 'verified-by-declared-checks',
      receiptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(runner.run).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it('refuses absent consent before dispatching any execution command', async () => {
    const input = await prepared();
    const runner: CommandRunner = { run: vi.fn() };
    await expect(execute(input, { runner })).rejects.toThrow(
      /No exact current adoption verification consent/u
    );
    expect(runner.run).not.toHaveBeenCalled();
    expect(await createScopedUserLocalRecordStore(
      input.root, 'adoption-verification-result', input.storage
    ).read(input.verification.plan.report.fingerprint)).toBeNull();
  });

  it('records a settled failed check without issuing a receipt or retaining the workspace', async () => {
    const input = await prepared('process.exit(7);\n');
    await grant(input);
    const result = await execute(input);
    expect(result).toMatchObject({
      status: 'failed',
      commands: [{ index: 0, status: 7, passed: false }],
      inputsUnchanged: true,
      cleanupComplete: true,
      compatibility: 'not-verified',
      transaction: 'not-authorized',
      receiptFingerprint: null
    });
    expect(result.blockers.join('\n')).toMatch(/check failed|exit/u);
    expect(await readResult(input)).toBeNull();
    expect(await execute(input)).toEqual(result);
    expect(await inspectRepairVerificationWorkspaces(
      input.root, input.storage
    )).toMatchObject({ status: 'absent' });
  });

  it('retains uncertain process scope and never persists success authority', async () => {
    const input = await prepared();
    await grant(input);
    const runner: CommandRunner = {
      run: vi.fn(async (
        command: ExternalCommand, _options?: RunCommandOptions
      ) => command.args.includes('--version')
        ? commandResult(command)
        : commandResult(command, {
            status: null,
            errorCode: 'DESCENDANT_PROCESSES_ACTIVE',
            processTreeSettled: false
          }))
    };
    const result = await execute(input, { runner });
    expect(result).toMatchObject({
      status: 'uncertain',
      commands: [{ passed: false }],
      cleanupComplete: false,
      compatibility: 'not-verified',
      receiptFingerprint: null,
      retainedWorkspace: expect.any(String)
    });
    expect(await readResult(input)).toBeNull();
    expect(await inspectRepairVerificationWorkspaces(
      input.root, input.storage
    )).toMatchObject({
      status: 'blocked',
      workspaces: [expect.objectContaining({
        workspaceId: result.workspaceId,
        owner: 'uncertain',
        uncertainCommands: 1
      })]
    });
  });

  it('revalidates current inputs before allocation and rejects post-consent drift', async () => {
    const input = await prepared();
    await grant(input);
    await put(
      input.root, input.backend.pathParts,
      'throw new Error("changed after consent");\n'
    );
    const runner: CommandRunner = { run: vi.fn() };
    await expect(execute(input, { runner })).rejects.toThrow();
    expect(runner.run).not.toHaveBeenCalled();
    expect(await inspectRepairVerificationWorkspaces(
      input.root, input.storage
    )).toMatchObject({ status: 'absent' });
  });

  it('rejects modified result envelopes even when their public payload still claims success', async () => {
    const input = await prepared();
    await grant(input);
    await execute(input);
    const store = createScopedUserLocalRecordStore(
      input.root, 'adoption-verification-result', input.storage
    );
    const saved = await store.read(
      input.verification.plan.report.fingerprint
    );
    expect(saved).not.toBeNull();
    await writeFile(saved!.path, JSON.stringify({
      ...(saved!.value as object),
      mac: '0'.repeat(64)
    }));
    await expect(readResult(input)).rejects.toThrow(/authentication failed/u);
  });

  it('runs separately consented locked preparation and freezes its private output before checks', async () => {
    const input = await prepared(undefined, false, true);
    await grant(input);
    const tools = input.verification.plan.verificationPolicy.toolchain;
    const runner: CommandRunner = {
      run: vi.fn(async (
        command: ExternalCommand, options?: RunCommandOptions
      ) => {
        const tool = tools.find(entry =>
          entry.probe.executable === command.executable &&
          entry.probe.args.join('\0') === command.args.join('\0'));
        if (tool) {
          return commandResult(command, {
            stdout: tool.id === 'npm'
              ? `npm ${tool.version}`
              : `Node.js v${tool.version}`
          });
        }
        if (command.args.includes('ci')) {
          await mkdir(path.join(options!.cwd!, 'node_modules'));
        }
        return commandResult(command);
      })
    };
    const result = await execute(input, { runner });
    expect(result).toMatchObject({
      status: 'passed',
      preparation: [{
        provider: 'npm-ci',
        status: 'passed',
        commands: [expect.objectContaining({ passed: true })]
      }],
      commands: [{ passed: true }],
      compatibility: 'verified-by-declared-checks'
    });
    expect(await readResult(input)).toEqual(result);
  });

  it('passes only the exact declared network marker to a network-authorized check', async () => {
    const input = await prepared(
      'if (process.env.LIFTOFF_APPLICATION_NETWORK !== "declared-allowed") process.exit(8);\n',
      true
    );
    await grant(input);
    const environments: NodeJS.ProcessEnv[] = [];
    const runner: CommandRunner = {
      run: vi.fn(async (
        command: ExternalCommand, options?: RunCommandOptions
      ) => {
        if (!command.args.includes('--version')) {
          environments.push({ ...options?.env });
        }
        return commandResult(command);
      })
    };
    expect(await execute(input, { runner })).toMatchObject({
      status: 'passed',
      compatibility: 'verified-by-declared-checks'
    });
    expect(environments).toHaveLength(1);
    expect(environments[0]?.LIFTOFF_APPLICATION_NETWORK)
      .toBe('declared-allowed');
  });
});
