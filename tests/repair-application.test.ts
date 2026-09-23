import { chmod, link, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectApplicationLayout, currentApplicationTargets } from '../src/application/repair/application-inventory.js';
import {
  applicationCandidateDigest, inspectApplicationPatch, verifyApplicationPatch, parseApplicationPatch
} from '../src/application/repair/application-patch.js';
import { applicationDigest, applicationPathKey } from '../src/application/repair/application-files.js';
import { applicationBounds, type ApplicationPatchDocument, type ApplicationVerificationCommand } from '../src/application/repair/application-types.js';
import {
  applicationCommandFailure, applicationFailureBlocker, applicationRunnerFailure
} from '../src/application/repair/application-diagnostics.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { buildArtifacts, buildManifest } from '../src/templates.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../src/process-runner.js';
import { projectMutationLockPath, withProjectMutationLock } from '../src/adapters/filesystem/project-lock.js';
import {
  applicationFixtureExcluded, applicationFixtureSources, createApplicationRepairFixture,
  putApplicationFixtureFile, stageApplicationRepairFixture, applicationVerificationFixtureContext
} from './fixtures/repair-application.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});

const directories: string[] = [];
async function fixtureDirectory() {
  // Leave room for the two full workspace identities within Windows' process cwd limit.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lf app ')));
  directories.push(directory);
  return directory;
}
async function fixture() {
  const directory = await fixtureDirectory();
  return { directory, ...await createApplicationRepairFixture(directory) };
}
async function stagedFixture() {
  const value = await fixture();
  return { ...value, ...await stageApplicationRepairFixture(value.root, value.stage, value.manifest) };
}
async function savePatch(stage: string, document: ApplicationPatchDocument) {
  await putApplicationFixtureFile(stage, ['patch.json'], `${JSON.stringify(document, null, 2)}\n`, 0o600);
}
function passingRunner(): CommandRunner {
  return {
    run: vi.fn(async (command) => ({
      command, displayCommand: 'not emitted', status: 0, signal: null,
      stdout: 'PRIVATE_UNTRUSTED_COMMAND_OUTPUT', stderr: '', timedOut: false, processTreeSettled: true
    }))
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('bounded application inventory and executable staged patch', () => {
  it('inventories actual custom paths, provenance, current target IDs and literal references without source values', async () => {
    const { root, manifest } = await fixture();
    const inspection = await inspectApplicationLayout(root, manifest);
    expect(inspection.report.blockers).toEqual([]);
    expect(inspection.report.complete).toBe(true);
    expect(inspection.report.target).toEqual(currentApplicationTargets(manifest).target);
    expect(inspection.report.files.find((file) => applicationPathKey(file.pathParts) === 'legacy/service.mjs')).toMatchObject({
      currentTargetLogicalName: null,
      provenance: { logicalName: 'node-backend-app', identity: 'recorded-only', contentMatchesRecordedHash: false }
    });

    expect(inspection.report.unresolvedMappings).toContainEqual({
      sourcePathParts: ['legacy', 'service.mjs'], decision: 'explicit-mapping-required'
    });
    expect(inspection.report.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePathParts: ['tests', 'quote.test.mjs'], targetPathParts: ['legacy', 'service.mjs'] }),
      expect.objectContaining({ sourcePathParts: ['Dockerfile'], targetPathParts: ['legacy'], targetKind: 'directory' }),
      expect.objectContaining({ sourcePathParts: ['.github', 'workflows', 'check.yml'], targetPathParts: ['legacy'] })
    ]));
    const output = JSON.stringify(inspection.report);
    expect(output).not.toContain('customer-volume-discount');
    expect(output).not.toContain('PRIVATE_');
    expect(JSON.stringify(inspection)).not.toContain('"type":"Buffer"');
    expect(inspection.report.referenceCoverage).toBe('bounded-literals-only');
    expect(inspection.snapshots.some((file) => file.content?.includes(Buffer.from('customer-volume-discount')))).toBe(true);
    for (const file of Object.keys(applicationFixtureExcluded)) {
      expect(inspection.snapshots.some((item) => applicationPathKey(item.pathParts) === file)).toBe(false);
    }
  });

  it.each([
    ['standard', 'node-fastify', undefined, false, 'node-backend-app'],
    ['standard', 'python-fastapi', undefined, true, 'backend-main'],
    ['standard', 'go-huma', undefined, false, 'go-backend-main'],
    ['genai', 'python-fastapi', 'rag', true, 'function-worker-app'],
    ['genai', 'python-fastapi', 'chatbot', false, 'backend-pattern-routes']
  ] as const)('derives real %s/%s targets with selected optional components (%s)', async (kind, apiStack, pattern, frontend, expected) => {
    const directory = await fixtureDirectory();
    const plan = buildProjectPlan({
      projectName: 'target-layout', projectType: kind, apiStack, ...(pattern ? { pattern } : {}),
      cloud: 'azure', region: 'eastus', environments: ['dev', 'prod'], specWorkflow: 'openspec',
      agents: ['github-copilot'], governanceProfile: 'none', includeFrontend: frontend
    }, { requireProjectName: true });
    const generated = buildArtifacts(plan), manifest = buildManifest(plan, generated);
    await putApplicationFixtureFile(directory, ['custom', 'domain.py'], 'def customer_policy():\n    return 37\n');
    const inspection = await inspectApplicationLayout(directory, manifest);
    expect(inspection.report.blockers).toEqual([]);
    const target = inspection.report.target!;
    expect(target.artifacts.some((item) => item.logicalName === expected)).toBe(true);
    expect(target.artifacts.some((item) => item.component === 'frontend')).toBe(frontend);
    expect(target.artifacts.some((item) => item.component === 'database')).toBe(true);
    expect(target.artifacts.some((item) => item.logicalName === 'docker-compose')).toBe(true);
    expect(target.artifacts.some((item) => item.component === 'functions')).toBe(pattern === 'rag');
    for (const artifact of target.artifacts) {
      expect(generated).toContainEqual(expect.objectContaining({
        logicalName: artifact.logicalName, category: artifact.category,
        pathParts: artifact.pathParts, lifecycle: 'project', provisioningGroup: artifact.provisioningGroup
      }));
      expect(artifact.pathParts.includes('infrastructure')).toBe(false);
    }
    expect(inspection.report.files).toContainEqual(expect.objectContaining({ pathParts: ['custom', 'domain.py'] }));
  });

  it('does not open excluded state/credentials/control content or enumerate excluded trees, even with oversized unreadable contents', async () => {
    const { root, manifest } = await fixture();
    await putApplicationFixtureFile(root, ['nested', 'state.json'], Buffer.alloc(applicationBounds.fileBytes + 1), 0);
    await putApplicationFixtureFile(root, ['nested', '.envrc'], 'PRIVATE_DIRENV_CONTENT', 0);
    vi.mocked(open).mockClear();
    vi.mocked(opendir).mockClear();
    const inspection = await inspectApplicationLayout(root, manifest);
    expect(inspection.report.complete, inspection.report.blockers.join('; ')).toBe(true);
    const reads = vi.mocked(open).mock.calls.map(([file]) => String(file));
    const enumerations = vi.mocked(opendir).mock.calls.map(([file]) => String(file));
    for (const file of [...Object.keys(applicationFixtureExcluded), 'nested/state.json', 'nested/.envrc', 'liftoff.manifest.json', 'liftoff.config.json']) {
      expect(reads).not.toContain(path.join(root, ...file.split('/')));
    }
    for (const excluded of ['.git', '.liftoff', 'infrastructure', 'node_modules', '.claude']) {
      expect(enumerations.some((entry) => entry === path.join(root, excluded) || entry.startsWith(`${path.join(root, excluded)}${path.sep}`))).toBe(false);
    }
    expect(JSON.stringify(inspection.report)).not.toContain('PRIVATE_');
  });

  it('detects concrete Python imports without pretending to resolve dynamic modules', async () => {
    const { root, manifest } = await fixture();
    await putApplicationFixtureFile(root, ['old', 'price.py'], 'def price():\n    return 17\n');
    await putApplicationFixtureFile(root, ['tests', 'test_price.py'], 'from old.price import price\nimport importlib\nmodule_name = "chosen_at_runtime"\n');
    const inspection = await inspectApplicationLayout(root, manifest);
    expect(inspection.report.references).toContainEqual(expect.objectContaining({
      sourcePathParts: ['tests', 'test_price.py'], kind: 'python-import', targetPathParts: ['old', 'price.py'], line: 1
    }));
    expect(inspection.report.limitations.join(' ')).toContain('Dynamic imports');
    expect(JSON.stringify(inspection.report)).not.toContain('chosen_at_runtime');
  });

  it('previews exact custom code/import/build/Docker/Compose/CI/docs mappings without project writes or checks', async () => {
    const { root, stage, manifest } = await fixture();
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.report.status).toBe('proposed');
    expect(candidate.report.limitations.join(' ')).toContain('Verification covers only the explicitly declared checks when run');
    expect(candidate.report.limitations.join(' ')).not.toContain('were evaluated');
    expect(candidate.networkRequired).toBe(false);
    expect(candidate.report.networkRequired).toBe(false);
    expect(candidate.report.limitations.join(' ')).toContain('network: false is a declaration, not enforced network isolation');
    expect(candidate.report.limitations.join(' ')).toContain('action-specific Yes/No questions (default No)');
    expect(candidate.report.limitations.join(' ')).toContain('Humans do not need to copy fingerprints');
    expect(candidate.report.limitations.join(' ')).toContain('same actual user-approved immutable plan and effect scopes');
    expect(candidate.report.limitations.join(' ')).toContain('autopilot mode or agent-generated Yes');
    expect(candidate.patchPath).toBe(patchPath);
    expect(candidate.scope.staging.files).toHaveLength(10);
    expect(candidate.snapshots).toContainEqual({ pathParts: ['backend', 'src', 'app.ts'] });
    expect(candidate.scope.directoryInventory).toContainEqual({
      pathParts: ['backend', 'src'], exists: false, mode: null, entries: []
    });
    expect(candidate.mutations).toContainEqual({ type: 'delete', pathParts: ['legacy', 'service.mjs'] });
    const app = candidate.mutations.find((item) => item.type === 'write' && applicationPathKey(item.pathParts) === 'backend/src/app.ts')!;
    expect(app.type === 'write' && app.content.toString()).toBe(applicationFixtureSources['legacy/service.mjs']);
    expect(candidate.report.effects.map((item) => applicationPathKey(item.sourcePathParts))).toEqual(expect.arrayContaining([
      'legacy/service.mjs', 'legacy/custom.mjs', 'tests/quote.test.mjs', 'scripts/check-layout.mjs',
      'Dockerfile', 'docker-compose.yml', '.github/workflows/check.yml', 'docs/operations.md', 'README.md', 'package.json'
    ]));
    expect(JSON.stringify(candidate.scope)).not.toContain('customer-volume-discount');
    expect(JSON.stringify(candidate)).not.toContain('"type":"Buffer"');
    expect(await readFile(path.join(root, 'legacy', 'service.mjs'), 'utf8')).toBe(applicationFixtureSources['legacy/service.mjs']);
    await expect(lstat(path.join(root, 'backend'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes native Node tests and real reference checks against the candidate without applying the file transaction', async () => {
    const { root, stage, manifest, directory } = await fixture();
    const manifestBefore = await readFile(path.join(root, 'liftoff.manifest.json'));
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const runner = new NodeCommandRunner();
    const spy = vi.spyOn(runner, 'run');
    const verified = await verifyApplicationPatch(root, candidate, runner,
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }, {
        env: { ...process.env, APPLICATION_FIXTURE_SECRET: 'PRIVATE_INHERITED_CREDENTIAL' }
      }));
    expect(verified.status, verified.blockers.join('; ')).toBe('passed');
    expect(verified.commands).toHaveLength(2);
    expect(verified.commands.every((item) => item.status === 0 && item.passed)).toBe(true);
    expect(verified).toMatchObject({ inspectedProjectUnchanged: true, cleanupComplete: true, candidateDigest: applicationCandidateDigest(candidate) });
    expect(verified).not.toHaveProperty('projectUnchanged');
    expect(verified.limitation).toContain('not an operating-system or network sandbox');
    expect(verified.limitation).toContain('read/write host files, start processes, and access the network');
    expect(verified.limitation).toContain('only the explicitly declared checks when run');
    expect(verified.limitation).toContain('not dependency preparation or framework qualification');
    expect(verified.limitation).toContain('Mandatory operating-system or network isolation is unsupported');
    expect(verified.limitation).toContain('inspectedProjectUnchanged compares only bounded application inventory');
    expect(verified.limitation).toContain('Excluded raw manifest/config/state/control/credential contents');
    for (const [command, options] of spy.mock.calls) {
      expect(command.executable).toBe('node');
      expect(options?.cwd).not.toBe(root);
      expect(path.relative(root, options!.cwd!).startsWith('..')).toBe(true);
      expect(options).toMatchObject({ stream: false, timeoutMs: 10_000, maxOutputBytes: 16_384 });
      expect(options?.env?.APPLICATION_FIXTURE_SECRET).toBeUndefined();
    }
    expect(JSON.stringify(verified)).not.toContain('PRIVATE_');
    expect(await readFile(path.join(root, 'liftoff.manifest.json'))).toEqual(manifestBefore);
    await expect(lstat(path.join(root, 'backend'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).sort()).toEqual(['project', 'stage', 'verification-records-home']);
  });

  it('provides exact private originals and destination absences for coordinator-owned backups', async () => {
    const { root, stage, manifest } = await fixture();
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const mutated = new Set(candidate.mutations.map((item) => applicationPathKey(item.pathParts)));
    const originals = candidate.snapshots.filter((item) => mutated.has(applicationPathKey(item.pathParts)));
    expect(originals).toHaveLength(candidate.mutations.length);
    expect(originals.find((item) => applicationPathKey(item.pathParts) === 'legacy/service.mjs')?.content?.toString('utf8'))
      .toBe(applicationFixtureSources['legacy/service.mjs']);
    expect(originals).toContainEqual({ pathParts: ['backend', 'src', 'app.ts'] });
    expect(originals.some((item) => applicationPathKey(item.pathParts) === 'docs/unrelated.txt')).toBe(false);
    expect(JSON.stringify(candidate)).not.toContain('"type":"Buffer"');
  });

  it('preserves executable and read-only modes in reviewed effects and isolated copies', async () => {
    const { root, stage, manifest } = await fixture();
    await chmod(path.join(root, 'legacy', 'custom.mjs'), process.platform === 'win32' ? 0o444 : 0o755);
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const expected = (await lstat(path.join(root, 'legacy', 'custom.mjs'))).mode & 0o7777;
    expect(candidate.report.effects.find((item) => applicationPathKey(item.sourcePathParts) === 'legacy/custom.mjs')?.afterMode).toBe(expected);
    const runner = passingRunner();
    vi.mocked(runner.run).mockImplementation(async (command, options) => {
      expect((await lstat(path.join(options!.cwd!, 'backend', 'src', 'custom.mjs'))).mode & 0o7777).toBe(expected);
      return { command, displayCommand: '', status: 0, signal: null, stdout: '', stderr: '', timedOut: false, processTreeSettled: true };
    });
    const result = await verifyApplicationPatch(root, candidate, runner,
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(result.status).toBe('passed');
    expect((await lstat(path.join(root, 'legacy', 'custom.mjs'))).mode & 0o7777).toBe(expected);
  });

  it.each([
    ['file bytes', async (root: string) => putApplicationFixtureFile(root, ['oversized.bin'], Buffer.alloc(applicationBounds.fileBytes + 1))],
    ['total bytes', async (root: string) => {
      for (let index = 0; index < 9; index++) await putApplicationFixtureFile(root, [`large-${index}.bin`], Buffer.alloc(applicationBounds.fileBytes));
    }],
    ['directory entries', async (root: string) => {
      await Promise.all(Array.from({ length: applicationBounds.directoryEntries + 1 }, (_, index) =>
        putApplicationFixtureFile(root, ['crowded', `${index}.txt`], '')));
    }],
    ['file count', async (root: string) => {
      await Promise.all(Array.from({ length: applicationBounds.files + 1 }, (_, index) =>
        putApplicationFixtureFile(root, [`group-${Math.floor(index / 128)}`, `${index}.txt`], '')));
    }],
    ['depth', async (root: string) => putApplicationFixtureFile(root, [...Array<string>(applicationBounds.depth).fill('d'), 'file.txt'], '')],
    ['references', async (root: string) => putApplicationFixtureFile(root, ['many-references.md'],
      Array<string>(applicationBounds.references + 1).fill('`legacy/service.mjs`\n').join(''))]
  ])('exposes incomplete inventory at the %s bound without authorizing a partial scope', async (_kind, populate) => {
    const { root, manifest } = await fixture();
    await populate(root);
    const inventory = await inspectApplicationLayout(root, manifest);
    expect(inventory.report.complete).toBe(false);
    expect(inventory.report.blockers.join(' ')).toMatch(/bound|depth|count/iu);
  });

  it.each([
    ['schema', (document: ApplicationPatchDocument) => { document.schemaVersion = 2 as never; }],
    ['kind', (document: ApplicationPatchDocument) => { document.kind = 'other' as never; }],
    ['extra field', (document: ApplicationPatchDocument) => Object.assign(document, { overwrite: true })],
    ['unsupported mandatory isolation', (document: ApplicationPatchDocument) =>
      Object.assign(document.verification, { requiredIsolation: 'operating-system-and-network' })],
    ['unresolved mapping', (document: ApplicationPatchDocument) => { document.unresolvedMappings = ['unreviewed'] as never; }],
    ['dynamic review', (document: ApplicationPatchDocument) => { document.dynamicReferencesReviewed = false as never; }],
    ['other root', (document: ApplicationPatchDocument) => { document.projectRoot = path.join(document.projectRoot, 'other'); }],
    ['inspection digest', (document: ApplicationPatchDocument) => { document.inspectionDigest = '0'.repeat(64); }],
    ['target digest', (document: ApplicationPatchDocument) => { document.targetLayoutDigest = '0'.repeat(64); }],
    ['source digest', (document: ApplicationPatchDocument) => { document.mappings[0]!.expectedSourceDigest = '0'.repeat(64); }],
    ['source mode', (document: ApplicationPatchDocument) => { document.mappings[0]!.expectedSourceMode ^= 0o100; }],
    ['special mode', (document: ApplicationPatchDocument) => { document.mappings[0]!.targetMode = 0o4755; }],
    ['unknown identity', (document: ApplicationPatchDocument) => { document.mappings[0]!.targetIdentity.logicalName = 'unselected-component'; }],
    ['target identity path', (document: ApplicationPatchDocument) => { document.mappings[0]!.targetPathParts = ['backend', 'different.ts']; }],
    ['unknown source', (document: ApplicationPatchDocument) => { document.mappings[0]!.sourcePathParts = ['unobserved', 'app.mjs']; }],
    ['unknown reference', (document: ApplicationPatchDocument) => { document.mappings[0]!.references[0]!.referenceId = '0'.repeat(64); }],
    ['missing reference', (document: ApplicationPatchDocument) => { document.mappings[0]!.references = []; }],
    ['duplicate mapping', (document: ApplicationPatchDocument) => { document.mappings.push(structuredClone(document.mappings[0]!)); }],
    ['duplicate target', (document: ApplicationPatchDocument) => { document.mappings[1]!.targetPathParts = [...document.mappings[0]!.targetPathParts]; }],
    ['overlapping target', (document: ApplicationPatchDocument) => { document.mappings[1]!.targetPathParts = [...document.mappings[0]!.targetPathParts, 'child.mjs']; }],
    ['source-destination cycle', (document: ApplicationPatchDocument) => { document.mappings[0]!.targetPathParts = [...document.mappings[1]!.sourcePathParts]; }],
    ['no verification', (document: ApplicationPatchDocument) => { document.verification.commands = []; }],
    ['unbounded timeout', (document: ApplicationPatchDocument) => { document.verification.commands[0]!.timeoutMs = applicationBounds.commandTimeoutMs + 1; }],
    ['no output bound', (document: ApplicationPatchDocument) => { document.verification.commands[0]!.maxOutputBytes = 0; }]
  ])('rejects malformed or unresolved patch authority: %s', async (_kind, change) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    change(document);
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.length).toBeGreaterThan(0);
    expect(candidate.mutations).toEqual([]);
    expect(candidate.report.status).toBe('blocked');
    expect(await readFile(path.join(root, 'legacy', 'service.mjs'), 'utf8')).toBe(applicationFixtureSources['legacy/service.mjs']);
  });

  it.each([
    ['..', 'outside.mjs'], ['/absolute.mjs'], ['C:\\outside.mjs'], ['backend', 'evil:stream'],
    ['backend', 'CON'], ['backend', 'trailing.'], ['backend', 'trailing '], ['backend', 'cafe\u0301.mjs'],
    ['backend', 'new\\file.mjs'], ['backend', 'control\u0001.mjs']
  ])('rejects a nonportable destination %j', async (...parts) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    document.mappings[0]!.targetPathParts = parts;
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.length).toBeGreaterThan(0);
    expect(candidate.mutations).toEqual([]);
  });

  it.each([
    ['liftoff.manifest.json'], ['liftoff.config.json'], ['.liftoff', 'repair-history', 'receipt.json'],
    ['nested', 'infrastructure', 'file.json'], ['backend', '.env'], ['backend', '.envrc'],
    ['.github', 'skills', 'custom', 'SKILL.md'], ['.github', 'workflows', 'copilot-setup-steps.yml'],
    ['.agents', 'skills', 'custom', 'SKILL.md'], ['openspec', 'config.yaml'], ['nested', 'credentials.json']
  ])('never grants authority to protected destinations %j', async (...parts) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    document.mappings[0]!.targetPathParts = parts;
    document.mappings[0]!.targetIdentity.kind = 'custom-component';
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toMatch(/protected/iu);
    expect(candidate.mutations).toEqual([]);
  });

  it('rejects duplicate JSON keys rather than approving a parser-dependent document', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    await putApplicationFixtureFile(stage, ['patch.json'], JSON.stringify(document).replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1'));
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('duplicate object fields');
    expect(candidate.mutations).toEqual([]);
  });

  it.each(['patch', 'replacement'])('enforces a finite %s byte limit before content reads', async (kind) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const parts = kind === 'patch' ? ['patch.json'] : document.mappings[0]!.stagedPathParts;
    await putApplicationFixtureFile(stage, parts, Buffer.alloc((kind === 'patch' ? applicationBounds.patchBytes : applicationBounds.fileBytes) + 1));
    vi.mocked(open).mockClear();
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toMatch(/byte bound/iu);
    expect(vi.mocked(open).mock.calls.map(([file]) => String(file))).not.toContain(path.join(stage, ...parts));
    expect(candidate.mutations).toEqual([]);
  });

  it('rejects occupied destinations even when they contain the exact source bytes', async () => {
    const { root, stage, manifest } = await fixture();
    await putApplicationFixtureFile(root, ['backend', 'src', 'app.ts'], applicationFixtureSources['legacy/service.mjs']!);
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('move destination must be absent');
    expect(candidate.mutations).toEqual([]);
  });

  it.each(['file-parent', 'case-alias'])('rejects an unsafe destination ancestor (%s)', async (kind) => {
    const { root, stage, manifest } = await fixture();
    await putApplicationFixtureFile(root, kind === 'file-parent' ? ['backend'] : ['Backend', 'neighbor.txt'], 'keep');
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toMatch(/parent|aliases/iu);
    expect(candidate.mutations).toEqual([]);
  });

  it('requires concrete custom-component selection, not a directory prefix or an unselected frontend', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    document.mappings[1]!.targetPathParts = ['frontend', 'src', 'custom.mjs'];
    await savePatch(stage, document);
    let candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('selected current application component');
    document.mappings[1]!.targetIdentity.logicalName = 'frontend-main';
    await savePatch(stage, document);
    candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('unknown or unselected');
  });

  it('requires affected unmodified import/container/CI/documentation files to have exact mappings', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    document.mappings = document.mappings.filter((item) => applicationPathKey(item.sourcePathParts) !== 'Dockerfile');
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toMatch(/Dockerfile.*affected reference/iu);
    expect(candidate.mutations).toEqual([]);
  });

  it('checks reviewed reference dispositions against the actual staged bytes', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const mapping = document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === 'tests/quote.test.mjs')!;
    await putApplicationFixtureFile(stage, mapping.stagedPathParts, applicationFixtureSources['tests/quote.test.mjs']!);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toMatch(/staged bytes.*reference/iu);
    expect(candidate.mutations).toEqual([]);
  });

  it('accepts an explicitly historical documentation reference without pretending it is executable', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const mapping = document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === 'docs/operations.md')!;
    await putApplicationFixtureFile(stage, mapping.stagedPathParts, applicationFixtureSources['docs/operations.md']!);
    mapping.customization = 'preserved';
    mapping.references = mapping.references.map((item) => ({ ...item, disposition: 'historical-documentation', afterTargetPathParts: null }));
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const verified = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(verified.status).toBe('failed');
    expect(verified.inspectedProjectUnchanged).toBe(true);
  });

  it('rejects a historical disposition in application code', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    Object.assign(document.mappings[0]!.references[0]!, { disposition: 'historical-documentation', afterTargetPathParts: null });
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('limited to explicitly mapped documentation');
  });

  it('rejects a falsely preserved customization claim', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    await putApplicationFixtureFile(stage, document.mappings[0]!.stagedPathParts,
      applicationFixtureSources['legacy/service.mjs']!.replace('customer-volume-discount', 'unreviewed-starter'));
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('preserved customization requires byte-identical');
    expect(candidate.mutations).toEqual([]);
  });

  it.each(['source-file', 'source-directory', 'staged-file', 'patch-file', 'project-root'])('refuses relevant symlinks/junctions (%s)', async (kind) => {
    const { root, stage, manifest, patchPath, document, directory } = await stagedFixture();
    const outside = path.join(directory, 'outside');
    await mkdir(outside);
    await putApplicationFixtureFile(outside, ['code.mjs'], 'PRIVATE_LINK_TARGET');
    let project = root, patch = patchPath;
    let linkPath: string, target: string, linkKind: 'file' | 'junction';
    if (kind === 'source-file') {
      linkPath = path.join(root, 'linked.mjs'); target = path.join(outside, 'code.mjs'); linkKind = 'file';
    } else if (kind === 'source-directory') {
      linkPath = path.join(root, 'linked-directory'); target = outside; linkKind = 'junction';
    } else if (kind === 'staged-file') {
      linkPath = path.join(stage, ...document.mappings[0]!.stagedPathParts);
      await rm(linkPath); target = path.join(outside, 'code.mjs'); linkKind = 'file';
    } else if (kind === 'patch-file') {
      linkPath = path.join(stage, 'linked-patch.json'); target = patchPath; linkKind = 'file'; patch = linkPath;
    } else {
      linkPath = path.join(directory, 'linked-project'); target = root; linkKind = 'junction'; project = linkPath;
    }
    try { await symlink(target, linkPath, linkKind); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM' && linkKind === 'file') return;
      throw error;
    }
    vi.mocked(open).mockClear();
    const candidate = await inspectApplicationPatch(project, manifest, patch);
    expect(candidate.blockers.join(' ')).toMatch(/link|junction/iu);
    expect(candidate.mutations).toEqual([]);
    expect(vi.mocked(open).mock.calls.map(([file]) => String(file))).not.toContain(path.join(outside, 'code.mjs'));
  });

  it.each(['source', 'stage'])('rejects hard-linked %s bytes before opening them', async (kind) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const original = kind === 'source' ? path.join(root, 'legacy', 'service.mjs') : path.join(stage, ...document.mappings[0]!.stagedPathParts);
    const duplicate = path.join(kind === 'source' ? root : stage, 'hardlink-copy.mjs');
    await link(original, duplicate);
    vi.mocked(open).mockClear();
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('singly linked regular files');
    expect(vi.mocked(open).mock.calls.map(([file]) => String(file))).not.toContain(original);
    expect(candidate.mutations).toEqual([]);
  });

  it('rejects staging inside the project and ancestor-wide staging', async () => {
    const { root, manifest, patchPath, directory } = await stagedFixture();
    const patchBytes = await readFile(patchPath);
    await putApplicationFixtureFile(root, ['patch.json'], patchBytes);
    let candidate = await inspectApplicationPatch(root, manifest, path.join(root, 'patch.json'));
    expect(candidate.blockers.join(' ')).toContain('outside the real project');
    await rm(path.join(root, 'patch.json'));
    await putApplicationFixtureFile(directory, ['patch.json'], patchBytes);
    candidate = await inspectApplicationPatch(root, manifest, path.join(directory, 'patch.json'));
    expect(candidate.blockers.join(' ')).toContain('disjoint directories');
  });

  it.each(['../replacement.txt', '/outside.txt', 'bad\\name.txt'])('rejects unsafe staged path %s', async (unsafe) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    document.mappings[0]!.stagedPathParts = unsafe.split('/');
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.length).toBeGreaterThan(0);
    expect(candidate.mutations).toEqual([]);
  });

  it.each(['source bytes', 'source mode', 'destination', 'directory entry', 'directory mode', 'staged bytes', 'staged mode', 'staged inventory', 'patch bytes'])(
    'refuses stale %s before executing any verification command', async (kind) => {
      const { root, stage, manifest, patchPath, document } = await stagedFixture();
      const candidate = await inspectApplicationPatch(root, manifest, patchPath);
      expect(candidate.blockers).toEqual([]);
      if (kind === 'source bytes') await putApplicationFixtureFile(root, ['legacy', 'custom.mjs'], 'export const changed = true;\n');
      if (kind === 'source mode') await chmod(path.join(root, 'legacy', 'custom.mjs'), 0o444);
      if (kind === 'destination') await putApplicationFixtureFile(root, ['backend', 'src', 'app.ts'], 'occupied');
      if (kind === 'directory entry') await putApplicationFixtureFile(root, ['docs', 'added.txt'], 'new');
      if (kind === 'directory mode') {
        if (process.platform === 'win32') return;
        await chmod(path.join(root, 'docs'), 0o700);
      }
      if (kind === 'staged bytes') await putApplicationFixtureFile(stage, document.mappings[1]!.stagedPathParts, 'changed');
      if (kind === 'staged mode') await chmod(path.join(stage, ...document.mappings[1]!.stagedPathParts), 0o444);
      if (kind === 'staged inventory') await putApplicationFixtureFile(stage, ['extra.txt'], 'new');
      if (kind === 'patch bytes') await putApplicationFixtureFile(stage, ['patch.json'], `${JSON.stringify(document)}\n\n`);
      const runner = passingRunner();
      const result = await verifyApplicationPatch(root, candidate, runner,
        await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
      expect(result.status).toBe('blocked');
      expect(runner.run).not.toHaveBeenCalled();
      expect(result.blockers.join(' ')).toMatch(/changed|stale/iu);
    }
  );

  it.each(['project', 'staging'])('keeps real-lock reinspection stable but binds same-named %s entries', async (location) => {
    const { root, stage, manifest, patchPath } = await stagedFixture();
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const originalDigest = applicationCandidateDigest(candidate);
    const lockPath = await projectMutationLockPath(root);
    await withProjectMutationLock(root, async (lease) => {
      await lease.assertHeld();
      expect((await lstat(lockPath)).isFile()).toBe(true);
      const fresh = await inspectApplicationPatch(root, manifest, patchPath);
      expect(fresh.blockers).toEqual([]);
      expect(fresh.scope.inspectionDigest).toBe(candidate.scope.inspectionDigest);
      expect(applicationCandidateDigest(fresh)).toBe(originalDigest);

      const unrelated = path.join(location === 'project' ? root : stage, path.basename(lockPath));
      expect(unrelated).not.toBe(lockPath);
      await putApplicationFixtureFile(location === 'project' ? root : stage, [path.basename(lockPath)], 'unrelated lock-looking entry');
      const changed = await inspectApplicationPatch(root, manifest, patchPath);
      expect(applicationCandidateDigest(changed)).not.toBe(originalDigest);
      const runner = passingRunner();
      const result = await verifyApplicationPatch(root, candidate, runner,
        await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
      expect(result.status).toBe('blocked');
      expect(runner.run).not.toHaveBeenCalled();
      expect(await readFile(unrelated, 'utf8')).toBe('unrelated lock-looking entry');
      await lease.assertHeld();
    });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects in-memory mutation of candidate bytes or policy before verification', async () => {
    const { root, manifest, patchPath } = await stagedFixture();
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    candidate.verificationPolicy.commands[0]!.args = ['--test', 'other.mjs'];
    const runner = passingRunner();
    const result = await verifyApplicationPatch(root, candidate, runner,
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(result.status).toBe('blocked');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('requires separate explicit network consent without doing any implicit installation', async () => {
    const { root, stage, manifest, patchPath, document, directory } = await stagedFixture();
    document.verification.commands[0]!.network = true;
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.networkRequired).toBe(true);
    expect(candidate.report.networkRequired).toBe(true);
    const runner = passingRunner();
    const blocked = await verifyApplicationPatch(root, candidate, runner,
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockers.join(' ')).toContain('--allow-network');
    expect(runner.run).not.toHaveBeenCalled();
    expect((await readdir(directory)).sort()).toEqual(['project', 'stage', 'verification-records-home']);
    const verified = await verifyApplicationPatch(root, candidate, runner,
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: true }));
    expect(verified.status).toBe('passed');
    expect(vi.mocked(runner.run).mock.calls[0]![1]!.env?.LIFTOFF_APPLICATION_NETWORK).toBe('declared-allowed');
    expect(vi.mocked(runner.run).mock.calls[1]![1]!.env?.LIFTOFF_APPLICATION_NETWORK).toBe('not-authorized');
  });

  it.each([
    ['git', ['status']], ['tofu', ['plan']], ['az', ['account', 'show']], ['bash', ['-c', 'echo unsafe']],
    ['npm', ['ci']], ['npm', ['install']], ['npm', ['run', 'deploy', '--ignore-scripts']], ['node', ['-e', 'process.exit(0)']],
    ['python', ['-m', 'pip', 'install', 'pytest']], ['python', ['-m', 'venv', 'environment']], ['go', ['install', 'example.com/tool']],
    ['go', ['test', '-exec=sh', './...']], ['go', ['test', '-buildvcs=true', './...']],
    ['node', ['../../outside.mjs']], ['node', ['/absolute/check.mjs']]
  ])('rejects undeclared authority through %s %j', async (executable, args) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    document.verification.commands = [{ ...document.verification.commands[0]!, executable, args }];
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.length).toBeGreaterThan(0);
    expect(candidate.mutations).toEqual([]);
  });

  it('does not expose arbitrary command output or exception messages after a failed check', async () => {
    const { root, manifest, patchPath } = await stagedFixture();
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    const runner = passingRunner();
    vi.mocked(runner.run).mockImplementation(async (command) => ({
      command, displayCommand: 'PRIVATE_DISPLAY_SECRET', status: 17, signal: null, timedOut: false,
      stdout: 'PRIVATE_STDOUT_TOKEN', stderr: 'PRIVATE_STDERR_TOKEN', errorMessage: 'PRIVATE_ERROR_TOKEN'
    }));
    const result = await verifyApplicationPatch(root, candidate, runner,
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(result.status).toBe('failed');
    expect(result.commands).toContainEqual(expect.objectContaining({ index: 0, status: 17, passed: false }));
    expect(result.blockers.join(' ')).toContain('[check-failed]');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(result.inspectedProjectUnchanged).toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('runs failing native custom behavior tests without changing the project', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const test = document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === 'tests/quote.test.mjs')!;
    const staged = await readFile(path.join(stage, ...test.stagedPathParts), 'utf8');
    await putApplicationFixtureFile(stage, test.stagedPathParts, staged.replace('totalCents: 3500', 'totalCents: 9999'));
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const result = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(result.status).toBe('failed');
    expect(result.commands[0]?.status).toBe(1);
    expect(result.blockers.join(' ')).toContain('[check-failed]');
    expect(result.inspectedProjectUnchanged).toBe(true);
    expect(await readFile(path.join(root, 'tests', 'quote.test.mjs'), 'utf8')).toBe(applicationFixtureSources['tests/quote.test.mjs']);
  });

  it.each(['timeout', 'output'])('bounds actual native Node %s while preserving the project and withholding diagnostics', async (kind) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const test = document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === 'tests/quote.test.mjs')!;
    const staged = await readFile(path.join(stage, ...test.stagedPathParts), 'utf8');
    await putApplicationFixtureFile(stage, test.stagedPathParts, `${staged}\n${kind === 'timeout'
      ? 'setInterval(() => {}, 1000);' : "while (true) console.log('PRIVATE_UNBOUNDED_OUTPUT'.repeat(1000));"}\n`);
    if (kind === 'timeout') document.verification.commands[0]!.timeoutMs = 150;
    else document.verification.commands[0]!.maxOutputBytes = 1024;
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const result = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(result.status).toBe('failed');
    expect(result.commands[0]?.[kind === 'timeout' ? 'timedOut' : 'outputLimitExceeded']).toBe(true);
    expect(result.blockers.join(' ')).toContain(kind === 'timeout' ? '[timed-out]' : '[output-limit]');
    expect(result.inspectedProjectUnchanged).toBe(true);
    expect(result.cleanupComplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  describe('sanitized application verification diagnostics', () => {
    function command(executable = 'node', network = false): ApplicationVerificationCommand {
      return {
        executable, args: ['declared-check'], cwdPathParts: [], timeoutMs: 10_000,
        maxOutputBytes: 16_384, network
      };
    }
    function result(overrides: Partial<CommandResult> = {}): CommandResult {
      return {
        command: { executable: 'PRIVATE_UNTRUSTED_EXECUTABLE', args: ['PRIVATE_ARGUMENT'] },
        displayCommand: 'PRIVATE_DISPLAY_COMMAND', status: 1, signal: null, stdout: '', stderr: '',
        timedOut: false, ...overrides
      };
    }

    it.each([
      {
        name: 'missing executable', executable: 'node', kind: 'missing-executable',
        output: { status: null, errorCode: 'ENOENT', errorMessage: 'PRIVATE_EXECUTABLE_PATH' },
        remedy: 'separately approved workstation setup'
      },
      {
        name: 'missing script executable', executable: 'npm', kind: 'missing-executable',
        output: { status: 127, stderr: 'sh: PRIVATE_CHECK: command not found' },
        remedy: 'does not install global tools'
      },
      {
        name: 'launch permissions', executable: 'python', kind: 'execution-failed',
        output: { status: null, errorCode: 'EACCES', errorMessage: 'PRIVATE_EXECUTABLE_PATH' },
        remedy: 'permission was denied'
      },
      {
        name: 'Node ESM package', executable: 'node', kind: 'missing-dependencies',
        output: { stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'PRIVATE_PACKAGE_NAME' imported from PRIVATE_PATH" },
        remedy: 'npm ci/install are currently rejected'
      },
      {
        name: 'Node CommonJS module', executable: 'node', kind: 'missing-dependencies',
        output: { stderr: "Error: Cannot find module 'PRIVATE_PACKAGE_NAME'\n  code: 'MODULE_NOT_FOUND'" },
        remedy: 'required build output'
      },
      {
        name: 'TypeScript dependencies', executable: 'npm', kind: 'missing-dependencies',
        output: { stdout: "PRIVATE_PATH(1,1): error TS2307: Cannot find module 'PRIVATE_PACKAGE_NAME' or its corresponding type declarations." },
        remedy: 'Live node_modules'
      },
      {
        name: 'missing POSIX local test tool', executable: 'npm', kind: 'missing-dependencies',
        output: { status: 127, stderr: 'sh: 1: vitest: not found\nPRIVATE_NPM_LOG' },
        remedy: 'project-local check tool'
      },
      {
        name: 'missing Windows local build tool', executable: 'npm', kind: 'missing-dependencies',
        output: { stderr: "'vue-tsc' is not recognized as an internal or external command,\nPRIVATE_NPM_LOG" },
        remedy: 'separate preparation scope'
      },
      {
        name: 'Python package', executable: 'python3', kind: 'missing-dependencies',
        output: { stderr: "ModuleNotFoundError: No module named 'PRIVATE_PYTHON_PACKAGE'" },
        remedy: 'Python environment preparation is currently absent'
      },
      {
        name: 'Python test runner', executable: 'python', kind: 'missing-dependencies',
        output: { stderr: '/PRIVATE_PYTHON_PATH/python: No module named pytest' },
        remedy: 'does not run pip'
      },
      {
        name: 'Go private cache', executable: 'go', kind: 'missing-dependencies',
        output: { stderr: 'go: PRIVATE_MODULE@v1.0.0: module lookup disabled by GOPROXY=off' },
        remedy: 'did not declare network effects'
      },
      {
        name: 'Go checksum inputs', executable: 'go', kind: 'missing-dependencies',
        output: { stderr: 'PRIVATE_FILE.go: missing go.sum entry for module providing package PRIVATE_MODULE' },
        remedy: 'GOTOOLCHAIN stays local'
      },
      {
        name: 'Go version mismatch', executable: 'go', kind: 'execution-failed',
        output: { stderr: 'go: go.mod requires go >= 1.26 (running go 1.25; GOTOOLCHAIN=local)\nPRIVATE_MODULE' },
        remedy: 'compatible Go executable separately'
      },
      {
        name: 'missing npm script', executable: 'npm', kind: 'check-failed',
        output: { stderr: 'npm error Missing script: "test"\nPRIVATE_PATH_TO_LOG' },
        remedy: 'does not declare the requested npm script'
      },
      {
        name: 'Python circular import', executable: 'python3', kind: 'check-failed',
        output: { stderr: "ImportError: cannot import name 'PRIVATE_SYMBOL' from partially initialized module 'PRIVATE_MODULE'" },
        remedy: 'assertions, build errors, or staged source'
      },
      {
        name: 'ordinary assertion', executable: 'node', kind: 'check-failed',
        output: { status: 17, stderr: 'AssertionError: PRIVATE_EXPECTED_VALUE !== PRIVATE_ACTUAL_VALUE' },
        remedy: 'fresh review'
      },
      {
        name: 'ordinary next-value assertion', executable: 'node', kind: 'check-failed',
        output: { stderr: 'AssertionError: next value not found in PRIVATE_EXPECTED_DATA' },
        remedy: 'assertions, build errors, or staged source'
      },
      {
        name: 'ordinary tree-node assertion', executable: 'node', kind: 'check-failed',
        output: { stderr: 'AssertionError: node value not found in PRIVATE_TREE_DATA' },
        remedy: 'assertions, build errors, or staged source'
      },
      {
        name: 'unknown runner error', executable: 'node', kind: 'execution-failed',
        output: { status: null, errorCode: 'PRIVATE_UNKNOWN_CODE', errorMessage: 'PRIVATE_EXCEPTION' },
        remedy: 'execution prerequisites'
      },
      {
        name: 'timeout before dependency classification', executable: 'node', kind: 'timed-out',
        output: { status: null, timedOut: true, stderr: 'ERR_MODULE_NOT_FOUND PRIVATE_OUTPUT' },
        remedy: '10000 ms'
      },
      {
        name: 'output limit before dependency classification', executable: 'node', kind: 'output-limit',
        output: { status: null, outputLimitExceeded: true, stderr: 'ERR_MODULE_NOT_FOUND PRIVATE_OUTPUT' },
        remedy: '16384 bytes'
      },
      {
        name: 'interrupted check', executable: 'node', kind: 'interrupted',
        output: { status: null, aborted: true, errorCode: 'ABORT_ERR', errorMessage: 'PRIVATE_EXCEPTION' },
        remedy: 'Earlier verifier effects are not undone'
      },
      {
        name: 'uncertain process termination', executable: 'node', kind: 'termination-unconfirmed',
        output: { status: null, timedOut: true, errorCode: 'PROCESS_TREE_TERMINATION_FAILED', stderr: 'PRIVATE_PROCESS_DATA' },
        remedy: 'private workspace is retained'
      }
    ])('classifies $name without exposing diagnostic values', ({ executable, output, kind, remedy }) => {
      const check = command(executable);
      const diagnostic = applicationCommandFailure(check, result(output));
      expect(diagnostic?.kind).toBe(kind);
      expect(diagnostic?.message).toContain(remedy);
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
      expect(applicationFailureBlocker(0, check, diagnostic!)).not.toContain('PRIVATE_');
    });

    it('does not turn error-like successful output into a failed verification', () => {
      expect(applicationCommandFailure(command(), result({
        status: 0, stdout: 'Expected MODULE_NOT_FOUND fixture handled successfully.', stderr: ''
      }))).toBeNull();
    });

    it('enforces output bounds even when an injected runner fails to flag oversized output', () => {
      const diagnostic = applicationCommandFailure(command(), result({
        status: 0, stdout: 'PRIVATE_VALUE'.repeat(20_000), stderr: 'MODULE_NOT_FOUND'
      }));
      expect(diagnostic?.kind).toBe('output-limit');
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    });

    it('honors the bounded diagnostic prefix and never scans or repeats trailing values', () => {
      const diagnostic = applicationCommandFailure(command(), result({
        stderr: `${' '.repeat(9000)}ERR_MODULE_NOT_FOUND PRIVATE_TRAILING_VALUE`
      }));
      expect(diagnostic?.kind).toBe('check-failed');
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    });

    it('describes Go network semantics without implying npm or Python preparation', () => {
      const diagnostic = applicationCommandFailure(command('go', true), result({
        stderr: 'missing go.sum entry for module providing package PRIVATE_MODULE'
      }));
      expect(diagnostic?.message).toContain('This command declared network effects');
      expect(diagnostic?.message).toContain('Go test/vet can download modules');
      expect(diagnostic?.message).toContain('GOTOOLCHAIN stays local');
      expect(diagnostic?.message).not.toContain('npm ci');
    });

    it('handles thrown allowlisted errors without reading or echoing arbitrary exception messages', () => {
      const missing = applicationRunnerFailure(command(), Object.assign(new Error('PRIVATE_EXCEPTION'), { code: 'ENOENT' }));
      const unknown = applicationRunnerFailure(command(), Object.assign(new Error('PRIVATE_EXCEPTION'), { code: 'PRIVATE_CODE' }));
      expect(missing.kind).toBe('missing-executable');
      expect(unknown.kind).toBe('execution-failed');
      expect(JSON.stringify([missing, unknown])).not.toContain('PRIVATE_');
    });

    it('returns actionable launch errors from an independently invoked verifier without leaking runner exceptions', async () => {
      const { root, manifest, patchPath } = await stagedFixture();
      const candidate = await inspectApplicationPatch(root, manifest, patchPath);
      const runner = passingRunner();
      vi.mocked(runner.run).mockRejectedValue(Object.assign(new Error('PRIVATE_EXCEPTION_PATH'), { code: 'ENOENT' }));
      const verification = await verifyApplicationPatch(root, candidate, runner,
        await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
      expect(verification.status).toBe('failed');
      expect(verification.blockers.join(' ')).toContain('[missing-executable]');
      expect(verification.blockers.join(' ')).toContain('separately approved workstation setup');
      expect(JSON.stringify(verification)).not.toContain('PRIVATE_');
      expect(verification.cleanupComplete).toBe(false);
      expect(runner.run).toHaveBeenCalledTimes(1);
    });

    it('classifies an actual native Node missing package and withholds its private name and stack', async () => {
      const { root, stage, manifest, patchPath, document } = await stagedFixture();
      const test = document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === 'tests/quote.test.mjs')!;
      const staged = await readFile(path.join(stage, ...test.stagedPathParts), 'utf8');
      await putApplicationFixtureFile(stage, test.stagedPathParts, `${staged}\nawait import('PRIVATE_UNAVAILABLE_PACKAGE');\n`);
      const candidate = await inspectApplicationPatch(root, manifest, patchPath);
      expect(candidate.blockers).toEqual([]);
      const verification = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
        await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
      expect(verification.status).toBe('failed');
      expect(verification.blockers.join(' ')).toContain('[missing-dependencies]');
      expect(verification.blockers.join(' ')).toContain('npm ci/install are currently rejected');
      expect(JSON.stringify(verification)).not.toContain('PRIVATE_');
      expect(verification.inspectedProjectUnchanged).toBe(true);
    });

    it('retains the private copy when the runner cannot confirm process-tree termination', async () => {
      const { root, manifest, patchPath } = await stagedFixture();
      const candidate = await inspectApplicationPatch(root, manifest, patchPath);
      const runner = passingRunner();
      vi.mocked(runner.run).mockImplementation(async (check) => ({
        command: check, displayCommand: 'PRIVATE_DATA', status: null, signal: 'SIGKILL',
        stdout: '', stderr: 'PRIVATE_PROCESS_DATA', timedOut: true, errorCode: 'PROCESS_TREE_TERMINATION_FAILED'
      }));
      const verification = await verifyApplicationPatch(root, candidate, runner,
        await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
      expect(verification.status).toBe('failed');
      expect(verification.cleanupComplete).toBe(false);
      expect(verification.blockers.join(' ')).toContain('[termination-unconfirmed]');
      expect(verification.blockers.join(' ')).toContain('workspace-cleanup');
      expect((await lstat(verification.retainedWorkspace!)).isDirectory()).toBe(true);
      expect(JSON.stringify(verification)).not.toContain('PRIVATE_');
      expect(runner.run).toHaveBeenCalledTimes(1);
    });
  });

  it.each(['source', 'stage'])('rechecks %s after every separately invoked command and never rolls back concurrent changes', async (kind) => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    const runner = passingRunner();
    vi.mocked(runner.run).mockImplementation(async (command) => {
      if (kind === 'source') await putApplicationFixtureFile(root, ['docs', 'unrelated.txt'], 'concurrent developer edit');
      else await putApplicationFixtureFile(stage, document.mappings[1]!.stagedPathParts, 'concurrent staged edit');
      return { command, displayCommand: '', status: 0, signal: null, stdout: '', stderr: '', timedOut: false };
    });
    const result = await verifyApplicationPatch(root, candidate, runner,
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(result.status).toBe('failed');
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(result.inspectedProjectUnchanged).toBe(kind === 'stage');
    if (kind === 'source') expect(await readFile(path.join(root, 'docs', 'unrelated.txt'), 'utf8')).toBe('concurrent developer edit');
  });

  it('does not inherit executable injection or credential environment when invoking native checks', async () => {
    const { root, manifest, patchPath } = await stagedFixture();
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    const result = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }, {
        env: { ...process.env, APPLICATION_FIXTURE_SECRET: 'PRIVATE_ENV', NODE_OPTIONS: '--require missing-ambient-module.cjs',
          PYTHONPATH: '/private/ambient', GOFLAGS: '-exec=unexpected', NPM_TOKEN: 'PRIVATE_NPM_TOKEN' }
      }));
    expect(result.status, result.blockers.join('; ')).toBe('passed');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ENV');
  });

  it('keeps originals larger than external-record limits in private snapshots rather than public records', async () => {
    const { root, stage, manifest } = await fixture();
    await putApplicationFixtureFile(root, ['legacy', 'custom.mjs'],
      `${applicationFixtureSources['legacy/custom.mjs']}\n/* ${'CUSTOM_BYTES_'.repeat(7000)} */\n`);
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.snapshots.find((item) => applicationPathKey(item.pathParts) === 'legacy/custom.mjs')?.content?.byteLength)
      .toBeGreaterThan(64 * 1024);
    expect(JSON.stringify(candidate)).not.toContain('CUSTOM_BYTES_');
    expect(JSON.stringify(candidate)).not.toContain('"type":"Buffer"');
  });

  it('rejects staged checks that rewrite the reviewed candidate before reporting success', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const mapping = document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === 'scripts/check-layout.mjs')!;
    const script = await readFile(path.join(stage, ...mapping.stagedPathParts), 'utf8');
    await putApplicationFixtureFile(stage, mapping.stagedPathParts,
      `${script}\nawait (await import('node:fs/promises')).writeFile('backend/src/custom.mjs', 'export const replaced = true;');\n`);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const verified = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(verified.status).toBe('failed');
    expect(verified.blockers.join(' ')).toContain('changed-candidate-input');
    expect(verified.inspectedProjectUnchanged).toBe(true);
    expect(verified.cleanupComplete).toBe(true);
    expect(await readFile(path.join(root, 'legacy', 'custom.mjs'), 'utf8')).toBe(applicationFixtureSources['legacy/custom.mjs']);
  });

  it('reports only inspected inventory equality when native verifier code changes excluded raw manifest and config', async () => {
    const { root, stage, manifest, patchPath, document } = await stagedFixture();
    const mapping = document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === 'scripts/check-layout.mjs')!;
    const script = await readFile(path.join(stage, ...mapping.stagedPathParts), 'utf8');
    const controls = [
      { file: 'liftoff.manifest.json', content: '{"fixtureVerifierChanged":"manifest"}\n' },
      { file: 'liftoff.config.json', content: '{"fixtureVerifierChanged":"config"}\n' }
    ];
    const writes = controls.map(({ file, content }) =>
      `await (await import('node:fs/promises')).writeFile(${JSON.stringify(path.join(root, file))}, ${JSON.stringify(content)});`
    ).join('\n');
    await putApplicationFixtureFile(stage, mapping.stagedPathParts, `${script}\n${writes}\n`);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers).toEqual([]);
    const verified = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }, { includeRawControls: false }));
    expect(verified.status, verified.blockers.join('; ')).toBe('passed');
    expect(verified.inspectedProjectUnchanged).toBe(true);
    expect(verified).not.toHaveProperty('projectUnchanged');
    expect(verified.limitation).toContain('using the originally supplied manifest metadata');
    expect(verified.limitation).toContain('callers must independently recheck raw manifest and configuration');
    for (const { file, content } of controls) expect(await readFile(path.join(root, file), 'utf8')).toBe(content);
    expect(await readFile(path.join(root, 'legacy', 'service.mjs'), 'utf8')).toBe(applicationFixtureSources['legacy/service.mjs']);
  });

  it('rejects candidate growth beyond the inventory bound even when each individual staged file is bounded', async () => {
    const { root, stage, manifest } = await fixture();
    for (let index = 0; index < 7; index++) {
      await putApplicationFixtureFile(root, [`unchanged-${index}.bin`], Buffer.alloc(applicationBounds.fileBytes));
    }
    const { patchPath, document } = await stageApplicationRepairFixture(root, stage, manifest);
    const mapping = document.mappings[1]!;
    await putApplicationFixtureFile(stage, mapping.stagedPathParts, Buffer.alloc(applicationBounds.fileBytes));
    mapping.customization = 'reviewed-edit';
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('resulting application would exceed');
    expect(candidate.mutations).toEqual([]);
  });

  it.each(['\n', '\r\n'])('keeps the documented patch example aligned with the implemented strict schema with %j line endings', async (newline) => {
    const source = await readFile(new URL('../docs/application-repair.md', import.meta.url), 'utf8');
    const documentation = source.replace(/\r?\n/gu, newline);
    const example = documentation.match(/```json\r?\n([\s\S]*?)\r?\n```/u)?.[1];
    expect(example).toBeDefined();
    const parsed = parseApplicationPatch(Buffer.from(example!, 'utf8'));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.mappings[0]?.targetIdentity.logicalName).toBe('node-backend-app');
    expect(parsed.verification.commands[0]?.args).toEqual(['--test', 'tests/service.test.mjs']);
    expect(documentation).toContain('not a security sandbox');
    expect(documentation).toContain('liftoff repair <project> --application-patch <external-patch.json>');
    expect(documentation).toContain('**default No**');
    expect(documentation).toContain('Bare JSON/non-TTY invocations preview only');
    expect(documentation).toContain('No, Ctrl-C, or EOF never grants authority');
    expect(documentation).toContain('### Optional automation');
    expect(documentation).toContain('genuine input and stderr TTY streams');
    expect(documentation).toContain('verification already ran, with its');
    expect(documentation).toContain('no file transaction committed');
    expect(documentation).toContain('"nothing happened."');
    expect(documentation).toContain('Changes while any prompt is open must');
    expect(documentation).toContain('unsupported and must remain blocked');
    expect(documentation).toContain('autopilot mode, agent-generated');
    expect(documentation).toContain('recipe\'s separately registered, reviewed manifest and history writes');
    expect(documentation).toContain('Permitted command families are not a promise');
    expect(documentation).toContain('dependency-free custom-behavior and reference checks');
    expect(documentation).toContain('Registered preparation providers are:');
    expect(documentation).toContain('`npm-ci` version 1');
    expect(documentation).toContain('`uv-locked-sync` version 1');
    expect(documentation).toContain('`go-mod-download` version 1');
    expect(documentation).toContain('--allow-dependency-preparation');
    expect(documentation).toContain('### Actionable failures without raw diagnostic output');
    expect(documentation).toContain('`missing-executable`');
    expect(documentation).toContain('`missing-dependencies`');
    expect(documentation).toContain('Generic `npm install` remains rejected');
  });

  it.each([
    ['standard', 'python-fastapi', undefined, false, 'backend-main', '# kept-customer-rule\ndef price():\n    return 875\n'],
    ['standard', 'go-huma', undefined, false, 'go-backend-api', 'package api\n// kept-customer-rule\nfunc Price() int { return 875 }\n'],
    ['genai', 'python-fastapi', 'rag', false, 'function-worker-app', '# kept-customer-rule\ndef worker():\n    return "custom"\n'],
    ['standard', 'node-fastify', undefined, true, 'frontend-app', '<template><p>kept-customer-rule</p></template>\n'],
    ['standard', 'node-fastify', undefined, false, 'database-schema', '-- kept-customer-rule\nCREATE TABLE custom_prices (cents integer);\n']
  ] as const)('stages real selected-component file mappings for %s/%s (%s, target %s)', async (kind, apiStack, pattern, frontend, logicalName, content) => {
    const directory = await fixtureDirectory();
    const root = path.join(directory, 'project'), stage = path.join(directory, 'stage');
    const plan = buildProjectPlan({
      projectName: 'component-repair', projectType: kind, apiStack, ...(pattern ? { pattern } : {}),
      cloud: 'azure', region: 'eastus', environments: ['dev'], specWorkflow: 'openspec',
      agents: ['github-copilot'], governanceProfile: 'none', includeFrontend: frontend
    }, { requireProjectName: true });
    const manifest = buildManifest(plan, buildArtifacts(plan));
    const checker = `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
assert.ok((await readFile('source/business.txt', 'utf8')).includes('kept-customer-rule'));
`;
    await putApplicationFixtureFile(root, ['source', 'business.txt'], content);
    await putApplicationFixtureFile(root, ['checks', 'candidate.mjs'], checker);
    await putApplicationFixtureFile(root, ['liftoff.manifest.json'], JSON.stringify(manifest));
    const inspection = await inspectApplicationLayout(root, manifest);
    expect(inspection.report.complete).toBe(true);
    const target = inspection.report.target!.artifacts.find((item) => item.logicalName === logicalName)!;
    const document: ApplicationPatchDocument = {
      schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: inspection.report.projectRoot,
      inspectionDigest: inspection.report.inspectionDigest, targetLayoutDigest: inspection.report.target!.digest,
      dynamicReferencesReviewed: true, unresolvedMappings: [], mappings: [],
      verification: { commands: [{
        executable: 'node', args: ['checks/candidate.mjs'], cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 16_384, network: false
      }] }
    };
    for (const [index, snapshot] of inspection.snapshots.entries()) {
      const application = applicationPathKey(snapshot.pathParts) === 'source/business.txt';
      const stagedPathParts = ['replacements', `${index}.txt`];
      await putApplicationFixtureFile(stage, stagedPathParts,
        application ? snapshot.content! : checker.replace('source/business.txt', applicationPathKey(target.pathParts)), 0o600);
      document.mappings.push({
        sourcePathParts: snapshot.pathParts, targetPathParts: application ? target.pathParts : snapshot.pathParts,
        expectedSourceDigest: applicationDigest(snapshot.content!), expectedSourceMode: snapshot.mode!,
        stagedPathParts, targetMode: snapshot.mode!, role: application ? 'application' : 'reference',
        targetIdentity: { kind: application ? 'generated-artifact' : 'custom-component', logicalName },
        customization: application ? 'preserved' : 'reviewed-edit',
        references: inspection.report.references.filter((item) => applicationPathKey(item.sourcePathParts) === applicationPathKey(snapshot.pathParts))
          .map((item) => ({ referenceId: item.id, disposition: 'updated', afterTargetPathParts: target.pathParts }))
      });
    }
    await savePatch(stage, document);
    const candidate = await inspectApplicationPatch(root, manifest, path.join(stage, 'patch.json'));
    expect(candidate.blockers).toEqual([]);
    const verified = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
      await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
    expect(verified.status, verified.blockers.join('; ')).toBe('passed');
    expect(verified.inspectedProjectUnchanged).toBe(true);
    await expect(lstat(path.join(root, ...target.pathParts))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'source', 'business.txt'), 'utf8')).toBe(content);
  });

  it('rejects a resulting directory that would exceed bounded inventory after the moves', async () => {
    const { root, stage, manifest } = await fixture();
    await Promise.all(Array.from({ length: applicationBounds.directoryEntries - 1 }, (_, index) =>
      putApplicationFixtureFile(root, ['backend', 'src', `neighbor-${index}.txt`], '')));
    const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
    const candidate = await inspectApplicationPatch(root, manifest, patchPath);
    expect(candidate.blockers.join(' ')).toContain('resulting application would exceed');
    expect(candidate.mutations).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('preserves unrelated read-only directories while removing only the disposable verified copy', async () => {
    const { root, stage, manifest, directory } = await fixture();
    await putApplicationFixtureFile(root, ['read-only', 'notice.txt'], 'preserve this read-only directory');
    await chmod(path.join(root, 'read-only'), 0o555);
    try {
      const { patchPath } = await stageApplicationRepairFixture(root, stage, manifest);
      const candidate = await inspectApplicationPatch(root, manifest, patchPath);
      expect(candidate.blockers).toEqual([]);
      const result = await verifyApplicationPatch(root, candidate, new NodeCommandRunner(),
        await applicationVerificationFixtureContext(root, candidate, { projectCode: true, dependencyPreparation: false, network: false }));
      expect(result.status, result.blockers.join('; ')).toBe('passed');
      expect(result.cleanupComplete).toBe(true);
      expect((await lstat(path.join(root, 'read-only'))).mode & 0o777).toBe(0o555);
      expect((await readdir(directory)).sort()).toEqual(['project', 'stage', 'verification-records-home']);
    } finally {
      await chmod(path.join(root, 'read-only'), 0o755);
    }
  });
});
