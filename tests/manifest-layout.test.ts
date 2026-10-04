import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { parseManifest, resolveManifestLayoutDescriptor } from '../src/application/project/manifest.js';
import { composeProjectPlugins } from '../src/application/project/plugins.js';
import type { ManifestLayoutDescriptor, ProjectOptions } from '../src/domain/project/contracts.js';
import {
  manifestActiveLayoutDigest, manifestLayoutBounds, validateManifestActiveLayout
} from '../src/domain/project/manifest/layout.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';

const plan = (options: ProjectOptions = {}) => buildProjectPlan({
  projectName: 'Layout Contract', projectType: 'standard', apiStack: 'node-fastify',
  environments: ['dev'], agents: ['github-copilot'], ...options
}, { requireProjectName: true });
const descriptor = () => resolveManifestLayoutDescriptor(plan());
const artifact = (logicalName: string, pathParts: unknown) => ({ kind: 'artifact', logicalName, pathParts });
const component = (id: string, pathParts: unknown) => ({ kind: 'component', component: id, pathParts });
const bound = (bindings: unknown[]) => ({ schemaVersion: 1, state: 'bound', bindings });
const unresolved = () => ({ schemaVersion: 1, state: 'unresolved', bindings: [] });
const patterns = ['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow'];
const workers = ['rag', 'agent', 'multi-agent', 'workflow'];

describe('installed finite layout descriptor', () => {
  it.each(patterns)('derives exact project identities and optional component gates for %s', (pattern) => {
    for (const specWorkflow of ['openspec', 'spec-kit']) {
      const selected = plan({
        projectType: 'genai', apiStack: 'python-fastapi', pattern, includeFrontend: true,
        environments: ['dev', 'prod'], specWorkflow
      });
      const context = resolveManifestLayoutDescriptor(selected);
      const expected = composeProjectPlugins(selected).expected;
      expect(context.artifacts.map((entry) => entry.logicalName)).toEqual(
        expected.filter((entry) => entry.lifecycle === 'project').map((entry) => entry.logicalName).sort());
      expect(context.components).toEqual([
        'backend', 'database', 'frontend', ...(workers.includes(pattern) ? ['function-worker'] : []),
        'opentofu-application', 'opentofu-environment:dev', 'opentofu-environment:prod'
      ]);
      const canonicalBindings = expected.filter((entry) => entry.lifecycle === 'project')
        .map((entry) => artifact(entry.logicalName, [...entry.pathParts]));
      expect(validateManifestActiveLayout(bound(canonicalBindings), context).bindings).toHaveLength(canonicalBindings.length);
      expect(context.artifacts.find((entry) => entry.logicalName === 'backend-main')?.component).toBe('backend');
      expect(context.artifacts.find((entry) => entry.logicalName === 'database-schema')?.component).toBe('database');
      expect(context.artifacts.find((entry) => entry.logicalName === 'root-readme')).not.toHaveProperty('component');
      if (workers.includes(pattern)) {
        expect(context.artifacts.find((entry) => entry.logicalName === 'function-worker-app')?.component).toBe('function-worker');
        expect(context.artifacts.find((entry) => entry.logicalName === 'functions-readme')).not.toHaveProperty('component');
      } else {
        expect(() => validateManifestActiveLayout(bound([component('function-worker', ['worker'])]), context))
          .toThrow('unknown or unselected component');
      }
      expect(() => validateManifestActiveLayout(bound([component('opentofu-environment:staging', ['stage'])]), context))
        .toThrow('unknown or unselected component');
    }
  });

  it.each(['python-fastapi', 'node-fastify', 'go-huma'])('selection-gates all standard %s identities', (apiStack) => {
    for (const specWorkflow of ['openspec', 'spec-kit']) {
      for (const environment of ['dev', 'staging', 'prod']) {
        const context = resolveManifestLayoutDescriptor(plan({ apiStack, specWorkflow, environments: [environment] }));
        expect(context.components).toEqual([
          'backend', 'database', 'opentofu-application', `opentofu-environment:${environment}`
        ]);
        for (const id of ['frontend', 'function-worker', 'arbitrary-directory']) {
          expect(() => validateManifestActiveLayout(bound([component(id, ['custom'])]), context))
            .toThrow('unknown or unselected component');
        }
        expect(() => validateManifestActiveLayout(bound([artifact('frontend-app', ['ui', 'App.vue'])]), context))
          .toThrow('unknown or unselected artifact');
        expect(() => validateManifestActiveLayout(bound([artifact('pattern-agent', ['agent.py'])]), context))
          .toThrow('unknown or unselected artifact');
      }
    }
  });

  it('does not expose core, desired-state, seed, framework or unknown identities as project artifacts', () => {
    for (const specWorkflow of ['openspec', 'spec-kit']) {
      const selected = plan({ specWorkflow });
      const context = resolveManifestLayoutDescriptor(selected);
      for (const entry of composeProjectPlugins(selected).expected.filter((entry) => entry.lifecycle !== 'project')) {
        expect(() => validateManifestActiveLayout(bound([artifact(entry.logicalName, ['unowned', 'file'])]), context))
          .toThrow('unknown or unselected artifact');
      }
      for (const name of ['repository-governance-copilot-launcher', 'opentofu-main', 'custom-artifact']) {
        expect(() => validateManifestActiveLayout(bound([artifact(name, ['file'])]), context))
          .toThrow('unknown or unselected artifact');
      }
    }
  });

  it('rejects fabricated Manual frameworks and team targets in the historical context', () => {
    const manual = structuredClone(plan());
    Reflect.set(manual.specWorkflow, 'id', 'manual');
    Reflect.set(manual.framework, 'id', 'manual');
    expect(() => resolveManifestLayoutDescriptor(manual)).toThrow(/does not match/i);
    const team = structuredClone(plan());
    Reflect.set(team.governanceProfile, 'id', 'team-gitflow');
    expect(() => resolveManifestLayoutDescriptor(team)).toThrow(/unknown|unsupported|invalid/i);
  });

  it('does not initialize the plugin registry when importing or using historical readers', async () => {
    vi.resetModules();
    const compose = vi.fn(() => { throw new Error('registry must remain lazy'); });
    vi.doMock('../src/application/project/plugins.js', () => ({ composeProjectPlugins: compose }));
    try {
      const reader = await import('../src/application/project/manifest.js');
      const raw: unknown = JSON.parse(readFileSync(
        new URL('./fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', import.meta.url), 'utf8'));
      expect(reader.parseManifest(raw)).toEqual(parseManifest(raw));
      expect(compose).not.toHaveBeenCalled();
      expect(() => reader.resolveManifestLayoutDescriptor(plan())).toThrow('registry must remain lazy');
      expect(compose).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../src/application/project/plugins.js');
      vi.resetModules();
    }
  });
});

describe('pure active layout interpretation', () => {
  it('keeps unresolved explicitly empty and different from a partial bound interpretation', () => {
    const context = descriptor();
    expect(validateManifestActiveLayout(unresolved(), context)).toEqual(unresolved());
    const partial = bound([artifact('node-backend-server', ['Services', 'API Service', 'main.ts'])]);
    expect(validateManifestActiveLayout(partial, context)).toEqual(partial);
    expect(manifestActiveLayoutDigest(partial, context)).not.toBe(manifestActiveLayoutDigest(unresolved(), context));
    expect(() => validateManifestActiveLayout(bound([]), context)).toThrow('at least one');
    expect(() => validateManifestActiveLayout({ ...unresolved(), bindings: partial.bindings }, context)).toThrow('empty bindings');
  });

  it('preserves real custom spelling and spaces without deriving ownership or generation provenance', () => {
    const server = artifact('node-backend-server', ['Services', 'Café API', 'entry.ts']);
    const input = bound([
      server,
      component('backend', ['Services', 'Café API']),
      artifact('root-readme', ['Project Guide.md'])
    ]);
    const before = structuredClone(input);
    const output = validateManifestActiveLayout(input, descriptor());
    expect(input).toEqual(before);
    expect(output).toEqual(bound([
      artifact('node-backend-server', ['Services', 'Café API', 'entry.ts']),
      artifact('root-readme', ['Project Guide.md']),
      component('backend', ['Services', 'Café API'])
    ]));
    server.pathParts = ['changed.ts'];
    expect(output.bindings[0].pathParts).toEqual(['Services', 'Café API', 'entry.ts']);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.bindings)).toBe(true);
    expect(Object.isFrozen(output.bindings[0].pathParts)).toBe(true);
  });

  it('uses canonical data and stable binding order for the digest', () => {
    const context = descriptor();
    const bindings = [component('backend', ['api']), artifact('node-backend-server', ['api', 'entry.ts'])];
    const left = bound(bindings), right = bound([...bindings].reverse());
    expect(validateManifestActiveLayout(left, context)).toEqual(validateManifestActiveLayout(right, context));
    expect(manifestActiveLayoutDigest(left, context)).toBe(manifestActiveLayoutDigest(right, context));
    expect(manifestActiveLayoutDigest(left, context)).toBe(`sha256:${canonicalSha256({
      kind: 'liftoff-active-layout', layout: validateManifestActiveLayout(left, context)
    })}`);
    expect(manifestActiveLayoutDigest(bound([artifact('node-backend-server', ['API', 'entry.ts'])]), context))
      .not.toBe(manifestActiveLayoutDigest(bound([artifact('node-backend-server', ['api', 'entry.ts'])]), context));
    expect(manifestActiveLayoutDigest(left, context)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('allows exact members within their own component, never inferring membership from custom paths', () => {
    const context = descriptor();
    expect(() => validateManifestActiveLayout(bound([
      component('backend', ['custom']), artifact('node-backend-server', ['custom', 'entry.ts'])
    ]), context)).not.toThrow();
    for (const name of ['database-schema', 'root-readme']) {
      expect(() => validateManifestActiveLayout(bound([
        component('backend', ['custom']), artifact(name, ['custom', 'file'])
      ]), context)).toThrow('overlapping');
    }
    expect(() => validateManifestActiveLayout(bound([
      component('backend', ['api']), artifact('node-backend-server', ['elsewhere', 'main.ts'])
    ]), context)).toThrow('outside its bound component');
  });

  it('allows project files beside managed files without reserving their shared parent', () => {
    const context = descriptor();
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', ['.github', 'Project Guide.md'])]), context))
      .not.toThrow();
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', ['governance', 'Project Guide.md'])]), context))
      .not.toThrow();
    expect(() => validateManifestActiveLayout(bound([component('backend', ['.github'])]), context)).toThrow('reserved');
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', ['.github'])]), context)).toThrow('reserved');
  });

  it('protects exact installed non-project paths even when integrations are unselected', () => {
    const context = descriptor();
    for (const parts of context.protectedPaths) {
      expect(() => validateManifestActiveLayout(bound([artifact('root-readme', [...parts])]), context)).toThrow('reserved');
    }
    expect(() => validateManifestActiveLayout(bound([
      artifact('root-readme', ['.claude', 'commands', 'liftoff-setup.md'])
    ]), context)).toThrow('reserved');
  });
});

describe('closed and bounded layout input', () => {
  const reservedAliases = [
    { alias: '.g\u0131t', literal: '.git' },
    { alias: '.\u00dfh', literal: '.ssh' },
    { alias: '.l\u0131ftoff', literal: '.liftoff' },
    { alias: 'l\u0131ftoff.manifest.json', literal: 'liftoff.manifest.json' },
    { alias: 'liftoff.man\u0131fest.json', literal: 'liftoff.manifest.json' },
    { alias: 'liftoff.conf\u0131g.json', literal: 'liftoff.config.json' },
    { alias: '.liftoff-\u0131n\u0131t.lock', literal: '.liftoff-init.lock' },
    { alias: '.terraform.tfstate.lock.\u0131nfo', literal: '.terraform.tfstate.lock.info' },
    { alias: 'CON\u0131N$', literal: 'CONIN$' },
    { alias: 'con\u0131n$.txt', literal: 'conin$.txt' }
  ];

  it.each(reservedAliases.flatMap(({ alias, literal }) =>
    (['component', 'artifact'] as const).flatMap((kind) =>
      [false, true].map((nested) => ({ alias, literal, kind, nested }))
    )
  ))('rejects the existing reserved alias equivalence $alias ($kind, nested=$nested)', ({ alias, literal, kind, nested }) => {
    const context = descriptor();
    expect(alias.toUpperCase().toLowerCase()).toBe(literal.toUpperCase().toLowerCase());
    expect(alias.normalize('NFKC')).toBe(alias);
    const bind = (name: string) => {
      const parts = nested ? ['custom', name] : [name];
      return bound([kind === 'component' ? component('backend', parts) : artifact('root-readme', parts)]);
    };
    expect(() => validateManifestActiveLayout(bind(literal), context)).toThrow(/reserved|non-portable/);
    expect(() => validateManifestActiveLayout(bind(alias), context)).toThrow(/reserved|non-portable/);
    expect(() => manifestActiveLayoutDigest(bind(alias), context)).toThrow(/reserved|non-portable/);
  });

  it('keeps the already protected root liftoff alias distinct from the nested segment gap', () => {
    const context = descriptor();
    expect(context.protectedPaths.some((parts) => parts[0] === '.liftoff')).toBe(true);
    for (const binding of [component('backend', ['.l\u0131ftoff']), artifact('root-readme', ['.l\u0131ftoff'])]) {
      expect(() => validateManifestActiveLayout(bound([binding]), context)).toThrow('reserved');
    }
    expect(() => validateManifestActiveLayout(bound([
      artifact('root-readme', ['.g\u0131thub', 'prompts', 'l\u0131ftoff-setup.prompt.md'])
    ]), context)).toThrow('reserved');
  });

  it.each(['Stra\u00dfe API', 'g\u0131t source', '.g\u0131t-guide'])(
    'preserves non-reserved Unicode spelling and digest for %s', (name) => {
      const context = descriptor();
      const input = bound([
        artifact('node-backend-server', [name, 'entry.ts']),
        component('backend', [name])
      ]);
      const output = validateManifestActiveLayout(input, context);
      expect(output).toEqual(input);
      expect(output.bindings[0].pathParts[0]).toBe(name);
      expect(manifestActiveLayoutDigest(input, context)).toBe(`sha256:${canonicalSha256({
        kind: 'liftoff-active-layout', layout: input
      })}`);
    }
  );

  it.each([
    null, undefined, false, 1, 'bound', [], {},
    { schemaVersion: '1', state: 'unresolved', bindings: [] },
    { schemaVersion: 2, state: 'unresolved', bindings: [] },
    { schemaVersion: 1, state: 'unknown', bindings: [] },
    { ...unresolved(), ownership: true },
    { ...unresolved(), bindings: null },
    { ...unresolved(), bindings: {} },
    { ...unresolved(), bindings: new Array(1) },
    bound([null]), bound(['artifact']), bound([false]), bound([{}]),
    bound([{ kind: 'directory', pathParts: ['x'] }]),
    bound([{ ...artifact('root-readme', ['x']), lifecycle: 'managed-core' }]),
    bound([{ ...component('backend', ['x']), logicalName: 'root-readme' }]),
    bound([{ ...artifact('root-readme', ['x']), component: 'backend' }]),
    bound([artifact('', ['x'])]), bound([artifact(' root-readme ', ['x'])])
  ].map((value) => ({ value })))('rejects malformed or unknown-field input %#', ({ value }) => {
    expect(() => validateManifestActiveLayout(value, descriptor())).toThrow();
    expect(() => manifestActiveLayoutDigest(value, descriptor())).toThrow();
  });

  it('rejects sparse arrays even when their enumerable property count matches the length', () => {
    const bindings = new Array(1);
    Object.assign(bindings, { extra: artifact('root-readme', ['x']) });
    expect(() => validateManifestActiveLayout(bound(bindings), descriptor())).toThrow('sparse');
    const parts = new Array(1);
    Object.assign(parts, { extra: 'x' });
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', parts)]), descriptor())).toThrow('sparse');
  });

  it.each([
    null, undefined, 'api/file', [], [null], [1], [{}], new Array(1),
    [''], [' '], ['.'], ['..'], ['a/b'], ['a\\b'], ['C:'], ['C:\\x'], ['\\\\server'],
    ['CON'], ['aux.txt'], ['LPT9'], ['CONIN$'], ['CONOUT$'], ['foo.'], ['foo '], ['x\0y'], ['x:y'], ['x*y'], ['x?y'],
    ['x<y'], ['x>y'], ['x|y'], ['x"y'], ['x\ny'], ['x\u007fy'], ['x\u0085y'], ['x\u200by'],
    ['cafe\u0301'], ['ＡＰＩ'], ['\ud800'], ['a'.repeat(256)]
  ].map((parts) => ({ parts })))('rejects unsafe, nonportable or malformed path %#', ({ parts }) => {
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', parts)]), descriptor())).toThrow();
  });

  it('enforces exact path-part, component-byte, total-byte and binding count ceilings', () => {
    const context = descriptor();
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', Array(32).fill('a'))]), context)).not.toThrow();
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', Array(33).fill('a'))]), context)).toThrow();
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', ['a'.repeat(255)])]), context)).not.toThrow();
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', ['é'.repeat(128)])]), context)).toThrow();
    const tooLong = Array(17).fill('a'.repeat(255));
    expect(Buffer.byteLength(tooLong.join('/'))).toBeGreaterThan(manifestLayoutBounds.pathBytes);
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', tooLong)]), context)).toThrow('bounds');
    const exactLimit = [...Array<string>(15).fill('a'.repeat(255)), 'b'.repeat(254), 'c'];
    expect(Buffer.byteLength(exactLimit.join('/'))).toBe(manifestLayoutBounds.pathBytes);
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', exactLimit)]), context)).not.toThrow();
    exactLimit[15] += 'b';
    expect(Buffer.byteLength(exactLimit.join('/'))).toBe(manifestLayoutBounds.pathBytes + 1);
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', exactLimit)]), context)).toThrow('bounds');
    const tooMany = Array(context.artifacts.length + context.components.length + 1).fill(artifact('root-readme', ['x']));
    expect(() => validateManifestActiveLayout(bound(tooMany), context)).toThrow('bounded dense');
  });

  it.each([
    ['.git', 'config'], ['nested', '.GIT', 'index'], ['.liftoff', 'governance', 'policy.md'],
    ['liftoff.manifest.json'], ['liftoff.config.json'], ['.liftoff-init.lock'],
    ['openspec', 'changes', 'work', 'tasks.md'], ['.specify', 'scripts', 'custom.sh'], ['specs', 'other', 'spec.md'],
    ['governance', 'activation-state.json'], ['governance', 'history', 'arbitrary', 'source.json'],
    ['governance', 'approvals', 'any.json'], ['governance', 'evidence', 'any.json'],
    ['governance', 'credentials', 'preflight-policy.json'],
    ['.github', 'prompts', 'opsx-apply.prompt.md'], ['.agents', 'skills', 'speckit-plan', 'SKILL.md'],
    ['.codex', 'config.toml'], ['.github', 'workflows', 'copilot-setup-steps.yml'],
    ['infrastructure', '.terraform', 'lock'], ['infrastructure', 'terraform.tfstate'],
    ['infrastructure', 'prod.tfstate.backup'], ['infrastructure', 'prod.tfplan'], ['.ssh', 'id_ed25519'],
    ['.azure', 'tokens.json'], ['.terraform.tfstate.lock.info'], ['terraform.tfstate.d', 'dev', 'state']
  ].map((parts) => ({ parts })))('rejects protected boundary %j', ({ parts }) => {
    expect(() => validateManifestActiveLayout(bound([artifact('root-readme', parts)]), descriptor())).toThrow('reserved');
  });

  it.each([
    [artifact('root-readme', ['one']), artifact('root-readme', ['two'])],
    [component('backend', ['one']), component('backend', ['two'])],
    [artifact('root-readme', ['one']), artifact('node-backend-server', ['one'])],
    [artifact('root-readme', ['One']), artifact('node-backend-server', ['one'])],
    [artifact('root-readme', ['Src', 'one']), artifact('node-backend-server', ['src', 'two'])],
    [artifact('root-readme', ['Σ', 'one']), artifact('node-backend-server', ['ς', 'two'])],
    [artifact('root-readme', ['ß', 'one']), artifact('node-backend-server', ['ss', 'two'])],
    [artifact('root-readme', ['one']), artifact('node-backend-server', ['one', 'two'])],
    [component('backend', ['one']), component('database', ['one'])],
    [component('backend', ['one']), component('database', ['one', 'two'])],
    [component('backend', ['One']), artifact('node-backend-server', ['one', 'entry.ts'])],
    [component('backend', ['one']), artifact('node-backend-server', ['one'])],
    [component('backend', ['one', 'two']), artifact('root-readme', ['one'])]
  ].map((bindings) => ({ bindings })))('rejects duplicate identities, aliases and incompatible overlapping paths %#', ({ bindings }) => {
    expect(() => validateManifestActiveLayout(bound(bindings), descriptor())).toThrow(/duplicate|aliased|overlapping|prefix/);
  });

  it('does not turn sparse partial bindings into a complete or writable inventory', () => {
    const context: ManifestLayoutDescriptor = descriptor();
    const value = validateManifestActiveLayout(bound([component('backend', ['custom backend'])]), context);
    expect(Object.keys(value).sort()).toEqual(['bindings', 'schemaVersion', 'state']);
    expect(value.bindings).toEqual([component('backend', ['custom backend'])]);
    expect(value).not.toHaveProperty('complete');
    expect(value).not.toHaveProperty('managedArtifacts');
    expect(value).not.toHaveProperty('generationHash');
  });
});
