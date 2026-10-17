import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildNativeProgram, readNativeProgramAssembly, type OriginalNativeProgramAssembly
} from '../distribution/native/native-program-assembly.mjs';
import {
  assertCurrentSource5WorkflowProgramContent, constructSource5WorkflowProgramContent, readSource5WorkflowProgramContent
} from '../src/governance-activation/workflow-source5-program-content.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { declareSource5WorkflowProgramSources } from '../src/governance-activation/workflow-source5-declaration.js';
import { createWorkflowRequiredSourceFixture } from './fixtures/workflow-required-source.js';

const roots: string[] = [], fixtures: Awaited<ReturnType<typeof createWorkflowRequiredSourceFixture>>[] = [];
afterAll(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-original-program-')));
  roots.push(root); return root;
}
async function fixture(root: string, workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
  profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
  const value = await createWorkflowRequiredSourceFixture(root, workflow, profile);
  fixtures.push(value); return value;
}

describe('private original-program input boundary without manufactured assembly facts', () => {
  let value: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { value = await fixture(await directory()); });
  const assembly = Object.freeze({ kind: 'liftoff-original-native-program-assembly' });
  const input = () => ({ context: value.context, runtime: value.runtime, assembly });

  it.each(['path', 'installedRoot', 'archive', 'manifest', 'receipt', 'reader', 'callback', 'authenticated', 'observedAt'])(
    'rejects caller-selected %s before original assembly observation', async field => {
      await expect(constructSource5WorkflowProgramContent({ ...input(), [field]: true }))
        .rejects.toMatchObject({ code: 'workflow-program-request' });
      expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
    });

  it.each(['ordinary', 'copy', 'json', 'proxy', 'accessor'])('refuses %s counterfeit original assembly without invoking hooks', async kind => {
    const hook = vi.fn();
    const candidate = kind === 'copy' ? { ...assembly } : kind === 'json' ? JSON.parse(JSON.stringify(assembly))
      : kind === 'proxy' ? new Proxy(assembly, { get: hook })
        : kind === 'accessor' ? Object.defineProperty({}, 'kind', { enumerable: true, get: hook }) : assembly;
    await expect(constructSource5WorkflowProgramContent({ ...input(), assembly: candidate }))
      .rejects.toThrow(/original invocations/);
    expect(hook).not.toHaveBeenCalled();
    expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
  });

  it.each(['context-copy', 'runtime-copy', 'proxy', 'accessor', 'extra-symbol', 'hidden-field'])(
    'refuses %s request reconstruction without invoking hooks', async kind => {
      const hook = vi.fn(), original = input();
      const candidate = kind === 'context-copy' ? { ...original, context: { ...original.context } }
        : kind === 'runtime-copy' ? { ...original, runtime: { ...original.runtime } }
          : kind === 'proxy' ? new Proxy(original, { get: hook, ownKeys: hook })
            : kind === 'accessor' ? Object.defineProperty({ ...original }, 'assembly', { enumerable: true, get: hook })
              : kind === 'extra-symbol' ? { ...original, [Symbol('extra')]: true }
                : Object.defineProperty({ ...original }, 'assembly', { enumerable: false, value: assembly });
      await expect(constructSource5WorkflowProgramContent(candidate)).rejects.toThrow();
      expect(hook).not.toHaveBeenCalled();
      expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
    });

  it('refuses a fabricated content token and proxy without reading their properties or returning archive bytes', async () => {
    const hook = vi.fn(), fake = Object.freeze({ kind: 'source5-original-program-content' as const,
      contentDigest: 'a'.repeat(64), assemblyDigest: 'c'.repeat(64) });
    for (const content of [fake, new Proxy(fake, { get: hook })]) {
      const request = { context: value.context, runtime: value.runtime, content };
      await expect(assertCurrentSource5WorkflowProgramContent(request)).rejects.toMatchObject({ code: 'workflow-program-observation' });
      await expect(readSource5WorkflowProgramContent(request)).rejects.toMatchObject({ code: 'workflow-program-observation' });
    }
    expect(hook).not.toHaveBeenCalled();
    expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
  });
});

describe('genuine original current5 program construction and consumption', () => {
  const enabled = Boolean(process.env.LIFTOFF_NATIVE_PROGRAM_RUNTIME_ARCHIVE);
  let root: string, assembly: OriginalNativeProgramAssembly;
  let original: Awaited<ReturnType<typeof readNativeProgramAssembly>>;
  let active: { value: Awaited<ReturnType<typeof fixture>>; result: Awaited<ReturnType<typeof constructSource5WorkflowProgramContent>> } | undefined;
  function current() {
    if (!active) throw new Error('The actual original build and current5 content preparation did not complete.');
    return { context: active.value.context, runtime: active.value.runtime, content: active.result.content };
  }

  it.runIf(enabled)('builds, packs and installs the actual versioned program before issuing any Source content token', async () => {
    const sourceArchive = process.env.LIFTOFF_NATIVE_PROGRAM_RUNTIME_ARCHIVE;
    if (!sourceArchive) throw new Error('Genuine program qualification requires the real pinned runtime archive.');
    const windowsLauncher = process.env.LIFTOFF_NATIVE_PROGRAM_WINDOWS_LAUNCHER;
    if (process.platform === 'win32' && !windowsLauncher) throw new Error('Genuine Windows assembly requires its actual native launcher.');
    root = await directory();
    const runtimeArchive = path.join(root, 'original-runtime-archive');
    await copyFile(sourceArchive, runtimeArchive);
    assembly = await buildNativeProgram({ output: path.join(root, 'original-program'), runtimeArchive,
      ...(process.platform === 'win32' && windowsLauncher ? { windowsLauncher } : {}) });
    original = await readNativeProgramAssembly(assembly);
    expect(original.manifest.package).toMatchObject({ name: '@msn-control/liftoff', version: '0.13.0-dev.0' });
    expect(createHash('sha256').update(original.packageArchive.content).digest('hex')).toBe(original.packageArchive.sha256);
  }, 300_000);

  it.runIf(enabled).each([
    ['manual', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'single-maintainer-gitflow'], ['openspec', 'team-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('binds actual original archive and complete installed content for %s/%s without issuing release authority', async (workflow, profile) => {
    if (!assembly) throw new Error('The actual original assembly preparation did not complete.');
    const value = await fixture(root, workflow, profile);
    const result = await constructSource5WorkflowProgramContent({ context: value.context, runtime: value.runtime, assembly });
    active = { value, result };
    expect(result).toMatchObject({ status: 'observed', package: { name: '@msn-control/liftoff', version: '0.13.0-dev.0' },
      archive: { bytes: original.packageArchive.bytes, sha256: original.packageArchive.sha256 },
      scope: 'original-current5-candidate-content', publication: 'not-observed',
      sourceFamily: 'compiled-current5-family-matched', inventoryScope: 'complete-original-bundle',
      dependencyClosure: 'original-packed-and-installed-readset', effects: [],
      releaseAuthority: 'not-issued', nativeQualification: 'not-issued', workflowAuthority: 'not-issued',
      requiredContextSemantics: 'not-validated', prerequisiteSession: null, phaseProof: 'not-issued' });
    expect(result.files).toBeGreaterThan(original.manifest.package.sourceFiles.length);
    const { content, ...archive } = original.packageArchive;
    expect(content.length).toBe(archive.bytes);
    expect(result.content.assemblyDigest).toBe(canonicalSha256({
      manifest: original.manifest, sourceInputs: original.sourceInputs, archive,
      installedApplicationRoot: original.installedApplicationRoot, installedCliEntrypoint: original.installedCliEntrypoint
    }));
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.content)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(original.installedApplicationRoot);
    await expect(assertCurrentSource5WorkflowProgramContent(current())).resolves.toBeUndefined();
    const declared = await declareSource5WorkflowProgramSources(current());
    expect(declared).toMatchObject({
      status: 'blocked', publicationSources: [], effects: [], qualifiedExecutableRecipe: null,
      prerequisiteSession: null, execution: 'not-authorized', workloadExecution: false
    });
    expect(declared.declaration.requiredProgram.authenticatedSubject).toMatchObject({
      kind: 'original-current5-program', scope: 'original-current5-candidate-content',
      contentDigest: result.content.contentDigest, assemblyDigest: result.content.assemblyDigest,
      archive: result.archive, originalAssembly: result.originalAssembly, delivery: 'not-observed',
      releaseAuthority: 'not-issued', nativeQualification: 'not-issued', workflowAuthority: 'not-issued'
    });
    expect(declared.blockers).toHaveLength(70);
    expect(declared.blockers.some(blocker => blocker.subject === 'current5-program')).toBe(false);
    expect(declared.declaration.recipes.every(recipe => recipe.completeJob === null && recipe.integrationId === null)).toBe(true);
    expect(declared.declarationDigest).toBe(canonicalSha256(declared.declaration));
    expect(JSON.stringify(declared)).not.toContain(original.installedApplicationRoot);
    expect(value.calls).toEqual([]); expect(value.processCalls()).toBe(0);
  });

  it.runIf(enabled)('rejects copied tokens, foreign original contexts/runtimes and getter-bearing substitutes', async () => {
    const request = current(), hook = vi.fn();
    for (const content of [{ ...request.content }, JSON.parse(JSON.stringify(request.content)),
      new Proxy(request.content, { get: hook })]) {
      await expect(readSource5WorkflowProgramContent({ ...request, content })).rejects.toMatchObject({ code: 'workflow-program-observation' });
    }
    const foreign = await fixture(root);
    await expect(readSource5WorkflowProgramContent({ ...request, context: foreign.context }))
      .rejects.toMatchObject({ code: 'workflow-program-observation' });
    await expect(readSource5WorkflowProgramContent({ ...request, runtime: foreign.runtime }))
      .rejects.toMatchObject({ code: 'workflow-program-observation' });
    expect(hook).not.toHaveBeenCalled();
  });

  it.runIf(enabled)('freshly consumes original runtime, validator and independent archive bytes without trusting the readback as a token', async () => {
    const request = current(), result = await readSource5WorkflowProgramContent(request);
    expect(result.installedApplicationRoot).toBe(original.installedApplicationRoot);
    expect(result.installedCliEntrypoint).toBe(original.installedCliEntrypoint);
    expect(result.installedValidatorEntrypoint).toBe(path.join(original.installedApplicationRoot, 'dist/workflow-context-validator.js'));
    expect(result.installedRuntimeEntrypoint).toBe(path.join(path.dirname(original.installedApplicationRoot),
      process.platform === 'win32' ? 'runtime/node.exe' : 'runtime/node'));
    expect(createHash('sha256').update(result.packageArchive.content).digest('hex')).toBe(original.packageArchive.sha256);
    result.packageArchive.content.fill(0);
    const next = await readSource5WorkflowProgramContent(request);
    expect(createHash('sha256').update(next.packageArchive.content).digest('hex')).toBe(original.packageArchive.sha256);
    await expect(readSource5WorkflowProgramContent({ ...request, content: { ...request.content } }))
      .rejects.toMatchObject({ code: 'workflow-program-observation' });
    expect(active!.value.calls).toEqual([]); expect(active!.value.processCalls()).toBe(0);
  });

  it.runIf(enabled)('captures original request references before caller substitution and refuses same-byte physical output replacement', async () => {
    const request = current(), originalContent = request.content, hook = vi.fn();
    const pending = readSource5WorkflowProgramContent(request);
    request.content = new Proxy(originalContent, { get: hook });
    expect((await pending).contentDigest).toBe(originalContent.contentDigest);
    expect(hook).not.toHaveBeenCalled();
    const file = original.installedCliEntrypoint, bytes = await readFile(file), mode = (await lstat(file)).mode & 0o777;
    await rename(file, path.join(root, 'retained-original-cli.js'));
    await writeFile(file, bytes, { flag: 'wx', mode });
    await expect(assertCurrentSource5WorkflowProgramContent({ ...request, content: originalContent }))
      .rejects.toThrow(/Original installed assembly readset changed/);
    await expect(declareSource5WorkflowProgramSources({ ...request, content: originalContent }))
      .rejects.toThrow(/Original installed assembly readset changed/);
  });
});
