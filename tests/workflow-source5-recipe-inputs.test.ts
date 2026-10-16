import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
  recognizeWorkflowValidatorProgramStep, workflowContextValidators
} from '../src/domain/governance/activation/workflow-validator-program.js';
import { workflowContextValidators as publicValidators } from '../src/workflow-context-validator.js';
import { workflowByteDigest } from '../src/governance-activation/workflow-binding.js';
import { declareSource5WorkflowSources } from '../src/governance-activation/workflow-source5-declaration.js';
import { observeSource5WorkflowRecipeInputs } from '../src/governance-activation/workflow-source5-recipe-inputs.js';
import type { Source5WorkflowRecipeReference } from '../src/governance-activation/workflow-source5-recipe-inputs.js';
import { createWorkflowRequiredSourceFixture } from './fixtures/workflow-required-source.js';

function step(validator = 'backend-tests') {
  return { name: 'Run actual validator', shell: 'bash --noprofile --norc -euo pipefail {0}',
    env: { LIFTOFF_SOURCE_SHA: '${{ inputs.source_sha }}', NODE_OPTIONS: '', NODE_PATH: '' },
    run: `node ./node_modules/@msn-control/liftoff/dist/workflow-context-validator.js --validator ${validator} --source-sha "$LIFTOFF_SOURCE_SHA"` };
}

describe('finite existing local CLI syntax, not context/program/runner qualification', () => {
  it.each(workflowContextValidators)('recognizes only the existing %s public selector syntax', validator => {
    expect(recognizeWorkflowValidatorProgramStep(step(validator))).toBe(validator);
    expect(publicValidators).toBe(workflowContextValidators);
    expect(Object.isFrozen(publicValidators)).toBe(true);
    expect(publicValidators).toEqual(['source-integrity', 'backend-tests', 'worker-tests', 'frontend-build', 'framework-source']);
  });

  it.each(['action-references', 'compose-configuration', 'infrastructure-format', 'checkov', 'unknown'])(
    'does not invent or publicly register the %s private/absent body', validator => {
      expect(recognizeWorkflowValidatorProgramStep(step(validator))).toBeNull();
    });

  it('rejects extra fields/env, altered shells/inputs, echo, forced exits and arbitrary command composition', () => {
    const value = step();
    for (const candidate of [
      { ...value, if: 'always()' }, { ...value, shell: 'bash' },
      { ...value, env: { ...value.env, BASH_ENV: 'project-script' } },
      { ...value, env: { ...value.env, NODE_OPTIONS: '--import project-script' } },
      { ...value, env: { ...value.env, NODE_PATH: 'project-modules' } },
      { ...value, env: { ...value.env, LIFTOFF_SOURCE_SHA: '${{ github.sha }}' } },
      { ...value, name: '' }, { ...value, run: 'echo success' }, { ...value, run: 'exit 1' },
      { ...value, run: `${value.run} || true` }, { ...value, run: `${value.run}\necho success` },
      { ...value, run: value.run.replace('$LIFTOFF_SOURCE_SHA', '${{ inputs.source_sha }}') },
      { ...value, run: value.run.replace('./node_modules', '/tmp/node_modules') },
      { ...value, run: value.run.replace('node ', 'npx ') }
    ]) expect(recognizeWorkflowValidatorProgramStep(candidate)).toBeNull();
    const missing = { ...value };
    Reflect.deleteProperty(missing, 'name');
    expect(recognizeWorkflowValidatorProgramStep(missing)).toBeNull();
  });

  it('rejects accessors, proxies, symbols, hidden fields and foreign prototypes without executing hooks', () => {
    const value = step(), hook = vi.fn(() => { throw new Error('Input hooks must not execute'); });
    const getter = { ...value }; Object.defineProperty(getter, 'run', { enumerable: true, get: hook });
    const hidden = { ...value }; Object.defineProperty(hidden, 'run', { enumerable: false });
    const symbol = { ...value, [Symbol('extra')]: true };
    const envGetter = { ...value.env }; Object.defineProperty(envGetter, 'NODE_OPTIONS', { enumerable: true, get: hook });
    for (const candidate of [getter, hidden, symbol, Object.assign(Object.create({}), value),
      new Proxy(value, { getPrototypeOf: hook }), { ...value, env: envGetter },
      { ...value, env: new Proxy(value.env, { ownKeys: hook }) }]) {
      expect(recognizeWorkflowValidatorProgramStep(candidate)).toBeNull();
    }
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('actual immutable recipe inputs with complete literal context/integration preservation', () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-recipe-inputs-'))); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
    profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow',
    family: Source5WorkflowRecipeReference['family'] = 'develop') {
    const value = await createWorkflowRequiredSourceFixture(root, workflow, profile);
    const reference = { family, ref: family === 'release' ? 'release/next' : family === 'hotfix' ? 'hotfix/next' : family,
      path: '.github/workflows/real-contexts.yml', digest: '' };
    const definition = {
      name: 'Real required contexts', 'run-name': 'Liftoff context proof ${{ inputs.proof_id }}',
      on: { workflow_dispatch: { inputs: {
        proof_id: { required: true, type: 'string' }, protected_ref: { required: true, type: 'string' },
        source_sha: { required: true, type: 'string' }
      } } },
      concurrency: { group: 'liftoff-context-proof-${{ inputs.proof_id }}', 'cancel-in-progress': false },
      permissions: { contents: 'read' },
      jobs: Object.fromEntries(value.names.map((name, index) => [`job${index}`, {
        name, 'runs-on': 'ubuntu-latest', if: '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}',
        'timeout-minutes': 10, steps: [
          { name: 'Checkout reviewed source', uses: `actions/checkout@${'c'.repeat(40)}`,
            with: { clean: true, 'persist-credentials': false, ref: '${{ inputs.source_sha }}' } },
          index === 1 ? { name: 'Unknown actual validator', run: 'echo success' } : step(index === 0 ? 'backend-tests' : 'framework-source')
        ]
      }]))
    };
    const ref = { ref: `refs/heads/${reference.ref}`, object: { sha: value.source.sourceSha } };
    value.routes.set(`/repos/owner/repo/git/ref/heads/${reference.ref}`, ref);
    const member = { path: reference.path, type: 'blob', mode: '100644' };
    value.state.tree.tree.push(member);
    const file = { type: 'file', path: reference.path, encoding: 'base64', content: '' };
    const update = () => {
      const content = stringify(definition, { lineWidth: 0 });
      reference.digest = workflowByteDigest(content); file.content = Buffer.from(content).toString('base64');
    };
    update();
    value.routes.set(`/repos/owner/repo/contents/${reference.path}?ref=${value.source.sourceSha}`, file);
    return { ...value, reference, definition, member, file, ref, update };
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['openspec', 'single-maintainer-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'team-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('derives actual %s/%s job identities and retains every unprovable context as blocked', async (workflow, profile) => {
    const value = await fixture(workflow, profile);
    try {
      const result = await observeSource5WorkflowRecipeInputs({
        context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
      });
      expect(Object.keys(result).sort()).toEqual([
        'blockers', 'execution', 'prerequisiteSession', 'qualifiedExecutableRecipe', 'source', 'status', 'workflow'
      ]);
      expect(result).toMatchObject({ status: 'blocked', execution: 'not-authorized', prerequisiteSession: null,
        qualifiedExecutableRecipe: null, source: { originalPlan: 'not-validated', requiredContextSemantics: 'not-validated' } });
      expect(result.workflow.contexts).toEqual(value.names.map((name, index) => ({
        name, jobId: `job${index}`, validationStep: index === 1 ? 'Unknown actual validator' : 'Run actual validator',
        integrationId: 700 + index, validatorSyntax: index === 1 ? null : index === 0 ? 'backend-tests' : 'framework-source'
      })));
      expect(result.blockers.filter(item => item.code === 'workflow-recipe-semantic-catalog-unavailable').map(item => item.context)).toEqual(value.names);
      expect(result.blockers.filter(item => item.code === 'workflow-recipe-validator-body-unavailable').map(item => item.context)).toEqual([value.names[1]]);
      expect(Object.isFrozen(result.workflow.contexts[2])).toBe(true);
      expect(Object.isFrozen(result.blockers)).toBe(true);
      expect(value.calls).toHaveLength(9);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });

  it.each(['develop', 'main', 'release', 'hotfix'] as const)('observes the exact %s family without omitting other source requirements', async family => {
    const value = await fixture('manual', 'single-maintainer-gitflow', family);
    try {
      const result = await observeSource5WorkflowRecipeInputs({
        context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
      });
      expect(result.workflow.family).toBe(family);
      expect(result.workflow.ref).toBe(value.reference.ref);
      expect(Object.keys(result.source.requirements.families)).toEqual(['develop', 'main', 'release', 'hotfix']);
      expect(value.calls.filter(call => call.path.includes('/git/ref/heads/'))).toEqual([
        { method: 'GET', path: `/repos/owner/repo/git/ref/heads/${value.reference.ref}` },
        { method: 'GET', path: `/repos/owner/repo/git/ref/heads/${value.reference.ref}` }
      ]);
    } finally { await value.close(); }
  });

  it('keeps a CodeQL-named backend job, arbitrary actual contexts and __proto__ present and blocked beside the intended declaration', async () => {
    const value = await fixture();
    value.names[0] = 'Liftoff / CodeQL';
    value.definition.jobs.job0!.name = value.names[0];
    const ruleset = value.state.files[0]!;
    ruleset.content = ruleset.content.replace('Repository workflows / Actual backend behavioral tests', value.names[0]);
    value.source.files[0]!.digest = workflowByteDigest(ruleset.content);
    value.update();
    try {
      const declaration = declareSource5WorkflowSources({ context: value.context });
      expect(value.calls).toEqual([]);
      const result = await observeSource5WorkflowRecipeInputs({
        context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
      });
      expect(result.status).toBe('blocked');
      expect(result.workflow.contexts.map(item => [item.name, item.integrationId])).toEqual(value.names.map((name, index) => [name, 700 + index]));
      expect(result.workflow.contexts[0]).toMatchObject({ name: 'Liftoff / CodeQL', validatorSyntax: 'backend-tests' });
      expect(result.workflow.contexts.at(-1)?.name).toBe('__proto__');
      expect(result.qualifiedExecutableRecipe).toBeNull();
      expect(result.prerequisiteSession).toBeNull();
      expect(result.blockers.filter(item => item.code === 'workflow-recipe-semantic-catalog-unavailable').map(item => item.context)).toEqual(value.names);
      expect(declaration.publicationSources).toEqual([]);
      expect(declaration.declaration.recipes.every(recipe => recipe.integrationId === null && recipe.completeJob === null)).toBe(true);
      expect(value.calls).toHaveLength(9);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });

  it.each(['missing', 'extra', 'renamed', 'duplicate', 'conditional', 'write-permission', 'wrong-sha', 'unpinned-checkout', 'duplicate-yaml'] as const)(
    'refuses actual %s inventory or weakened structural workflow source', async variant => {
      const value = await fixture(), job = value.definition.jobs.job0!;
      if (variant === 'missing') Reflect.deleteProperty(value.definition.jobs, 'job2');
      if (variant === 'extra') value.definition.jobs.extra = structuredClone(job);
      if (variant === 'renamed') job.name = 'Build';
      if (variant === 'duplicate') value.definition.jobs.job2!.name = job.name;
      if (variant === 'conditional') Reflect.set(job.steps.at(-1)!, 'if', 'always()');
      if (variant === 'write-permission') value.definition.permissions.contents = 'write';
      if (variant === 'wrong-sha') job.if = '${{ github.run_attempt == 1 }}';
      if (variant === 'unpinned-checkout') {
        const checkout = job.steps[0]!;
        if (!('uses' in checkout)) throw new Error('Expected actual checkout fixture.');
        checkout.uses = 'actions/checkout@main';
      }
      value.update();
      if (variant === 'duplicate-yaml') {
        const content = Buffer.from(value.file.content, 'base64').toString('utf8') + '\npermissions: {contents: write}\n';
        value.file.content = Buffer.from(content).toString('base64'); value.reference.digest = workflowByteDigest(content);
      }
      try {
        await expect(observeSource5WorkflowRecipeInputs({
          context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
        })).rejects.toThrow(/complete actual workflow|independent bounded job|read-only permissions|unambiguous bounded/);
        expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });

  it.each(['absent', 'symlink', 'executable', 'duplicate', 'ref-name', 'ref-source', 'bytes'] as const)(
    'refuses actual %s immutable workflow membership/ref/byte mismatch', async variant => {
      const value = await fixture();
      if (variant === 'absent') value.state.tree.tree.pop();
      if (variant === 'symlink') value.member.mode = '120000';
      if (variant === 'executable') value.member.mode = '100755';
      if (variant === 'duplicate') value.state.tree.tree.push({ ...value.member });
      if (variant === 'ref-name') value.ref.ref = 'refs/heads/main';
      if (variant === 'ref-source') value.ref.object.sha = 'd'.repeat(40);
      if (variant === 'bytes') value.file.content = Buffer.from('unapproved bytes').toString('base64');
      try {
        await expect(observeSource5WorkflowRecipeInputs({
          context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
        })).rejects.toThrow(/ordinary non-executable workflow|actual selected protected ref|Immutable provider source bytes differ/);
        expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });

  it('captures original selectors before asynchronous observations rather than accepting changed request meaning', async () => {
    const value = await fixture(), original = structuredClone(value.reference);
    value.hooks.afterResponse = endpoint => {
      if (endpoint === '/repos/owner/repo') {
        value.reference.ref = 'main'; value.reference.path = '.github/workflows/foreign.yml';
        value.reference.digest = 'd'.repeat(64); value.source.sourceSha = 'e'.repeat(40);
      }
    };
    try {
      const result = await observeSource5WorkflowRecipeInputs({
        context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
      });
      expect(result.workflow).toMatchObject(original);
      expect(result.source.source.sourceSha).toBe('a'.repeat(40));
      expect(value.calls.some(call => call.path.includes('foreign') || call.path.endsWith('/heads/main'))).toBe(false);
    } finally { await value.close(); }
  });

  it('retains an actually unpinned integration as null rather than fabricating an application identity', async () => {
    const value = await fixture();
    const file = value.state.files[0]!, ruleset = JSON.parse(file.content);
    delete ruleset.rules[0].parameters.required_status_checks[0].integration_id;
    file.content = JSON.stringify(ruleset); value.source.files[0]!.digest = workflowByteDigest(file.content);
    try {
      const result = await observeSource5WorkflowRecipeInputs({
        context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
      });
      expect(result.workflow.contexts[0]).toMatchObject({ name: value.names[0], integrationId: null, validatorSyntax: 'backend-tests' });
      expect(result.status).toBe('blocked'); expect(result.qualifiedExecutableRecipe).toBeNull();
    } finally { await value.close(); }
  });

  it('rejects copied contexts/runtimes, forged reports, extra selectors, getters and proxies before any HTTP', async () => {
    const value = await fixture(), request = {
      context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
    };
    try {
      for (const input of [
        { ...request, context: { records: value.context.records } }, { ...request, runtime: { ...value.runtime } },
        { ...request, qualifiedExecutableRecipe: { status: 'ready' } },
        { ...request, workflow: { ...value.reference, contexts: value.names } },
        { ...request, workflow: { ...value.reference, ref: 'main' } },
        { ...request, workflow: { ...value.reference, path: '../foreign.yml' } },
        { ...request, workflow: { ...value.reference, digest: ['d'.repeat(64)] } }
      ]) await expect(Reflect.apply(observeSource5WorkflowRecipeInputs, undefined, [input])).rejects.toThrow();
      const hook = vi.fn(() => { throw new Error('Input hooks must not execute'); });
      const getter = { ...request }; Object.defineProperty(getter, 'runtime', { enumerable: true, get: hook });
      await expect(observeSource5WorkflowRecipeInputs(getter)).rejects.toThrow(/accepts only/);
      await expect(observeSource5WorkflowRecipeInputs(new Proxy(request, { getPrototypeOf: hook }))).rejects.toThrow(/accepts only/);
      expect(hook).not.toHaveBeenCalled(); expect(value.calls).toEqual([]);
    } finally { await value.close(); }
  });

  it.each(['expiry', 'transport', 'ref-moved'] as const)('rechecks the original %s boundary after actual source reads', async variant => {
    const value = await fixture(), now = Date.now();
    value.hooks.afterResponse = endpoint => {
      if (endpoint.includes('/contents/.github/workflows/')) {
        if (variant === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(now + 180_001);
        if (variant === 'transport') value.transport.request = async () => { throw new Error('Replacement must not execute'); };
        if (variant === 'ref-moved') value.ref.object.sha = 'f'.repeat(40);
      }
    };
    try {
      await expect(observeSource5WorkflowRecipeInputs({
        context: value.context, runtime: value.runtime, source: value.source, workflow: value.reference
      })).rejects.toMatchObject({
        code: variant === 'expiry' ? 'workflow-deadline' : variant === 'transport' ? 'workflow-observation-runtime' : 'workflow-recipe-input-ref'
      });
      expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });
});
