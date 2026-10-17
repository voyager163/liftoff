import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { projectCatalog } from '../src/application/project/catalog.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { createModernActivationIdentityReader } from '../src/domain/governance/activation/modern-identity.js';
import type { ModernDigest } from '../src/domain/governance/activation/modern-record-contracts.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { createManifestV8ProjectReader } from '../src/domain/project/manifest/v8-project.js';
import { createSource5WorkflowContext } from '../src/governance-activation/workflow-source5-context.js';
import {
  declareSource5WorkflowProgramSources, declareSource5WorkflowSources
} from '../src/governance-activation/workflow-source5-declaration.js';
import { validateWorkflowPublication } from '../src/governance-activation/workflow-publication.js';
import { workflowObservationRuntime } from '../src/governance-activation/workflow-runtime.js';

// Pure context relations, not qualified installed/plugin/runtime or release subjects.
function context(source = modernActivationSourceContracts()[0]!) {
  const { profile, workflow, policyVersion } = source.identity;
  const selection = { ...createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
    project: { name: 'declaration-fixture', workload: { kind: 'standard', apiStack: 'node-fastify', cloud: 'azure',
      region: 'eastus', frontend: false, environments: ['dev'] }, specWorkflow: workflow,
      agents: workflow === 'manual' ? [] : ['github-copilot'],
      ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {}) },
    framework: workflow === 'manual' ? { state: 'not-required' } :
      { state: 'initialized', adapter: workflow, contractVersion: '1.2.3' }
  }), profile };
  const digest: ModernDigest = `sha256:${'a'.repeat(64)}`;
  const input = { profile, policyVersion, selection, pluginResolutionDigest: digest, activeLayoutDigest: digest };
  const recordedIdentity = createModernActivationIdentityReader(projectCatalog).identityForSource({
    ...input, sourceVersion: source.identity.liftoffVersion
  });
  return createSource5WorkflowContext(projectCatalog, { ...input, recordedIdentity });
}

const invoke = (input: unknown) => Reflect.apply(declareSource5WorkflowSources, undefined, [input]);

describe('closed private intended source declaration with no publishable sources or authority', () => {
  it.each(modernActivationSourceContracts())('blocks exact $identity.profile/$identity.workflow without replacing its graph or review meaning', source => {
    const value = context(source), result = declareSource5WorkflowSources({ context: value });
    expect(result).toMatchObject({
      status: 'blocked', publicationSources: [], effects: [], requiredContextSemantics: 'not-validated',
      qualifiedExecutableRecipe: null, prerequisiteSession: null, execution: 'not-authorized',
      projectWrites: false, providerReads: false, providerWrites: false, workloadExecution: false
    });
    expectTypeOf(result.publicationSources).toEqualTypeOf<readonly []>();
    expectTypeOf(result.qualifiedExecutableRecipe).toEqualTypeOf<null>();
    expectTypeOf(result.prerequisiteSession).toEqualTypeOf<null>();
    expect(result.declaration.identity).toEqual(value.records.identity);
    expect(result.declaration.graphHash).toBe(canonicalSha256(value.records.graph));
    expect(result.declaration.pullRequestReview).toEqual(value.records.graph.profileContract.pullRequestReview);
    expect(result.declaration.pullRequestReview.humanApprovals).toBe(source.identity.profile === 'team-gitflow' ? 1 : 0);
    if (result.declaration.pullRequestReview.kind === 'independent-human') {
      expect(result.declaration.pullRequestReview).toMatchObject({
        excludeAuthor: true, excludeBots: true, invalidateOnRelevantChanges: true, currentHeadRequired: true
      });
    }
    expect(result.declaration.requiredProgram).toEqual({
      package: '@msn-control/liftoff', version: source.identity.liftoffVersion,
      activationContractVersion: 5, authenticatedSubject: null
    });
    expect(result.declarationDigest).toBe(canonicalSha256(result.declaration));
    expect(declareSource5WorkflowSources({ context: value })).toEqual(result);
    expect(result.declaration.recipes).toHaveLength(14);
    expect(result.blockers).toHaveLength(84);
    for (const recipe of result.declaration.recipes) {
      expect(recipe.integrationId).toBeNull();
      expect(recipe.completeJob).toBeNull();
      expect(result.blockers.filter(blocker => blocker.recipeKey === recipe.key).map(blocker => blocker.subject)).toEqual([
        'current5-program', 'provider-integration', 'complete-job', 'runner-and-checkout', 'controlled-red',
        'semantic-program-and-evidence'
      ]);
    }
  });

  it('keeps all fourteen literal names proposed, not an observed inventory or label-to-validator mapping', () => {
    const result = declareSource5WorkflowSources({ context: context() });
    expect(result.declaration.inventory).toBe('intended-not-observed');
    expect(result.declaration.recipes.map(recipe => recipe.proposedContext)).toEqual([
      'Liftoff / source integrity', 'Liftoff / backend tests', 'Liftoff / frontend build', 'Liftoff / worker tests',
      'Liftoff / infrastructure', 'Liftoff / framework source', 'Liftoff / secret protection',
      'Liftoff / dependency review', 'Liftoff / CodeQL', 'Liftoff / Checkov', 'Liftoff / action references',
      'Liftoff / image qualification', 'Liftoff / release qualification', 'Liftoff / staging qualification'
    ]);
    expect(new Set(result.declaration.recipes.map(recipe => recipe.proposedJobId)).size).toBe(14);
    expect(result.declaration.pairing).toBe('one-declaration-for-workflow-and-ruleset-source');
    expect(result.declaration.publicationDirectories).toEqual({
      workflows: '.github/workflows', rulesets: 'governance/rulesets'
    });
    expect(result.declaration.recipes.find(recipe => recipe.key === 'codeql')?.semantics).toContain('backend tests do not implement CodeQL');
    expect(result.declaration.recipes.find(recipe => recipe.key === 'staging-qualification')?.applicability).toContain('Main only');
    expect(result.declaration.recipes.find(recipe => recipe.key === 'framework-source')?.applicability).toContain('Manual has no fictional');
    expect(JSON.stringify(result)).not.toMatch(/"content"|"run"|"uses"|"jobs"|"required_status_checks"|"integration_id"/u);
  });

  it.each([
    'program', 'integrations', 'recipes', 'commands', 'workflows', 'rulesets', 'publicationSources',
    'effects', 'prerequisiteSession', 'qualifiedExecutableRecipe', 'observedRequirements', '__proto__'
  ])('rejects caller %s registration/subjects without reading it', key => {
    const hook = vi.fn(() => { throw new Error('Caller authority must not execute'); });
    const input = { context: context() };
    Object.defineProperty(input, key, { enumerable: true, get: hook });
    expect(() => invoke(input)).toThrow('private declaration accepts only');
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([null, undefined, false, 'ready', [], {}, { context: {} }, { context: null }])(
    'refuses malformed or structural input %# rather than issuing sources', input => {
      expect(() => invoke(input)).toThrow();
    });

  it('refuses copied, serialized, proxy and foreign-prototype contexts, requests and hooks', () => {
    const value = context(), hook = vi.fn(() => { throw new Error('Hooks must not execute'); });
    const getter = {}; Object.defineProperty(getter, 'context', { enumerable: true, get: hook });
    const hidden = {}; Object.defineProperty(hidden, 'context', { enumerable: false, value });
    for (const input of [
      getter, hidden, { context: value, [Symbol('extra')]: true }, Object.assign(Object.create({}), { context: value }),
      new Proxy({ context: value }, { getPrototypeOf: hook }),
      new Proxy({ context: value }, { ownKeys: hook }),
      { context: new Proxy(value, { get: hook }) }, { context: { ...value } },
      { context: JSON.parse(JSON.stringify(value)) }
    ]) expect(() => invoke(input)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it('deep-freezes the declaration, refusal and empty outputs without creating an authorization handle', () => {
    const result = declareSource5WorkflowSources({ context: context() });
    for (const value of [result, result.declaration, result.declaration.recipes, result.declaration.recipes[0]!,
      result.declaration.recipes[0]!.missingSubjects, result.declaration.recipes[0]!.commonObligations,
      result.declaration.recipes[0]!.commonObligations[0]!, result.blockers, result.blockers[0]!,
      result.publicationSources, result.effects]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Reflect.set(value, 'callerReady', true)).toBe(false);
    }
    expect(() => invoke({ context: result })).toThrow('context must be constructed');
  });

  it('cannot feed its empty sources through the unchanged publication boundary', () => {
    const result = declareSource5WorkflowSources({ context: context() });
    expect(() => validateWorkflowPublication({
      repository: 'owner/repo', repositoryId: 123, ref: 'ci/liftoff-workflows-proposed',
      parentSha: 'a'.repeat(40), files: result.publicationSources, sourceTransmissionApproved: true
    })).toThrow('bounded unique per-file inventory');
  });

  it('requires an original program, not a public release as a substitute for original executable content', () => {
    const result = declareSource5WorkflowSources({ context: context() });
    const requirement = result.declaration.recipes[0]!.commonObligations.find(item => item.subject === 'current5-program')!.requirement;
    expect(requirement).toContain('genuine original first-party current5 program');
    expect(requirement).not.toContain('immutable release');
    expect(result.blockers.filter(blocker => blocker.subject === 'current5-program')).toHaveLength(14);
  });
});

describe('original program-backed declaration request boundary', () => {
  function input() {
    const run = vi.fn(async () => { throw new Error('Declaration cannot run commands.'); });
    const request = vi.fn(async () => { throw new Error('Declaration cannot access the provider.'); });
    const runtime = workflowObservationRuntime({ projectRoot: process.cwd(), runner: { run }, transport: { request } });
    const content = Object.freeze({
      kind: 'source5-original-program-content' as const, contentDigest: 'a'.repeat(64), assemblyDigest: 'b'.repeat(64)
    });
    return { value: { context: context(), runtime, content }, run, request };
  }

  it.each(['path', 'reader', 'archive', 'receipt', 'program', 'authenticated', 'observedAt'])(
    'refuses caller %s before programme or provider observation', async field => {
      const { value, run, request } = input(), hook = vi.fn();
      Object.defineProperty(value, field, { enumerable: true, get: hook });
      await expect(declareSource5WorkflowProgramSources(value)).rejects.toMatchObject({ code: 'workflow-declaration-request' });
      expect(hook).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    });

  it.each(['ordinary', 'copy', 'json', 'proxy'])('refuses %s program proof data without invoking hooks', async kind => {
    const { value, run, request } = input(), hook = vi.fn();
    const content = kind === 'copy' ? { ...value.content } : kind === 'json' ? JSON.parse(JSON.stringify(value.content))
      : kind === 'proxy' ? new Proxy(value.content, { get: hook }) : value.content;
    await expect(declareSource5WorkflowProgramSources({ ...value, content }))
      .rejects.toMatchObject({ code: 'workflow-program-observation' });
    expect(hook).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it('captures only own data references and refuses copied contexts/runtimes or hook-bearing requests', async () => {
    const { value, run, request } = input(), hook = vi.fn();
    const getter = Object.defineProperty({ ...value }, 'content', { enumerable: true, get: hook });
    const hidden = Object.defineProperty({ ...value }, 'content', { enumerable: false, value: value.content });
    for (const candidate of [
      getter, hidden, new Proxy(value, { getPrototypeOf: hook, ownKeys: hook }), { ...value, [Symbol('extra')]: true },
      { ...value, context: { ...value.context } }, { ...value, runtime: { ...value.runtime } }
    ]) await expect(declareSource5WorkflowProgramSources(candidate)).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});
