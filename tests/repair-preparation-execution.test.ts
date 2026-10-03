import { chmod, cp, link, lstat, mkdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectApplicationPatch, verifyApplicationPatch } from '../src/application/repair/application-patch.js';
import { inspectRepairVerificationWorkspaces } from '../src/application/repair/workspaces.js';
import type { ApplicationPatchCandidate } from '../src/application/repair/application-types.js';
import type { ApplicationVerificationOptions } from '../src/application/repair/application-preparation-types.js';
import { applicationVerificationFixtureContext, putApplicationFixtureFile } from './fixtures/repair-application.js';
import { createPreparationFixture, type PreparationFixture } from './fixtures/repair-preparation.js';
import {
  TemporaryDirectories, ScriptedRunner, commandResult, externalToolCopies, isNpmCi, isToolProbe, simulateNpmCi,
  snapshotTree, type RecordedCall, type RunnerScript
} from './fixtures/repair-branches.js';

const directories = new TemporaryDirectories();
afterEach(async () => { await directories.cleanup(); });

interface PreparedState {
  f: PreparationFixture;
  candidate: ApplicationPatchCandidate;
  context: ApplicationVerificationOptions;
  project: Record<string, string>;
  staging: Record<string, string>;
  tools?: Record<string, string>;
}

/** With inheritPath, attributable tool copies take precedence while host-only companions (such as npm) still resolve. */
async function prepared(
  options: Parameters<typeof createPreparationFixture>[1] = {}, tools: readonly string[] = [],
  mutate?: (f: PreparationFixture) => Promise<void>, inheritPath = false
): Promise<PreparedState> {
  const parent = await directories.make('lf prep ex ');
  const copies = tools.length ? await externalToolCopies(parent, tools) : undefined;
  const hostPath = process.env.PATH ?? process.env.Path ?? '';
  const env = copies
    ? { PATH: inheritPath ? [copies.directory, hostPath].filter(Boolean).join(path.delimiter) : copies.directory }
    : undefined;
  const f = await createPreparationFixture(parent, options);
  await mutate?.(f);
  const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, { runner: new ScriptedRunner(), ...(env ? { env } : {}) });
  expect(candidate.blockers).toEqual([]);
  const context = await applicationVerificationFixtureContext(f.root, candidate,
    { projectCode: true, dependencyPreparation: true, network: candidate.networkRequired }, env ? { env } : {});
  return { f, candidate, context, project: await snapshotTree(f.root), staging: await snapshotTree(f.stage), tools: copies?.files };
}

/** Runs verification and proves no write escaped the private copy into the real project or user staging. */
async function verify(state: PreparedState, script: RunnerScript) {
  const runner = new ScriptedRunner(script);
  const result = await verifyApplicationPatch(state.f.root, state.candidate, runner, state.context);
  expect(await snapshotTree(state.f.root)).toEqual(state.project);
  expect(await snapshotTree(state.f.stage)).toEqual(state.staging);
  expect(runner.calls.every((call) => path.relative(state.f.root, call.options!.cwd!).startsWith('..'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('CANARY_');
  return { result, runner, effects: runner.effects() };
}

const isCheck = (call: RecordedCall) => !isToolProbe(call.command) && !isNpmCi(call.command);

describe('frozen npm preparation effects stay inside their registered private roles', () => {
  it('stops after a frozen npm ci failure without running project checks or exposing diagnostics', async () => {
    const state = await prepared();
    const { result, effects } = await verify(state, (call) => isNpmCi(call.command)
      ? commandResult(call.command, { status: 1, stderr: 'npm error code ENOTCACHED CANARY_PACKAGE' }) : undefined);
    expect(result.status).toBe('failed');
    expect(result.commands).toEqual([]);
    expect(result.preparation).toEqual([expect.objectContaining({
      provider: 'npm-ci', status: 'failed', commands: [expect.objectContaining({ status: 1, passed: false })]
    })]);
    const blockers = result.blockers.join(' ');
    expect(blockers).toContain('Locked preparation:');
    expect(blockers).toContain('[private-cache-miss]');
    expect(blockers).toContain('[preparation-failed]');
    expect(result).toMatchObject({ cleanupComplete: true, inspectedProjectUnchanged: true });
    expect(effects.map((call) => isNpmCi(call.command))).toEqual([true]);
  });

  it('does not accept a successful exit that produced no protected dependency root', async () => {
    const state = await prepared();
    const { result, effects } = await verify(state, () => undefined);
    expect(result.status).toBe('failed');
    expect(result.commands).toEqual([]);
    expect(result.preparation[0]).toMatchObject({ status: 'failed', commands: [expect.objectContaining({ passed: true })] });
    expect(result.blockers.join(' ')).toMatch(/\[(?:verification-failed|missing-prepared-dependencies)\]/u);
    expect(result.cleanupComplete).toBe(true);
    expect(effects).toHaveLength(1);
  });

  it.each([
    ['an undeclared candidate file', async (call: RecordedCall) => {
      await putApplicationFixtureFile(call.options!.cwd!, ['preparation-report.txt'], 'CANARY_OUTPUT\n', 0o600);
    }, 'undeclared-private-output'],
    ['a rewritten private tool configuration', async (call: RecordedCall) => {
      await writeFile(call.options!.env!.npm_config_userconfig!, 'registry=https://CANARY_REGISTRY.invalid/\n');
    }, 'changed-private-configuration'],
    ['a multiply linked dependency file', async (call: RecordedCall) => {
      const directory = path.join(call.options!.cwd!, 'node_modules', 'registry-package');
      await link(path.join(directory, 'index.js'), path.join(directory, 'alias.js'));
    }, 'unsafe-prepared-output']
  ])('rejects %s before any project check', async (_name, effect, code) => {
    const state = await prepared();
    const { result, effects } = await verify(state, async (call) => {
      if (!isNpmCi(call.command)) return undefined;
      const outcome = await simulateNpmCi(call);
      await effect(call);
      return outcome;
    });
    expect(result.status).toBe('failed');
    expect(result.blockers.join(' ')).toContain(`[${code}]`);
    expect(result.commands).toEqual([]);
    expect(result.preparation[0]?.status).toBe('failed');
    expect(result.cleanupComplete).toBe(true);
    expect(effects.filter(isCheck)).toEqual([]);
  });

  it('retains, rather than follows or deletes, a dependency junction into host scope', async () => {
    const state = await prepared();
    let junction = '';
    const { result } = await verify(state, async (call) => {
      if (!isNpmCi(call.command)) return undefined;
      const outcome = await simulateNpmCi(call);
      junction = path.join(call.options!.cwd!, 'node_modules', 'host-link');
      await symlink(state.f.root, junction, 'junction');
      return outcome;
    });
    expect(result.status).toBe('failed');
    expect(result.blockers.join(' ')).toContain('[unsafe-prepared-link]');
    expect(result.commands).toEqual([]);
    expect(result.cleanupComplete).toBe(false);
    expect(result.retainedWorkspace).toBeDefined();
    expect(result.blockers.join(' ')).toContain('[workspace-unsafe-path]');
    expect((await lstat(junction)).isSymbolicLink()).toBe(true);
    const retained = await inspectRepairVerificationWorkspaces(state.f.root, state.context.storage);
    expect(retained.workspaces).toEqual([expect.objectContaining({
      directory: result.retainedWorkspace, phase: 'cleanup-failed', owner: 'released', cleanupComplete: false
    })]);
  });

  it('permits a leaf link to the approved installed interpreter and unlinks only the link', async ({ skip }) => {
    const state = await prepared({}, ['node'], undefined, true);
    const node = state.candidate.verificationPolicy.toolchain.find((tool) => tool.id === 'node')!.executablePath;
    expect(node).toBe(await realpath(state.tools!.node!));
    const before = await stat(node);
    const probe = path.join(state.f.directory, 'symlink capability probe');
    try { await symlink(node, probe, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('Unrun: this Windows host cannot create file symbolic links (Developer Mode or SeCreateSymbolicLinkPrivilege is required), so the approved-interpreter link case was not exercised.');
      }
      throw error;
    }
    await unlink(probe);
    let linked = false;
    const { result } = await verify(state, async (call) => {
      if (!isNpmCi(call.command)) return undefined;
      const outcome = await simulateNpmCi(call);
      const bin = path.join(call.options!.cwd!, 'node_modules', '.bin');
      await mkdir(bin, { recursive: true, mode: 0o700 });
      await symlink(node, path.join(bin, 'node'), 'file');
      linked = (await lstat(path.join(bin, 'node'))).isSymbolicLink();
      return outcome;
    });
    expect(linked).toBe(true);
    expect(result.status, result.blockers.join('; ')).toBe('passed');
    expect(result.preparation[0]?.status).toBe('passed');
    expect(result.cleanupComplete).toBe(true);
    expect((await inspectRepairVerificationWorkspaces(state.f.root, state.context.storage)).status).toBe('absent');
    const after = await stat(node);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
  });

  it('rejects a passing check that rewrites frozen dependencies and stops later checks', async () => {
    const state = await prepared();
    const { result, effects } = await verify(state, async (call) => {
      if (isNpmCi(call.command)) return simulateNpmCi(call);
      if (!isCheck(call)) return undefined;
      await putApplicationFixtureFile(call.options!.cwd!, ['node_modules', 'registry-package', 'index.js'],
        'module.exports = "CANARY_REWRITTEN";\n', 0o600);
      return commandResult(call.command);
    });
    expect(result.status).toBe('failed');
    expect(result.commands).toEqual([expect.objectContaining({ index: 0, passed: true })]);
    expect(result.blockers.join(' ')).toContain('[changed-prepared-dependencies]');
    expect(result.preparation[0]?.status).toBe('passed');
    expect(effects.filter(isCheck)).toHaveLength(1);
    expect(result.cleanupComplete).toBe(true);
  });

  it.each([
    ['declared build and test-cache outputs', [['dist', 'server.js'], ['node_modules', '.vite', 'results.json']], null],
    ['an undeclared coverage directory', [['coverage', 'lcov.info']], 'undeclared-private-output']
  ] as const)('evaluates checks writing %s', async (_name, outputs, code) => {
    const state = await prepared();
    const { result } = await verify(state, async (call) => {
      if (isNpmCi(call.command)) return simulateNpmCi(call);
      if (!isCheck(call)) return undefined;
      for (const parts of outputs) await putApplicationFixtureFile(call.options!.cwd!, parts, 'private output\n', 0o600);
      return commandResult(call.command);
    });
    if (code) {
      expect(result.status).toBe('failed');
      expect(result.blockers.join(' ')).toContain(`[${code}]`);
    } else {
      expect(result.status, result.blockers.join('; ')).toBe('passed');
      expect(result.commands.map((command) => command.passed)).toEqual([true, true]);
    }
    expect(result.cleanupComplete).toBe(true);
  });
});

describe('preparation environments and bounds bind the displayed plan', () => {
  it('uses the registered Microsoft feed offline with its remote-proxy opt-in only during preparation', async () => {
    const state = await prepared({ npmSource: 'microsoft-npm', network: false });
    const { result, effects } = await verify(state, (call) => isNpmCi(call.command) ? simulateNpmCi(call) : undefined);
    expect(result.status, result.blockers.join('; ')).toBe('passed');
    const [prepare, ...checks] = effects;
    expect(prepare!.command.args).toEqual(expect.arrayContaining(['--allow-remote=all', '--offline']));
    expect(prepare!.options!.env).toMatchObject({
      npm_config_registry: 'https://packagefeedproxy.microsoft.io/npm/', npm_config_allow_remote: 'all',
      npm_config_offline: 'true', npm_config_ignore_scripts: 'true', LIFTOFF_APPLICATION_NETWORK: 'not-authorized'
    });
    for (const check of checks) expect(check.options!.env).toMatchObject({ npm_config_offline: 'true' });
  });

  it.skipIf(process.platform === 'win32')('stops at the prepared dependency depth bound (Windows unrun)', async () => {
    const state = await prepared();
    const { result } = await verify(state, async (call) => {
      if (!isNpmCi(call.command)) return undefined;
      const outcome = await simulateNpmCi(call);
      await mkdir(path.join(call.options!.cwd!, 'node_modules', ...Array<string>(41).fill('d')), { recursive: true, mode: 0o700 });
      return outcome;
    });
    expect(result.status).toBe('failed');
    expect(result.blockers.join(' ')).toContain('[private-output-bound] Prepared dependency depth exceeds its bound.');
    expect(result.commands).toEqual([]);
    expect(result.cleanupComplete).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rejects a check that changes an inspected candidate directory mode (Windows unrun)', async () => {
    const state = await prepared();
    const { result } = await verify(state, async (call) => {
      if (isNpmCi(call.command)) return simulateNpmCi(call);
      if (!isCheck(call)) return undefined;
      await chmod(path.join(call.options!.cwd!, 'src'), 0o700);
      return commandResult(call.command);
    });
    expect(result.status).toBe('failed');
    expect(result.blockers.join(' ')).toContain('[changed-candidate-directory]');
    expect(result.commands).toEqual([expect.objectContaining({ passed: true })]);
    expect(result.cleanupComplete).toBe(true);
  });

  it('refuses to reuse one saved preview for a different staged candidate', async () => {
    const state = await prepared();
    const copy = path.join(state.f.directory, 'stage copy');
    await cp(state.f.stage, copy, { recursive: true });
    const other = await inspectApplicationPatch(state.f.root, state.f.manifest, path.join(copy, 'patch.json'), { runner: new ScriptedRunner() });
    expect(other.blockers).toEqual([]);
    const runner = new ScriptedRunner();
    const result = await verifyApplicationPatch(state.f.root, other, runner, state.context);
    expect(result.status).toBe('blocked');
    expect(result.blockers.join(' ')).toContain('[stale-preview] The real saved preview does not match this application candidate');
    expect(result.workspaceId).toBeUndefined();
    expect(runner.calls).toEqual([]);
  });
});

describe('locked uv preparation uses only an approved isolated interpreter', () => {
  const interpreter = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const venv = (config: string, withInterpreter = true): RunnerScript => async (call) => {
    if (!call.command.args.includes('venv')) return undefined;
    const environment = call.command.args.at(-1)!;
    await mkdir(path.join(environment, interpreter[0]!), { recursive: true, mode: 0o700 });
    await writeFile(path.join(environment, 'pyvenv.cfg'), config, { mode: 0o600 });
    if (withInterpreter) await writeFile(path.join(environment, ...interpreter), 'private interpreter copy\n', { mode: 0o700 });
    return commandResult(call.command);
  };
  const config = (lines: string) => `home = private\n${lines}\n`;

  it.each([
    ['python', true], ['python3', false]
  ] as const)('syncs against the approved interpreter and runs %s checks through the private environment (network %s)', async (executable, network) => {
    const state = await prepared({ stack: 'python-fastapi', network }, ['python3', 'uv'], async (f) => {
      f.document.verification.commands[0]!.executable = executable;
      await putApplicationFixtureFile(f.stage, ['patch.json'], `${JSON.stringify(f.document, null, 2)}\n`, 0o600);
    });
    const python = state.candidate.verificationPolicy.toolchain.find((tool) => tool.id === 'python')!;
    expect(python.executablePath).toBe(await realpath(state.tools!.python3!));
    const { result, effects } = await verify(state, venv(config('include-system-site-packages = false\nversion = 3.14.7')));
    expect(result.status, result.blockers.join('; ')).toBe('passed');
    expect(result.preparation).toEqual([expect.objectContaining({
      provider: 'uv-locked-sync', status: 'passed', commands: [expect.objectContaining({ passed: true }), expect.objectContaining({ passed: true })]
    })]);
    const [create, sync, check] = effects;
    expect(create!.command.executable).toBe(python.executablePath);
    expect(sync!.command.args).toEqual(expect.arrayContaining(['sync', '--locked', '--no-build', '--python', python.executablePath]));
    expect(sync!.command.args).not.toContain('$APPROVED_PYTHON');
    expect(sync!.options!.env).toMatchObject({
      UV_PROJECT_ENVIRONMENT: path.join(sync!.options!.cwd!, '.venv'), UV_OFFLINE: network ? '0' : '1', PIP_NO_INDEX: network ? '0' : '1',
      UV_DEFAULT_INDEX: 'https://pypi.org/simple', UV_PYTHON_DOWNLOADS: 'never',
      LIFTOFF_APPLICATION_NETWORK: network ? 'declared-allowed' : 'not-authorized'
    });
    if (network) expect(sync!.command.args).not.toContain('--offline');
    else expect(sync!.command.args).toContain('--offline');
    expect(check!.command.executable).toBe(path.join(sync!.options!.cwd!, '.venv', ...interpreter));
    expect(check!.options!.env).toMatchObject({ UV_OFFLINE: '1', PIP_NO_INDEX: '1', PYTHONNOUSERSITE: '1' });
    expect(result.cleanupComplete).toBe(true);
  });

  it.each([
    ['inherits system site packages', config('include-system-site-packages = true\nversion = 3.14.7')],
    ['belongs to another interpreter version', config('include-system-site-packages = false\nversion = 3.13.1')]
  ])('rejects a prepared environment that %s before any check', async (_name, contents) => {
    const state = await prepared({ stack: 'python-fastapi' }, ['python3', 'uv']);
    const { result, effects } = await verify(state, venv(contents));
    expect(result.status).toBe('failed');
    expect(result.blockers.join(' ')).toContain('[incompatible-private-environment]');
    expect(result.preparation[0]).toMatchObject({ status: 'failed' });
    expect(result.preparation[0]!.commands).toHaveLength(2);
    expect(result.commands).toEqual([]);
    expect(effects).toHaveLength(2);
    expect(result.cleanupComplete).toBe(true);
  });

  it('does not fall back to a host interpreter when the private interpreter is absent', async () => {
    const state = await prepared({ stack: 'python-fastapi' }, ['python3', 'uv']);
    const { result, effects } = await verify(state, venv(config('include-system-site-packages = false\nversion = 3.14.7'), false));
    expect(result.status).toBe('failed');
    expect(result.preparation[0]?.status).toBe('passed');
    expect(result.commands).toEqual([]);
    expect(effects).toHaveLength(2);
    expect(result.cleanupComplete).toBe(true);
  });
});

describe('Go module preparation uses the local toolchain and private caches', () => {
  const download: RunnerScript = async (call) => {
    if (!call.command.args.includes('download')) return undefined;
    const cache = call.options!.env!.GOMODCACHE!;
    await mkdir(path.join(cache, 'cache', 'download'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(cache, 'cache', 'download', 'list'), 'private module cache\n', { mode: 0o600 });
    return commandResult(call.command);
  };

  it.each([true, false])('keeps declared network %s to preparation and checks with proxies disabled', async (network) => {
    const state = await prepared({ stack: 'go-huma', network }, ['go']);
    const { result, effects } = await verify(state, download);
    expect(result.status, result.blockers.join('; ')).toBe('passed');
    const [prepare, check] = effects;
    expect(prepare!.command.args).toEqual(['mod', 'download', '-json']);
    expect(prepare!.options!.env).toMatchObject({
      GOPROXY: network ? 'https://proxy.golang.org' : 'off', GOSUMDB: network ? 'sum.golang.org' : 'off',
      GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly -buildvcs=false', GOWORK: 'off',
      LIFTOFF_APPLICATION_NETWORK: network ? 'declared-allowed' : 'not-authorized'
    });
    expect(path.relative(state.f.root, prepare!.options!.env!.GOMODCACHE!).startsWith('..')).toBe(true);
    expect(check!.command.args).toEqual(['test', './...']);
    expect(check!.options!.env).toMatchObject({ GOPROXY: 'off', GOSUMDB: 'off', GOMODCACHE: prepare!.options!.env!.GOMODCACHE });
    expect(result.cleanupComplete).toBe(true);
  });

  it('fails closed when module preparation leaves no private module cache', async () => {
    const state = await prepared({ stack: 'go-huma' }, ['go']);
    const { result, effects } = await verify(state, () => undefined);
    expect(result.status).toBe('failed');
    expect(result.preparation[0]?.status).toBe('failed');
    expect(result.commands).toEqual([]);
    expect(effects).toHaveLength(1);
    expect(result.cleanupComplete).toBe(true);
  });
});
