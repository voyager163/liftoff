import { rm, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectModernInstalledActivation } from '../src/application/governance/modern-installed-preflight.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import { installedLocalBinding } from '../src/domain/governance/activation/modern-local-runtime.js';
import {
  planSource5WorkflowReview, parseSource5WorkflowReviewRequest, type Source5WorkflowReviewRequest
} from '../src/governance-activation/workflow-source5-review.js';
import { source5WorkflowPlanInventory } from '../src/governance-activation/workflow-source5-operations.js';
import { workflowSource5JournalFixture } from './fixtures/workflow-source5-journal.js';

describe('source5 deterministic review values, without effect or prerequisite authority', () => {
  let fixture: Awaited<ReturnType<typeof workflowSource5JournalFixture>>;
  let installed: Extract<Awaited<ReturnType<typeof inspectModernInstalledActivation>>, { status: 'observed' }>;
  let request: Source5WorkflowReviewRequest;
  beforeAll(async () => {
    fixture = await workflowSource5JournalFixture();
    const observed = await inspectModernInstalledActivation(fixture.projectRoot);
    if (observed.status !== 'observed') throw new Error('Expected isolated actual installed fixture input.');
    installed = observed;
    request = {
      phaseId: fixture.control.phaseId, executionId: fixture.control.executionId,
      createdAt: fixture.plan.createdAt, expiresAt: fixture.plan.expiresAt,
      configuration: fixture.plan.configuration!, origin: null, remainingFrom: null,
      effects: [{ action: 'git.workflow-source.publish-reviewed', binding: fixture.binding }]
    };
  });
  afterAll(async () => { if (fixture) await rm(fixture.root, { recursive: true, force: true }); });
  const plan = (selected = request, observed = installed) => planSource5WorkflowReview({
    context: fixture.context, installed: observed, projectKey: fixture.control.projectKey, request: selected
  });

  it('constructs deterministic exact operations and explicit original dependencies, never approval or readiness', async () => {
    const before = await readFile(`${fixture.projectRoot}/governance/activation-state.json`);
    const first = plan(), second = plan();
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      control: fixture.control, execution: 'not-authorized',
      prerequisites: { status: 'not-observed', recordedProgressIsCurrentProof: false },
      plan: { stateHash: canonicalSha256(installed.current!.state), baselineDigest: installed.binding,
        approval: { required: true, envelopeId: null, envelopeHash: null, evaluation: { status: 'approval-required' } } }
    });
    expect(first.prerequisites.dependencies).toEqual(
      fixture.context.records.graph.phases.find(phase => phase.id === request.phaseId)!.dependencies);
    expect(source5WorkflowPlanInventory(first.plan).effects).toEqual([fixture.operation]);
    expect(await fixture.store.read('plan', first.control.controlKey)).toBeNull();
    expect(await fixture.store.read('journal', first.control.controlKey)).toBeNull();
    expect(await readFile(`${fixture.projectRoot}/governance/activation-state.json`)).toEqual(before);
  });

  it('detaches and freezes the full request, plan and dependency inventory', () => {
    const selected = structuredClone(request), review = plan(selected);
    const original = structuredClone(review.plan.operations[0]!.inputs);
    const binding = selected.effects[0]!.binding;
    if (!isRecord(binding)) throw new Error('Expected isolated source binding.');
    Reflect.set(binding, 'ref', 'main');
    expect(review.plan.operations[0]!.inputs).toEqual(original);
    for (const value of [review, review.control, review.plan, review.plan.operations, review.plan.operations[0]!.inputs,
      review.prerequisites, review.prerequisites.dependencies]) expect(Object.isFrozen(value)).toBe(true);
  });

  it.each(['executionId', 'createdAt', 'expiresAt', 'effects', 'configuration', 'origin', 'remainingFrom'] as const)(
    'rejects missing required %s rather than inventing default scope, time or budget', key => {
      const selected = structuredClone(request); Reflect.deleteProperty(selected, key);
      expect(() => plan(selected)).toThrow();
    });

  it.each(['execute', 'approve', 'checkpoint', 'prerequisites'] as const)(
    'rejects caller-supplied %s authority fields', key => {
      const selected = structuredClone(request); Reflect.set(selected, key, true);
      expect(() => plan(selected)).toThrow(/complete exact current installed snapshot/);
    });

  it('rejects effect expansion instead of dropping unregistered fields', () => {
    const selected = structuredClone(request); Reflect.set(selected.effects[0]!, 'callback', 'unregistered');
    expect(() => plan(selected)).toThrow(/complete exact current installed snapshot/);
  });

  it.each(['fresh', 'successor', 'released-source', 'governance-none'] as const)(
    'does not treat %s inputs as the current execution family', classification => {
      expect(() => plan(request, { ...installed, classification })).toThrow(/complete exact current installed snapshot/);
    });

  it('refuses missing state and inconsistent installed capture', () => {
    expect(() => plan(request, { ...installed, current: null })).toThrow(/complete exact current installed snapshot/);
    expect(() => plan(request, { ...installed, binding: '0'.repeat(64) })).toThrow(/complete exact current installed snapshot/);
  });

  it('refuses an independently inconsistent state identity even after the snapshot binding is recomputed', () => {
    const changed = structuredClone(installed);
    Reflect.set(changed.current!.state.identity, 'activationContractVersion', 4);
    const snapshot = structuredClone(changed.snapshot);
    expect(() => plan(request, { ...changed, snapshot, binding: installedLocalBinding(snapshot) }))
      .toThrow(/complete exact current installed snapshot/);
  });

  it('keeps the original per-file bytes in the semantic plan and fingerprint', () => {
    const first = plan(), selected = structuredClone(request);
    const binding = selected.effects[0]!.binding;
    if (!isRecord(binding)) throw new Error('Expected isolated source binding.');
    Reflect.set(binding, 'ref', 'ci/liftoff-workflows-other');
    const second = plan(selected);
    expect(second.plan.planDigest).not.toBe(first.plan.planDigest);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.control.controlKey).toBe(first.control.controlKey);
  });

  it('does not collapse the reviewed publication and exact-source stages', () => {
    const selected = { ...request, effects: [
      { action: 'git.workflow-source.publish-reviewed' as const, binding: fixture.binding },
      { action: 'github.workflow-source.bind-execution-ref' as const, binding: {
        repository: fixture.binding.repository, repositoryId: fixture.binding.repositoryId,
        sourceSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), executionRef: `liftoff-execution-${'c'.repeat(40)}`
      } }
    ] };
    expect(() => plan(selected)).toThrow(/Publication A|publication/);
  });

  it('parses only the explicit public review kind, retaining every actual request field', () => {
    const parsed = parseSource5WorkflowReviewRequest({ schemaVersion: 1, kind: 'review-workflow-source5', ...request });
    expect(parsed).toEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(plan(parsed)).toEqual(plan(request));
  });

  it.each(['schemaVersion', 'kind', 'unknown', 'effects', 'origin', 'remainingFrom'] as const)(
    'refuses malformed public %s rather than granting a legacy or broadened request', key => {
      const value = { schemaVersion: 1, kind: 'review-workflow-source5', ...request };
      Reflect.set(value, key, true);
      expect(() => parseSource5WorkflowReviewRequest(value)).toThrow();
    });
});
