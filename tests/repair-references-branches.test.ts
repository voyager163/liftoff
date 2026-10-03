import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationCandidateDigest, applicationInspectedProjectUnchanged, assertApplicationCandidateCurrent, inspectApplicationPatch
} from '../src/application/repair/application-patch-inspection.js';
import { inspectApplicationReferences } from '../src/application/repair/application-references.js';
import { applicationPathKey } from '../src/application/repair/application-files.js';
import type { ApplicationPatchDocument } from '../src/application/repair/application-types.js';
import { buildRepairPreview, loadRepairPreview } from '../src/application/repair/preview.js';
import { saveRepairVerification } from '../src/application/repair/verification-receipt.js';
import { inspectRepairVerificationWorkspaces } from '../src/application/repair/workspaces.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import {
  applicationFixtureSources, createApplicationRepairFixture, putApplicationFixtureFile, stageApplicationRepairFixture
} from './fixtures/repair-application.js';
import {
  TemporaryDirectories, ScriptedRunner, backendNpmCi, createCommandFlowFixture, historicalRepairPathParts, historicalRepairReceipt,
  repairJson, repairNow, snapshotTree, userRecordFiles
} from './fixtures/repair-branches.js';

const directories = new TemporaryDirectories();
afterEach(async () => { await directories.cleanup(); });

async function staged() {
  const directory = await directories.make('lf ref ');
  const base = await createApplicationRepairFixture(directory);
  return { directory, ...base, ...await stageApplicationRepairFixture(base.root, base.stage, base.manifest) };
}
async function save(stage: string, document: ApplicationPatchDocument) {
  await putApplicationFixtureFile(stage, ['patch.json'], `${JSON.stringify(document, null, 2)}\n`, 0o600);
}
const mapping = (document: ApplicationPatchDocument, source: string) =>
  document.mappings.find((item) => applicationPathKey(item.sourcePathParts) === source)!;

describe('reviewed reference dispositions bind the actual staged bytes', () => {
  it.each([
    ['an updated reference without a concrete target', (document: ApplicationPatchDocument) => {
      mapping(document, 'tests/quote.test.mjs').references[0]!.afterTargetPathParts = null;
    }, 'Reviewed references require a concrete candidate target.'],
    ['an unchanged reference retargeted elsewhere', (document: ApplicationPatchDocument) => {
      const check = mapping(document, 'scripts/check-layout.mjs');
      const unchanged = check.references.find((item) => item.disposition === 'unchanged-reviewed')!;
      unchanged.afterTargetPathParts = applicationPathKey(unchanged.afterTargetPathParts!) === 'README.md' ? ['Dockerfile'] : ['README.md'];
    }, 'Unchanged reference dispositions must retain their exact target.'],
    ['one reference identity reviewed twice', (document: ApplicationPatchDocument) => {
      const check = mapping(document, 'scripts/check-layout.mjs');
      expect(check.references.length).toBeGreaterThan(1);
      check.references[1] = { ...check.references[1]!, referenceId: check.references[0]!.referenceId };
    }, 'every observed outgoing reference requires exactly one reviewed disposition.']
  ])('rejects %s before any check or write', async (_name, change, message) => {
    const f = await staged();
    change(f.document);
    await save(f.stage, f.document);
    const before = await snapshotTree(f.root);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers.join(' ')).toContain(message);
    expect(candidate.mutations).toEqual([]);
    expect(await snapshotTree(f.root)).toEqual(before);
  });

  it('rejects staged bytes that still reference a moved source even when the declared target is present', async () => {
    const f = await staged();
    const test = mapping(f.document, 'tests/quote.test.mjs');
    const replacement = applicationFixtureSources['tests/quote.test.mjs']!.replace('../legacy/service.mjs', '../backend/src/app.ts');
    await putApplicationFixtureFile(f.stage, test.stagedPathParts, `${replacement}// Moved from legacy/custom.mjs during review.\n`, 0o600);
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers.join(' ')).toContain('tests/quote.test.mjs: staged bytes retain a reference to a removed source.');
    expect(candidate.mutations).toEqual([]);
  });
});

describe('verification helpers bind the exact inspected candidate object, root and bytes', () => {
  it('does not accept an unregistered copy, another root, a blocked candidate or in-memory edits', async () => {
    const f = await staged();
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(candidate.blockers).toEqual([]);
    expect(await applicationInspectedProjectUnchanged(f.root, candidate)).toBe(true);
    const copy = structuredClone(candidate);
    expect(await applicationInspectedProjectUnchanged(f.root, copy)).toBe(false);
    expect(await applicationInspectedProjectUnchanged(f.stage, candidate)).toBe(false);
    const unrecognized = 'blocked, unrecognized, or changed after inspection';
    await expect(assertApplicationCandidateCurrent(f.root, copy)).rejects.toThrow(unrecognized);
    await expect(assertApplicationCandidateCurrent(f.stage, candidate)).rejects.toThrow(unrecognized);

    f.document.inspectionDigest = '0'.repeat(64);
    await save(f.stage, f.document);
    const blocked = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    expect(blocked.blockers.length).toBeGreaterThan(0);
    await expect(assertApplicationCandidateCurrent(f.root, blocked)).rejects.toThrow(unrecognized);

    const edited = await (async () => {
      const f2 = await staged();
      const value = await inspectApplicationPatch(f2.root, f2.manifest, f2.patchPath);
      const digest = applicationCandidateDigest(value);
      value.scope.mappings[0]!.customization = value.scope.mappings[0]!.customization === 'preserved' ? 'reviewed-edit' : 'preserved';
      expect(applicationCandidateDigest(value)).not.toBe(digest);
      return { f2, value };
    })();
    await expect(assertApplicationCandidateCurrent(edited.f2.root, edited.value)).rejects.toThrow(unrecognized);
  });

  it('reports project drift after inspection without treating the old candidate as current', async () => {
    const f = await staged();
    const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath);
    await putApplicationFixtureFile(f.root, ['docs', 'unrelated.txt'], 'concurrent developer edit\n');
    expect(await applicationInspectedProjectUnchanged(f.root, candidate)).toBe(false);
    await expect(assertApplicationCandidateCurrent(f.root, candidate)).rejects.toThrow('changed after review');
  });
});

describe('bounded literal reference inventory', () => {
  const file = (parts: string[], text: string | Buffer) => ({
    pathParts: parts, content: Buffer.isBuffer(text) ? text : Buffer.from(text), mode: 0o644
  });
  const targets = (references: ReturnType<typeof inspectApplicationReferences>) => references.map((item) =>
    `${applicationPathKey(item.sourcePathParts)}:${item.line}:${item.kind}->${applicationPathKey(item.targetPathParts)}:${item.targetKind}`);

  it('resolves TypeScript ESM specifiers, directories and Python module imports to observed files only', () => {
    const references = inspectApplicationReferences([
      file(['src', 'app.ts'], "import { a } from './lib/util.js';\nimport widgets from './components';\nimport missing from './lib/absent.js';\n"),
      file(['src', 'lib', 'util.ts'], 'export const a = 1;\n'),
      file(['src', 'components', 'index.ts'], 'export default 1;\n'),
      file(['api', 'main.py'], 'from api.routes import router\nimport api.models\nimport chosen_at_runtime\n'),
      file(['api', 'routes.py'], 'router = object()\n'),
      file(['api', 'models', '__init__.py'], '')
    ], []);
    expect(targets(references)).toEqual([
      'api/main.py:1:python-import->api/routes.py:file',
      'api/main.py:2:python-import->api/models:directory',
      'src/app.ts:1:relative-literal->src/lib/util.ts:file',
      'src/app.ts:2:relative-literal->src/components:directory'
    ]);
  });

  it('ignores absolute, escaping, variable, drive-qualified, self and binary references', () => {
    const references = inspectApplicationReferences([
      file(['service', 'config.mjs'], [
        "const hostFile = '/etc/hosts';", "const outside = '../../outside/secret.mjs';", "const expanded = '$HOME/tool.mjs';",
        "const drive = 'C:\\\\tools\\\\tool.mjs';", "const parent = 'service/..';", "const self = './config.mjs';"
      ].join('\n')),
      file(['service', 'blob.bin'], Buffer.from([0x00, 0x2e, 0x2f, 0x63, 0x6f, 0x6e, 0x66, 0x69, 0x67, 0x2e, 0x6d, 0x6a, 0x73]))
    ], [{ pathParts: ['service'], exists: true, mode: 0o755, entries: [] }]);
    expect(references).toEqual([]);
  });

  it('recognizes bare directory names only after container and CI working-directory keywords', () => {
    const references = inspectApplicationReferences([
      file(['Dockerfile'], 'FROM node:24\nWORKDIR worker\nRUN echo worker\n'),
      file(['worker', 'job.mjs'], 'export {};\n')
    ], []);
    expect(targets(references)).toEqual(['Dockerfile:2:path-literal->worker:directory']);
  });

  it('fails closed when literal scanning exceeds the token bound instead of reporting partial coverage', () => {
    expect(() => inspectApplicationReferences([file(['notes.md'], 'a.b\n'.repeat(500_001))], []))
      .toThrow('Application reference token bound exceeded; coverage is incomplete.');
  });
});

describe('saved-plan authority cannot cross recipes or widen stored verification', () => {
  it('reports an incomplete read-only layout inventory as blocked rather than inspected', async () => {
    const f = await createCommandFlowFixture(await directories.make('lf bind '));
    const outside = path.join(f.parent, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'CANARY_TARGET.txt'), 'outside the project\n');
    await symlink(outside, path.join(f.root, 'linked-outside'), 'junction');
    const project = await snapshotTree(f.root);
    const runner = new ScriptedRunner();
    const inventory = await repairJson(f.root, ['--inspect-layout'], { home: f.home, runner });
    expect(inventory.code).toBe(2);
    expect(inventory.report).toMatchObject({ status: 'blocked', committed: false, operationKind: 'inspect-layout' });
    expect(inventory.report.message).toBe('Application inventory is incomplete; unresolved scope cannot authorize a patch.');
    expect(inventory.report.blockers.join(' ')).toMatch(/link/iu);
    expect(JSON.stringify(inventory.report)).not.toContain('CANARY_');
    expect(runner.calls).toEqual([]);
    expect(await snapshotTree(f.root)).toEqual(project);
    expect(await userRecordFiles(f.home)).toEqual([]);
  });

  it('refuses application verification for a saved infrastructure plan without running anything', async () => {
    const f = await createCommandFlowFixture(await directories.make('lf bind '));
    const storage = { homedir: f.home, env: {} };
    const infrastructure = buildRepairPreview({
      projectRoot: f.root, snapshots: [], mutations: [], scope: { layout: 'flat-root' }, live: false, now: repairNow
    });
    await createScopedUserLocalRecordStore(f.root, 'repair-preview', storage).write(infrastructure.fingerprint, infrastructure);
    const project = await snapshotTree(f.root);
    const runner = new ScriptedRunner();
    const result = await repairJson(f.root, ['--verify-plan', infrastructure.fingerprint, '--allow-network'], { home: f.home, runner });
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({ status: 'failed', committed: false, verification: 'not-run', requestedScope: 'application-layout' });
    expect(result.report.blockers.join(' ')).toContain('Application verification requires a reviewed application-layout-patch plan, not infrastructure approval.');
    expect(runner.calls).toEqual([]);
    expect(await snapshotTree(f.root)).toEqual(project);
    expect(await userRecordFiles(f.home, 'repair-verification')).toEqual([]);
    expect((await inspectRepairVerificationWorkspaces(f.root, storage)).status).toBe('absent');
  });

  it.each<[string, Parameters<typeof createCommandFlowFixture>[1]]>([
    ['network', { network: true }],
    ['dependency preparation', { preparation: [backendNpmCi()] }]
  ])('refuses a stored success receipt that lacks the declared %s authority', async (authority, options) => {
    const f = await createCommandFlowFixture(await directories.make('lf bind '), options);
    const storage = { homedir: f.home, env: {} };
    const runner = new ScriptedRunner();
    const check = await repairJson(f.root, ['--check', '--application-patch', f.patch], { home: f.home, runner });
    const fingerprint = check.report.fingerprint!;
    await saveRepairVerification(await loadRepairPreview(f.root, fingerprint, repairNow, storage), repairNow, false, storage, false);
    const project = await snapshotTree(f.root);
    const apply = await repairJson(f.root, ['--approve-plan', fingerprint], { home: f.home, runner });
    expect(apply.code).toBe(1);
    expect(apply.report).toMatchObject({ status: 'failed', committed: false });
    expect(apply.report.blockers.join(' ')).toContain(`Stored verification lacks the exact declared ${authority} authority.`);
    expect(apply.report.historyPath).toBeUndefined();
    expect(apply.report.backupPath).toBeUndefined();
    expect(runner.effects()).toEqual([]);
    expect(await snapshotTree(f.root)).toEqual(project);
    expect(await userRecordFiles(f.home, 'repair-backup')).toEqual([]);
    expect(await readdir(path.join(f.root, '.liftoff', 'repair-history'))).toEqual([historicalRepairPathParts[2]]);
    expect(await readFile(path.join(f.root, ...historicalRepairPathParts), 'utf8')).toBe(historicalRepairReceipt);
  });
});
