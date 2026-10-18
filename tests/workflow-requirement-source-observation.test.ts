import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { workflowByteDigest } from '../src/governance-activation/workflow-binding.js';
import { observeSource5WorkflowRequirementSource } from '../src/governance-activation/workflow-requirement-source-observation.js';
import { createWorkflowRequiredSourceFixture } from './fixtures/workflow-required-source.js';

describe('actual immutable full ruleset inventory for canonical composition, not qualification', () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-required-source-'))); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture(workflow: 'manual' | 'openspec' | 'spec-kit' = 'manual',
    profile: 'single-maintainer-gitflow' | 'team-gitflow' = 'single-maintainer-gitflow') {
    return createWorkflowRequiredSourceFixture(root, workflow, profile);
  }

  it.each([
    ['manual', 'single-maintainer-gitflow'], ['openspec', 'single-maintainer-gitflow'],
    ['spec-kit', 'single-maintainer-gitflow'], ['manual', 'team-gitflow'],
    ['openspec', 'team-gitflow'], ['spec-kit', 'team-gitflow']
  ] as const)('retains every actual full context/integration for the selected %s/%s graph', async (workflow, profile) => {
    const value = await fixture(workflow, profile);
    try {
      const observed = await observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      });
      expect(Object.keys(observed).sort()).toEqual([
        'execution', 'graphHash', 'originalPlan', 'prerequisiteSession', 'requiredContextSemantics',
        'requirements', 'source', 'sourceRefCurrentness', 'status'
      ]);
      expect(observed).toMatchObject({
        status: 'observed', graphHash: canonicalSha256(value.context.records.graph), originalPlan: 'not-validated',
        sourceRefCurrentness: 'not-observed', requiredContextSemantics: 'not-validated',
        prerequisiteSession: null, execution: 'not-authorized'
      });
      expect(observed.requirements.profile).toBe(profile);
      for (const family of ['develop', 'main', 'release', 'hotfix'] as const) {
        expect(observed.requirements.families[family]).toEqual([...value.names].sort());
        value.names.forEach((name, index) => {
          expect(Object.getOwnPropertyDescriptor(observed.requirements.integrations[family], name))
            .toMatchObject({ value: 700 + index, enumerable: true });
        });
      }
      expect(observed.requirements.files).toEqual([...value.source.files].sort((a, b) => a.path.localeCompare(b.path)));
      expect(Object.isFrozen(observed.requirements.families)).toBe(true);
      expect(value.calls).toHaveLength(5);
      expect(value.calls.every(call => call.method === 'GET')).toBe(true);
      expect(value.processCalls()).toBe(0);
    } finally { await value.close(); }
  });

  it.each(['omitted', 'extra', 'nested', 'symlink', 'executable'] as const)(
    'refuses %s actual ruleset membership before reading selected source bytes', async variant => {
      const value = await fixture();
      if (variant === 'omitted') value.source.files.pop();
      else value.state.tree.tree.push({
        path: variant === 'nested' ? 'governance/rulesets/nested/extra.json' : 'governance/rulesets/extra.json',
        type: 'blob', mode: variant === 'symlink' ? '120000' : variant === 'executable' ? '100755' : '100644'
      });
      try {
        await expect(observeSource5WorkflowRequirementSource({
          context: value.context, runtime: value.runtime, source: value.source
        })).rejects.toThrow(/omitted|unsupported/);
        expect(value.calls.filter(call => call.path.includes('/contents/'))).toEqual([]);
        expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });

  it.each(['commit', 'tree', 'repository-id', 'repository-name', 'truncated', 'malformed'] as const)(
    'refuses actual %s readback mismatch', async variant => {
      const value = await fixture();
      if (variant === 'commit') value.state.commit.sha = 'c'.repeat(40);
      if (variant === 'tree') value.state.tree.sha = 'c'.repeat(40);
      if (variant === 'repository-id') value.state.repository.id++;
      if (variant === 'repository-name') value.state.repository.full_name = 'owner/foreign';
      if (variant === 'truncated') value.state.tree.truncated = true;
      if (variant === 'malformed') {
        // @ts-expect-error A malformed actual provider member must not disappear from the complete inventory.
        value.state.tree.tree.push({});
      }
      try {
        await expect(observeSource5WorkflowRequirementSource({
          context: value.context, runtime: value.runtime, source: value.source
        })).rejects.toThrow(/source tree|truncated|repository/);
        expect(value.processCalls()).toBe(0);
      } finally { await value.close(); }
    });

  it('refuses changed actual source bytes and the wrong selected-profile human review minimum', async () => {
    const value = await fixture();
    try {
      value.state.files[0]!.content += '\n';
      await expect(observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      })).rejects.toThrow(/bytes|digest/);
      const ruleset = JSON.parse(value.state.files[0]!.content);
      ruleset.rules[1].parameters.required_approving_review_count = 1;
      value.state.files[0]!.content = JSON.stringify(ruleset);
      value.source.files[0]!.digest = workflowByteDigest(value.state.files[0]!.content);
      await expect(observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      })).rejects.toThrow(/profile review minimum/);
    } finally { await value.close(); }
  });

  it('captures original source selectors before asynchronous observation', async () => {
    const value = await fixture(), original = structuredClone(value.source);
    value.hooks.afterResponse = endpoint => {
      if (endpoint === '/repos/owner/repo') { value.source.files.length = 0; value.source.sourceSha = 'c'.repeat(40); }
    };
    try {
      const observed = await observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      });
      expect(observed.source).toEqual(original);
      expect(observed.requirements.files).toHaveLength(2);
    } finally { await value.close(); }
  });

  it('rejects copied context/runtime, source proof bags and extra request fields before any HTTP', async () => {
    const value = await fixture(), request = { context: value.context, runtime: value.runtime, source: value.source };
    try {
      for (const input of [
        { ...request, context: { records: value.context.records } }, { ...request, runtime: { ...value.runtime } },
        { ...request, source: { ...value.source, contexts: value.names } },
        { ...request, source: { ...value.source, sourceSha: ['a'.repeat(40)] } },
        { ...request, prerequisites: { currentness: 'current' } },
        { ...request, source: { ...value.source, files: value.source.files.map(file => ({ ...file, verified: true })) } }
      ]) await expect(Reflect.apply(observeSource5WorkflowRequirementSource, undefined, [input])).rejects.toThrow();
      const proxy = new Proxy(request, { getPrototypeOf: () => { throw new Error('Proxy trap must not execute'); } });
      await expect(observeSource5WorkflowRequirementSource(proxy)).rejects.toThrow(/accepts only/);
      const getter = { context: value.context, source: value.source };
      Object.defineProperty(getter, 'runtime', { enumerable: true, get() { throw new Error('Getter must not execute'); } });
      await expect(Reflect.apply(observeSource5WorkflowRequirementSource, undefined, [getter])).rejects.toThrow(/accepts only/);
      expect(value.calls).toEqual([]);
    } finally { await value.close(); }
  });

  it.each(['expiry', 'transport'] as const)('retains the original %s boundary across actual reads', async variant => {
    const value = await fixture(), now = Date.now();
    value.hooks.afterResponse = endpoint => {
      if (endpoint.includes('/git/trees/')) {
        if (variant === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(now + 180_001);
        else value.transport.request = async () => { throw new Error('Replacement transport must not execute'); };
      }
    };
    try {
      await expect(observeSource5WorkflowRequirementSource({
        context: value.context, runtime: value.runtime, source: value.source
      })).rejects.toMatchObject({ code: variant === 'expiry' ? 'workflow-deadline' : 'workflow-observation-runtime' });
      expect(value.calls.filter(call => call.path.includes('/contents/'))).toEqual([]);
    } finally { await value.close(); }
  });
});
