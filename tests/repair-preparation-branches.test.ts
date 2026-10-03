import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectApplicationLayout, inspectApplicationPatch } from '../src/application/repair/application-patch.js';
import { parseApplicationPreparation } from '../src/application/repair/application-preparation-inputs.js';
import { applicationPreparationFailure } from '../src/application/repair/application-preparation-diagnostics.js';
import type { ApplicationResolvedPreparation } from '../src/application/repair/application-preparation-types.js';
import type { ApplicationPatchCandidate, ApplicationVerificationCommand } from '../src/application/repair/application-types.js';
import type { CommandResult } from '../src/process-runner.js';
import { putApplicationFixtureFile } from './fixtures/repair-application.js';
import { createPreparationFixture, type PreparationFixture } from './fixtures/repair-preparation.js';
import {
  TemporaryDirectories, ScriptedRunner, externalToolCopies, isToolProbe, snapshotTree
} from './fixtures/repair-branches.js';

type Json = Record<string, any>;
const directories = new TemporaryDirectories();
afterEach(async () => { await directories.cleanup(); });

async function fixture(options: Parameters<typeof createPreparationFixture>[1] = {}): Promise<PreparationFixture> {
  return createPreparationFixture(await directories.make('lf prep br '), options);
}

const key = (parts: readonly string[]) => parts.join('/');

/** Rebinds the reviewed patch to the edited inventory; reference dispositions follow the fixture's reviewed moves. */
async function refresh(f: PreparationFixture): Promise<void> {
  const inspected = await inspectApplicationLayout(f.root, f.manifest);
  if (inspected.report.blockers.length) throw new Error(inspected.report.blockers.join('; '));
  f.document.inspectionDigest = inspected.report.inspectionDigest;
  f.document.targetLayoutDigest = inspected.report.target!.digest;
  const moves = new Map(f.document.mappings.map((mapping) => [key(mapping.sourcePathParts), mapping.targetPathParts]));
  for (const mapping of f.document.mappings) {
    mapping.references = inspected.report.references
      .filter((reference) => key(reference.sourcePathParts) === key(mapping.sourcePathParts))
      .map((reference) => {
        const afterTargetPathParts = moves.get(key(reference.targetPathParts)) ?? reference.targetPathParts;
        return {
          referenceId: reference.id, afterTargetPathParts,
          disposition: key(afterTargetPathParts) === key(reference.targetPathParts) ? 'unchanged-reviewed' as const : 'updated' as const
        };
      });
  }
  await putApplicationFixtureFile(f.stage, ['patch.json'], `${JSON.stringify(f.document, null, 2)}\n`, 0o600);
}

async function editJson(f: PreparationFixture, parts: string[], change: (value: Json) => void): Promise<void> {
  const value = JSON.parse(await readFile(path.join(f.root, ...parts), 'utf8')) as Json;
  change(value);
  await putApplicationFixtureFile(f.root, parts, `${JSON.stringify(value, null, 2)}\n`);
}

async function editToml(f: PreparationFixture, parts: string[], change: (value: Json) => void): Promise<void> {
  const value = parseToml(await readFile(path.join(f.root, ...parts), 'utf8')) as Json;
  change(value);
  await putApplicationFixtureFile(f.root, parts, stringifyToml(value));
}

async function editText(f: PreparationFixture, parts: string[], change: (value: string) => string): Promise<void> {
  await putApplicationFixtureFile(f.root, parts, change(await readFile(path.join(f.root, ...parts), 'utf8')));
}

/** Inspection must stay read-only and remove its attributable probe root, whatever blocks it. */
async function inspect(
  f: PreparationFixture, options: { runner?: ScriptedRunner; env?: NodeJS.ProcessEnv } = {}
): Promise<{ candidate: ApplicationPatchCandidate; runner: ScriptedRunner }> {
  const runner = options.runner ?? new ScriptedRunner();
  const before = await snapshotTree(f.root), stage = await snapshotTree(f.stage);
  const candidate = await inspectApplicationPatch(f.root, f.manifest, f.patchPath, {
    runner, ...(options.env ? { env: options.env } : {})
  });
  expect(await snapshotTree(f.root)).toEqual(before);
  expect(await snapshotTree(f.stage)).toEqual(stage);
  expect((await readdir(f.directory)).filter((name) => name.startsWith('.liftoff-preparation-probe-'))).toEqual([]);
  expect(runner.effects()).toEqual([]);
  return { candidate, runner };
}

async function expectBlocked(
  f: PreparationFixture, code: string, options: { env?: NodeJS.ProcessEnv; probes?: boolean } = {}
): Promise<ApplicationPatchCandidate> {
  const { candidate, runner } = await inspect(f, options);
  expect(candidate.blockers.join(' ')).toContain(`[${code}]`);
  expect(candidate.mutations).toEqual([]);
  expect(candidate.report.status).toBe('blocked');
  expect(JSON.stringify(candidate.report)).not.toContain('CANARY_');
  if (!options.probes) expect(runner.calls).toEqual([]);
  else expect(runner.calls.every((call) => isToolProbe(call.command))).toBe(true);
  return candidate;
}

const noTools = { PATH: '', Path: '' };

describe('preparation descriptors are exact registered contracts', () => {
  it.each([
    ['a non-array descriptor', { provider: 'npm-ci' }, 'preparation-schema'],
    ['more providers than the bound', Array.from({ length: 5 }, () => ({
      provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'npmjs', network: false, lifecycle: 'disabled'
    })), 'preparation-schema'],
    ['a non-boolean network declaration', [{
      provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'npmjs', network: 'yes', lifecycle: 'disabled'
    }], 'preparation-schema'],
    ['install hooks', [{
      provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'npmjs', network: false, lifecycle: 'enabled'
    }], 'unsupported-lifecycle'],
    ['an authenticated private feed', [{
      provider: 'npm-ci', version: 1, cwdPathParts: ['backend'], packageSource: 'https://CANARY_TOKEN@feed.invalid/', network: false, lifecycle: 'disabled'
    }], 'unsupported-package-source']
  ])('rejects %s', (_name, value, code) => {
    expect(() => parseApplicationPreparation(value)).toThrow(`[${code}]`);
  });

  it.each([
    ['two providers for one component', (f: PreparationFixture) => {
      f.document.verification.preparation!.push({ ...f.document.verification.preparation![0]! });
    }, 'preparation-schema'],
    ['a provider for an unselected component identity', (f: PreparationFixture) => {
      f.document.verification.preparation = [{
        provider: 'uv-locked-sync', version: 1, cwdPathParts: ['backend'], packageSource: 'pypi', network: false, lifecycle: 'disabled'
      }];
    }, 'unselected-preparation-component'],
    ['a package source registered for another provider', (f: PreparationFixture) => {
      f.document.verification.preparation![0]!.packageSource = 'pypi';
    }, 'unselected-preparation-component'],
    ['a component directory without a selected manifest', (f: PreparationFixture) => {
      f.document.verification.preparation![0]!.cwdPathParts = ['legacy'];
    }, 'unselected-preparation-component']
  ])('binds preparation to one selected component: rejects %s before probing', async (_name, change, code) => {
    const f = await fixture();
    change(f);
    await refresh(f);
    await expectBlocked(f, code);
  });
});

describe('frozen npm ci inputs', () => {
  const dependency = 'node_modules/fastify';
  it.each([
    ['a non-v3 lock', (lock: Json) => { lock.lockfileVersion = 2; }, 'missing-lock'],
    ['a lock root for another package', (lock: Json) => { lock.packages[''].name = 'another-package'; }, 'mismatched-lock'],
    ['a non-registry lock location', (lock: Json) => { lock.packages['vendor/local-package'] = { version: '1.0.0' }; }, 'unsupported-package-source'],
    ['an inexact locked version', (lock: Json) => { lock.packages[dependency].version = '^5.0.0'; }, 'unsupported-package-source'],
    ['a registry artifact without integrity', (lock: Json) => { delete lock.packages[dependency].integrity; }, 'missing-lock'],
    ['an unlisted bundled child', (lock: Json) => {
      lock.packages[`${dependency}/node_modules/unlisted-child`] = { version: '1.0.0', inBundle: true };
    }, 'missing-lock'],
    ['an escaping binary link', (lock: Json) => { lock.packages[dependency].bin = { tool: '../../CANARY_OUTSIDE.js' }; }, 'unsupported-package-source'],
    ['an absolute binary link', (lock: Json) => { lock.packages[dependency].bin = '/usr/local/bin/tool'; }, 'unsupported-package-source'],
    ['a malformed binary link', (lock: Json) => { lock.packages[dependency].bin = 7; }, 'unsupported-package-source'],
    ['a plain-HTTP artifact', (lock: Json) => { lock.packages[dependency].resolved = 'http://registry.npmjs.org/fastify/-/fastify.tgz'; }, 'unsupported-package-source'],
    ['a foreign artifact origin', (lock: Json) => { lock.packages[dependency].resolved = 'https://registry.example.invalid/fastify.tgz'; }, 'unsupported-package-source'],
    ['an encoded path separator', (lock: Json) => { lock.packages[dependency].resolved = 'https://registry.npmjs.org/fastify%2f..%2fCANARY_.tgz'; }, 'unsupported-package-source'],
    ['a whole encoded dot-segment', (lock: Json) => { lock.packages[dependency].resolved = 'https://registry.npmjs.org/fastify/%2e%2e/CANARY_.tgz'; }, 'unsupported-package-source'],
    ['a mixed-case encoded dot-segment', (lock: Json) => { lock.packages[dependency].resolved = 'https://registry.npmjs.org/fastify/.%2E/CANARY_.tgz'; }, 'unsupported-package-source'],
    ['an unparseable artifact URL', (lock: Json) => { lock.packages[dependency].resolved = 'https://'; }, 'unsupported-package-source'],
    ['a non-string artifact URL', (lock: Json) => { lock.packages[dependency].resolved = 42; }, 'unsupported-package-source'],
    ['an overlong artifact URL', (lock: Json) => {
      lock.packages[dependency].resolved = `https://registry.npmjs.org/${'a'.repeat(2100)}.tgz`;
    }, 'unsupported-package-source'],
    ['a lock beyond the package bound', (lock: Json) => {
      for (let index = 0; index < 4100; index++) lock.packages[`node_modules/bound-${index}`] = { version: '1.0.0' };
    }, 'preparation-bound']
  ])('rejects %s without probing or installing', async (_name, change, code) => {
    const f = await fixture();
    await editJson(f, ['backend', 'package-lock.json'], (lock) => {
      expect(lock.packages[dependency]).toBeDefined();
      change(lock);
    });
    await refresh(f);
    await expectBlocked(f, code);
  });

  it.each([
    ['an alias dependency', { fastify: 'npm:CANARY_ALIAS@5.0.0' }, 'unsupported-package-source'],
    ['a dist-tag dependency', { fastify: 'latest' }, 'unsupported-package-source'],
    ['an unbounded dependency map', Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`bound-${index}`, '1.0.0'])),
      'unsupported-package-source']
  ])('rejects %s declared identically in package and lock root', async (_name, dependencies, code) => {
    const f = await fixture();
    await editJson(f, ['backend', 'package.json'], (project) => { project.dependencies = dependencies; });
    await editJson(f, ['backend', 'package-lock.json'], (lock) => { lock.packages[''].dependencies = dependencies; });
    await refresh(f);
    await expectBlocked(f, code);
  });

  it.each([
    ['bundled dependency arrangements', (project: Json) => { project.bundleDependencies = ['fastify']; }, 'unsupported-package-source'],
    ['non-string engine requirements', (project: Json) => { project.engines = { node: 24 }; }, 'preparation-input'],
    ['another package manager', (project: Json) => { project.packageManager = 'pnpm@9.0.0'; }, 'unsupported-tool-requirement']
  ])('rejects %s in the candidate package manifest', async (_name, change, code) => {
    const f = await fixture();
    await editJson(f, ['backend', 'package.json'], change);
    await refresh(f);
    await expectBlocked(f, code);
  });

  it.each([
    ['a non-JSON lock', ['backend', 'package-lock.json'], '{CANARY_NOT_JSON'],
    ['a non-object manifest', ['backend', 'package.json'], '[]\n'],
    ['a non-UTF-8 manifest', ['backend', 'package.json'], Buffer.from([0x7b, 0xff, 0xfe, 0x7d])]
  ])('rejects %s as untrusted preparation input', async (_name, parts, content) => {
    const f = await fixture();
    await putApplicationFixtureFile(f.root, parts, content);
    await refresh(f);
    await expectBlocked(f, 'preparation-input');
  });

  it('accepts a legitimate %2B escape in an integrity-bound npm registry artifact URL', async () => {
    const f = await fixture();
    await editJson(f, ['backend', 'package-lock.json'], (lock) => {
      lock.packages[dependency].resolved = 'https://registry.npmjs.org/fastify/-/fastify-5.12.3%2Bbuild.1.tgz';
    });
    await refresh(f);
    const { candidate } = await inspect(f);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.report.status).toBe('proposed');
  });

  it('records remote-proxy opt-in only for the registered Microsoft feed and keeps install hooks suppressed', async () => {
    const f = await fixture({ npmSource: 'microsoft-npm', network: false });
    const { candidate } = await inspect(f);
    expect(candidate.blockers).toEqual([]);
    const [preparation] = candidate.verificationPolicy.preparation;
    expect(preparation!.registry).toBe('https://packagefeedproxy.microsoft.io/npm/');
    expect(preparation!.commands[0]!.args).toEqual(expect.arrayContaining([
      '--allow-remote=all', 'ci', '--ignore-scripts', '--offline', '--registry=https://packagefeedproxy.microsoft.io/npm/'
    ]));
    expect(preparation!.suppressedLifecyclePackages).toBeGreaterThan(0);
    expect(candidate.verificationPolicy.effects).toMatchObject({ preparation: true, network: false, lifecycle: false });
  });

  it('keeps the public npm registry closed to remote-proxy sources and online only with declared network', async () => {
    const f = await fixture({ network: true });
    const { candidate } = await inspect(f);
    expect(candidate.blockers).toEqual([]);
    const args = candidate.verificationPolicy.preparation[0]!.commands[0]!.args;
    expect(args).not.toContain('--allow-remote=all');
    expect(args).not.toContain('--offline');
    expect(candidate.networkRequired).toBe(true);
  });

  it('does not let an unrelated Go workspace file block the npm component preparation', async () => {
    const f = await fixture();
    await putApplicationFixtureFile(f.root, ['go.work'], 'go 1.27.0\n');
    await refresh(f);
    const { candidate } = await inspect(f);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.verificationPolicy.preparation.map((item) => item.provider)).toEqual(['npm-ci']);
  });
});

describe('installed tool requirements declared by the candidate', () => {
  const installed = process.version.slice(1);
  it.each([
    ['a caret range on the installed major', `^${installed.split('.')[0]}.0.0`, null],
    ['an upper bound', '<99.0.0', null],
    ['a strict lower bound', '>1.0.0', null],
    ['an exact equality', `==${installed}`, null],
    ['a comma-separated window', '>=1,<99', null],
    ['a requirement above the installed runtime', '>=99.0.0', 'incompatible-tool'],
    ['an upper bound below the installed runtime', '<=1.0.0', 'incompatible-tool'],
    ['a tilde range', '~24.1', 'unsupported-tool-requirement'],
    ['a zero-major caret', '^0.1.0', 'unsupported-tool-requirement'],
    ['an empty requirement', ' ', 'unsupported-tool-requirement']
  ])('evaluates %s against the probed installed Node identity', async (_name, requirement, code) => {
    const f = await fixture();
    await editJson(f, ['backend', 'package.json'], (project) => { project.engines = { node: requirement }; });
    await refresh(f);
    if (code) {
      await expectBlocked(f, code, { probes: true });
      return;
    }
    const { candidate, runner } = await inspect(f);
    expect(candidate.blockers).toEqual([]);
    expect(candidate.verificationPolicy.preparation[0]!.toolRequirements.node).toBe(requirement);
    expect(runner.calls.length).toBeGreaterThan(0);
  });

  it('binds an exact packageManager npm version and rejects a different installed npm', async () => {
    const f = await fixture();
    const version = (await inspect(f)).candidate.verificationPolicy.toolchain.find((tool) => tool.id === 'npm')!.version;
    await editJson(f, ['backend', 'package.json'], (project) => { project.packageManager = `npm@${version}`; });
    await refresh(f);
    const exact = (await inspect(f)).candidate;
    expect(exact.blockers).toEqual([]);
    expect(exact.verificationPolicy.preparation[0]!.toolRequirements['npm-exact']).toBe(version);
    await editJson(f, ['backend', 'package.json'], (project) => { project.packageManager = 'npm@1.0.0'; });
    await refresh(f);
    await expectBlocked(f, 'incompatible-tool', { probes: true });
  });
});

describe('locked uv wheel-only inputs', () => {
  const root = (lock: Json, project: Json) => lock.package.find((entry: Json) => entry.name === project.project.name);
  const registry = (lock: Json) => lock.package.find((entry: Json) => entry.name === 'redis');
  it.each([
    ['a non-v1 lock', (_project: Json, lock: Json) => { lock.version = 2; }, 'missing-lock'],
    ['a custom index', (project: Json) => { project.tool.uv = { 'index-url': 'https://CANARY_INDEX.invalid/simple' }; }, 'unsupported-package-source'],
    ['a local source override', (project: Json) => { project.tool.uv = { sources: { redis: { path: '../CANARY_LOCAL' } } }; }, 'unsupported-package-source'],
    ['dynamic metadata', (project: Json) => { project.project.dynamic = ['version']; }, 'unsupported-package-source'],
    ['dependency groups', (project: Json) => { project['dependency-groups'] = { dev: ['pytest==9.1.1'] }; }, 'unsupported-package-source'],
    ['a different interpreter range', (project: Json) => { project.project['requires-python'] = '>=3.13,<3.14'; }, 'mismatched-lock'],
    ['an unbounded interpreter range', (project: Json, lock: Json) => {
      project.project['requires-python'] = '>=3.14'; lock['requires-python'] = '>=3.14';
    }, 'unsupported-python-requirement'],
    ['an implicit locked interpreter range', (_project: Json, lock: Json) => { delete lock['requires-python']; }, 'mismatched-lock'],
    ['an unsupported extra', (project: Json) => { project.project['optional-dependencies'].docs = ['sphinx==8.0.0']; }, 'unsupported-package-source'],
    ['a missing test extra', (project: Json) => { delete project.project['optional-dependencies'].test; }, 'missing-dependencies'],
    ['a missing project version', (project: Json) => { delete project.project.version; }, 'mismatched-lock'],
    ['an installable locked root', (project: Json, lock: Json) => { root(lock, project).source = { registry: 'https://pypi.org/simple' }; }, 'mismatched-lock'],
    ['a range instead of an exact pin', (project: Json) => {
      project.project.dependencies = project.project.dependencies.map((item: string) => item.startsWith('redis==') ? 'redis>=8' : item);
    }, 'unsupported-package-source'],
    ['a URL root dependency', (project: Json, lock: Json) => {
      const entry = root(lock, project).metadata['requires-dist'].find((item: Json) => item.name === 'redis');
      entry.url = 'https://files.pythonhosted.org/CANARY_.whl';
    }, 'unsupported-package-source'],
    ['a platform marker', (project: Json, lock: Json) => {
      root(lock, project).metadata['requires-dist'].find((item: Json) => item.name === 'redis').marker = "sys_platform == 'linux'";
    }, 'mismatched-lock'],
    ['malformed locked extras', (project: Json, lock: Json) => {
      root(lock, project).metadata['requires-dist'].find((item: Json) => item.name === 'psycopg').extras = 'binary';
    }, 'mismatched-lock'],
    ['a pin differing from the lock', (project: Json) => {
      project.project.dependencies = project.project.dependencies.map((item: string) => item.startsWith('redis==') ? 'redis==8.0.0' : item);
    }, 'mismatched-lock'],
    ['a direct pin without its locked package', (project: Json, lock: Json) => {
      project.project.dependencies = project.project.dependencies.map((item: string) => item.startsWith('redis==') ? 'redis==9.9.9' : item);
      root(lock, project).metadata['requires-dist'].find((item: Json) => item.name === 'redis').specifier = '==9.9.9';
    }, 'mismatched-lock'],
    ['a package from a foreign index', (_project: Json, lock: Json) => {
      registry(lock).source = { registry: 'https://CANARY_INDEX.invalid/simple' };
    }, 'unsupported-package-source'],
    ['a package without artifacts', (_project: Json, lock: Json) => { delete registry(lock).sdist; delete registry(lock).wheels; }, 'missing-lock'],
    ['an artifact without SHA-256 integrity', (_project: Json, lock: Json) => { registry(lock).wheels[0].hash = 'md5:0123'; }, 'missing-lock'],
    ['an artifact from a foreign origin', (_project: Json, lock: Json) => {
      registry(lock).wheels[0].url = 'https://CANARY_MIRROR.invalid/redis.whl';
    }, 'unsupported-package-source'],
    ['an artifact behind a whole encoded dot-segment', (_project: Json, lock: Json) => {
      registry(lock).wheels[0].url = 'https://files.pythonhosted.org/packages/%2e/CANARY_.whl';
    }, 'unsupported-package-source'],
    ['an artifact behind a mixed-case encoded parent segment', (_project: Json, lock: Json) => {
      registry(lock).sdist.url = 'https://files.pythonhosted.org/packages/%2E%2e/CANARY_.tar.gz';
    }, 'unsupported-package-source'],
    ['a non-string dependency declaration', (project: Json) => { project.project.dependencies = [...project.project.dependencies, 42]; },
      'unsupported-package-source'],
    ['a non-list unselected extra', (project: Json) => { project.project['optional-dependencies'].functions = 'pytest==9.1.1'; },
      'preparation-input'],
    ['a non-string locked marker', (project: Json, lock: Json) => {
      root(lock, project).metadata['requires-dist'].find((item: Json) => item.name === 'redis').marker = 42;
    }, 'mismatched-lock']
  ])('rejects %s before resolving interpreters', async (_name, change, code) => {
    const f = await fixture({ stack: 'python-fastapi' });
    const projectPath = path.join(f.root, 'backend', 'pyproject.toml'), lockPath = path.join(f.root, 'backend', 'uv.lock');
    const project = parseToml(await readFile(projectPath, 'utf8')) as Json;
    const lock = parseToml(await readFile(lockPath, 'utf8')) as Json;
    expect(registry(lock)).toBeDefined();
    change(project, lock);
    await putApplicationFixtureFile(f.root, ['backend', 'pyproject.toml'], stringifyToml(project));
    await putApplicationFixtureFile(f.root, ['backend', 'uv.lock'], stringifyToml(lock));
    await refresh(f);
    await expectBlocked(f, code, { env: noTools });
  });

  it.each([
    ['non-UTF-8 TOML', Buffer.from([0x5b, 0xff, 0x5d])],
    ['invalid TOML', '[project\nname = CANARY_NOT_TOML\n']
  ])('rejects %s as untrusted preparation input', async (_name, content) => {
    const f = await fixture({ stack: 'python-fastapi' });
    await putApplicationFixtureFile(f.root, ['backend', 'uv.lock'], content);
    await refresh(f);
    await expectBlocked(f, 'preparation-input', { env: noTools });
  });

  it('accepts a legitimate %2B escape in an integrity-bound wheel URL and reaches tool resolution', async () => {
    const f = await fixture({ stack: 'python-fastapi' });
    await editToml(f, ['backend', 'uv.lock'], (lock) => {
      lock.package.find((entry: Json) => entry.name === 'redis').wheels[0].url =
        'https://files.pythonhosted.org/packages/redis-8.1.0%2Blocal-py3-none-any.whl';
    });
    await refresh(f);
    const candidate = await expectBlocked(f, 'missing-tool', { env: noTools });
    expect(candidate.blockers.join(' ')).not.toContain('[unsupported-package-source]');
  });

  it('rejects a missing uv lock as missing exact inputs', async () => {
    const f = await fixture({ stack: 'python-fastapi' });
    await rm(path.join(f.root, 'backend', 'uv.lock'));
    await refresh(f);
    await expectBlocked(f, 'missing-lock', { env: noTools });
  });

  it('normalizes a wildcard lock range and reaches tool resolution without installing an interpreter', async () => {
    const f = await fixture({ stack: 'python-fastapi' });
    const lock = parseToml(await readFile(path.join(f.root, 'backend', 'uv.lock'), 'utf8')) as Json;
    expect(lock['requires-python']).toBe('==3.14.*');
    const candidate = await expectBlocked(f, 'missing-tool', { env: noTools });
    const [preparation] = candidate.verificationPolicy.preparation;
    expect(preparation!.toolRequirements.python).toBe('>=3.14,<3.15');
    expect(preparation!.pythonExtras).toEqual(['test']);
    expect(preparation!.commands[1]!.args).toEqual(expect.arrayContaining([
      '--no-config', '--locked', '--no-build', '--no-install-project', '--no-python-downloads', '--python', '$APPROVED_PYTHON'
    ]));
    expect(preparation!.commands[1]!.args).not.toContain('--offline');
  });

  it('selects the functions extra and private worker test cache only for a selected worker component', async () => {
    const f = await fixture({ stack: 'python-fastapi', genai: true, network: false });
    const candidate = await expectBlocked(f, 'missing-tool', { env: noTools });
    const [preparation] = candidate.verificationPolicy.preparation;
    expect(preparation!.pythonExtras).toEqual(['test', 'functions']);
    expect(preparation!.outputRoles.map((role) => role.id)).toContain('python-worker-tests');
    expect(preparation!.commands[1]!.args).toEqual(expect.arrayContaining(['--extra', 'functions', '--offline']));
    await editToml(f, ['backend', 'pyproject.toml'], (project) => { delete project.project['optional-dependencies'].functions; });
    await refresh(f);
    await expectBlocked(f, 'missing-dependencies', { env: noTools });
  });
});

describe('local-toolchain Go module inputs', () => {
  it.each([
    ['a replacement directive', (text: string) => `${text}\nreplace github.com/go-chi/chi/v5 => ../CANARY_FORK\n`, 'unsupported-package-source'],
    ['a missing go directive', (text: string) => text.replace(/^go \d+\.\d+(?:\.\d+)?$/mu, ''), 'preparation-input'],
    ['a nested require block', (text: string) => text.replace('require (', 'require (\nrequire ('), 'preparation-input'],
    ['an unexpected block end', (text: string) => `)\n${text}`, 'preparation-input'],
    ['an unterminated require block', (text: string) => `${text}\nrequire (\n\tgithub.com/example/pending v1.0.0\n`, 'preparation-input']
  ])('rejects %s in go.mod', async (_name, change, code) => {
    const f = await fixture({ stack: 'go-huma' });
    await editText(f, ['backend', 'go.mod'], change);
    await refresh(f);
    await expectBlocked(f, code, { env: noTools });
  });

  it.each([
    ['a malformed checksum record', (text: string) => `${text}CANARY_NOT_A_SUM\n`, 'missing-lock'],
    ['a missing go.mod checksum for a required module', (text: string) =>
      text.split(/\r?\n/u).filter((line) => !line.startsWith('github.com/go-chi/chi/v5 ') || !line.includes('/go.mod')).join('\n'), 'mismatched-lock'],
    ['a checksum inventory beyond its bound', (text: string) =>
      `${text}${Array.from({ length: 8193 }, (_, index) => `example.com/bound/m${index} v1.0.0 h1:${'A'.repeat(43)}=\n`).join('')}`, 'preparation-bound']
  ])('rejects %s in go.sum', async (_name, change, code) => {
    const f = await fixture({ stack: 'go-huma' });
    await editText(f, ['backend', 'go.sum'], change);
    await refresh(f);
    await expectBlocked(f, code, { env: noTools });
  });

  it.each([['go.work'], ['go.work.sum']])('refuses workspace input %s anywhere in the candidate', async (name) => {
    const f = await fixture({ stack: 'go-huma' });
    await putApplicationFixtureFile(f.root, [name], 'go 1.27.0\n\nuse ./backend\n');
    await refresh(f);
    await expectBlocked(f, 'unsupported-package-source', { env: noTools });
  });

  it('rejects non-UTF-8 module inputs and a missing checksum file', async () => {
    const f = await fixture({ stack: 'go-huma' });
    const original = await readFile(path.join(f.root, 'backend', 'go.mod'));
    await putApplicationFixtureFile(f.root, ['backend', 'go.mod'], Buffer.concat([original, Buffer.from([0xff])]));
    await refresh(f);
    await expectBlocked(f, 'preparation-input', { env: noTools });
    await putApplicationFixtureFile(f.root, ['backend', 'go.mod'], original);
    await rm(path.join(f.root, 'backend', 'go.sum'));
    await refresh(f);
    await expectBlocked(f, 'missing-lock', { env: noTools });
  });

  it('records single-line requirements and a local toolchain floor without downloading a toolchain', async () => {
    const f = await fixture({ stack: 'go-huma' });
    await editText(f, ['backend', 'go.mod'], (text) => text
      .replace(/^go (\d+\.\d+(?:\.\d+)?)$/mu, 'go $1\ntoolchain go1.27.1 // local only')
      .replace(/require \(\n\tgithub\.com\/danielgtaylor\/huma\/v2 (v[^\n]+)\n/u, 'require github.com/danielgtaylor/huma/v2 $1\nrequire (\n'));
    await refresh(f);
    const candidate = await expectBlocked(f, 'missing-tool', { env: noTools });
    const [preparation] = candidate.verificationPolicy.preparation;
    expect(preparation!.toolRequirements).toMatchObject({ go: '>=1.27.0', 'go-toolchain': '>=1.27.1' });
    expect(preparation!.commands).toEqual([expect.objectContaining({ tool: 'go', args: ['mod', 'download', '-json'] })]);
    expect(preparation!.outputRoles.filter((role) => role.protectedAfterPreparation).map((role) => role.pathParts))
      .toEqual([['cache', 'go-mod', 'backend']]);
  });

  it.each([
    ['go directive', (text: string) => text.replace(/^go \d+\.\d+(?:\.\d+)?$/mu, 'go 1.99.0')],
    ['toolchain directive', (text: string) => text.replace(/^go (\d+\.\d+(?:\.\d+)?)$/mu, 'go $1\ntoolchain go1.99.0')]
  ])('refuses an installed Go below the candidate %s instead of fetching a toolchain', async (_name, change) => {
    const f = await fixture({ stack: 'go-huma' });
    const tools = await externalToolCopies(f.directory, ['go']);
    await editText(f, ['backend', 'go.mod'], change);
    await refresh(f);
    await expectBlocked(f, 'incompatible-tool', { env: { PATH: tools.directory }, probes: true });
  });
});

describe('frozen preparation failure classification', () => {
  const preparation = (provider: ApplicationResolvedPreparation['provider']) => ({ provider }) as ApplicationResolvedPreparation;
  const command: ApplicationVerificationCommand = {
    executable: 'npm', args: ['ci'], cwdPathParts: ['backend'], timeoutMs: 1_000, maxOutputBytes: 16_384, network: false
  };
  const failed = (overrides: Partial<CommandResult>): CommandResult => ({
    command: { executable: 'CANARY_EXECUTABLE', args: ['CANARY_ARGUMENT'] }, displayCommand: 'CANARY_DISPLAY',
    status: 1, signal: null, stdout: '', stderr: '', timedOut: false, processTreeSettled: true, ...overrides
  });

  it.each([
    ['npm-ci', { stderr: 'npm error code ENOTCACHED CANARY_PACKAGE' }, 'missing-dependencies', '[private-cache-miss]'],
    ['go-mod-download', { stderr: 'CANARY_MODULE: module lookup disabled by GOPROXY=off' }, 'missing-dependencies', '[private-cache-miss]'],
    ['npm-ci', { stderr: '`npm ci` can only install packages when your package.json and package-lock.json are in sync' }, 'missing-dependencies', '[mismatched-lock]'],
    ['go-mod-download', { stderr: 'go: updates to go.mod needed; CANARY_MODULE' }, 'missing-dependencies', '[mismatched-lock]'],
    ['uv-locked-sync', { stderr: 'error: Building source distributions is disabled CANARY_PACKAGE' }, 'missing-dependencies', '[unsupported-build-hook]'],
    ['npm-ci', { stderr: 'You installed esbuild for another platform than the one you are currently using CANARY_PATH' }, 'missing-dependencies', '[unsupported-build-hook]'],
    ['npm-ci', { stderr: 'npm error code E401 CANARY_TOKEN' }, 'missing-dependencies', '[unsupported-package-source]'],
    ['uv-locked-sync', { stderr: 'CANARY_UV_TRACE' }, 'missing-dependencies', '[python-preparation-failed]'],
    ['go-mod-download', { stderr: 'CANARY_GO_TRACE' }, 'missing-dependencies', '[go-preparation-failed]'],
    ['npm-ci', { stderr: 'CANARY_NPM_TRACE' }, 'missing-dependencies', '[npm-preparation-failed]'],
    ['npm-ci', { status: null, timedOut: true }, 'timed-out', 'No automatic retry'],
    ['npm-ci', { status: null, outputLimitExceeded: true }, 'output-limit', 'Output is withheld'],
    ['uv-locked-sync', { status: null, aborted: true, errorCode: 'ABORT_ERR' }, 'interrupted', 'Earlier verifier effects are not undone'],
    ['go-mod-download', { status: null, errorCode: 'ENOENT' }, 'missing-executable', 'Repair does not install global tools'],
    ['npm-ci', { status: null, errorCode: 'RESTRICTED_EXECUTION_POLICY' }, 'execution-failed', 'Liftoff does not bypass execution policies'],
    ['npm-ci', { status: null, errorCode: 'CONSTRAINED_LANGUAGE_MODE' }, 'execution-failed', 'FullLanguage mode'],
    ['npm-ci', { status: null, errorCode: 'CORRUPTED_CONTROLLER_ASSET' }, 'execution-failed', 'integrity verification'],
    ['npm-ci', { status: null, errorCode: 'POWERSHELL_SPAWN_FAILED' }, 'execution-failed', 'Windows PowerShell 5.1']
  ] as const)('classifies %s result %j as %s without exposing diagnostics', (provider, output, kind, text) => {
    const diagnostic = applicationPreparationFailure(preparation(provider), command, failed(output));
    expect(diagnostic?.kind).toBe(kind);
    expect(diagnostic?.message).toContain(text);
    expect(diagnostic?.cleanupUnsafe).toBe(false);
    expect(JSON.stringify(diagnostic)).not.toContain('CANARY_');
  });

  it('keeps unconfirmed process-tree termination unsafe for cleanup and success-free', () => {
    const diagnostic = applicationPreparationFailure(preparation('npm-ci'), command,
      failed({ status: null, errorCode: 'PROCESS_TREE_TERMINATION_FAILED', stderr: 'npm error code ENOTCACHED' }));
    expect(diagnostic).toMatchObject({ kind: 'termination-unconfirmed', cleanupUnsafe: true });
  });

  it('does not classify a completed frozen preparation as a failure', () => {
    expect(applicationPreparationFailure(preparation('npm-ci'), command, failed({ status: 0, stdout: 'ENOTCACHED text in success output' })))
      .toBeNull();
  });
});
